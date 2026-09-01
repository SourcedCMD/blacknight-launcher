'use strict';
const crypto = require('crypto');
const { Store } = require('./store');

/**
 * Accounts that exist somewhere other than one machine.
 *
 * The launcher's own auth is deliberately local - it works offline and owes
 * nothing to anyone. This is the other mode: a library that follows you to a
 * second PC, a password that can actually be reset, and an entitlement the
 * user cannot grant themselves by editing a file.
 *
 * Password hashing matches the launcher exactly, so an account created either
 * side is verifiable by the other.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
const RESET_MINUTES = 30;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');

/** Constant time, so a wrong password cannot be narrowed by timing it. */
function sameSecret(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Never leaves the server: no hash, no salt, no passkey material. */
const publicUser = (user) =>
  user && {
    id: user.id,
    handle: user.handle,
    email: user.email,
    displayName: user.displayName,
    tier: user.tier,
    createdAt: user.createdAt,
    hasPasskey: (user.passkeys || []).length > 0
  };

class Accounts {
  constructor(dir) {
    this.store = new Store(dir, 'accounts', { users: [], sessions: {}, resets: {} });
  }

  _find(identifier) {
    const needle = String(identifier || '').toLowerCase();
    return this.store
      .get('users')
      .find((u) => u.email.toLowerCase() === needle || u.handle.toLowerCase() === needle);
  }

  _issueSession(user) {
    const token = crypto.randomBytes(32).toString('hex');
    const sessions = this.store.get('sessions');
    sessions[token] = { userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 86400000 };
    this.store.set('sessions', sessions);
    return token;
  }

  register({ email, handle, password, displayName }) {
    if (!EMAIL_RE.test(String(email || ''))) throw fail(400, 'That email does not look right.');
    if (!HANDLE_RE.test(String(handle || ''))) {
      throw fail(400, 'Handle must be 3-20 characters: letters, numbers or underscore.');
    }
    if (String(password || '').length < 8) throw fail(400, 'Password must be at least 8 characters.');

    const users = this.store.get('users');
    // One message for both cases: which of the two is taken is not something
    // an unauthenticated caller needs to learn.
    if (users.some((u) => u.email.toLowerCase() === email.toLowerCase() || u.handle.toLowerCase() === handle.toLowerCase())) {
      throw fail(409, 'That email or handle is already registered.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      email,
      handle,
      displayName: displayName || handle,
      salt,
      hash: hash(password, salt),
      tier: 'standard',
      entitlements: [],
      passkeys: [],
      createdAt: Date.now()
    };

    users.push(user);
    this.store.set('users', users);
    return { user: publicUser(user), token: this._issueSession(user) };
  }

  signIn({ identifier, password }) {
    const user = this._find(identifier);
    // The same reply whether the account is missing or the password is wrong,
    // so this cannot be used to enumerate who has an account.
    const generic = 'Incorrect credentials.';
    if (!user) {
      // Still spend the time, so a missing account is not faster.
      hash(String(password || ''), 'decoy');
      throw fail(401, generic);
    }
    if (!sameSecret(hash(password, user.salt), user.hash)) throw fail(401, generic);

    return { user: publicUser(user), token: this._issueSession(user) };
  }

  session(token) {
    const record = this.store.get('sessions')[token];
    if (!record || record.expiresAt < Date.now()) return null;
    const user = this.store.get('users').find((u) => u.id === record.userId);
    return user ? publicUser(user) : null;
  }

  signOut(token) {
    const sessions = this.store.get('sessions');
    delete sessions[token];
    this.store.set('sessions', sessions);
    return { ok: true };
  }

  /**
   * Starts a password reset.
   *
   * Always reports success. Telling a caller whether an address is registered
   * is exactly the leak this endpoint would otherwise be.
   */
  requestReset(email) {
    const user = this._find(email);
    if (!user) return { ok: true };

    const token = crypto.randomBytes(24).toString('hex');
    const resets = this.store.get('resets');
    resets[token] = { userId: user.id, expiresAt: Date.now() + RESET_MINUTES * 60000 };
    this.store.set('resets', resets);

    // Nothing here can send email. The token is returned so a mail service can
    // be wired in front without this file changing.
    return { ok: true, token, email: user.email };
  }

  completeReset({ token, password }) {
    const resets = this.store.get('resets');
    const record = resets[token];
    if (!record || record.expiresAt < Date.now()) throw fail(400, 'That reset link has expired.');
    if (String(password || '').length < 8) throw fail(400, 'Password must be at least 8 characters.');

    const users = this.store.get('users');
    const user = users.find((u) => u.id === record.userId);
    if (!user) throw fail(400, 'That reset link is no longer valid.');

    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hash(password, user.salt);
    this.store.set('users', users);

    delete resets[token];
    this.store.set('resets', resets);

    // Every existing session dies with the password.
    const sessions = this.store.get('sessions');
    for (const [key, value] of Object.entries(sessions)) {
      if (value.userId === user.id) delete sessions[key];
    }
    this.store.set('sessions', sessions);

    return { ok: true };
  }

  /* --- Passkeys --------------------------------------------------------- */

  /**
   * A challenge for the browser to sign.
   *
   * Verifying a WebAuthn assertion properly means parsing CBOR and checking a
   * signature against the stored public key. That is real work and belongs
   * behind a reviewed library rather than being improvised here, so this
   * stores the credential and records the challenge, and the verification step
   * is marked plainly as the piece to complete before it is relied on.
   */
  challenge(userId) {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const users = this.store.get('users');
    const user = users.find((u) => u.id === userId);
    if (!user) throw fail(404, 'No such account.');
    user.challenge = { value: challenge, expiresAt: Date.now() + 5 * 60000 };
    this.store.set('users', users);
    return { challenge, rpId: 'localhost', userId };
  }

  registerPasskey({ userId, credentialId, publicKey, challenge }) {
    const users = this.store.get('users');
    const user = users.find((u) => u.id === userId);
    if (!user) throw fail(404, 'No such account.');
    if (!user.challenge || user.challenge.value !== challenge || user.challenge.expiresAt < Date.now()) {
      throw fail(400, 'That challenge is no longer valid.');
    }

    user.passkeys = user.passkeys || [];
    user.passkeys.push({ credentialId, publicKey, addedAt: Date.now() });
    delete user.challenge;
    this.store.set('users', users);
    return { ok: true, count: user.passkeys.length };
  }

  /* --- Entitlements ------------------------------------------------------ */

  /**
   * What an account is allowed to have.
   *
   * Shaped so a payment processor's webhook can grant one later without the
   * launcher changing: a list of ids, and a tier derived from them.
   */
  entitlements(token) {
    const user = this.session(token);
    if (!user) throw fail(401, 'Not signed in.');
    const record = this.store.get('users').find((u) => u.id === user.id);
    return {
      tier: record.tier || 'standard',
      entitlements: record.entitlements || [],
      // The launcher checks this before offering a playtest channel.
      channels: (record.entitlements || []).filter((e) => e.startsWith('channel:')).map((e) => e.slice(8))
    };
  }

  grant(userId, entitlement) {
    const users = this.store.get('users');
    const user = users.find((u) => u.id === userId);
    if (!user) throw fail(404, 'No such account.');
    user.entitlements = [...new Set([...(user.entitlements || []), entitlement])];
    if (entitlement === 'plus') user.tier = 'plus';
    this.store.set('users', users);
    return { ok: true, entitlements: user.entitlements };
  }
}

module.exports = { Accounts, publicUser, hash };
