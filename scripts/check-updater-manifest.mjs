// Drives .github/scripts/r2_sync_release.py in --dry-run mode over a fixture
// release tree and checks the updater.json it derives: every signed installer
// lands under the keys tauri-plugin-updater looks up, unsigned ones are left
// out, URLs are absolute and percent-encoded, and latest.json keeps offering
// installers only.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repoRoot, '.github', 'scripts', 'r2_sync_release.py');

const root = mkdtempSync(join(tmpdir(), 'nc-updater-manifest-'));
const version = '9.9.9';
const assets = [
  ['bundle-windows-latest/nsis', `Negative Converter_${version}_x64-setup.exe`, true],
  ['bundle-windows-latest/msi', `Negative Converter_${version}_x64_en-US.msi`, true],
  ['bundle-ubuntu-latest/appimage', `Negative Converter_${version}_amd64.AppImage`, true],
  ['bundle-ubuntu-latest/deb', `Negative Converter_${version}_amd64.deb`, false],
  ['bundle-ubuntu-latest/rpm', `Negative Converter-${version}-1.x86_64.rpm`, true],
  ['bundle-linux-legacy', `Negative Converter_${version}_amd64_legacy-glibc235.AppImage`, true],
  ['bundle-macos-latest/dmg', `Negative Converter_${version}_aarch64.dmg`, false],
  ['bundle-macos-latest/macos', `Negative Converter_${version}_aarch64.app.tar.gz`, true],
];
for (const [dir, name, signed] of assets) {
  const full = join(root, 'artifacts', dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, name), `payload of ${name}`);
  if (signed) writeFileSync(join(full, `${name}.sig`), `sig-of ${name}\n`);
}

const result = spawnSync('python3', [
  script,
  '--dry-run',
  '--source-dir', join(root, 'artifacts'),
  '--bucket', 'fixture',
  '--prefix', 'negative-converter/release',
  '--tag', `v${version}`,
  '--public-base-url', 'https://download.example.com/',
  '--manifest-dir', join(root, 'out'),
  '--update-latest',
], { encoding: 'utf8' });

try {
  assert.equal(result.status, 0, `script failed:\n${result.stdout}\n${result.stderr}`);

  const updater = JSON.parse(readFileSync(join(root, 'out', 'updater.json'), 'utf8'));
  assert.equal(updater.version, version);
  assert.match(updater.pub_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

  const expectedKeys = [
    'windows-x86_64-nsis', 'windows-x86_64', 'windows-x86_64-msi',
    'linux-x86_64-appimage', 'linux-x86_64', 'linux-x86_64-rpm', 'linux-x86_64-glibc235',
    'darwin-aarch64-app', 'darwin-aarch64',
  ].sort();
  assert.deepEqual(Object.keys(updater.platforms).sort(), expectedKeys);

  const base = 'https://download.example.com/negative-converter/release/v9.9.9';
  assert.equal(updater.platforms['windows-x86_64-nsis'].url, `${base}/Negative%20Converter_9.9.9_x64-setup.exe`);
  assert.equal(updater.platforms['windows-x86_64'].url, updater.platforms['windows-x86_64-nsis'].url);
  assert.equal(updater.platforms['windows-x86_64-msi'].url, `${base}/Negative%20Converter_9.9.9_x64_en-US.msi`);
  assert.equal(updater.platforms['linux-x86_64-appimage'].url, `${base}/Negative%20Converter_9.9.9_amd64.AppImage`);
  assert.equal(updater.platforms['linux-x86_64-glibc235'].url, `${base}/Negative%20Converter_9.9.9_amd64_legacy-glibc235.AppImage`);
  assert.equal(updater.platforms['darwin-aarch64'].url, `${base}/Negative%20Converter_9.9.9_aarch64.app.tar.gz`);
  assert.equal(updater.platforms['linux-x86_64-appimage'].signature, 'sig-of Negative Converter_9.9.9_amd64.AppImage');
  assert.equal(updater.platforms['darwin-aarch64'].signature, 'sig-of Negative Converter_9.9.9_aarch64.app.tar.gz');
  // The unsigned .deb must not be offered in-app.
  assert.equal(updater.platforms['linux-x86_64-deb'], undefined);

  const latest = JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8'));
  assert.equal(latest.version, version);
  const latestTypes = latest.files.map((f) => f.type).sort();
  assert.deepEqual(latestTypes, ['appimage', 'appimage', 'deb', 'dmg', 'exe', 'msi', 'rpm']);
  assert.ok(latest.files.every((f) => !f.name.endsWith('.sig') && !f.name.endsWith('.app.tar.gz')));

  // Signatures ship next to their installers; the manifests are last.
  const uploads = result.stdout.split('\n').filter((l) => l.startsWith('[dry-run] Would upload:'));
  assert.ok(uploads.some((l) => l.includes('Negative Converter_9.9.9_x64-setup.exe.sig')));
  assert.ok(uploads.at(-1).includes('negative-converter/release/updater.json'));

  // Nothing signed → refusing to publish a manifest the app would trip over.
  const emptyRoot = join(root, 'empty');
  mkdirSync(join(emptyRoot, 'dmg'), { recursive: true });
  writeFileSync(join(emptyRoot, 'dmg', 'Negative Converter_9.9.9_aarch64.dmg'), 'x');
  const empty = spawnSync('python3', [
    script, '--dry-run', '--source-dir', emptyRoot, '--bucket', 'fixture', '--tag', 'v9.9.9',
    '--manifest-dir', join(root, 'out-empty'), '--update-latest',
  ], { encoding: 'utf8' });
  assert.equal(empty.status, 1, 'an updater.json without platforms must not be published');
  assert.match(empty.stderr, /no platforms/);

  console.log('updater manifest: ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
