/* =========================================================================
   Renderer diagnostics.

   Loaded second, straight after util.js, so it is watching before any view
   code runs. Until the IPC bridge exists, reports queue in memory and flush
   once it does - an error thrown while the launcher is still wiring itself up
   is exactly the one worth keeping.

   A silent renderer exception used to leave a half-drawn view and no record of
   why. Now it reaches the log file, and the user is told something went wrong
   rather than being left staring at a launcher that stopped responding.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  const queue = [];
  let flushing = false;

  /** Errors do not survive structuredClone, so they cross IPC as plain data. */
  function describe(error) {
    if (!error) return null;
    if (error instanceof Error) {
      return { name: error.name, message: error.message, stack: error.stack };
    }
    if (typeof error === 'object') {
      try {
        return JSON.parse(JSON.stringify(error));
      } catch {
        return { message: String(error) };
      }
    }
    return { message: String(error) };
  }

  function flush() {
    if (flushing || !BN.api?.log?.write) return;
    flushing = true;
    while (queue.length) {
      const entry = queue.shift();
      try {
        BN.api.log.write(entry.level, entry.scope, entry.message, entry.detail);
      } catch {
        /* if logging itself is broken there is nowhere left to report it */
      }
    }
    flushing = false;
  }

  function record(level, scope, message, detail) {
    queue.push({ level, scope, message, detail: describe(detail) });
    flush();
  }

  const log = {
    debug: (scope, message, detail) => record('debug', scope, message, detail),
    info: (scope, message, detail) => record('info', scope, message, detail),
    warn: (scope, message, detail) => record('warn', scope, message, detail),
    error: (scope, message, detail) => record('error', scope, message, detail)
  };

  /* --------------------------------------------------------------------- */
  /* Surfacing                                                              */

  // One toast per problem, not one per repetition: a failure inside a render
  // loop would otherwise bury the screen in identical notices.
  const seen = new Set();

  function surface(message) {
    if (seen.has(message)) return;
    seen.add(message);
    setTimeout(() => seen.delete(message), 30000);

    // The UI layer may not exist yet, or may itself be what broke.
    try {
      BN.ui?.toast?.('Something went wrong', 'The details were written to the launcher log.', {
        kind: 'error',
        ms: 7000,
        action: BN.api?.log?.open ? { label: 'Open logs', onClick: () => BN.api.log.open() } : null
      });
    } catch {
      /* nothing further to try */
    }
  }

  window.addEventListener('error', (event) => {
    // Failed <img>/<script> loads arrive here too, without an error object.
    if (!event.error && event.target !== window) {
      log.warn('renderer', `Failed to load ${event.target?.src || event.target?.href || 'a resource'}`);
      return;
    }
    log.error('renderer', event.message || 'Uncaught error', event.error);
    surface(event.message || 'error');
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    log.error('renderer', `Unhandled rejection: ${reason?.message || reason}`, reason);
    surface(reason?.message || String(reason));
  });

  BN.log = log;
  BN.diagnostics = { flush, describe };

  // The bridge lands a moment later; flush whatever was caught before it.
  document.addEventListener('DOMContentLoaded', flush);
  setTimeout(flush, 0);
})();
