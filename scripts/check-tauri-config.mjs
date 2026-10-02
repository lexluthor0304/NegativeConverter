// The desktop window must keep running while it is hidden (#241). On macOS
// 14+ WKWebView otherwise suspends the whole WebContent process 20 s after
// the window is minimised, hidden or covered, and a batch export or roll
// analysis stops until the window is shown again. The policy has to be static:
// WebKit latches RunningBoard throttling per process, so it cannot be switched
// around a job at runtime.
//
// Every build merges one override on top of tauri.conf.json with `--config`
// (the App Store build and the release build). JSON Merge Patch replaces an
// array whole, so an override that sets `app.windows` would silently drop the
// policy along with the rest of the window definition.
//
//
// The app's asset protocol also sends the cross-origin isolation pair (#264,
// app.security.headers) on every response. An override may not touch it:
// Merge Patch would drop it with a null and replace its values otherwise.
//
// Every bundle carries the RAW decoder's licence notices as a readable file
// (bundle.resources): LibRaw, musl and libomp are compiled into the desktop
// binaries, the App Store build included, and their licences ask for the
// notices in what recipients get (scripts/check-third-party-notices.mjs). It
// lands in Contents/Resources/licenses in the macOS app, in the installation
// folder on Windows and in usr/lib/<product name>/licenses in the Linux
// packages. No override may set bundle.resources either: Merge Patch would
// drop the map with a null and replace it with an array.
//
//   node scripts/check-tauri-config.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CROSS_ORIGIN_ISOLATION_HEADERS } from './cross-origin-isolation.mjs';

const tauriDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const problems = [];
const read = (name) => {
  try {
    return JSON.parse(readFileSync(join(tauriDir, name), 'utf8'));
  } catch (err) {
    problems.push(`${name}: ${err.message}`);
    return null;
  }
};

const base = read('tauri.conf.json');
const windows = base?.app?.windows;
if (!Array.isArray(windows) || !windows.length) {
  problems.push('tauri.conf.json: app.windows[0] is missing');
} else if (windows[0].backgroundThrottling !== 'disabled') {
  problems.push(`tauri.conf.json: app.windows[0].backgroundThrottling must be "disabled", found ${JSON.stringify(windows[0].backgroundThrottling)}`);
}

const securityHeaders = base?.app?.security?.headers;
for (const [key, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
  if (securityHeaders?.[key] !== value) {
    problems.push(`tauri.conf.json: app.security.headers["${key}"] must be ${JSON.stringify(value)}, found ${JSON.stringify(securityHeaders?.[key])}`);
  }
}

const NOTICES_SOURCE = '../negative2positive/public/licenses/raw-decoder-notices.txt';
const NOTICES_TARGET = 'licenses/raw-decoder-notices.txt';
const resources = base?.bundle?.resources;
if (Array.isArray(resources) || resources?.[NOTICES_SOURCE] !== NOTICES_TARGET) {
  problems.push(`tauri.conf.json: bundle.resources must map ${JSON.stringify(NOTICES_SOURCE)} to ${JSON.stringify(NOTICES_TARGET)}, found ${JSON.stringify(resources)}`);
} else if (!existsSync(join(tauriDir, NOTICES_SOURCE))) {
  problems.push(`tauri.conf.json: bundle.resources names ${NOTICES_SOURCE}, which does not exist`);
}

const overrides = readdirSync(tauriDir).filter((name) => /^tauri\..+\.conf\.json$/.test(name));
if (!overrides.length) problems.push('no override configs found next to tauri.conf.json');
for (const name of overrides) {
  const config = read(name);
  if (config?.app && Object.prototype.hasOwnProperty.call(config.app, 'windows')) {
    problems.push(`${name}: sets app.windows, which would replace the window list and drop backgroundThrottling`);
  }
  if (config?.app?.security && Object.prototype.hasOwnProperty.call(config.app.security, 'headers')) {
    problems.push(`${name}: sets app.security.headers, which would change or drop the cross-origin isolation headers`);
  }
  if (config?.bundle && Object.prototype.hasOwnProperty.call(config.bundle, 'resources')) {
    problems.push(`${name}: sets bundle.resources, which could replace or drop the bundled licence notices`);
  }
}

if (problems.length) {
  console.error('FAIL tauri config:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`ok: backgroundThrottling is disabled, the isolation headers are set, the bundles carry ${NOTICES_TARGET} and ${overrides.length} override config(s) leave app.windows, app.security.headers and bundle.resources alone`);
