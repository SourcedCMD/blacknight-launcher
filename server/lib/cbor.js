'use strict';

/**
 * Just enough CBOR to read a WebAuthn attestation.
 *
 * WebAuthn wraps its attestation object and its public keys in CBOR, and there
 * is no way to read either without a decoder. This handles the subset those
 * structures actually use: unsigned and negative integers, byte strings, text
 * strings, arrays and maps.
 *
 * Deliberately missing, because WebAuthn does not use them and a decoder that
 * accepts less is a decoder with less to get wrong: tags, floats, indefinite
 * lengths, and the simple values beyond true/false/null.
 *
 * Every unsupported major type is an error rather than a silent skip. A
 * decoder that quietly ignores what it does not understand is how a structure
 * gets parsed into something other than what was signed.
 */

const MAX_DEPTH = 16;
const MAX_ITEMS = 4096;

class CborError extends Error {}

/**
 * Reads the argument that follows a major type.
 *
 * The low five bits are either the value itself (0-23) or say how many bytes
 * of length follow.
 */
function readArgument(buf, pos, info) {
  if (info < 24) return { value: info, pos };
  if (info === 24) {
    if (pos + 1 > buf.length) throw new CborError('truncated');
    return { value: buf[pos], pos: pos + 1 };
  }
  if (info === 25) {
    if (pos + 2 > buf.length) throw new CborError('truncated');
    return { value: buf.readUInt16BE(pos), pos: pos + 2 };
  }
  if (info === 26) {
    if (pos + 4 > buf.length) throw new CborError('truncated');
    return { value: buf.readUInt32BE(pos), pos: pos + 4 };
  }
  if (info === 27) {
    if (pos + 8 > buf.length) throw new CborError('truncated');
    const big = buf.readBigUInt64BE(pos);
    // Nothing in an attestation is legitimately this large, and turning it
    // into a float would lose the exactness that made it worth reading.
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('length out of range');
    return { value: Number(big), pos: pos + 8 };
  }
  // 28-30 are reserved; 31 is an indefinite length, which WebAuthn does not use.
  throw new CborError(`unsupported additional information ${info}`);
}

function decodeItem(buf, pos, depth) {
  if (depth > MAX_DEPTH) throw new CborError('nested too deeply');
  if (pos >= buf.length) throw new CborError('truncated');

  const initial = buf[pos];
  const major = initial >> 5;
  const info = initial & 0x1f;
  let cursor = pos + 1;

  // Major 7 is the only one where the argument is not a length or a value.
  if (major === 7) {
    if (info === 20) return { value: false, pos: cursor };
    if (info === 21) return { value: true, pos: cursor };
    if (info === 22) return { value: null, pos: cursor };
    if (info === 23) return { value: undefined, pos: cursor };
    throw new CborError(`unsupported simple value ${info}`);
  }

  const argument = readArgument(buf, cursor, info);
  cursor = argument.pos;
  const value = argument.value;

  switch (major) {
    case 0: // unsigned
      return { value, pos: cursor };

    case 1: // negative: encoded as -1 - n
      return { value: -1 - value, pos: cursor };

    case 2: { // byte string
      if (cursor + value > buf.length) throw new CborError('truncated byte string');
      return { value: buf.subarray(cursor, cursor + value), pos: cursor + value };
    }

    case 3: { // text string
      if (cursor + value > buf.length) throw new CborError('truncated text string');
      return { value: buf.subarray(cursor, cursor + value).toString('utf8'), pos: cursor + value };
    }

    case 4: { // array
      if (value > MAX_ITEMS) throw new CborError('array too long');
      const items = [];
      let at = cursor;
      for (let i = 0; i < value; i++) {
        const item = decodeItem(buf, at, depth + 1);
        items.push(item.value);
        at = item.pos;
      }
      return { value: items, pos: at };
    }

    case 5: { // map
      if (value > MAX_ITEMS) throw new CborError('map too large');
      const map = new Map();
      let at = cursor;
      for (let i = 0; i < value; i++) {
        const key = decodeItem(buf, at, depth + 1);
        const val = decodeItem(buf, key.pos, depth + 1);
        // A duplicate key means two readers could disagree about the contents,
        // which for something being verified is not acceptable.
        if (map.has(key.value)) throw new CborError('duplicate map key');
        map.set(key.value, val.value);
        at = val.pos;
      }
      return { value: map, pos: at };
    }

    default:
      throw new CborError(`unsupported major type ${major}`);
  }
}

/**
 * Decodes one CBOR item.
 *
 * Trailing bytes are an error: an attestation object with something appended
 * is not an attestation object, and accepting it would mean verifying one
 * thing and storing another.
 */
function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { value, pos } = decodeItem(buf, 0, 0);
  if (pos !== buf.length) throw new CborError('trailing data after the item');
  return value;
}

/** Decodes the first item and says where it ended, for the attested key. */
function decodeFirst(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const { value, pos } = decodeItem(buf, 0, 0);
  return { value, bytesRead: pos };
}

module.exports = { decode, decodeFirst, CborError };
