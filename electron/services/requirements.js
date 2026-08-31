'use strict';
/**
 * Compares a catalog entry's system requirements against real hardware.
 *
 * Pure functions with no electron import, so the whole thing is unit tested.
 *
 * Memory, storage and OS version are measurable, so those get a real verdict.
 * CPU and GPU are free-text model names ("Intel i5-8400 / Ryzen 5 2600"), and
 * ranking those properly needs a benchmark database this launcher has no
 * business shipping. Instead they are scored with a coarse family/generation
 * tier that covers the hardware people actually own, and anything that fails
 * to parse reports `unknown` rather than guessing. A confident wrong answer
 * about whether a 90 GB game will run is worse than an honest "compare these
 * yourself".
 */

const GB = 1024 * 1024 * 1024;

/* --- Parsing ----------------------------------------------------------- */

/** "12 GB" / "16GB" / "8 GB RAM" -> bytes. */
function parseBytes(text) {
  const match = String(text || '').match(/(\d+(?:\.\d+)?)\s*(TB|GB|MB)/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  return unit === 'TB' ? value * 1024 * GB : unit === 'GB' ? value * GB : value * 1024 * 1024;
}

/** "Windows 10 64-bit" -> 10. */
function parseWindowsVersion(text) {
  const match = String(text || '').match(/windows\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

/* --- Coarse hardware tiers --------------------------------------------- */

/**
 * Rough GPU ranking. The number is only ever compared against another number
 * produced by this same function, so the scale is arbitrary - it just has to
 * be monotonic within and across families.
 */
function gpuTier(text) {
  const s = String(text || '').toLowerCase();

  // NVIDIA GeForce: GTX 1660, RTX 3060 Ti, RTX 4070 Super, ...
  let m = s.match(/\b(?:gtx|rtx)\s*(\d{3,4})\s*(ti|super)?/);
  if (m) {
    const model = Number(m[1]);
    const series = model >= 1000 ? Math.floor(model / 1000) : 7; // 900-series and older
    const rank = model % 1000;
    // rank/10 puts one model step (1050 -> 1060) exactly 1 apart, so the
    // suffix bonus has to stay well under that: a 1050 Ti is quicker than a
    // plain 1050 but nowhere near a 1060.
    let tier = series * 100 + rank / 10;
    if (m[2] === 'ti') tier += 0.5;
    if (m[2] === 'super') tier += 0.3;
    return tier;
  }

  // AMD Radeon: RX 6700 XT, RX 7900 XTX, ...
  m = s.match(/\brx\s*(\d{3,4})\s*(xtx|xt)?/);
  if (m) {
    const model = Number(m[1]);
    const series = model >= 1000 ? Math.floor(model / 1000) : 5;
    const rank = model % 1000;
    let tier = series * 100 + rank / 10;
    if (m[2] === 'xtx') tier += 0.8;
    if (m[2] === 'xt') tier += 0.5;
    return tier;
  }

  // Intel Arc: A770, B580
  m = s.match(/\barc\s*([ab])(\d{3})/);
  if (m) return (m[1] === 'b' ? 350 : 300) + Number(m[2]) / 10;

  return null;
}

/**
 * Rough CPU ranking from family and generation.
 * "Intel i7-12700K" -> class 7, gen 12.  "Ryzen 5 5800X3D" -> class 5, gen 5.
 */
function cpuTier(text) {
  const s = String(text || '').toLowerCase();

  let m = s.match(/\bi([3579])[\s-]*(\d{4,5})/);
  if (m) {
    const cls = Number(m[1]);
    const digits = m[2];
    const gen = digits.length === 5 ? Number(digits.slice(0, 2)) : Number(digits.slice(0, 1));
    return gen * 10 + cls;
  }

  m = s.match(/\bryzen\s*([3579])\s*(\d{4})/);
  if (m) {
    const cls = Number(m[1]);
    const gen = Number(m[2].slice(0, 1));
    // Ryzen model families run a generation ahead of their Intel counterparts
    // numerically (5000-series competes with 11th/12th gen Core).
    return (gen + 6) * 10 + cls;
  }

  return null;
}

/* --- Comparison --------------------------------------------------------- */

const ORDER = { below: 0, unknown: 1, ok: 2 };

/** Splits "Intel i5-8400 / Ryzen 5 2600" and keeps whichever side ranks best. */
function bestTier(text, tierFn) {
  const parts = String(text || '').split('/');
  let best = null;
  for (const part of parts) {
    const tier = tierFn(part);
    if (tier !== null && (best === null || tier > best)) best = tier;
  }
  return best;
}

function compareTier(need, have, tierFn) {
  const needTier = bestTier(need, tierFn);
  const haveTier = bestTier(have, tierFn);
  if (needTier === null || haveTier === null) return 'unknown';
  return haveTier >= needTier ? 'ok' : 'below';
}

/**
 * Checks one requirement tier (minimum or recommended) against a machine.
 *
 * `machine` is what hardware.js probes:
 *   { os, cpu, gpu, ramBytes, freeBytes }
 *
 * Returns { verdict, rows } where verdict is the worst row status.
 */
function checkTier(spec, machine) {
  if (!spec) return { verdict: 'unknown', rows: [] };
  const rows = [];

  const add = (key, label, need, have, status) => rows.push({ key, label, need, have, status });

  /* Memory ------------------------------------------------------------- */
  const needRam = parseBytes(spec.ram);
  if (needRam && machine.ramBytes) {
    // Reported RAM is always a little under the sticker figure, so a 16 GB
    // machine must still satisfy a "16 GB" requirement.
    add('ram', 'Memory', spec.ram, formatBytes(machine.ramBytes),
      machine.ramBytes >= needRam * 0.95 ? 'ok' : 'below');
  } else {
    add('ram', 'Memory', spec.ram || '-', machine.ramBytes ? formatBytes(machine.ramBytes) : 'Unknown', 'unknown');
  }

  /* Storage ------------------------------------------------------------- */
  const needDisk = parseBytes(spec.storage);
  if (needDisk && machine.freeBytes != null) {
    add('storage', 'Storage', spec.storage, `${formatBytes(machine.freeBytes)} free`,
      machine.freeBytes >= needDisk ? 'ok' : 'below');
  } else {
    add('storage', 'Storage', spec.storage || '-', 'Unknown', 'unknown');
  }

  /* Operating system ---------------------------------------------------- */
  const needOs = parseWindowsVersion(spec.os);
  const haveOs = parseWindowsVersion(machine.os);
  if (needOs && haveOs) {
    add('os', 'Operating system', spec.os, machine.os, haveOs >= needOs ? 'ok' : 'below');
  } else {
    add('os', 'Operating system', spec.os || '-', machine.os || 'Unknown', 'unknown');
  }

  /* Processor and graphics ---------------------------------------------- */
  add('cpu', 'Processor', spec.cpu || '-', machine.cpu || 'Unknown', compareTier(spec.cpu, machine.cpu, cpuTier));
  add('gpu', 'Graphics', spec.gpu || '-', machine.gpu || 'Unknown', compareTier(spec.gpu, machine.gpu, gpuTier));

  const verdict = rows.reduce((worst, row) => (ORDER[row.status] < ORDER[worst] ? row.status : worst), 'ok');
  return { verdict, rows };
}

/**
 * Full check against both tiers.
 *
 * `level` is the headline answer:
 *   recommended - clears the recommended spec
 *   minimum     - clears minimum but not recommended
 *   below       - fails minimum on something measurable
 *   unknown     - not enough was measurable to say
 */
function check(requirements, machine) {
  if (!requirements || !machine) return { level: 'unknown', minimum: null, recommended: null };

  const minimum = checkTier(requirements.minimum, machine);
  const recommended = checkTier(requirements.recommended, machine);

  let level;
  if (minimum.verdict === 'below') level = 'below';
  else if (recommended.verdict === 'ok') level = 'recommended';
  else if (minimum.verdict === 'ok') level = 'minimum';
  else level = 'unknown';

  return { level, minimum, recommended };
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return 'Unknown';
  const gb = bytes / GB;
  return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

module.exports = { check, checkTier, gpuTier, cpuTier, parseBytes, parseWindowsVersion, formatBytes };
