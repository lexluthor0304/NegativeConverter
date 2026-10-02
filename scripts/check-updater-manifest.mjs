// Drives .github/scripts/r2_sync_release.py in --dry-run mode over a fixture
// release tree and checks the updater.json it derives: every signed installer
// lands under the keys tauri-plugin-updater looks up, unsigned ones are left
// out, URLs are absolute and percent-encoded, and latest.json keeps offering
// installers only.
//
// Then the endpoints the clients use: the feedback POST reaches the function
// without a redirect, and every URL the desktop app reads a manifest from is
// one the release workflows publish it at.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCorsOrigin } from '../negative2positive/api/_lib/feedback-core.mjs';

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

// Site endpoints (#229 review R2-047). The desktop app posts its feedback to
// the site by full URL. The POST carries JSON, so the webview preflights it,
// and a preflight that gets a redirect fails: the path must be the spelling
// the site serves as is. Vercel answers the other one with a 308
// (`trailingSlash` in vercel.json), with no CORS headers.
const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');
const mainJs = read('negative2positive', 'src', 'app', 'main.js');
const SITE_ORIGIN = 'https://negative-converter.tokugai.com';

const feedback = mainJs.match(/const FEEDBACK_ENDPOINT = isTauriDesktop\(\)\s*\?\s*'([^']*)'\s*:\s*'([^']*)';/);
assert.ok(feedback, "main.js: `const FEEDBACK_ENDPOINT = isTauriDesktop() ? '<desktop>' : '<web>';` not found");
const [, desktopFeedback, webFeedback] = feedback;
assert.ok(existsSync(join(repoRoot, 'negative2positive', 'api', 'feedback.mjs')), 'the feedback function is no longer /api/feedback');
for (const config of ['vercel.json', join('negative2positive', 'vercel.json')]) {
  const trailingSlash = JSON.parse(read(config)).trailingSlash === true;
  const path = trailingSlash ? '/api/feedback/' : '/api/feedback';
  const why = `${config} has trailingSlash: ${trailingSlash}`;
  assert.equal(webFeedback, path, `main.js: the web feedback endpoint must be ${path} (${why})`);
  assert.equal(desktopFeedback, `${SITE_ORIGIN}${path}`, `main.js: the desktop feedback endpoint must be ${SITE_ORIGIN}${path} (${why})`);
}
// The function answers both desktop webview origins in production, and the
// desktop's CSP lets the webview connect to the site.
for (const origin of ['tauri://localhost', 'http://tauri.localhost']) {
  assert.equal(resolveCorsOrigin(origin, { allowLocalOrigins: false }), origin, `the feedback function does not answer ${origin}`);
}
const tauriConf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
const connectSrc = String(tauriConf?.app?.security?.csp || '').split(';')
  .map((directive) => directive.trim().split(/\s+/))
  .find(([name]) => name === 'connect-src')?.slice(1) || [];
assert.ok(connectSrc.includes(SITE_ORIGIN), `tauri.conf.json: connect-src must allow ${SITE_ORIGIN}`);
console.log(`feedback endpoint: ok (desktop ${desktopFeedback}, web ${webFeedback})`);

// Release manifests (#229 review R2-048). The release workflows upload
// latest.json and updater.json to <public base>/<prefix>/ of the release
// bucket and nowhere else, so that is the only place a client may read them
// from: a fallback elsewhere can only fail (the site's copy never existed,
// and its 404 carries no CORS header either).
function publishedManifestDirs() {
  const dirs = new Set();
  for (const workflow of ['desktop-release.yml', 'r2-sync.yml']) {
    const calls = read('.github', 'workflows', workflow).split('.github/scripts/r2_sync_release.py').slice(1);
    assert.ok(calls.length, `${workflow}: no r2_sync_release.py call`);
    for (const call of calls) {
      // The call's own lines, up to the first one that does not continue.
      const lines = [];
      for (const line of call.split('\n')) {
        lines.push(line);
        if (!line.trimEnd().endsWith('\\')) break;
      }
      const args = lines.join(' ');
      const prefix = args.match(/--prefix\s+"([^"]+)"/)?.[1];
      const base = args.match(/--public-base-url\s+"([^"]+)"/)?.[1];
      assert.ok(prefix && base, `${workflow}: r2_sync_release.py is called without an explicit --prefix and --public-base-url`);
      dirs.add(`${base.replace(/\/+$/, '')}/${prefix.replace(/^\/+|\/+$/g, '')}`);
    }
  }
  return [...dirs];
}
const manifestDirs = publishedManifestDirs();
const publishedAt = (name) => manifestDirs.map((dir) => `${dir}/${name}`);
function assertPublished(urls, name, where) {
  assert.ok(urls.length, `${where}: no ${name} URL`);
  for (const url of urls) {
    assert.ok(publishedAt(name).includes(url),
      `${where}: ${url} does not serve ${name}; the release workflows publish it at ${publishedAt(name).join(', ')}`);
  }
}

const desktopList = mainJs.match(/const DESKTOP_UPDATE_MANIFEST_URLS = \[([^\]]*)\];/)?.[1];
assert.ok(desktopList !== undefined, 'main.js: `const DESKTOP_UPDATE_MANIFEST_URLS = [...];` not found');
assert.equal(desktopList.replace(/'[^']*'/g, '').replace(/\/\/[^\n]*/g, '').replace(/[\s,]/g, ''), '',
  'main.js: DESKTOP_UPDATE_MANIFEST_URLS must list plain string URLs');
const desktopManifestUrls = [...desktopList.matchAll(/'([^']*)'/g)].map((m) => m[1]);
assertPublished(desktopManifestUrls, 'latest.json', 'main.js DESKTOP_UPDATE_MANIFEST_URLS');
for (const url of desktopManifestUrls) {
  const { origin } = new URL(url);
  assert.ok(connectSrc.includes(origin), `tauri.conf.json: connect-src must allow ${origin}`);
}
assertPublished(tauriConf?.plugins?.updater?.endpoints || [], 'updater.json', 'tauri.conf.json plugins.updater.endpoints');
console.log(`release manifests: ok (${publishedAt('latest.json').join(', ')})`);
