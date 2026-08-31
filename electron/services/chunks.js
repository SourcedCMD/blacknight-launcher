'use strict';
const fs = require('fs');
const crypto = require('crypto');

/**
 * Block-level delta patching.
 *
 * A game update usually changes a fraction of its data, but a plain download
 * transfers all of it. This splits a build into fixed-size chunks, hashes each
 * one, and lets an update work out which blocks it already has on disk.
 *
 * The saving comes from two places:
 *   - blocks the old build already holds at the same offset (the common case)
 *   - blocks it holds at a *different* offset, which still only need a local
 *     copy rather than a transfer
 *
 * Fixed-size chunking cannot follow an insertion that shifts everything after
 * it - that needs a rolling hash, which costs far more to compute and is not
 * worth it for game data, where builds are rebuilt rather than edited in place.
 *
 * Pure functions over files and plain objects, so it is all unit tested.
 */

const DEFAULT_CHUNK = 4 * 1024 * 1024;

/** Hash of one chunk. Truncated: 128 bits is ample to key a block index. */
const hashChunk = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32);

/**
 * Splits a file into chunk hashes.
 *
 * The whole-file digest is carried alongside so a patched result can be
 * checked against the same value a fresh download would be.
 */
function buildManifest(file, { chunkSize = DEFAULT_CHUNK } = {}) {
  const stat = fs.statSync(file);
  const whole = crypto.createHash('sha256');
  const chunks = [];

  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(chunkSize);
    let read;
    while ((read = fs.readSync(fd, buffer, 0, chunkSize, null)) > 0) {
      const slice = buffer.subarray(0, read);
      whole.update(slice);
      chunks.push(hashChunk(slice));
    }
  } finally {
    fs.closeSync(fd);
  }

  return { chunkSize, totalBytes: stat.size, sha256: whole.digest('hex'), chunks };
}

/**
 * Works out how to build `next` from what `current` already holds.
 *
 * Returns a plan of operations in output order:
 *   { type: 'copy',  from, offset, length }  - lift a block off the old file
 *   { type: 'fetch', index, offset, length } - ask the network for it
 *
 * `from` is the byte offset in the old file, `offset` the offset in the new
 * one, so applying the plan is a straight walk from start to finish.
 */
function diff(current, next) {
  if (!current || !next || current.chunkSize !== next.chunkSize) {
    return fullFetch(next);
  }

  // Every offset each block already lives at, so a block that merely moved is
  // still a local copy rather than a download.
  const index = new Map();
  current.chunks.forEach((hash, i) => {
    if (!index.has(hash)) index.set(hash, i);
  });

  const size = next.chunkSize;
  const plan = [];
  let reusedBytes = 0;
  let fetchedBytes = 0;

  next.chunks.forEach((hash, i) => {
    const offset = i * size;
    // The final chunk of either build may be short.
    const length = Math.min(size, next.totalBytes - offset);
    const found = index.get(hash);

    if (found === undefined) {
      plan.push({ type: 'fetch', index: i, offset, length });
      fetchedBytes += length;
    } else {
      plan.push({ type: 'copy', from: found * size, offset, length });
      reusedBytes += length;
    }
  });

  return { plan, reusedBytes, fetchedBytes, totalBytes: next.totalBytes };
}

function fullFetch(next) {
  if (!next) return { plan: [], reusedBytes: 0, fetchedBytes: 0, totalBytes: 0 };
  const size = next.chunkSize;
  const plan = next.chunks.map((_hash, i) => {
    const offset = i * size;
    return { type: 'fetch', index: i, offset, length: Math.min(size, next.totalBytes - offset) };
  });
  return { plan, reusedBytes: 0, fetchedBytes: next.totalBytes, totalBytes: next.totalBytes };
}

/**
 * Merges neighbouring fetches into single ranges.
 *
 * Twenty adjacent 4 MB blocks are one 80 MB request, not twenty - HTTP range
 * requests have real per-request cost and servers dislike being machine-gunned.
 */
function fetchRanges(plan) {
  const ranges = [];
  for (const op of plan) {
    if (op.type !== 'fetch') continue;
    const last = ranges[ranges.length - 1];
    if (last && last.offset + last.length === op.offset) {
      last.length += op.length;
    } else {
      ranges.push({ offset: op.offset, length: op.length });
    }
  }
  return ranges;
}

/**
 * Writes the parts of the plan that can be taken from the old file.
 *
 * `fetch` blocks are left as holes for the download engine to fill, so this
 * can run before a single byte has been transferred and the user sees the
 * reused portion counted as progress immediately.
 */
function applyCopies(sourceFile, targetFile, plan) {
  const source = fs.openSync(sourceFile, 'r');
  const target = fs.openSync(targetFile, fs.existsSync(targetFile) ? 'r+' : 'w+');
  let copied = 0;

  try {
    for (const op of plan) {
      if (op.type !== 'copy') continue;
      const buffer = Buffer.alloc(op.length);
      const read = fs.readSync(source, buffer, 0, op.length, op.from);
      if (read !== op.length) continue; // truncated old file: let it be fetched
      fs.writeSync(target, buffer, 0, read, op.offset);
      copied += read;
    }
    // The result has to be exactly the right length even if it ends in a hole.
    fs.ftruncateSync(target, plan.length ? plan[plan.length - 1].offset + plan[plan.length - 1].length : 0);
  } finally {
    fs.closeSync(source);
    fs.closeSync(target);
  }

  return copied;
}

/** How much a delta saves, for the line the UI shows before committing. */
function summarise(result) {
  const total = result.totalBytes || 1;
  return {
    ...result,
    savedFraction: result.reusedBytes / total,
    savedPercent: Math.round((result.reusedBytes / total) * 100)
  };
}

module.exports = { buildManifest, diff, fetchRanges, applyCopies, summarise, hashChunk, DEFAULT_CHUNK };
