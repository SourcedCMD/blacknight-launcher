'use strict';
/**
 * WebAuthn verification.
 *
 * There is no browser here, so the tests bring their own authenticator: a real
 * P-256 key pair, real CBOR, real signatures over the real signed-data layout.
 * That is what makes the negative cases meaningful — every one of them starts
 * from something that genuinely verifies and breaks exactly one thing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyRegistration, verifyAssertion, parseAuthData, rpIdHash, FLAG } = require('../lib/webauthn');
const { decode, decodeFirst, CborError } = require('../lib/cbor');

/* --- A CBOR encoder, only for building fixtures -------------------------- */

function head(major, value) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

function encode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(encode)]);
  if (value instanceof Map) {
    const parts = [head(5, value.size)];
    for (const [k, v] of value) parts.push(encode(k), encode(v));
    return Buffer.concat(parts);
  }
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === null) return Buffer.from([0xf6]);
  throw new Error(`cannot encode ${typeof value}`);
}

/* --- A fake authenticator ------------------------------------------------ */

const RP_ID = 'localhost';
const ORIGIN = 'https://localhost';

function makeAuthenticator({ rpId = RP_ID } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });

  const credentialId = crypto.randomBytes(32);

  // COSE_Key for ES256: kty EC2, alg ES256, crv P-256, x, y.
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')]
  ]);

  const authData = ({ signCount = 0, flags = FLAG.USER_PRESENT | FLAG.USER_VERIFIED, attested = true, id = rpId } = {}) => {
    const header = Buffer.alloc(37);
    rpIdHash(id).copy(header, 0);
    header[32] = attested ? flags | FLAG.ATTESTED_DATA : flags;
    header.writeUInt32BE(signCount, 33);

    if (!attested) return header;

    const aaguid = Buffer.alloc(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([header, aaguid, idLength, credentialId, encode(cose)]);
  };

  const clientData = (type, challenge, origin = ORIGIN) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), 'utf8');

  return {
    credentialId,
    privateKey,

    register({ challenge, ...options } = {}) {
      const data = authData(options);
      return {
        attestationObject: encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]])).toString('base64url'),
        clientDataJSON: clientData('webauthn.create', challenge, options.origin)
      };
    },

    assert({ challenge, signCount = 1, origin = ORIGIN, ...options } = {}) {
      const data = authData({ signCount, attested: false, ...options });
      const client = clientData('webauthn.get', challenge, origin);
      const hash = crypto.createHash('sha256').update(client).digest();

      const signature = crypto.sign('SHA256', Buffer.concat([data, hash]), privateKey);

      return {
        authenticatorData: data.toString('base64url'),
        clientDataJSON: client,
        signature: signature.toString('base64url')
      };
    }
  };
}

const challengeFor = () => crypto.randomBytes(32).toString('base64url');

/* --- CBOR ---------------------------------------------------------------- */

test('cbor round-trips the shapes an attestation uses', () => {
  const value = new Map([
    ['fmt', 'none'],
    ['count', 300],
    ['big', 70000],
    ['negative', -7],
    ['bytes', Buffer.from([1, 2, 3])],
    ['list', [1, 2, 3]],
    ['nested', new Map([[1, 2]])]
  ]);
  const back = decode(encode(value));

  assert.equal(back.get('fmt'), 'none');
  assert.equal(back.get('count'), 300);
  assert.equal(back.get('big'), 70000);
  assert.equal(back.get('negative'), -7);
  assert.deepEqual([...back.get('bytes')], [1, 2, 3]);
  assert.deepEqual(back.get('list'), [1, 2, 3]);
  assert.equal(back.get('nested').get(1), 2);
});

test('cbor refuses trailing data', () => {
  const good = encode(new Map([['a', 1]]));
  assert.throws(() => decode(Buffer.concat([good, Buffer.from([0xff])])), CborError);
});

test('cbor refuses a duplicate key', () => {
  // Two entries with the same key: readers could disagree about the contents.
  const bytes = Buffer.concat([head(5, 2), encode('a'), encode(1), encode('a'), encode(2)]);
  assert.throws(() => decode(bytes), CborError);
});

test('cbor refuses truncated input rather than guessing', () => {
  const good = encode(new Map([['authData', Buffer.alloc(40)]]));
  for (const cut of [1, 5, 20, good.length - 1]) {
    assert.throws(() => decode(good.subarray(0, cut)), CborError, `cut at ${cut}`);
  }
});

test('cbor refuses indefinite lengths and tags', () => {
  assert.throws(() => decode(Buffer.from([0x5f])), CborError, 'indefinite byte string');
  assert.throws(() => decode(Buffer.from([0xc0, 0x01])), CborError, 'tag');
});

test('decodeFirst reports where the item ended', () => {
  const first = encode(new Map([[1, 2]]));
  const { value, bytesRead } = decodeFirst(Buffer.concat([first, Buffer.from([0xaa, 0xbb])]));
  assert.equal(value.get(1), 2);
  assert.equal(bytesRead, first.length);
});

/* --- Registration -------------------------------------------------------- */

test('a genuine registration verifies and yields a storable credential', () => {
  const auth = makeAuthenticator();
  const challenge = challengeFor();

  const result = verifyRegistration({
    ...auth.register({ challenge }),
    challenge,
    origin: ORIGIN,
    rpId: RP_ID
  });

  assert.equal(result.credentialId, auth.credentialId.toString('base64url'));
  assert.equal(result.publicKeyJwk.kty, 'EC');
  assert.equal(result.publicKeyJwk.crv, 'P-256');
  assert.ok(!('d' in result.publicKeyJwk), 'no private half, because there never is one');
  assert.equal(result.userVerified, true);
});

test('a registration for a different challenge is refused', () => {
  const auth = makeAuthenticator();
  const registration = auth.register({ challenge: challengeFor() });

  assert.throws(
    () => verifyRegistration({ ...registration, challenge: challengeFor(), origin: ORIGIN, rpId: RP_ID }),
    /challenge/
  );
});

test('a registration from another origin is refused', () => {
  const auth = makeAuthenticator();
  const challenge = challengeFor();
  const registration = auth.register({ challenge, origin: 'https://evil.example' });

  assert.throws(
    () => verifyRegistration({ ...registration, challenge, origin: ORIGIN, rpId: RP_ID }),
    /evil\.example/
  );
});

test('a registration for another site is refused', () => {
  const auth = makeAuthenticator({ rpId: 'someone-else.example' });
  const challenge = challengeFor();
  const registration = auth.register({ challenge, id: 'someone-else.example' });

  assert.throws(
    () => verifyRegistration({ ...registration, challenge, origin: ORIGIN, rpId: RP_ID }),
    /different site/
  );
});

test('a registration with nobody present is refused', () => {
  const auth = makeAuthenticator();
  const challenge = challengeFor();
  const registration = auth.register({ challenge, flags: 0 });

  assert.throws(
    () => verifyRegistration({ ...registration, challenge, origin: ORIGIN, rpId: RP_ID }),
    /present/
  );
});

test('user verification is enforced when the account asks for it', () => {
  const auth = makeAuthenticator();
  const challenge = challengeFor();
  const registration = auth.register({ challenge, flags: FLAG.USER_PRESENT });

  assert.throws(
    () => verifyRegistration({ ...registration, challenge, origin: ORIGIN, rpId: RP_ID, requireUserVerification: true }),
    /user verification/
  );
  // And is not enforced when it is not asked for.
  assert.ok(verifyRegistration({ ...registration, challenge, origin: ORIGIN, rpId: RP_ID }));
});

test('a mangled attestation object is refused rather than crashing', () => {
  const challenge = challengeFor();
  for (const bad of ['', 'bm90LWNib3I', Buffer.from([0x00]).toString('base64url')]) {
    assert.throws(
      () => verifyRegistration({
        attestationObject: bad,
        clientDataJSON: Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN })),
        challenge, origin: ORIGIN, rpId: RP_ID
      }),
      /attestation|CBOR|credential/i,
      `for ${JSON.stringify(bad)}`
    );
  }
});

/* --- Assertion ----------------------------------------------------------- */

function enrol() {
  const auth = makeAuthenticator();
  const challenge = challengeFor();
  const credential = verifyRegistration({
    ...auth.register({ challenge }),
    challenge, origin: ORIGIN, rpId: RP_ID
  });
  return { auth, credential };
}

test('a genuine assertion verifies', () => {
  const { auth, credential } = enrol();
  const challenge = challengeFor();

  const result = verifyAssertion({
    credential,
    ...auth.assert({ challenge, signCount: 1 }),
    challenge, origin: ORIGIN, rpId: RP_ID
  });

  assert.equal(result.ok, true);
  assert.equal(result.signCount, 1);
});

test('a tampered signature is refused', () => {
  const { auth, credential } = enrol();
  const challenge = challengeFor();
  const assertion = auth.assert({ challenge, signCount: 1 });

  // Flip one byte of the signature.
  const bytes = Buffer.from(assertion.signature, 'base64url');
  bytes[10] ^= 0xff;

  assert.throws(
    () => verifyAssertion({
      credential, ...assertion, signature: bytes.toString('base64url'),
      challenge, origin: ORIGIN, rpId: RP_ID
    }),
    /signature/
  );
});

test('an assertion replayed against a different challenge is refused', () => {
  const { auth, credential } = enrol();
  const assertion = auth.assert({ challenge: challengeFor(), signCount: 1 });

  assert.throws(
    () => verifyAssertion({ credential, ...assertion, challenge: challengeFor(), origin: ORIGIN, rpId: RP_ID }),
    /challenge/
  );
});

test('an assertion signed by a different key is refused', () => {
  const { credential } = enrol();
  const impostor = makeAuthenticator();
  const challenge = challengeFor();

  assert.throws(
    () => verifyAssertion({
      credential, ...impostor.assert({ challenge, signCount: 1 }),
      challenge, origin: ORIGIN, rpId: RP_ID
    }),
    /signature/
  );
});

test('an assertion from another origin is refused', () => {
  const { auth, credential } = enrol();
  const challenge = challengeFor();

  assert.throws(
    () => verifyAssertion({
      credential, ...auth.assert({ challenge, signCount: 1, origin: 'https://evil.example' }),
      challenge, origin: ORIGIN, rpId: RP_ID
    }),
    /evil\.example/
  );
});

test('a counter that goes backwards means a clone', () => {
  const { auth, credential } = enrol();

  const first = challengeFor();
  const seen = verifyAssertion({
    credential, ...auth.assert({ challenge: first, signCount: 10 }),
    challenge: first, origin: ORIGIN, rpId: RP_ID
  });
  assert.equal(seen.signCount, 10);

  const next = challengeFor();
  assert.throws(
    () => verifyAssertion({
      credential: { ...credential, signCount: seen.signCount },
      ...auth.assert({ challenge: next, signCount: 5 }),
      challenge: next, origin: ORIGIN, rpId: RP_ID
    }),
    /cloned/
  );
});

test('an authenticator that always reports zero is not treated as a clone', () => {
  // Plenty of platform authenticators do this, and it is legitimate.
  const { auth, credential } = enrol();

  for (let i = 0; i < 3; i++) {
    const challenge = challengeFor();
    const result = verifyAssertion({
      credential: { ...credential, signCount: 0 },
      ...auth.assert({ challenge, signCount: 0 }),
      challenge, origin: ORIGIN, rpId: RP_ID
    });
    assert.equal(result.ok, true);
  }
});

/* --- Parsing ------------------------------------------------------------- */

test('authenticator data shorter than its header is refused', () => {
  for (const length of [0, 10, 36]) {
    assert.throws(() => parseAuthData(Buffer.alloc(length)), /too short/);
  }
});

test('a credential id longer than the spec allows is refused', () => {
  const header = Buffer.alloc(55);
  header[32] = FLAG.USER_PRESENT | FLAG.ATTESTED_DATA;
  header.writeUInt16BE(2000, 53);
  assert.throws(() => parseAuthData(header), /implausibly long/);
});

test('a truncated attested credential is refused', () => {
  const header = Buffer.alloc(55);
  header[32] = FLAG.USER_PRESENT | FLAG.ATTESTED_DATA;
  header.writeUInt16BE(64, 53); // claims 64 bytes that are not there
  assert.throws(() => parseAuthData(header), /truncated/);
});
