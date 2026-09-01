'use strict';
/**
 * Removes Electron runtime files this launcher does not use.
 *
 * `build.files` only filters the application source; Electron's own binaries
 * are copied in wholesale afterwards, so trimming them needs a hook that runs
 * once the directory exists.
 *
 * What goes, and why it is safe here: this UI is HTML, inline SVG and a 2D
 * canvas. It never compiles a shader and never falls back to software Vulkan.
 * Anything that starts doing 3D in-process needs these back.
 *
 * Reports what it removed rather than doing it silently, because a build that
 * quietly deletes things is hard to trust when something later breaks.
 */
const fs = require('fs');
const path = require('path');

// Roughly 30 MB between them, on every download.
const UNUSED = [
  'dxcompiler.dll',
  'dxil.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll'
];

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let freed = 0;
  const removed = [];

  for (const name of UNUSED) {
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      fs.rmSync(file);
      freed += stat.size;
      removed.push(name);
    } catch {
      // Absent already, or a platform that never had it.
    }
  }

  if (removed.length) {
    console.log(
      `  • trimmed unused runtime  ${removed.join(', ')} (${(freed / 1024 / 1024).toFixed(1)} MB)`
    );
  }
};
