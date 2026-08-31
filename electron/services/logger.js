'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Rolling log file, so "it won't start" is a report you can actually act on.
 *
 * Everything lands in one file under the launcher's data directory. It rolls
 * at a size cap and keeps a single previous copy - enough to cover the run
 * that broke plus the one before it, without quietly growing forever on
 * someone's drive.
 *
 * Writes are append-only and synchronous. A logger that loses the last few
 * lines is useless precisely when it matters, and these are short lines
 * written rarely.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor(dir, { level = 'info', includeSystemInfo = true } = {}) {
    this.dir = path.join(dir, 'logs');
    this.file = path.join(this.dir, 'launcher.log');
    this.previous = path.join(this.dir, 'launcher.previous.log');
    this.level = LEVELS[level] || LEVELS.info;
    this.includeSystemInfo = includeSystemInfo;

    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch {
      /* logging must never be the reason the launcher fails to start */
    }
  }

  /** Written once per run so every report carries its own context. */
  header(app) {
    const lines = [
      '',
      '='.repeat(72),
      `BlackNight Launcher ${app.getVersion()} started ${new Date().toISOString()}`
    ];

    // Machine details are diagnostics, so they follow the same switch the user
    // sees in Settings rather than being written regardless.
    if (this.includeSystemInfo) {
      lines.push(
        `  platform   ${process.platform} ${process.arch} (${os.release()})`,
        `  electron   ${process.versions.electron}  chrome ${process.versions.chrome}  node ${process.versions.node}`,
        `  cpu        ${os.cpus()[0]?.model?.trim() || 'unknown'} x${os.cpus().length}`,
        `  memory     ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
        `  packaged   ${app.isPackaged}`
      );
    }

    lines.push('='.repeat(72));
    this._write(lines.join('\n') + '\n');
  }

  _roll() {
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size < MAX_BYTES) return;
      fs.rmSync(this.previous, { force: true });
      fs.renameSync(this.file, this.previous);
    } catch {
      /* a failed roll must not take the process with it */
    }
  }

  _write(text) {
    try {
      this._roll();
      fs.appendFileSync(this.file, text);
    } catch {
      /* disk full, permissions, a removed folder - never fatal */
    }
  }

  log(level, scope, message, detail) {
    if ((LEVELS[level] || 0) < this.level) return;
    const stamp = new Date().toISOString();
    let line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}\n`;
    if (detail) {
      const body = typeof detail === 'string' ? detail : safeJson(detail);
      line += body.replace(/^/gm, '    ') + '\n';
    }
    this._write(line);
    // Mirrored to stderr so `npm run dev` shows the same stream.
    if (level === 'error' || level === 'warn') process.stderr.write(line);
  }

  debug(scope, message, detail) { this.log('debug', scope, message, detail); }
  info(scope, message, detail) { this.log('info', scope, message, detail); }
  warn(scope, message, detail) { this.log('warn', scope, message, detail); }
  error(scope, message, detail) { this.log('error', scope, message, detail); }

  setIncludeSystemInfo(on) {
    this.includeSystemInfo = !!on;
  }

  /** Where the Settings panel sends the user. */
  location() {
    return { dir: this.dir, file: this.file };
  }
}

/** Errors and cyclic objects both have to survive being logged. */
function safeJson(value) {
  if (value instanceof Error) return `${value.stack || value.message}`;
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (val instanceof Error) return { message: val.message, stack: val.stack };
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[circular]';
          seen.add(val);
        }
        return val;
      },
      2
    );
  } catch {
    return String(value);
  }
}

module.exports = { Logger, safeJson };
