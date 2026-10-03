import assert from 'node:assert/strict';
import { verifiedWebKitAssociation, WebKitOwnership, sameProcess } from './webkit-ownership.mjs';
import { webkitMemory, launchWebKitProcess, runWebKit } from './webkit.mjs';
import { cleanupResources } from './resources.mjs';

const identity = (pid, path, parentPid = 1, parentUnique = '0') => ({ pid, unique: String(pid + 100), version: 7, uid: 501, path, parentPid, parentUnique });
const root = identity(900000021, '/owned/tauri');
const owner = identity(900000022, '/owned/app', root.pid, root.unique);
const renderer = identity(900000023, '/framework/com.apple.WebKit.WebContent');
const gpu = identity(900000024, '/framework/com.apple.WebKit.GPU');
const endpoint = (p, instance) => ({ identity: p, instance, auditToken: [0, 501, 501, 501, 501, p.pid, 0, p.version] });
const snapshot = { source: 'wkwebview+xpc-oneshot', owner, ancestors: [root], port: 5581,
  views: [{ renderer: endpoint(renderer, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), gpu: endpoint(gpu, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') }] };
const current = Object.fromEntries([root, owner, renderer, gpu].map(p => [p.pid, p]));
const verify = (value = snapshot, processes = current, bound = root) => verifiedWebKitAssociation(value, { root: bound, current: processes, port: 5581 });
assert.ok(verify(), 'explicit view, one-shot endpoints and bound native ancestry agree');
assert.equal(verify(snapshot, current, identity(900000025, '/unrelated/app')), null, 'a fresh native instance on the same port is not this child');
assert.equal(verify({ ...snapshot, port: 5582 }), null);
assert.equal(verify({ ...snapshot, source: 'coalition-membership' }), null, 'group membership cannot prove exclusive GPU ownership');
assert.equal(verify({ ...snapshot, views: [...snapshot.views, ...snapshot.views] }), null, 'ambiguous views fail closed');
assert.equal(verify(snapshot, { ...current, [gpu.pid]: { ...gpu, unique: 'reused' } }), null, 'same PID and binary after reuse cannot pass');
assert.equal(verify({ ...snapshot, ancestors: [{ ...root, version: 8 }] }), null, 'root identity must remain bound');
assert.equal(verify({ ...snapshot, owner: { ...owner, parentUnique: 'unrelated' } }), null, 'parent PID alone cannot prove native ancestry');
assert.equal(verify(snapshot, { ...current, [owner.pid]: { ...owner, parentUnique: 'changed' } }), null,
  'the live native ancestry is also rechecked');
assert.equal(verify({ ...snapshot, views: [{ ...snapshot.views[0], gpu: { ...snapshot.views[0].gpu, auditToken: Array(8).fill(0) } }] }), null);
assert.equal(verify({ ...snapshot, views: [{ ...snapshot.views[0], gpu: { ...snapshot.views[0].gpu, instance: snapshot.views[0].renderer.instance } }] }), null);
assert.equal(sameProcess(gpu, { ...gpu, version: gpu.version + 1 }), false);

let bound, spawned;
const launch = launchWebKitProcess('/owned/tauri', ['dev'], {
  memory: { processEnv: () => ({ NC_PERF_OWNERSHIP_PORT: '5581' }), bindProcess: child => { bound = child; }, stopOwnedProcess() {} },
  spawnProcess: (bin, argv, options) => { spawned = { bin, argv, options }; return { pid: root.pid }; }
});
assert.equal(spawned.options.env.NC_PERF_OWNERSHIP_PORT, '5581', 'production launch propagates the provider environment');
assert.equal(bound.pid, root.pid, 'production launch binds the exact spawned native ancestry');
launch.unregister();
if (process.platform === 'darwin') {
  let preparation = false;
  await assert.rejects(runWebKit({ args: { browser: 'safari' }, prepareFixtures: async () => { preparation = true; } }),
    /Safari GPU ownership.*before fixtures or navigation/);
  assert.equal(preparation, false, 'unsupported exclusive Safari ownership is refused before resource-heavy or user-browser work');
}

let text = JSON.stringify(snapshot) + '\n', state = current;
const signals = [];
const ownership = new WebKitOwnership({ library: '/owned/observer.dylib', file: '/fake/evidence.jsonl', port: 5581,
  read: () => text, write() {}, metadata: (pids, request = {}) => {
    if (request.signal) { signals.push(request); return { signalled: true }; }
    return Object.fromEntries(pids.map(pid => [pid, state[pid]]));
  } });
ownership.bindProcess({ pid: root.pid, exitCode: null });
assert.equal(ownership.environment().DYLD_INSERT_LIBRARIES, '/owned/observer.dylib');
assert.equal(ownership.resolve().gpu.identity.pid, gpu.pid);
assert.equal(ownership.kill(gpu.pid), true);
assert.equal(signals[0].signal.auditToken[7], gpu.version);
state = { ...current, [gpu.pid]: { ...gpu, version: 8 } };
assert.equal(ownership.kill(gpu.pid), false, 'cleanup rechecks identity immediately, even after a positive sample');
assert.equal(signals.length, 1);
state = current;
text += JSON.stringify({ ...snapshot, views: [] }) + '\n';
assert.equal(ownership.resolve(), null, 'a later empty state revokes an earlier association');
text = JSON.stringify(snapshot); // an incomplete write must never qualify
assert.equal(ownership.resolve(), null);

// Actual memory caller and global exit cleanup use the guarded provider,
// including when the PID is reused after registration but before cleanup.
text = JSON.stringify(snapshot) + '\n';
let listed = [];
const read = [], killed = [];
const fakeKill = ownership.kill.bind(ownership);
ownership.kill = pid => { const ok = fakeKill(pid); if (ok) killed.push(pid); return ok; };
const memory = await webkitMemory({ label: 'owned', port: 5581, outDir: '.', args: {}, ownership, start: false,
  swapAtStart: 0, readSwap: async () => ({ used: 0 }), readDisk: () => 100 * 1024 ** 3,
  list: async () => listed, reader: { start: async () => {}, stop() {}, read: async pids => {
    read.push(pids); return Object.fromEntries(pids.map(pid => [pid, { footprint: 1024 ** 2 }]));
  } } });
listed = [renderer, gpu].map(p => ({ pid: p.pid, command: p.path }));
await memory.sampler.tick();
await memory.assertScope();
assert.deepEqual(read, [[renderer.pid, gpu.pid]]);
state = { ...current, [gpu.pid]: { ...gpu, unique: 'reused' } };
const kill = process.kill, rawKills = [];
process.kill = pid => { rawKills.push(pid); return true; };
try {
  cleanupResources({ removeWorktrees: false });
  memory.stop();
} finally { process.kill = kill; }
assert.deepEqual(rawKills, [], 'registered XPC endpoints cannot bypass ownership revalidation via a raw PID kill');
assert.deepEqual(killed, [], 'both normal and global cleanup preserve a PID whose ownership changed');
assert.equal(signals.length, 1);
console.log('WebKit ownership: native evidence, ambiguity, reuse, revocation and guarded caller cleanup passed (fake OS data)');
