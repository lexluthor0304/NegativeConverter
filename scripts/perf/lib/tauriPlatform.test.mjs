import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { tauriDevArgs, createTauriCache, launchWebKitScript } = await import(process.env.NC_PERF_PLATFORM_MODULE
  ? pathToFileURL(process.env.NC_PERF_PLATFORM_MODULE) : new URL('./webkit.mjs', import.meta.url));
const window = { label: 'main', width: 1280, height: 850, dragDropEnabled: false, backgroundThrottling: 'disabled' };
const input = { port: 5591, scenario: 's1', fixtures: ['tiny.png'], windows: [window] };
const args = tauriDevArgs(input);
assert.ok(args.includes('perf-harness'), 'the real production caller must compile the isolated cache feature');
assert.ok(args.includes('--release'), 'production measurements still use release mode');
const config = JSON.parse(args[args.indexOf('--config') + 1]);
assert.deepEqual(config.app.windows, [{ ...window, incognito: true }], 'nonpersistent storage preserves the configured geometry');
assert.equal(config.build.beforeDevCommand, '');
assert.match(config.build.devUrl, /^http:\/\/127\.0\.0\.1:5591\/\?lang=en&perf=1/);
assert.ok(!tauriDevArgs({ ...input, release: false }).includes('--release'), 'the bounded caller proof can reuse the debug cache');
const legacy = tauriDevArgs({ port: input.port, scenario: input.scenario, fixtures: input.fixtures });
assert.deepEqual(legacy.slice(0, 4), ['dev', '--release', '--no-watch', '--config'], 'legacy caller argument positions stay stable');
assert.equal(JSON.parse(legacy[4]).app.windows[0].incognito, true, 'legacy callers use the configured window with isolated storage');
assert.throws(() => tauriDevArgs({ ...input, windows: [] }), /one configured window/);
assert.throws(() => tauriDevArgs({ ...input, windows: [window, window] }), /one configured window/);

const out = mkdtempSync(join(tmpdir(), 'nc229-platform-cache-test-'));
const a = createTauriCache(out), b = createTauriCache(out);
assert.notEqual(a.NC_PERF_TAURI_CACHE_ROOT, b.NC_PERF_TAURI_CACHE_ROOT, 'every native run gets a fresh cache');
assert.notEqual(a.NC_PERF_TAURI_CACHE_TOKEN, b.NC_PERF_TAURI_CACHE_TOKEN);
assert.equal(readFileSync(join(a.NC_PERF_TAURI_CACHE_ROOT, '.nc-perf-harness'), 'utf8'), `${a.NC_PERF_TAURI_CACHE_TOKEN}\n`);
if (process.platform !== 'win32') {
  assert.equal(statSync(a.NC_PERF_TAURI_CACHE_ROOT).mode & 0o077, 0);
  assert.equal(statSync(join(a.NC_PERF_TAURI_CACHE_ROOT, '.nc-perf-harness')).mode & 0o077, 0);
}
let spawned;
const launch = launchWebKitScript('/owned/tauri.js', ['dev'], { env: a,
  memory: { processEnv: () => ({ DYLD_INSERT_LIBRARIES: '/owned/observer.dylib' }), bindProcess() {}, stopOwnedProcess() {} },
  spawnProcess: (bin, argv, options) => { spawned = { bin, argv, options }; return { pid: 900000041 }; } });
assert.equal(spawned.bin, process.execPath);
assert.equal(spawned.options.env.NC_PERF_TAURI_CACHE_ROOT, a.NC_PERF_TAURI_CACHE_ROOT);
assert.equal(spawned.options.env.DYLD_INSERT_LIBRARIES, '/owned/observer.dylib', 'cache isolation preserves the existing observer');
launch.unregister();
console.log('Tauri platform: production feature, isolated cache claims, nonpersistent geometry and observer propagation passed');
