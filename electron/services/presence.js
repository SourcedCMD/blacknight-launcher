'use strict';
const net = require('net');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Discord rich presence, spoken directly over Discord's local IPC socket.
 *
 * Discord's own client exposes a named pipe on Windows and a unix socket
 * elsewhere; the wire format is a 4-byte little-endian opcode, a 4-byte
 * little-endian length, then JSON. That is the whole protocol we need, so
 * there is no dependency here - `discord-rpc` would pull a tree of packages to
 * write two frames.
 *
 * Everything about this is best-effort. Discord not running, the user not
 * having it installed, the socket closing mid-session: all of it degrades to
 * "no presence" without surfacing an error, because sharing what you are
 * playing is never worth interrupting someone over.
 */

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;

/**
 * The Discord application this presence belongs to. Create an application at
 * https://discord.com/developers/applications and paste its Application ID
 * here; while it is empty the service stays dormant and the settings toggle
 * explains why.
 */
const CLIENT_ID = '1543980440615129159';

/** Discord probes ipc-0 through ipc-9 to find a running client. */
function socketPath(index) {
  if (process.platform === 'win32') return path.join('\\\\?\\pipe', `discord-ipc-${index}`);
  const base =
    process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || os.tmpdir();
  return path.join(base, `discord-ipc-${index}`);
}

function encode(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

class Presence {
  constructor({ enabled = true, clientId = CLIENT_ID, log = null } = {}) {
    this.clientId = clientId;
    this.log = log;
    this.enabled = enabled;
    this.socket = null;
    this.connected = false;
    this.current = null;
    this.retry = null;
    // The launcher-is-open activity, and the game one if a session is running.
    this.idle = null;
    this.idleSince = null;
    this.playing = null;
  }

  get configured() {
    return !!this.clientId;
  }

  /** Reports why presence is or is not running, for the settings panel. */
  status() {
    if (!this.configured) return { state: 'unconfigured' };
    if (!this.enabled) return { state: 'off' };
    return { state: this.connected ? 'connected' : 'waiting' };
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (!this.enabled) this.disconnect();
    else if (!this.connected) this.connect();
    // Re-publish whatever was showing before the toggle flipped.
    if (this.enabled && this.current) this.setActivity(this.current);
    return this.status();
  }

  connect(index = 0) {
    if (!this.configured || !this.enabled || this.socket || index > 9) return;

    const socket = net.createConnection(socketPath(index));
    socket.on('connect', () => {
      this.socket = socket;
      socket.write(encode(OP_HANDSHAKE, { v: 1, client_id: this.clientId }));
    });

    socket.on('data', () => {
      // Any reply to the handshake means Discord accepted us.
      if (!this.connected) {
        this.connected = true;
        this.log?.info('presence', `Connected to Discord on ipc-${index}`);
        if (this.current) this.setActivity(this.current);
      }
    });

    const fail = () => {
      socket.destroy();
      if (this.socket === socket) {
        this.socket = null;
        this.connected = false;
      }
      // Try the next pipe index, then back off and start over.
      if (index < 9) this.connect(index + 1);
      else {
        // Said once per attempt rather than once per pipe, and at info: a
        // Discord that is simply not running is the ordinary case, not a fault.
        this.log?.info('presence', 'Discord is not running; will try again in 30s');
        this._scheduleRetry();
      }
    };

    socket.on('error', fail);
    socket.on('close', fail);
  }

  _scheduleRetry() {
    if (this.retry || !this.enabled) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, 30000);
  }

  /**
   * What to show while the launcher is open and nothing is running.
   *
   * Presence used to be published only during a play session, which meant that
   * on a machine with no games installed - or any evening somebody browsed
   * without starting anything - Discord showed nothing at all, and the feature
   * looked broken when it was merely idle.
   *
   * Steam, Epic and GOG all do this. "In the launcher" is the floor; naming
   * the screen is better, because it is true and it is more interesting.
   */
  setIdle(where = null) {
    this.idleSince = this.idleSince || Date.now();
    this.idle = {
      title: 'BlackNight Launcher',
      details: where || undefined,
      startedAt: this.idleSince,
      idle: true
    };
    // A running game always outranks the launcher.
    if (!this.playing) this.setActivity(this.idle);
  }

  /**
   * `activity` is null to clear, or { title, details, startedAt }.
   *
   * Clearing while the launcher is still open falls back to the idle state
   * rather than showing nothing, so closing a game returns to "in the
   * launcher" instead of going blank.
   */
  setActivity(activity) {
    this.playing = activity && !activity.idle ? activity : null;
    if (!activity && this.idle) activity = this.idle;

    this.current = activity;
    if (!this.configured || !this.enabled) return;
    if (!this.connected) {
      this.connect();
      return;
    }

    const payload = activity
      ? {
          details: activity.title,
          state: activity.details || undefined,
          timestamps: activity.startedAt ? { start: Math.floor(activity.startedAt / 1000) } : undefined,
          assets: {
            // These names refer to art uploaded to the Discord application's
            // Rich Presence assets. Without them Discord still shows the text,
            // just no image - which is why a missing asset is not an error.
            large_image: activity.idle ? 'launcher' : 'blacknight',
            large_text: 'BlackNight Launcher'
          },
          // A party turns "Playing Tidebreaker" into something joinable in
          // chat rather than a line of text. Only sent when the title actually
          // supports it, because an invite that goes nowhere is worse than no
          // invite at all.
          party: activity.party
            ? { id: activity.party.id, size: [activity.party.size || 1, activity.party.max || 4] }
            : undefined,
          secrets: activity.party && activity.party.joinable
            ? { join: activity.party.joinSecret || activity.party.id }
            : undefined,
          buttons: activity.link ? [{ label: 'View in launcher', url: activity.link }] : undefined,
          instance: !!activity.party
        }
      : null;

    try {
      this.socket.write(
        encode(OP_FRAME, {
          cmd: 'SET_ACTIVITY',
          args: { pid: process.pid, activity: payload },
          nonce: crypto.randomUUID()
        })
      );
      this.log?.info(
        'presence',
        payload ? `Showing "${payload.details}"${payload.state ? ` - ${payload.state}` : ''}` : 'Cleared'
      );
    } catch (err) {
      this.connected = false;
      this.log?.info('presence', `Lost the Discord socket: ${err.message}`);
    }
  }

  /** Ends the game activity, falling back to the launcher one. */
  clear() {
    this.playing = null;
    this.setActivity(null);
  }

  /** Genuinely nothing, for quitting. */
  clearAll() {
    this.playing = null;
    this.idle = null;
    this.idleSince = null;
    this.current = null;
    if (this.connected && this.socket) {
      try {
        this.socket.write(
          encode(OP_FRAME, {
            cmd: 'SET_ACTIVITY',
            args: { pid: process.pid, activity: null },
            nonce: crypto.randomUUID()
          })
        );
      } catch { /* going away anyway */ }
    }
  }

  disconnect() {
    clearTimeout(this.retry);
    this.retry = null;
    if (!this.socket) return;
    try {
      this.socket.write(encode(OP_CLOSE, {}));
      this.socket.destroy();
    } catch {
      /* already gone */
    }
    this.socket = null;
    this.connected = false;
  }
}

module.exports = { Presence, socketPath, encode };
