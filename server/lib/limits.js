'use strict';

/**
 * Rate limiting, and lockout after repeated failures.
 *
 * Two separate problems that look like one.
 *
 * The first is guessing: somebody works through a password list against one
 * account. The answer is a per-account failure counter with a growing delay,
 * so the tenth attempt costs minutes rather than milliseconds.
 *
 * The second is cost. Sign-in hashes with scrypt at N=16384, which is
 * deliberately expensive — that is the entire point of the parameter. It also
 * means an unauthenticated caller can spend a large amount of this server's
 * CPU per request. Without a per-address ceiling, the login endpoint is a
 * denial of service with a friendly name.
 *
 * Both counters live in memory. A restart forgets them, which is the right
 * trade for a single process: persisting lockout state invites its own bugs,
 * and an attacker cannot restart the server.
 */

const MINUTE = 60000;

/** Sliding window: how many requests an address may make, and over how long. */
const WINDOWS = {
  // Expensive because of scrypt, so this is the tight one.
  login: { limit: 10, windowMs: 5 * MINUTE },
  register: { limit: 5, windowMs: 15 * MINUTE },
  reset: { limit: 5, windowMs: 15 * MINUTE },
  // Cheap, but a crash loop should not be able to fill the disk either.
  crash: { limit: 60, windowMs: MINUTE },
  default: { limit: 120, windowMs: MINUTE }
};

/**
 * How long an account is locked after n consecutive failures.
 *
 * Nothing for the first few, because people mistype. Then it climbs fast
 * enough that an online guessing attack stops being viable, and caps so a
 * locked-out account is not locked out forever by somebody else's attempts.
 */
function lockoutMs(failures) {
  if (failures < 5) return 0;
  if (failures < 8) return 1 * MINUTE;
  if (failures < 12) return 5 * MINUTE;
  return 15 * MINUTE;
}

class Limits {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.hits = new Map();    // key -> [timestamps]
    this.failures = new Map(); // identifier -> { count, until }
  }

  /**
   * Records a request and says whether it is allowed.
   *
   * The window slides: old timestamps are dropped rather than the whole
   * counter being reset on a boundary, so an attacker cannot line up bursts
   * either side of a reset.
   */
  take(bucket, key) {
    const rule = WINDOWS[bucket] || WINDOWS.default;
    const at = this.now();
    const id = `${bucket}:${key}`;

    const recent = (this.hits.get(id) || []).filter((t) => at - t < rule.windowMs);
    if (recent.length >= rule.limit) {
      this.hits.set(id, recent);
      const retryAfter = Math.ceil((rule.windowMs - (at - recent[0])) / 1000);
      return { ok: false, retryAfter: Math.max(1, retryAfter) };
    }

    recent.push(at);
    this.hits.set(id, recent);
    return { ok: true, remaining: rule.limit - recent.length };
  }

  /** Whether this account is currently locked, and for how much longer. */
  locked(identifier) {
    const record = this.failures.get(String(identifier || '').toLowerCase());
    if (!record || record.until <= this.now()) return null;
    return { retryAfter: Math.ceil((record.until - this.now()) / 1000) };
  }

  /** Called on a failed sign-in. */
  fail(identifier) {
    const key = String(identifier || '').toLowerCase();
    const record = this.failures.get(key) || { count: 0, until: 0 };
    record.count++;
    const wait = lockoutMs(record.count);
    if (wait) record.until = this.now() + wait;
    this.failures.set(key, record);
    return record;
  }

  /** Called on a successful sign-in: the slate is wiped. */
  succeed(identifier) {
    this.failures.delete(String(identifier || '').toLowerCase());
  }

  /**
   * Drops counters nobody is using any more.
   *
   * Without this, every address that ever made a request would be remembered
   * for the life of the process — a slow leak that is also a list of who has
   * been here.
   */
  sweep() {
    const at = this.now();
    const longest = Math.max(...Object.values(WINDOWS).map((w) => w.windowMs));

    for (const [id, times] of this.hits) {
      const recent = times.filter((t) => at - t < longest);
      if (recent.length) this.hits.set(id, recent);
      else this.hits.delete(id);
    }

    for (const [id, record] of this.failures) {
      // Keep a lockout while it is live, and a count only while it could still
      // escalate; an hour of quiet means they were probably just typing badly.
      if (record.until <= at && at - record.until > 60 * MINUTE) this.failures.delete(id);
    }
  }

  /** For the tests, and for a health endpoint. */
  size() {
    return { hits: this.hits.size, failures: this.failures.size };
  }
}

module.exports = { Limits, WINDOWS, lockoutMs };
