'use strict';
/**
 * Points git at the tracked hooks directory.
 *
 * Hooks in .git/hooks are not version controlled, so they only ever exist on
 * the machine somebody set them up on. core.hooksPath makes them part of the
 * repository instead, which is the only way a hook is any use to a second
 * person. Run automatically by `npm install` via the prepare script.
 */
const { execFileSync } = require('child_process');
const path = require('path');

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'ignore'
  });
} catch {
  // Not a git checkout (a tarball, or a CI cache restore). Nothing to do.
}
