'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Tiny atomic JSON store. Every document lives in its own file under the
 * launcher's data directory so a corrupt write can never take out unrelated
 * state (accounts surviving a bad settings write, for example).
 */
class Store {
  constructor(dir, name, defaults = {}) {
    this.file = path.join(dir, `${name}.json`);
    this.defaults = defaults;
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
    return this.data;
  }

  get(key, fallback) {
    return key === undefined ? this.data : (this.data[key] ?? fallback);
  }

  set(key, value) {
    if (typeof key === 'object') Object.assign(this.data, key);
    else this.data[key] = value;
    return this.save();
  }

  /** A copy of everything, safe to hand out or serialise. */
  all() {
    return structuredClone(this.data);
  }

  reset() {
    this.data = structuredClone(this.defaults);
    return this.save();
  }
}

module.exports = { Store };
