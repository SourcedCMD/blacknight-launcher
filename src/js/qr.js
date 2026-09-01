/* =========================================================================
   QR encoding.

   Byte mode, error correction level M, versions 1 to 10 - which covers a URL
   of roughly 270 characters, comfortably more than a handoff link needs.

   Written out rather than pulled in because the renderer has no dependencies
   by design, and a QR encoder is a known, finite algorithm: Reed-Solomon over
   GF(256), a fixed set of layout rules, and eight mask patterns scored against
   published penalties.
   ========================================================================= */
(function () {
  'use strict';
  const BN = (window.BN = window.BN || {});

  /* --- GF(256) ----------------------------------------------------------- */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      // The QR generator polynomial: x^8 + x^4 + x^3 + x^2 + 1.
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  /** Generator polynomial for `degree` error-correction codewords. */
  function generator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecCodewords(data, count) {
    const gen = generator(count);
    const result = new Array(count).fill(0);
    for (const byte of data) {
      const factor = byte ^ result[0];
      result.shift();
      result.push(0);
      for (let i = 0; i < count; i++) result[i] ^= mul(gen[i + 1], factor);
    }
    return result;
  }

  /* --- Version tables (level M) ------------------------------------------ */

  // [total codewords, ec codewords per block, group1 blocks, group2 blocks]
  const VERSIONS = [
    null,
    [26, 10, 1, 0], [44, 16, 1, 0], [70, 26, 1, 0], [100, 18, 2, 0],
    [134, 24, 2, 0], [172, 16, 4, 0], [196, 18, 4, 0], [242, 22, 2, 2],
    [292, 22, 3, 2], [346, 26, 4, 1]
  ];

  const ALIGNMENT = [
    [], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
  ];

  /** Smallest version that fits `length` bytes at level M. */
  function pickVersion(length) {
    for (let v = 1; v <= 10; v++) {
      const [total, ecPer, g1, g2] = VERSIONS[v];
      const dataCodewords = total - ecPer * (g1 + g2);
      // 4 bits mode + 8 or 16 bits length + the payload itself.
      const header = 4 + (v < 10 ? 8 : 16);
      if (dataCodewords * 8 >= header + length * 8) return v;
    }
    return null;
  }

  /* --- Bit stream --------------------------------------------------------- */

  function buildData(bytes, version) {
    const [total, ecPer, g1, g2] = VERSIONS[version];
    const blocks = g1 + g2;
    const dataCodewords = total - ecPer * blocks;

    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    for (const byte of bytes) push(byte, 8);

    // Terminator, then pad to a byte boundary.
    for (let i = 0; i < 4 && bits.length < dataCodewords * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      codewords.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    }
    // The spec's alternating pad bytes.
    const PADS = [0xec, 0x11];
    for (let i = 0; codewords.length < dataCodewords; i++) codewords.push(PADS[i % 2]);

    // Split into blocks, compute EC for each, then interleave both.
    const shortLen = Math.floor(dataCodewords / blocks);
    const dataBlocks = [];
    const ecBlocks = [];
    let at = 0;
    for (let b = 0; b < blocks; b++) {
      const len = b < g1 ? shortLen : shortLen + 1;
      const block = codewords.slice(at, at + len);
      at += len;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, ecPer));
    }

    const out = [];
    const longest = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < longest; i++) {
      for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
    }
    for (let i = 0; i < ecPer; i++) {
      for (const block of ecBlocks) out.push(block[i]);
    }
    return out;
  }

  /* --- Matrix ------------------------------------------------------------- */

  function place(version, codewords) {
    const size = version * 4 + 17;
    const grid = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const finder = (row, col) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = row + r;
          const cc = col + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const edge = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          grid[rr][cc] = edge || core ? 1 : 0;
          reserved[rr][cc] = true;
        }
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    // Timing patterns.
    for (let i = 8; i < size - 8; i++) {
      grid[6][i] = grid[i][6] = i % 2 === 0 ? 1 : 0;
      reserved[6][i] = reserved[i][6] = true;
    }

    // Alignment patterns, skipping the finder corners.
    const centres = ALIGNMENT[version];
    for (const r of centres) {
      for (const c of centres) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const ring = Math.max(Math.abs(dr), Math.abs(dc));
            grid[r + dr][c + dc] = ring === 1 ? 0 : 1;
            reserved[r + dr][c + dc] = true;
          }
        }
      }
    }

    // Format information areas, plus the one always-dark module.
    for (let i = 0; i < 9; i++) {
      if (!reserved[8][i]) { reserved[8][i] = true; grid[8][i] = 0; }
      if (!reserved[i][8]) { reserved[i][8] = true; grid[i][8] = 0; }
    }
    for (let i = 0; i < 8; i++) {
      reserved[8][size - 1 - i] = true;
      grid[8][size - 1 - i] = 0;
      reserved[size - 1 - i][8] = true;
      grid[size - 1 - i][8] = 0;
    }
    grid[size - 8][8] = 1;
    reserved[size - 8][8] = true;

    // Zig-zag placement, right to left, skipping the vertical timing column.
    const bits = [];
    for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1);

    let bit = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (const c of [col, col - 1]) {
          if (reserved[row][c]) continue;
          grid[row][c] = bit < bits.length ? bits[bit++] : 0;
        }
      }
      upward = !upward;
    }

    return { grid, reserved, size };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  /** The published penalty rules, used to pick the least-bad mask. */
  function score(grid, size) {
    let penalty = 0;

    const runs = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          if (get(a, b) === get(a, b - 1)) run++;
          else {
            if (run >= 5) penalty += 3 + (run - 5);
            run = 1;
          }
        }
        if (run >= 5) penalty += 3 + (run - 5);
      }
    };
    runs((a, b) => grid[a][b]);
    runs((a, b) => grid[b][a]);

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) penalty += 3;
      }
    }

    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += grid[r][c];
    const ratio = (dark * 100) / (size * size);
    penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;

    return penalty;
  }

  // Level M format bits, already masked, indexed by mask pattern.
  const FORMAT = [
    0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0
  ];

  function applyFormat(grid, size, mask) {
    const bits = FORMAT[mask];
    for (let i = 0; i < 15; i++) {
      const bit = (bits >> i) & 1;
      // Around the top-left finder.
      if (i < 6) grid[8][i] = bit;
      else if (i < 8) grid[8][i + 1] = bit;
      else if (i === 8) grid[7][8] = bit;
      else grid[14 - i][8] = bit;

      // The duplicate copy: seven modules up the left edge, then eight along
      // the top right. Taking eight up the edge would land on the always-dark
      // module at (size - 8, 8) and overwrite it.
      if (i < 7) grid[size - 1 - i][8] = bit;
      else grid[8][size - 15 + i] = bit;
    }
  }

  /**
   * Encodes `text` and returns { size, grid } where grid[r][c] is 0 or 1.
   * Returns null when the text is too long for version 10 at level M.
   */
  function encode(text) {
    const bytes = [...new TextEncoder().encode(String(text))];
    const version = pickVersion(bytes.length);
    if (!version) return null;

    const codewords = buildData(bytes, version);
    const { grid, reserved, size } = place(version, codewords);

    let best = null;
    for (let m = 0; m < 8; m++) {
      const candidate = grid.map((row) => row.slice());
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!reserved[r][c] && MASKS[m](r, c)) candidate[r][c] ^= 1;
        }
      }
      applyFormat(candidate, size, m);
      const penalty = score(candidate, size);
      if (!best || penalty < best.penalty) best = { penalty, grid: candidate };
    }

    return { size, grid: best.grid, version };
  }

  /** Renders an encoded matrix as inline SVG. */
  function svg(text, { size = 220, quiet = 4, dark = '#05050a', light = '#ffffff' } = {}) {
    const code = encode(text);
    if (!code) return '';
    const span = code.size + quiet * 2;

    // One path for every dark module beats thousands of rects.
    let d = '';
    for (let r = 0; r < code.size; r++) {
      for (let c = 0; c < code.size; c++) {
        if (code.grid[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }

    return `<svg viewBox="0 0 ${span} ${span}" width="${size}" height="${size}"
      xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" role="img"
      aria-label="QR code">
      <rect width="${span}" height="${span}" fill="${light}"/>
      <path d="${d}" fill="${dark}"/>
    </svg>`;
  }

  // The Reed-Solomon and version helpers are exposed so the test suite can
  // check them against an independent implementation. A QR that renders but
  // does not decode looks exactly like one that works.
  BN.qr = { encode, svg, _internals: { ecCodewords, generator, pickVersion, buildData } };
})();
