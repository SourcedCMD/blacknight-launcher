/* =========================================================================
   Shared helpers. Everything hangs off the single global `BN` namespace so the
   renderer can run as classic scripts under file:// (ES modules are blocked
   there by Chromium's CORS rules).
   ========================================================================= */
(function () {
  'use strict';

  const BN = (window.BN = window.BN || {});

  /* --- DOM ------------------------------------------------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /** Builds an element from a tag, props and children. */
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === null || value === undefined) continue;
      // ARIA states are strings, not boolean attributes: aria-checked="false"
      // is meaningful, and aria-checked="" is not a valid value at all.
      if (key.startsWith('aria-')) {
        node.setAttribute(key, String(value));
        continue;
      }
      if (value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /** Escapes text destined for an innerHTML template. */
  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const frag = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content;
  };

  /* --- Formatting ------------------------------------------------------ */

  function bytes(n, decimals = 1) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
    const value = n / 1024 ** i;
    return `${value.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
  }

  const speed = (bps) => (bps > 0 ? `${bytes(bps, 1)}/s` : '--');

  function duration(seconds) {
    if (!seconds || seconds < 0) return '--';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  function playtime(seconds) {
    if (!seconds) return 'Never played';
    const h = seconds / 3600;
    if (h < 1) return `${Math.max(1, Math.round(seconds / 60))} minutes played`;
    return `${h.toFixed(1)} hours played`;
  }

  const money = (usd) =>
    usd === 0 ? 'Free' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(usd);

  /** Parses a value as a date, treating bare YYYY-MM-DD as local rather than
   *  UTC - otherwise a release date can display as the previous day. */
  const toDate = (value) =>
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);

  const date = (value) =>
    value ? toDate(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '--';

  function relative(ts) {
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    const mins = Math.round(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date(ts);
  }

  /** Days until a future date, or null once it has passed. */
  function countdown(isoDate) {
    const target = new Date(isoDate + 'T00:00:00').getTime();
    const days = Math.ceil((target - Date.now()) / 86400000);
    return days > 0 ? days : null;
  }

  /* --- Misc ------------------------------------------------------------ */

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function debounce(fn, wait = 180) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function throttle(fn, wait = 60) {
    let last = 0;
    let queued = null;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) {
        last = now;
        fn(...args);
      } else {
        clearTimeout(queued);
        queued = setTimeout(() => {
          last = Date.now();
          fn(...args);
        }, wait - (now - last));
      }
    };
  }

  /** Deterministic PRNG - the same seed always yields the same key art. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const hashString = (str) => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  const initials = (name) =>
    String(name || '?')
      .split(/[\s_-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();

  /** Animates a number in an element from its current value to `to`. */
  function countTo(node, to, { format = (n) => Math.round(n).toLocaleString(), ms = 900 } = {}) {
    const from = Number(node.dataset.value || 0);
    node.dataset.value = to;
    if (document.documentElement.dataset.motion === 'reduced') {
      node.textContent = format(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = clamp((now - start) / ms, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = format(lerp(from, to, eased));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /* --- Tiny event bus -------------------------------------------------- */

  const listeners = new Map();
  const bus = {
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus:${event}]`, err);
        }
      }
    }
  };

  BN.util = {
    $, $$, el, esc, frag,
    bytes, speed, duration, playtime, money, date, relative, countdown,
    clamp, lerp, sleep, debounce, throttle, rng, hashString, initials, countTo,
    bus
  };
})();
