import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WEB_PLATFORM, simulatedPlatform, fallbackTauriPlatform, normalizePlatform, platformClasses, resolvePlatform } from './platform.js';

const ios = { shell: 'tauri', os: 'ios', arch: 'aarch64', mobile: true, capabilities: { nativeDialogs: false, watchFolder: false, updater: false, externalLinks: true, documentsExport: true } };
const desktop = { shell: 'tauri', os: 'windows', mobile: false, capabilities: { nativeDialogs: true, watchFolder: true, updater: true, externalLinks: true } };
assert.deepEqual(platformClasses(WEB_PLATFORM), ['shell-web']);
assert.equal(simulatedPlatform('?shell=nonsense'), null);
assert.equal(simulatedPlatform('?shell=__proto__'), null);
assert.equal((await resolvePlatform({ invoke: null, search: '' })).shell, 'web');
assert.deepEqual(platformClasses(await resolvePlatform({ invoke: null, search: '?shell=mobile' })), ['shell-tauri', 'shell-mobile', 'os-ios']);
// URL flags cannot disguise an iOS shell as desktop, nor remove native I/O.
for (const search of ['', '?shell=desktop', '?shell=web']) {
  assert.deepEqual(await resolvePlatform({ invoke: async () => ios, search }), normalizePlatform(ios));
}
// A desktop-like iPad UA and a touchscreen PC do not determine capabilities.
assert.equal((await resolvePlatform({ invoke: async () => desktop, navigator: { maxTouchPoints: 10 }, search: '' })).mobile, false);
assert.equal(normalizePlatform({ ...ios, mobile: false, capabilities: desktop.capabilities }).capabilities.updater, false);
assert.equal(normalizePlatform({ ...ios, capabilities: desktop.capabilities }).capabilities.watchFolder, false);
assert.equal(normalizePlatform({ ...ios, capabilities: { sourceRecovery: true } }).capabilities.sourceRecovery, true);
assert.equal(normalizePlatform({ ...desktop, capabilities: { sourceRecovery: true } }).capabilities.sourceRecovery, false);
assert.ok(!simulatedPlatform('?shell=mobile').capabilities.sourceRecovery, 'layout preview has no native source store');
assert.equal(normalizePlatform({ ...desktop, capabilities: { ...desktop.capabilities, updater: false } }).capabilities.updater, false, 'store build has no updater');
for (const answer of [null, {}, [], { shell: 'web' }, { shell: 'tauri', os: 'ios invalid' }]) {
  const resolved = await resolvePlatform({ invoke: async () => answer, search: '' });
  assert.deepEqual(resolved, fallbackTauriPlatform());
  assert.deepEqual(platformClasses(resolved), ['shell-tauri', 'shell-unknown']);
  assert.equal(resolved.capabilities.watchFolder, false);
  assert.equal(resolved.capabilities.updater, false);
}
for (const invoke of [() => { throw new Error('missing command'); }, () => new Promise(() => {})]) {
  assert.deepEqual(await resolvePlatform({ invoke, timeoutMs: 5 }), fallbackTauriPlatform());
}
// Regression: collecting a capability does not enable it when the iOS config
// explicitly selects only "default". Verify the actual merged config input.
const tauri = new URL('../../../src-tauri/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('tauri.ios.conf.json', tauri)));
assert.deepEqual(config.app.security.capabilities, ['default', 'mobile']);
const capability = JSON.parse(readFileSync(new URL('capabilities/mobile.json', tauri)));
assert.ok(capability.platforms.includes('iOS'));
assert.ok(!capability.permissions.some((p) => String(p.identifier ?? p).startsWith('updater:')));
assert.deepEqual(capability.permissions, [{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://*' }] }]);
console.log('platform tests passed');
