'use strict';
const crypto = require('crypto');
const { Store } = require('./store');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_DAYS = 30;

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');

const constantTimeEqual = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;

/** Public-facing shape of an account. Never leaks the hash or salt. */
const publicUser = (u) =>
  u && {
    id: u.id,
    handle: u.handle,
    email: u.email,
    displayName: u.displayName,
    avatarSeed: u.avatarSeed,
    tier: u.tier,
    createdAt: u.createdAt,
    lastLogin: u.lastLogin,
    offline: !!u.offline
  };

class Auth {
  constructor(dir) {
    this.store = new Store(dir, 'accounts', { users: [], session: null });
  }

  /* ---------------------------------------------------------------- */

  passwordStrength(password = '') {
    let score = 0;
    if (password.length >= 8) score++;
    if (password.length >= 12) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^A-Za-z0-9]/.test(password)) score++;
    return Math.min(score, 5);
  }

  signUp({ email, handle, password, displayName }) {
    email = String(email || '').trim().toLowerCase();
    handle = String(handle || '').trim();

    if (!EMAIL_RE.test(email)) return { ok: false, error: 'Enter a valid email address.' };
    if (!HANDLE_RE.test(handle))
      return { ok: false, error: 'Handle must be 3-20 characters: letters, numbers or underscore.' };
    if (String(password || '').length < 8)
      return { ok: false, error: 'Password must be at least 8 characters.' };
    if (this.passwordStrength(password) < 3)
      return { ok: false, error: 'Password is too weak. Mix upper/lowercase, numbers or symbols.' };

    const users = this.store.get('users');
    if (users.some((u) => u.email === email)) return { ok: false, error: 'That email is already registered.' };
    if (users.some((u) => u.handle.toLowerCase() === handle.toLowerCase()))
      return { ok: false, error: 'That handle is taken.' };

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: crypto.randomUUID(),
      email,
      handle,
      displayName: String(displayName || handle).slice(0, 40),
      avatarSeed: crypto.randomBytes(4).toString('hex'),
      tier: 'standard',
      salt,
      hash: hash(password, salt),
      createdAt: Date.now(),
      lastLogin: Date.now()
    };
    users.push(user);
    this.store.set('users', users);
    return this._startSession(user, true);
  }

  signIn({ identifier, password, remember = true }) {
    const id = String(identifier || '').trim().toLowerCase();
    const users = this.store.get('users');
    const user = users.find((u) => u.email === id || u.handle.toLowerCase() === id);

    // Always burn the same work whether or not the account exists, so timing
    // can't be used to enumerate registered emails.
    const salt = user ? user.salt : 'decoy-salt-value';
    const attempt = hash(String(password || ''), salt);
    if (!user || !constantTimeEqual(attempt, user.hash))
      return { ok: false, error: 'Incorrect credentials. Check your email/handle and password.' };

    user.lastLogin = Date.now();
    this.store.set('users', users);
    return this._startSession(user, remember);
  }

  /** Lets someone into the library without a round trip to an account server. */
  signInOffline() {
    const user = {
      id: 'offline',
      handle: 'OfflinePlayer',
      email: '',
      displayName: 'Offline Player',
      avatarSeed: 'offline',
      tier: 'standard',
      createdAt: Date.now(),
      lastLogin: Date.now(),
      offline: true
    };
    this.store.set('session', {
      token: crypto.randomBytes(24).toString('hex'),
      userId: 'offline',
      offline: true,
      expiresAt: Date.now() + 86400000
    });
    return { ok: true, user: publicUser(user) };
  }

  _startSession(user, remember) {
    this.store.set('session', {
      token: crypto.randomBytes(24).toString('hex'),
      userId: user.id,
      remember: !!remember,
      expiresAt: Date.now() + SESSION_TTL_DAYS * 86400000
    });
    return { ok: true, user: publicUser(user) };
  }

  session() {
    const s = this.store.get('session');
    if (!s || s.expiresAt < Date.now()) return { ok: false };
    if (s.offline) return this.signInOffline();
    if (!s.remember) return { ok: false };
    const user = this.store.get('users').find((u) => u.id === s.userId);
    return user ? { ok: true, user: publicUser(user) } : { ok: false };
  }

  signOut() {
    this.store.set('session', null);
    return { ok: true };
  }

  updateProfile(userId, patch = {}) {
    const users = this.store.get('users');
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, error: 'Account not found.' };
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName).slice(0, 40);
    if (patch.avatarSeed !== undefined) user.avatarSeed = String(patch.avatarSeed).slice(0, 32);
    if (patch.tier !== undefined && ['standard', 'plus'].includes(patch.tier)) user.tier = patch.tier;
    this.store.set('users', users);
    return { ok: true, user: publicUser(user) };
  }

  changePassword(userId, { current, next }) {
    const users = this.store.get('users');
    const user = users.find((u) => u.id === userId);
    if (!user) return { ok: false, error: 'Account not found.' };
    if (!constantTimeEqual(hash(String(current || ''), user.salt), user.hash))
      return { ok: false, error: 'Current password is incorrect.' };
    if (this.passwordStrength(next) < 3)
      return { ok: false, error: 'New password is too weak.' };
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = hash(next, user.salt);
    this.store.set('users', users);
    return { ok: true };
  }

  accountCount() {
    return this.store.get('users').length;
  }
}

module.exports = { Auth };
