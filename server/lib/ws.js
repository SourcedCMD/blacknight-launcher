'use strict';
const crypto = require('crypto');

/**
 * A minimal WebSocket server, enough for signalling.
 *
 * Node has a WebSocket client but no server, and the rendezvous needs to relay
 * a few small JSON messages between launchers. The protocol for that is a
 * handshake and a frame format - about a hundred lines - which is a better
 * trade than a dependency in a project that has none.
 *
 * Deliberately incomplete in ways that do not matter here: no compression, no
 * fragmented sends, and inbound frames larger than the cap are dropped rather
 * than reassembled. Signalling messages are hundreds of bytes.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 256 * 1024;

const OP = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

/** Frames a text payload. Server frames are never masked. */
function encode(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | OP.TEXT; // FIN + text

  return Buffer.concat([header, payload]);
}

/**
 * Pulls one frame off the front of a buffer.
 * Returns null when there is not yet a whole frame to read.
 */
function decode(buffer) {
  if (buffer.length < 2) return null;

  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (length > MAX_FRAME) return { opcode: OP.CLOSE, payload: '', consumed: buffer.length, oversized: true };

  // Every frame from a browser is masked; an unmasked one is a protocol error.
  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }

  return { opcode, payload: payload.toString('utf8'), consumed: offset + length };
}

/**
 * Upgrades an HTTP request to a WebSocket.
 *
 * Returns a small connection object: `send`, `close`, and handlers the caller
 * assigns. Nothing here knows what the messages mean.
 */
function upgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const connection = {
    socket,
    onmessage: null,
    onclose: null,
    open: true,
    send(text) {
      if (!connection.open) return;
      try {
        socket.write(encode(text));
      } catch {
        connection.close();
      }
    },
    close() {
      if (!connection.open) return;
      connection.open = false;
      try {
        socket.end();
      } catch { /* already gone */ }
      connection.onclose?.();
    }
  };

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // A slow-loris style stream that never completes a frame must not grow
    // without limit.
    if (buffer.length > MAX_FRAME * 2) {
      connection.close();
      return;
    }

    let frame;
    while ((frame = decode(buffer))) {
      buffer = buffer.subarray(frame.consumed);

      if (frame.opcode === OP.CLOSE) {
        connection.close();
        return;
      }
      if (frame.opcode === OP.PING) {
        socket.write(Buffer.from([0x80 | OP.PONG, 0]));
        continue;
      }
      if (frame.opcode === OP.TEXT) connection.onmessage?.(frame.payload);
    }
  });

  socket.on('error', () => connection.close());
  socket.on('close', () => {
    if (connection.open) {
      connection.open = false;
      connection.onclose?.();
    }
  });

  return connection;
}

module.exports = { upgrade, encode, decode, OP, MAX_FRAME };
