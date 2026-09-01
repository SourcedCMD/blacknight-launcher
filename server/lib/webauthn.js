'use strict';
const crypto = require('crypto');
const { decode, decodeFirst } = require('./cbor');

/**
 * WebAuthn registration and assertion verification.
 *
 * Worth saying plainly what this is and is not.
 *
 * It implements the checks that decide whether a signature is genuine and
 * whether it was made for this server, this challenge and this credential:
 * every step in the "verifying an authentication assertion" list that does not
 * depend on trusting an authenticator vendor.
 *
 * It does not verify attestation statements. That means it does not attempt to
 * prove which physical make and model of authenticator created a credential,
 * which requires maintaining a trust store of vendor roots. For a launcher
 * signing people into their own account that is the right call - the security
 * comes from the signature and the challenge, not from knowing the brand of
 * key - but if this is ever used somewhere that must exclude unknown
 * authenticators, that piece is missing and its absence is deliberate.
 *
 * Only ES256 and RS256 are accepted. Those are what browsers and platform
 * authenticators actually produce, and a shorter list of algorithms is a
 * shorter list of ways to be wrong.
 */

const COSE = {
  KTY: 1, ALG: 3,
  CRV: -1, X: -2, Y: -3,  // EC2
  N: -1, E: -2            // RSA
};

const ALG = {
  ES256: -7,
  RS256: -257
};

const FLAG = {
  USER_PRESENT: 0x01,
  USER_VERIFIED: 0x04,
  ATTESTED_DATA: 0x40,
  EXTENSION_DATA: 0x80
};

const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400, webauthn: true });
};

const fromBase64url = (text) => Buffer.from(String(text || ''), 'base64url');
const toBase64url = (buffer) => Buffer.from(buffer).toString('base64url');

/**
 * Turns a COSE key into a Node KeyObject.
 *
 * Node cannot import COSE directly, so the key is rebuilt as a JWK - which it
 * can - rather than assembling DER by hand.
 */
function coseToKey(cose) {
  const kty = cose.get(COSE.KTY);
  const alg = cose.get(COSE.ALG);

  if (alg === ALG.ES256) {
    if (kty !== 2) fail('the key algorithm and type disagree');
    const x = cose.get(COSE.X);
    const y = cose.get(COSE.Y);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      fail('that EC key is malformed');
    }
    return {
      key: crypto.createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: toBase64url(x), y: toBase64url(y) },
        format: 'jwk'
      }),
      alg: ALG.ES256
    };
  }

  if (alg === ALG.RS256) {
    if (kty !== 3) fail('the key algorithm and type disagree');
    const n = cose.get(COSE.N);
    const e = cose.get(COSE.E);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) fail('that RSA key is malformed');
    return {
      key: crypto.createPublicKey({
        key: { kty: 'RSA', n: toBase64url(n), e: toBase64url(e) },
        format: 'jwk'
      }),
      alg: ALG.RS256
    };
  }

  fail('that key uses an algorithm this server does not accept');
  return null;
}

/**
 * Parses authenticator data.
 *
 * A fixed 37-byte header, optionally followed by an attested credential and
 * extensions. Lengths are checked at every step because this is attacker
 * supplied.
 */
function parseAuthData(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 37) fail('the authenticator data is too short');

  const rpIdHash = buffer.subarray(0, 32);
  const flags = buffer[32];
  const signCount = buffer.readUInt32BE(33);

  const result = {
    rpIdHash,
    flags,
    signCount,
    userPresent: !!(flags & FLAG.USER_PRESENT),
    userVerified: !!(flags & FLAG.USER_VERIFIED),
    credentialId: null,
    publicKey: null
  };

  if (!(flags & FLAG.ATTESTED_DATA)) return result;

  // 16 bytes AAGUID, 2 bytes id length, then the id, then the COSE key.
  if (buffer.length < 55) fail('the attested credential data is truncated');
  const idLength = buffer.readUInt16BE(53);
  // The spec caps a credential id at 1023 bytes.
  if (idLength > 1023) fail('that credential id is implausibly long');
  if (buffer.length < 55 + idLength) fail('the attested credential data is truncated');

  result.credentialId = buffer.subarray(55, 55 + idLength);

  // The key is the next CBOR item; extensions may follow it.
  const { value } = decodeFirst(buffer.subarray(55 + idLength));
  if (!(value instanceof Map)) fail('the credential public key is not a COSE key');
  result.publicKey = value;

  return result;
}

/** The client data, checked against what this server asked for. */
function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let data;
  try {
    data = JSON.parse(Buffer.from(clientDataJSON).toString('utf8'));
  } catch {
    fail('the client data is not valid JSON');
  }

  if (data.type !== type) fail(`this was signed for "${data.type}", not "${type}"`);

  // Constant time, and length-checked first so the comparison cannot throw.
  const expected = Buffer.from(String(challenge));
  const actual = Buffer.from(String(data.challenge || ''));
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    fail('that challenge does not match the one issued');
  }

  // The origin is what stops a credential registered here being used from
  // somewhere else, so it is compared exactly rather than by suffix.
  if (origin && data.origin !== origin) fail(`that was signed for ${data.origin}, not ${origin}`);

  return data;
}

const rpIdHash = (rpId) => crypto.createHash('sha256').update(String(rpId)).digest();

function verifySignature({ key, alg }, signedData, signature) {
  const verifier = crypto.createVerify('SHA256');
  verifier.update(signedData);
  verifier.end();

  // WebAuthn's ES256 signatures are DER encoded, which is what Node expects
  // by default, so no dsaEncoding override is needed here.
  return verifier.verify(key, signature);
}

/**
 * Registration: checks the attestation and returns what to store.
 *
 * Returns the credential id, the public key as a JWK, and the initial signature
 * counter. Nothing secret is produced - a WebAuthn credential's private half
 * never leaves the authenticator, which is the entire point of it.
 */
function verifyRegistration({ attestationObject, clientDataJSON, challenge, origin, rpId, requireUserVerification = false }) {
  checkClientData(clientDataJSON, { type: 'webauthn.create', challenge, origin });

  let attestation;
  try {
    attestation = decode(fromBase64url(attestationObject));
  } catch (err) {
    fail(`the attestation object could not be read: ${err.message}`);
  }
  if (!(attestation instanceof Map)) fail('the attestation object is not a CBOR map');

  const authData = parseAuthData(attestation.get('authData'));

  if (!authData.credentialId || !authData.publicKey) fail('the attestation carried no credential');
  if (!authData.userPresent) fail('the authenticator did not report a person being present');
  if (requireUserVerification && !authData.userVerified) fail('this account requires user verification');

  const expected = rpIdHash(rpId);
  if (!crypto.timingSafeEqual(authData.rpIdHash, expected)) fail('that credential was created for a different site');

  // Proves the key parses and is an algorithm this server accepts, before it
  // is stored and relied on later.
  const { key } = coseToKey(authData.publicKey);

  return {
    credentialId: toBase64url(authData.credentialId),
    publicKeyJwk: key.export({ format: 'jwk' }),
    signCount: authData.signCount,
    userVerified: authData.userVerified,
    // The attestation format is recorded rather than trusted, so a decision to
    // start checking it later has the data to work with.
    fmt: attestation.get('fmt') || 'none'
  };
}

/**
 * Assertion: checks a sign-in against a stored credential.
 *
 * The signature covers the authenticator data concatenated with the SHA-256 of
 * the client data. Both halves matter: the first ties it to this site and this
 * authenticator's state, the second to this challenge.
 */
function verifyAssertion({
  credential,
  authenticatorData,
  clientDataJSON,
  signature,
  challenge,
  origin,
  rpId,
  requireUserVerification = false
}) {
  checkClientData(clientDataJSON, { type: 'webauthn.get', challenge, origin });

  const authBuffer = fromBase64url(authenticatorData);
  const authData = parseAuthData(authBuffer);

  if (!authData.userPresent) fail('the authenticator did not report a person being present');
  if (requireUserVerification && !authData.userVerified) fail('this account requires user verification');
  if (!crypto.timingSafeEqual(authData.rpIdHash, rpIdHash(rpId))) fail('that assertion was made for a different site');

  const key = crypto.createPublicKey({ key: credential.publicKeyJwk, format: 'jwk' });
  const alg = credential.publicKeyJwk.kty === 'EC' ? ALG.ES256 : ALG.RS256;

  const clientHash = crypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest();
  const signed = Buffer.concat([authBuffer, clientHash]);

  if (!verifySignature({ key, alg }, signed, fromBase64url(signature))) fail('that signature is not valid');

  /**
   * The counter, which is how a cloned authenticator is caught.
   *
   * An authenticator that reports a counter must never report one lower than
   * before: that means two devices hold the same credential. Many platform
   * authenticators report zero always, and that is legitimate - the check only
   * applies once a non-zero counter has been seen.
   */
  if (credential.signCount > 0 && authData.signCount > 0 && authData.signCount <= credential.signCount) {
    fail('that credential may have been cloned');
  }

  return {
    ok: true,
    signCount: authData.signCount,
    userVerified: authData.userVerified
  };
}

module.exports = {
  verifyRegistration,
  verifyAssertion,
  parseAuthData,
  coseToKey,
  checkClientData,
  rpIdHash,
  ALG,
  FLAG
};
