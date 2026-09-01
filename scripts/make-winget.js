'use strict';
/**
 * Generates a winget manifest for the current version.
 *
 *   npm run winget
 *
 * `winget install BlackNightStudios.BlackNightLauncher` is how a lot of people
 * install things on Windows now, and it costs nothing: the manifest is three
 * YAML files submitted as a pull request to microsoft/winget-pkgs, pointing at
 * a release asset that already exists.
 *
 * The installer SHA has to match the published asset exactly, so this reads it
 * from the built file rather than asking anyone to paste it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const VERSION = pkg.version;
const ID = 'BlackNightStudios.BlackNightLauncher';
const REPO = 'https://github.com/SourcedCMD/blacknight-launcher';
const INSTALLER = path.join(ROOT, 'release', `BlackNightLauncher-Setup-${VERSION}.exe`);
const OUT = path.join(ROOT, 'release', 'winget', VERSION);

// winget pins the schema version in every file; they must agree.
const SCHEMA = '1.6.0';

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex').toUpperCase();
}

function main() {
  if (!fs.existsSync(INSTALLER)) {
    console.error(`No installer at ${INSTALLER}\nRun "npm run dist:win" first.`);
    process.exit(1);
  }

  const digest = sha256(INSTALLER);
  fs.mkdirSync(OUT, { recursive: true });

  const files = {
    [`${ID}.yaml`]: `# Created with BlackNight Launcher's make-winget script
PackageIdentifier: ${ID}
PackageVersion: ${VERSION}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: ${SCHEMA}
`,

    [`${ID}.installer.yaml`]: `PackageIdentifier: ${ID}
PackageVersion: ${VERSION}
InstallerType: nsis
Scope: user
InstallModes:
  - interactive
  - silent
UpgradeBehavior: install
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${REPO}/releases/download/v${VERSION}/BlackNightLauncher-Setup-${VERSION}.exe
    InstallerSha256: ${digest}
ManifestType: installer
ManifestVersion: ${SCHEMA}
`,

    [`${ID}.locale.en-US.yaml`]: `PackageIdentifier: ${ID}
PackageVersion: ${VERSION}
PackageLocale: en-US
Publisher: BlackNight Studios
PublisherUrl: ${REPO}
PublisherSupportUrl: ${REPO}/issues
PackageName: BlackNight Launcher
PackageUrl: ${REPO}
License: Proprietary
LicenseUrl: ${REPO}/blob/main/LICENSE
Copyright: Copyright (c) 2026 BlackNight Studios
ShortDescription: The official game launcher for BlackNight Studios.
Description: |-
  One launcher for every BlackNight Studios title. Your library, your downloads
  and your progress, wherever the night takes you.

  Checks whether your PC can run a title before you download it, yields
  bandwidth to a running game, patches updates block by block, and can share
  installs across your local network.
Moniker: blacknight
Tags:
  - game
  - launcher
  - games
ReleaseNotesUrl: ${REPO}/releases/tag/v${VERSION}
ManifestType: defaultLocale
ManifestVersion: ${SCHEMA}
`
  };

  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(OUT, name), body, 'utf8');
  }

  console.log(`winget manifest for ${VERSION} written to release/winget/${VERSION}/`);
  console.log(`  installer sha256: ${digest}`);
  console.log('');
  console.log('To publish, once the release is live:');
  console.log('  1. Check the URL in the installer manifest actually resolves.');
  console.log('  2. winget validate --manifest release/winget/' + VERSION);
  console.log(`  3. Open a PR adding these to microsoft/winget-pkgs under`);
  console.log(`     manifests/b/BlackNightStudios/BlackNightLauncher/${VERSION}/`);
}

main();
