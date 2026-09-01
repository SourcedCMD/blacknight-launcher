'use strict';

/**
 * Splitting a download across every source that has the build.
 *
 * A transfer used to be one connection, one Range header, one source - the
 * origin or a peer, never both. The chunk manifest already says exactly which
 * byte ranges are wanted, so they can be handed out across the origin and every
 * LAN peer at once, which is how torrents and Steam's content system work.
 *
 * The scheduling is the whole problem, and it is a small one stated plainly:
 *
 *   - work is a queue of byte ranges, not a single stream
 *   - each source pulls the next range when it finishes one, so a fast source
 *     naturally does more work than a slow one without measuring anything
 *   - a source that fails is retired, and its outstanding range goes back on
 *     the queue for somebody else
 *   - the origin is never retired, because it is the only source guaranteed to
 *     exist; if everything else dies the transfer degrades to what it was
 *
 * Pure scheduling, no I/O: the planner is a state machine over ranges, so the
 * interesting behaviour is testable without a network.
 */

/** Merges adjacent chunks into ranges of roughly `target` bytes. */
function planRanges(plan, { target = 8 * 1024 * 1024 } = {}) {
  const ranges = [];
  let current = null;

  for (const op of plan) {
    if (op.type !== 'fetch') {
      current = null; // a copied block breaks the run
      continue;
    }
    if (current && current.offset + current.length === op.offset && current.length < target) {
      current.length += op.length;
    } else {
      current = { offset: op.offset, length: op.length };
      ranges.push(current);
    }
  }
  return ranges;
}

class Scheduler {
  /**
   * `sources` is a list of { id, url, kind } - kind 'origin' or 'peer'.
   * The origin must be present, and is the fallback of last resort.
   */
  constructor(ranges, sources) {
    this.pending = [...ranges];
    this.inFlight = new Map(); // sourceId -> range
    this.done = [];
    this.failures = new Map(); // sourceId -> consecutive failures
    this.sources = sources.filter(Boolean);
    this.retired = new Set();
  }

  get origin() {
    return this.sources.find((s) => s.kind === 'origin');
  }

  /** Sources still worth handing work to. */
  active() {
    return this.sources.filter((s) => !this.retired.has(s.id));
  }

  /** True once every range has been written. */
  get complete() {
    return this.pending.length === 0 && this.inFlight.size === 0;
  }

  /** The next range for a source, or null when there is nothing to do. */
  take(sourceId) {
    if (this.retired.has(sourceId)) return null;
    if (this.inFlight.has(sourceId)) return this.inFlight.get(sourceId);
    const range = this.pending.shift();
    if (!range) return null;
    this.inFlight.set(sourceId, range);
    return range;
  }

  /** A range arrived and verified. */
  complete_(sourceId) {
    const range = this.inFlight.get(sourceId);
    if (!range) return;
    this.inFlight.delete(sourceId);
    this.done.push(range);
    this.failures.set(sourceId, 0);
  }

  /**
   * A source failed. Its range goes back on the front of the queue, so the
   * data nobody has yet is the next thing anybody asks for.
   *
   * A peer is retired after two consecutive failures - it has probably gone
   * off the network. The origin is never retired.
   */
  fail(sourceId) {
    const range = this.inFlight.get(sourceId);
    if (range) {
      this.inFlight.delete(sourceId);
      this.pending.unshift(range);
    }

    const count = (this.failures.get(sourceId) || 0) + 1;
    this.failures.set(sourceId, count);

    const source = this.sources.find((s) => s.id === sourceId);
    if (source && source.kind !== 'origin' && count >= 2) this.retired.add(sourceId);

    return { retired: this.retired.has(sourceId), remaining: this.active().length };
  }

  /** Bytes accounted for, for progress that does not jump around. */
  bytesDone() {
    return this.done.reduce((sum, r) => sum + r.length, 0);
  }

  stats() {
    return {
      pending: this.pending.length,
      inFlight: this.inFlight.size,
      done: this.done.length,
      sources: this.active().length,
      retired: [...this.retired]
    };
  }
}

/**
 * Decides how many connections are worth opening.
 *
 * More is not better past a point: every extra connection costs a handshake
 * and competes for the same line. One per source, capped, and never more than
 * there are ranges to fetch.
 */
function connectionCount(sources, rangeCount, { max = 6 } = {}) {
  return Math.max(1, Math.min(sources.length, rangeCount, max));
}

module.exports = { planRanges, Scheduler, connectionCount };
