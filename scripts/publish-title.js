'use strict';
/**
 * Turns a build into something the launcher can actually download.
 *
 *   npm run publish-title -- <file> <game-id> [--version 1.0.0]
 *   npm run publish-title -- ./UmbraDemo.pak blacknight-demo --version 1.1.0
 *
 * Everything in the download path - resume, checksum verification, block-level
 * patching, LAN sharing, rollback - is built and tested, and none of it has
 * ever moved a real byte, because no catalog entry has a downloadUrl. This is
 * the missing step.
 *
 * What it does:
 *   1. hashes the build, whole-file and per block
 *   2. writes the chunk manifest next to it
 *   3. updates the catalog entry with url, size, digest and manifest
 *   4. prints the one command needed to attach the files to a release
 *
 * It does not upload. Publishing needs credentials, and a script that quietly
 * pushes a build somewhere is not a script anyone should trust.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildManifest, DEFAULT_CHUNK } = require(path.join(ROOT, 'electron', 'services', 'chunks.js'));

const CATALOG = path.join(ROOT, 'electron', 'data', 'catalog.json');
const REPO = 'SourcedCMD/blacknight-launcher';

function die(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1];
    else positional.push(argv[i]);
  }
  return { file: positional[0], gameId: positional[1], flags };
}

function gb(bytes) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function main() {
  const { file, gameId, flags } = parseArgs(process.argv.slice(2));

  if (!file || !gameId) {
    die('Usage: npm run publish-title -- <file> <game-id> [--version 1.0.0]');
  }
  if (!fs.existsSync(file)) die(`No such file: ${file}`);

  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
  const game = catalog.games.find((g) => g.id === gameId);
  if (!game) {
    die(`"${gameId}" is not in the catalog. Known ids:\n  ${catalog.games.map((g) => g.id).join('\n  ')}`);
  }

  const version = flags.version || game.version || '1.0.0';
  const stat = fs.statSync(file);

  console.log(`\nPublishing ${game.title} ${version}`);
  console.log(`  source   ${file}`);
  console.log(`  size     ${gb(stat.size)}`);
  process.stdout.write('  hashing  ');

  // One pass produces both the whole-file digest and the per-block manifest,
  // so a large build is not read twice.
  const started = Date.now();
  const manifest = buildManifest(file, { chunkSize: DEFAULT_CHUNK });
  console.log(`${manifest.chunks.length} blocks in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  sha256   ${manifest.sha256}`);

  // The manifest travels beside the build; the launcher fetches it to work out
  // which blocks an update actually needs.
  const manifestName = `${gameId}-${version}.manifest.json`;
  const manifestPath = path.join(path.dirname(file), manifestName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');

  const assetName = `${gameId}-${version}.pak`;
  const base = `https://github.com/${REPO}/releases/download/titles-${gameId}-${version}`;

  game.version = version;
  game.sizeBytes = stat.size;
  game.sha256 = manifest.sha256;
  game.downloadUrl = `${base}/${assetName}`;
  game.chunkManifestUrl = `${base}/${manifestName}`;
  // Inlined too, so a first install can plan its blocks without a second
  // request. It is a few hundred kilobytes for a 90 GB build.
  game.chunkManifest = { chunkSize: manifest.chunkSize, totalBytes: manifest.totalBytes, chunks: manifest.chunks };

  fs.writeFileSync(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  console.log(`\nCatalog updated: ${gameId} -> ${version}`);
  console.log(`  manifest written to ${manifestPath}`);
  console.log('\nTo publish, from a shell signed in with the GitHub CLI:\n');
  console.log(`  gh release create titles-${gameId}-${version} \\`);
  console.log(`    "${path.resolve(file)}#${assetName}" \\`);
  console.log(`    "${manifestPath}#${manifestName}" \\`);
  console.log(`    --title "${game.title} ${version}" \\`);
  console.log('    --notes "Game build. Not a launcher release."\n');
  console.log('Then: npm run check:catalog && npm run sync\n');
  console.log('The launcher will verify this digest before reporting an install');
  console.log('complete, so the uploaded file has to be exactly this one.\n');
}

main();
