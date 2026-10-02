// Where the display-proxy caches read their free space (#249, R2-068):
// main.js's displayProxyFreeSpace, run in a vm with stub hosts. The desktop
// reports its volume's free space, which the store's 10 GiB floor applies
// to; the web reports the origin's quota left, which it does not (Firefox
// caps an origin at 10 GiB, so the store never stored there).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDesktopProxyRecords } from './displayProxyDesktop.js';
import { displayProxyStoreBudget, DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES } from './displayProxyStore.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
async function freeSpace(host) {
  const context = vm.createContext({ createDesktopProxyRecords, desktopProxyInvoke: null, navigator: {}, ...host });
  vm.runInContext(functionSource('displayProxyFreeSpace'), context);
  return { ...(await context.displayProxyFreeSpace()) };
}
const GiB = 1024 ** 3;
const limit = DISPLAY_PROXY_STORE_DEFAULT_LIMIT_BYTES;
const estimating = (quota, usage) => ({ storage: { estimate: async () => ({ quota, usage }) } });

// Firefox: 10 GiB for the origin.
const firefox = await freeSpace({ navigator: estimating(10 * GiB, 0) });
assert.deepEqual(firefox, { bytes: 10 * GiB, kind: 'quota' }, 'the web reports the quota left');
assert.equal(displayProxyStoreBudget(firefox, limit), limit, 'a 10 GiB origin quota gives the store its setting');
assert.equal(displayProxyStoreBudget(firefox.bytes, limit), 0, 'which, read as a volume\'s free space, it never had');
const used = await freeSpace({ navigator: estimating(10 * GiB, 9 * GiB) });
assert.deepEqual(used, { bytes: 1 * GiB, kind: 'quota' });
assert.equal(displayProxyStoreBudget(used, limit), 0.5 * GiB, 'at most half of what is left');
// Without an estimate the setting applies.
assert.deepEqual(await freeSpace({}), { bytes: null, kind: 'quota' });
// The desktop: the volume's free space, under its 10 GiB floor.
const commands = [];
const desktop = await freeSpace({
  desktopProxyInvoke: async command => { commands.push(command); return { freeBytes: 30 * GiB, totalBytes: 500 * GiB }; },
  navigator: { storage: { estimate: async () => { throw new Error('the desktop does not read the origin quota'); } } }
});
assert.deepEqual(desktop, { bytes: 30 * GiB, kind: 'volume' }, 'the desktop reports its volume');
assert.deepEqual(commands, ['display_proxy_space']);
assert.equal(displayProxyStoreBudget(desktop, 10 * GiB), 5 * GiB, 'a quarter of the space above the floor');
assert.equal(displayProxyStoreBudget({ bytes: 10 * GiB, kind: 'volume' }, limit), 0, 'and nothing at the floor');

console.log('displayProxyFreeSpace: the web reads the origin quota left, the desktop its volume, each under its own budget rule');
