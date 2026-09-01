'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Runtimes a game needs that are not part of the game.
 *
 * A title built against the Visual C++ runtime or a particular DirectX
 * component will not start on a machine that lacks it, and the failure is
 * silent and baffling: the process exits immediately with no window and no
 * message. To the person it happens to, the launcher is broken.
 *
 * So the launcher checks, and offers to run the vendor's own installer that
 * ships alongside the build. Three rules:
 *
 *   - It only ever runs an installer that came with the title, from inside the
 *     install directory. Nothing is downloaded from anywhere for this.
 *   - It is always offered, never silent. These installers are system-wide and
 *     usually want elevation; that is not something to do to somebody without
 *     asking.
 *   - A missing prerequisite is a warning, not a block. Plenty of machines
 *     already have these, the detection is best-effort, and refusing to launch
 *     because a registry key looked wrong would be worse than the problem.
 *
 * Windows only, because that is where these exist.
 */

const CHECKS = [
  {
    id: 'vcredist2015',
    name: 'Microsoft Visual C++ 2015-2022 Redistributable',
    // The runtime DLL itself, which is more honest than a registry version:
    // it is what the game actually loads.
    files: ['vcruntime140.dll', 'vcruntime140_1.dll'],
    installers: ['vc_redist.x64.exe', 'vcredist_x64.exe']
  },
  {
    id: 'dotnet4',
    name: '.NET Framework 4',
    // mscoree.dll is the shim every .NET application loads and it does live in
    // System32. `clr.dll` does not - it sits under Microsoft.NET\Framework64 -
    // so looking for it here reported .NET as missing on machines that have it.
    files: ['mscoree.dll'],
    installers: ['ndp48-x86-x64-allos-enu.exe', 'dotnetfx.exe']
  },
  {
    id: 'directx',
    name: 'DirectX End-User Runtime',
    files: ['d3dcompiler_47.dll', 'xinput1_3.dll'],
    installers: ['dxsetup.exe', 'dxwebsetup.exe']
  }
];

/** Where Windows keeps the runtimes these checks look for. */
function systemDirs() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(root, 'System32'), path.join(root, 'SysWOW64')];
}

const present = (file) => systemDirs().some((dir) => fs.existsSync(path.join(dir, file)));

/**
 * Finds an installer a title shipped for a prerequisite.
 *
 * Looked for only in the places a build actually puts them, and never followed
 * outside the install directory - running an arbitrary executable because it
 * had a matching name is not a thing this should do.
 */
function findInstaller(installDir, names) {
  if (!installDir || !fs.existsSync(installDir)) return null;

  const roots = [
    installDir,
    path.join(installDir, '_CommonRedist'),
    path.join(installDir, 'Redist'),
    path.join(installDir, 'redist'),
    path.join(installDir, 'Prerequisites')
  ];

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!names.includes(entry.name.toLowerCase())) continue;

      const full = path.join(entry.parentPath || entry.path || root, entry.name);
      // Must still be inside the install directory after resolution.
      if (!path.resolve(full).startsWith(path.resolve(installDir))) continue;
      return full;
    }
  }
  return null;
}

/**
 * What a title needs and does not have.
 *
 * Returns only the missing ones, each with the installer that would fix it if
 * the build shipped one. An empty list is the common case.
 */
function check(installDir) {
  if (process.platform !== 'win32') return [];

  const missing = [];
  for (const item of CHECKS) {
    if (item.files.some(present)) continue;

    missing.push({
      id: item.id,
      name: item.name,
      installer: findInstaller(installDir, item.installers.map((n) => n.toLowerCase()))
    });
  }
  return missing;
}

/**
 * Runs one prerequisite installer.
 *
 * Passed through the shell's own elevation, quietly, because that is how these
 * are meant to be run and because a UAC prompt the user did not expect is
 * worse than one they did. The path is checked again here rather than trusted
 * from the caller.
 */
function install(installerPath, installDir) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Windows only.' });

    const resolved = path.resolve(String(installerPath || ''));
    if (!installDir || !resolved.startsWith(path.resolve(installDir))) {
      return resolve({ ok: false, error: 'That installer is not part of this title.' });
    }
    if (!fs.existsSync(resolved) || path.extname(resolved).toLowerCase() !== '.exe') {
      return resolve({ ok: false, error: 'That installer is not there any more.' });
    }

    // /quiet /norestart is the convention every one of these accepts.
    const child = spawn(resolved, ['/quiet', '/norestart'], { windowsHide: true, detached: false });

    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('exit', (code) => {
      // 0 is success; 3010 is success needing a reboot, which is not a failure.
      resolve(code === 0 || code === 3010 ? { ok: true, rebootRequired: code === 3010 } : { ok: false, code });
    });
  });
}

module.exports = { check, install, findInstaller, CHECKS };
