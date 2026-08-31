'use strict';
const { Store } = require('./store');

/**
 * Launcher achievements, earned entirely from local history.
 *
 * These are about how someone uses the launcher, not about what happens inside
 * a game - which is the only kind that can be honest without a server or engine
 * integration. Every rule reads data already recorded: the play journal, the
 * library, and the session insights.
 *
 * Each definition is a pure predicate over a snapshot, so the whole set is unit
 * tested and adding one is a single object.
 */

const DEFS = [
  {
    id: 'first-night',
    name: 'First Night',
    description: 'Finish your first session.',
    test: (s) => s.sessions >= 1
  },
  {
    id: 'regular',
    name: 'Regular',
    description: 'Play on ten separate days.',
    test: (s) => s.distinctDays >= 10
  },
  {
    id: 'after-dark',
    name: 'After Dark',
    description: 'Finish ten sessions between midnight and five.',
    test: (s) => s.smallHourSessions >= 10
  },
  {
    id: 'long-haul',
    name: 'Long Haul',
    description: 'Play for six hours in one sitting.',
    test: (s) => s.longestSeconds >= 6 * 3600
  },
  {
    id: 'the-slate',
    name: 'The Slate',
    description: 'Own five BlackNight titles.',
    test: (s) => s.owned >= 5
  },
  {
    id: 'completionist',
    name: 'Completionist',
    description: 'Install every released title.',
    test: (s) => s.released > 0 && s.installedReleased >= s.released
  },
  {
    id: 'archivist',
    name: 'Archivist',
    description: 'Write a note on twenty journal entries.',
    test: (s) => s.notes >= 20
  },
  {
    id: 'early-bird',
    name: 'Early Bird',
    description: 'Pre-load a title before its release date.',
    test: (s) => s.preloaded >= 1
  },
  {
    id: 'good-neighbour',
    name: 'Good Neighbour',
    description: 'Share an install with another machine on your network.',
    test: (s) => s.peerBytes > 0
  },
  {
    id: 'centurion',
    name: 'Centurion',
    description: 'Reach a hundred hours across the slate.',
    test: (s) => s.totalSeconds >= 100 * 3600
  }
];

class Achievements {
  constructor(dir, library) {
    this.store = new Store(dir, 'achievements', { earned: {} });
    this.library = library;
  }

  /** Everything the rules read, gathered once. */
  snapshot() {
    const journal = this.library.journal(null, { limit: 2000 });
    const games = this.library.list();
    const entries = Object.values(this.library.store.get('entries'));

    const days = new Set(journal.map((e) => new Date(e.at).toDateString()));
    const usage = this.library.dataUsage({ months: 120 });

    return {
      sessions: journal.length,
      distinctDays: days.size,
      smallHourSessions: journal.filter((e) => {
        const h = new Date(e.at).getHours();
        return h >= 0 && h < 5;
      }).length,
      longestSeconds: journal.reduce((max, e) => Math.max(max, e.seconds || 0), 0),
      totalSeconds: journal.reduce((sum, e) => sum + (e.seconds || 0), 0),
      notes: journal.filter((e) => e.note && e.note.trim()).length,
      owned: games.filter((g) => g.owned).length,
      released: games.filter((g) => g.status === 'released').length,
      installedReleased: games.filter((g) => g.status === 'released' && g.installed).length,
      preloaded: entries.filter((e) => e.status === 'installed' && e.preloaded).length,
      peerBytes: usage.reduce((sum, m) => sum + (m.peer || 0), 0)
    };
  }

  /**
   * Re-evaluates every rule.
   *
   * Returns only what was newly earned, so the caller can announce it without
   * having to diff anything itself. Already-earned entries are never revoked -
   * uninstalling a game should not take an achievement away.
   */
  evaluate() {
    const snapshot = this.snapshot();
    const earned = this.store.get('earned');
    const fresh = [];

    for (const def of DEFS) {
      if (earned[def.id]) continue;
      let passed = false;
      try {
        passed = !!def.test(snapshot);
      } catch {
        passed = false;
      }
      if (passed) {
        earned[def.id] = { at: Date.now() };
        fresh.push({ id: def.id, name: def.name, description: def.description });
      }
    }

    if (fresh.length) this.store.set('earned', earned);
    return fresh;
  }

  /** The full set, earned or not, for the profile view. */
  list() {
    const earned = this.store.get('earned');
    return DEFS.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      earned: !!earned[def.id],
      at: earned[def.id]?.at || null
    }));
  }

  progress() {
    const all = this.list();
    return { earned: all.filter((a) => a.earned).length, total: all.length };
  }
}

module.exports = { Achievements, ACHIEVEMENT_DEFS: DEFS };
