'use strict';
/**
 * Packs build/icons/icon-<size>.png into the multi-resolution build/icon.ico
 * that electron-builder stamps onto the executable and the NSIS installer.
 *
 * The PNGs are rasterised from the same vector mark the launcher draws at
 * runtime (BN.art.logo), so the taskbar, the tray and the installer all show
 * one brand. Vista and later read PNG-compressed entries directly, so no BMP
 * conversion is needed.
 *
 *   npm run icon
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icons');
const OUT = path.join(ROOT, 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Reads a PNG and confirms its IHDR matches the size we expect. */
function readPng(size) {
  const file = path.join(SRC, `icon-${size}.png`);
  const data = fs.readFileSync(file);
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error(`${file} is not a PNG`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`${file} is ${width}x${height}, expected ${size}x${size}`);
  }
  return data;
}

function build() {
  const images = SIZES.map(readPng);

  const HEADER = 6;
  const ENTRY = 16;
  const ico = Buffer.alloc(HEADER + ENTRY * images.length);

  ico.writeUInt16LE(0, 0);              // reserved
  ico.writeUInt16LE(1, 2);              // type: 1 = icon
  ico.writeUInt16LE(images.length, 4);  // image count

  // Data follows the directory, so the first offset clears the whole table.
  let offset = ico.length;

  images.forEach((png, i) => {
    const size = SIZES[i];
    const at = HEADER + ENTRY * i;
    ico.writeUInt8(size === 256 ? 0 : size, at);      // 0 encodes 256
    ico.writeUInt8(size === 256 ? 0 : size, at + 1);
    ico.writeUInt8(0, at + 2);                        // palette colours
    ico.writeUInt8(0, at + 3);                        // reserved
    ico.writeUInt16LE(1, at + 4);                     // colour planes
    ico.writeUInt16LE(32, at + 6);                    // bits per pixel
    ico.writeUInt32LE(png.length, at + 8);
    ico.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  fs.writeFileSync(OUT, Buffer.concat([ico, ...images]));
  const total = fs.statSync(OUT).size;
  console.log(`icon.ico  ${SIZES.join(', ')}  ${(total / 1024).toFixed(1)} kB`);
}

build();
