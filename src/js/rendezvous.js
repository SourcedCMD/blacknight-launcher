/* =========================================================================
   Peers beyond the local network.

   Multicast discovery stops at the subnet, so LAN sharing only ever helps a
   household. WebRTC reaches anywhere, and needs exactly one thing the local
   version does not: somewhere for two launchers to exchange connection
   details before they can talk directly.

   This lives in the renderer because RTCPeerConnection does. The main process
   owns the disk, so blocks that arrive here are handed straight over IPC to be
   written - the renderer never holds a build in memory.

   Off unless `rendezvousUrl` is set. With no server configured nothing here
   runs and the settings row says so, rather than offering a switch that
   quietly does nothing.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  // Public STUN only. A TURN relay would carry the actual bytes, which is
  // both a running cost and a party this design does not want in the middle.
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

  const CHUNK = 64 * 1024; // comfortably under the data channel message limit
  const BUFFER_HIGH = 4 * 1024 * 1024;

  let socket = null;
  let selfId = null;
  const connections = new Map(); // peerId -> RTCPeerConnection

  const configured = () => !!BN.state?.data?.settings?.rendezvousUrl;
  const enabled = () => configured() && BN.state.data.settings.remoteSharing === true;

  /* --------------------------------------------------------------------- */
  /* Signalling                                                             */

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /**
   * Connects to the rendezvous and says what this machine can offer.
   *
   * Only game ids and versions, exactly as the LAN announcement does - the
   * server never learns who is running the launcher.
   */
  async function connect() {
    if (!enabled() || socket) return { ok: false, reason: configured() ? 'off' : 'unconfigured' };

    const url = BN.state.data.settings.rendezvousUrl;
    selfId = BN.state.data.settings.peerId || crypto.randomUUID();

    try {
      socket = new WebSocket(url);
    } catch (err) {
      BN.log?.warn('rendezvous', 'Could not open the rendezvous', err);
      return { ok: false, error: err.message };
    }

    socket.addEventListener('open', async () => {
      BN.log?.info('rendezvous', 'Connected');
      send({ type: 'hello', id: selfId, titles: await installedTitles() });
    });

    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // anything that is not ours is not our problem
      }
      handle(message).catch((err) => BN.log?.warn('rendezvous', 'Signalling failed', err));
    });

    socket.addEventListener('close', () => {
      socket = null;
      // Reconnect quietly; a dropped rendezvous is not worth telling anyone.
      if (enabled()) setTimeout(connect, 30000);
    });

    socket.addEventListener('error', () => BN.log?.debug('rendezvous', 'Signalling socket error'));
    return { ok: true };
  }

  function disconnect() {
    for (const pc of connections.values()) {
      try {
        pc.close();
      } catch { /* already closed */ }
    }
    connections.clear();
    try {
      socket?.close();
    } catch { /* already closed */ }
    socket = null;
  }

  async function installedTitles() {
    try {
      return (await BN.api.library.list())
        .filter((g) => g.installed && g.installedVersion)
        .map((g) => ({ gameId: g.id, version: g.installedVersion }));
    } catch {
      return [];
    }
  }

  /* --------------------------------------------------------------------- */
  /* Peer connections                                                       */

  function peerConnection(peerId) {
    if (connections.has(peerId)) return connections.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'ice', to: peerId, from: selfId, candidate: e.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        connections.delete(peerId);
      }
    };
    // Whoever answers is the one serving a build.
    pc.ondatachannel = (e) => serve(e.channel);

    connections.set(peerId, pc);
    return pc;
  }

  async function handle(message) {
    if (message.to && message.to !== selfId) return;

    if (message.type === 'offer') {
      const pc = peerConnection(message.from);
      await pc.setRemoteDescription(message.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'answer', to: message.from, from: selfId, sdp: answer });
      return;
    }

    if (message.type === 'answer') {
      await connections.get(message.from)?.setRemoteDescription(message.sdp);
      return;
    }

    if (message.type === 'ice') {
      try {
        await connections.get(message.from)?.addIceCandidate(message.candidate);
      } catch { /* a candidate arriving before the description is normal */ }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Serving                                                                */

  /**
   * Answers a request for a byte range of a build this machine has.
   *
   * The main process reads the file; the renderer only moves bytes. Requests
   * are bounded and checked against what is actually installed, so a peer
   * cannot ask for arbitrary paths.
   */
  function serve(channel) {
    channel.binaryType = 'arraybuffer';
    channel.onmessage = async (event) => {
      let request;
      try {
        request = JSON.parse(event.data);
      } catch {
        return;
      }
      if (request.type !== 'range') return;

      try {
        const block = await BN.api.peers.readRange(request.gameId, request.version, request.offset, request.length);
        if (!block?.ok) {
          channel.send(JSON.stringify({ type: 'error', id: request.id, reason: block?.error || 'unavailable' }));
          return;
        }
        channel.send(JSON.stringify({ type: 'range', id: request.id, offset: request.offset, length: block.length }));

        // Paced against the send buffer, or a large range closes the channel.
        const bytes = Uint8Array.from(atob(block.data), (c) => c.charCodeAt(0));
        for (let at = 0; at < bytes.length; at += CHUNK) {
          while (channel.bufferedAmount > BUFFER_HIGH) {
            await new Promise((r) => setTimeout(r, 40));
          }
          channel.send(bytes.subarray(at, at + CHUNK));
        }
      } catch (err) {
        BN.log?.warn('rendezvous', 'Could not serve a range', err);
      }
    };
  }

  /* --------------------------------------------------------------------- */
  /* Status                                                                 */

  function status() {
    return {
      configured: configured(),
      enabled: enabled(),
      connected: socket?.readyState === WebSocket.OPEN,
      peers: connections.size
    };
  }

  async function setEnabled(on) {
    await BN.state.setSettings({ remoteSharing: !!on });
    if (!on) {
      disconnect();
      return status();
    }
    await connect();
    return status();
  }

  BN.rendezvous = { connect, disconnect, status, setEnabled, ICE };
})();
