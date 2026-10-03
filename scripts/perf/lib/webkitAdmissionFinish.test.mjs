import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebKitOwnership, sameProcess } from './webkit-ownership.mjs';
import { admissionPaths } from '../preview-plugin.mjs';
const { webkitMemory, tauriScenario } = await import(process.env.NC_PERF_ADMISSION_MODULE
  ? pathToFileURL(process.env.NC_PERF_ADMISSION_MODULE) : new URL('./webkit.mjs', import.meta.url));

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const identity = (pid, path, parent) => ({ pid, path, parentPid: parent?.pid || 1, parentUnique: parent?.unique || '0', unique: String(pid + 100), version: 7, uid: 501 });
const root = identity(900000081, '/owned/launcher'), host = identity(900000082, '/owned/native-host', root);
const renderer = identity(900000083, '/framework/com.apple.WebKit.WebContent'), gpu = identity(900000084, '/framework/com.apple.WebKit.GPU');
const outsider = identity(900000085, '/another/owned-host');
const endpoint = (p, instance) => ({ identity: p, instance, auditToken: [0, 501, 501, 501, 501, p.pid, 0, p.version] });
const initial = { source: 'wkwebview+xpc-oneshot', owner: host, ancestors: [root], port: 5661, views: [{
  renderer: endpoint(renderer, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), gpu: endpoint(gpu, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') }] };
const losses = ['gpu-version', 'revoked', 'ambiguous', 'updated-version', 'renderer-version'];
function change(state, loss) {
  if (loss === 'gpu-version' || loss === 'updated-version') state.current[gpu.pid].version++;
  if (loss === 'renderer-version') state.current[renderer.pid].version++;
  if (loss === 'revoked') state.snapshot.views = [];
  if (loss === 'ambiguous') state.snapshot.views.push(structuredClone(state.snapshot.views[0]));
  if (loss === 'updated-version') {
    state.snapshot.views[0].gpu.identity.version++;
    state.snapshot.views[0].gpu.auditToken[7]++;
  }
}
async function world() {
  const state = { snapshot: structuredClone(initial), current: Object.fromEntries([root, host, renderer, gpu, outsider].map(p => [p.pid, structuredClone(p)])),
    listed: [], stops: [], aborts: [], boundary: null, reads: 0, readMode: 'positive', entered: deferred(), release: deferred() };
  const pause = async boundary => { if (state.boundary === boundary) { state.entered.resolve(); await state.release.promise; } };
  const ownership = new WebKitOwnership({ library: '/fake/observer', file: '/fake/log', port: 5661, write() {},
    read: () => JSON.stringify(state.snapshot) + '\n', metadata: (pids, request = {}) => {
      const current = Object.fromEntries(pids.map(pid => [pid, state.current[pid]]));
      if (request.descendantsOf) current.descendants = [{ chain: [state.current[host.pid], state.current[root.pid]] }, { chain: [outsider] }];
      if (request.signal) {
        const chain = request.ownedChain;
        const valid = request.expected.every(p => sameProcess(p, state.current[p.pid]))
          && (!chain || chain.slice(0, -1).every((p, i) => p.parentPid === chain[i + 1].pid && p.parentUnique === chain[i + 1].unique));
        if (valid) state.stops.push({ pid: request.signal.identity.pid, native: !!chain });
        return { signalled: valid };
      }
      return current;
    } });
  const memory = await webkitMemory({ label: 'post-await-admission', port: 5661, outDir: '.', args: {}, ownership, start: false,
    swapAtStart: 0, ceilingBytes: 1024 ** 3, sampleTimeoutMs: 500,
    readSwap: async () => { await pause('swap'); state.afterGuardRead?.(); return { used: 0 }; }, readDisk: () => 100 * 1024 ** 3,
    list: async () => { if (state.reads) await pause('validation'); return state.listed; },
    reader: { start: async () => {}, stop() {}, read: async pids => {
      await pause('footprint'); state.reads++; state.beforeRead?.();
      return Object.fromEntries(pids.map(pid => [pid, { footprint: state.readMode === 'zero' ? 0 : 2 * 1024 ** 2 }]));
    } }, onAbort: verdict => state.aborts.push(verdict) });
  state.listed = [renderer, gpu].map(p => ({ pid: p.pid, command: p.path }));
  memory.bindProcess({ pid: root.pid, exitCode: null });
  const originalResolve = ownership.resolve.bind(ownership);
  ownership.resolve = () => { const association = originalResolve(); state.afterResolve?.(); return association; };
  return { state, memory };
}
function checkDenied(state, memory, loss) {
  assert.equal(memory.verdict?.reason, 'error');
  assert.equal(state.aborts.length, 1, 'automatic abort callback is latched');
  assert.ok(state.stops.some(p => p.native && p.pid === host.pid), 'the actual ancestry-verified host receives the owned stop');
  assert.ok(state.stops.some(p => p.native && p.pid === root.pid), 'its verified launcher is stopped too');
  assert.ok(!state.stops.some(p => p.pid === outsider.pid), 'unrelated endpoints remain untouched');
  const deniedEndpoints = loss === 'footprint' ? [] : loss === 'renderer-version' ? [renderer.pid]
    : loss === 'updated-version' || loss === 'gpu-version' ? [gpu.pid] : [renderer.pid, gpu.pid];
  assert.ok(!state.stops.some(p => deniedEndpoints.includes(p.pid)), 'changed/revoked/ambiguous endpoints receive no signals');
}

// Real memory/waitForScope + native identity validator, with tiny OS data.
// Hold the footprint, post-footprint attribution, and swap awaits separately.
for (const boundary of ['footprint', 'validation', 'swap']) for (const acquired of [false, true]) for (const request of ['before-tick', 'inflight']) for (const loss of losses) {
  const { state, memory } = await world();
  try {
    if (acquired) await memory.sampler.tick();
    const before = memory.summary();
    state.reads = 0; state.boundary = boundary;
    let tick;
    if (request === 'inflight') tick = memory.sampler.tick();
    let waiting = request === 'before-tick' ? memory.waitForScope({ timeoutMs: 200 }) : null;
    let checked = waiting && assert.rejects(waiting, /identity|attribution/);
    await state.entered.promise;
    change(state, loss);
    if (!waiting) { waiting = memory.waitForScope({ timeoutMs: 200 }); checked = assert.rejects(waiting, /identity|attribution/); }
    state.release.resolve();
    await checked; if (tick) await tick;
    checkDenied(state, memory, loss);
    if (boundary !== 'swap') assert.deepEqual(memory.summary(), before);
    else {
      assert.ok(memory.summary().rendererPeakMB > 0 && memory.summary().gpuPeakMB > 0, 'genuine readings survive late guard failure');
      assert.ok(memory.summary().samples >= (before?.samples || 0));
    }
    await assert.rejects(memory.waitForScope(), /identity|attribution/);
  } finally { memory.stop(); }
}
// After admission, the sampler must abort its own pending guard read even
// when no new admission waiter exists to discover the loss for it.
for (const acquired of [false, true]) for (const loss of ['gpu-version', 'revoked', 'ambiguous']) {
  const { state, memory } = await world();
  try {
    if (acquired) await memory.waitForScope({ timeoutMs: 200 });
    state.boundary = 'swap';
    const tick = memory.sampler.tick(); await state.entered.promise;
    change(state, loss); state.release.resolve(); await tick;
    checkDenied(state, memory, loss);
    assert.ok(memory.summary().rendererPeakMB > 0 && memory.summary().gpuPeakMB > 0);
  } finally { memory.stop(); }
}
// The native metadata read itself is synchronous, but the subsequent tick
// drain yields. A change in that yield must invalidate the readiness result.
for (const loss of ['gpu-version', 'revoked', 'ambiguous']) {
  const { state, memory } = await world();
  try {
    let guardRead = false, changed = false;
    state.afterGuardRead = () => { guardRead = true; };
    state.afterResolve = () => {
      if (guardRead && !changed) { changed = true; queueMicrotask(() => change(state, loss)); }
    };
    await assert.rejects(memory.waitForScope({ timeoutMs: 200 }), /identity|attribution/);
    assert.equal(changed, true);
    checkDenied(state, memory, loss);
  } finally { memory.stop(); }
}

// A request during a successful old tick still needs a new positive sample.
{
  const { state, memory } = await world();
  try {
    state.boundary = 'swap';
    const oldTick = memory.sampler.tick(); await state.entered.promise;
    state.beforeRead = () => { if (state.reads === 2) state.readMode = 'zero'; };
    const checked = assert.rejects(memory.waitForScope({ timeoutMs: 200 }), /footprint/);
    state.release.resolve(); await oldTick; await checked;
    assert.equal(state.reads, 2, 'a pre-request tick cannot satisfy admission');
    assert.equal(memory.summary().samples, 1, 'the genuine old sample is retained; zero data adds no observation');
    checkDenied(state, memory, 'footprint');
  } finally { memory.stop(); }
}
for (const acquired of [false, true]) for (const request of ['before-tick', 'inflight']) {
  const { state, memory } = await world();
  try {
    if (acquired) await memory.sampler.tick();
    const before = state.reads;
    state.boundary = 'swap';
    let tick, waiting;
    if (request === 'inflight') { tick = memory.sampler.tick(); await state.entered.promise; }
    waiting = memory.waitForScope({ timeoutMs: 200 });
    if (!tick) await state.entered.promise;
    state.release.resolve();
    const sample = await waiting; if (tick) await tick;
    assert.equal(state.reads - before, request === 'inflight' ? 2 : 1);
    assert.ok(sample.rendererBytes > 0 && sample.gpuBytes > 0);
    assert.deepEqual(sample.renderer.map(p => p.pid), [renderer.pid]);
    assert.deepEqual(sample.gpu.map(p => p.pid), [gpu.pid]);
    memory.assertAdmissionScope(sample);
    assert.equal(memory.verdict, null);
  } finally { memory.stop(); }
}
for (const acquired of [false, true]) {
  const { state, memory } = await world();
  try {
    if (acquired) await memory.sampler.tick();
    const before = memory.summary();
    state.boundary = 'footprint';
    const oldTick = memory.sampler.tick(); await state.entered.promise;
    await assert.rejects(memory.waitForScope({ timeoutMs: 20 }), /timed out before workload admission/);
    checkDenied(state, memory, 'footprint');
    state.release.resolve(); await oldTick;
    assert.deepEqual(memory.summary(), before, 'late reads after the bounded warmup failure cannot add observations or readiness');
  } finally { memory.stop(); }
}

// Observe every real production grant write, including loss after the awaited
// readiness result but before the caller's synchronous admission continuation.
for (const acquired of [false, true]) for (const boundary of ['swap', 'after-wait']) for (const loss of [...losses, 'valid']) {
  const out = mkdtempSync('/private/tmp/nc229-codex-handoff/native-admission-finish-unit-');
  const resultsDir = join(out, 'results'); mkdirSync(resultsDir);
  const { state, memory } = await world();
  let interval;
  const originalWrite = fs.writeFileSync;
  try {
    if (acquired) await memory.sampler.tick();
    let requestReached;
    const requested = new Promise(resolve => { requestReached = resolve; });
    const originalWait = memory.waitForScope;
    memory.waitForScope = async options => {
      const pending = originalWait(options); requestReached();
      const sample = await pending;
      if (boundary === 'after-wait' && loss !== 'valid') change(state, loss);
      return sample;
    };
    let tick;
    if (boundary === 'swap') { state.boundary = 'swap'; tick = memory.sampler.tick(); await state.entered.promise; }
    let files, grants = 0, metrics = {};
    const grantStates = [];
    fs.writeFileSync = (file, data, ...options) => {
      if (file === files?.grant) grantStates.push(JSON.parse(data).state);
      return originalWrite(file, data, ...options);
    };
    syncBuiltinESMExports();
    const scenario = tauriScenario('s1', { ref: { port: 5661, resultsDir, worktree: { path: process.cwd() } }, fixtureNames: ['tiny.png'],
      record: (key, value) => { metrics[key] = value; }, note() {}, log() {}, outDir: out, label: loss,
      memory, release: false, scopeTimeoutMs: 300, timeoutMs: 1000,
      spawnProcess: (bin, argv) => {
        const child = new EventEmitter(); Object.assign(child, { pid: root.pid, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
        const token = new URL(JSON.parse(argv[argv.indexOf('--config') + 1]).build.devUrl).searchParams.get('admission');
        files = admissionPaths(resultsDir, token); writeFileSync(files.request, '{}');
        interval = setInterval(() => {
          if (grants || !existsSync(files.grant) || JSON.parse(readFileSync(files.grant)).state !== 'admitted') return;
          grants++;
          writeFileSync(join(resultsDir, 'result-tiny.json'), JSON.stringify({ scenario: 's1', error: 'controlled later interruption',
            parts: [{ name: 'import', before: 0, events: [{ k: 'req', t: 1, cls: 'libraw', fn: 'open' }] }] }));
        }, 1);
        return child;
      } });
    const checked = assert.rejects(scenario, loss === 'valid' ? /controlled later interruption/ : /identity|attribution/);
    await requested;
    if (boundary === 'swap') { if (loss !== 'valid') change(state, loss); state.release.resolve(); await tick; }
    await checked;
    assert.equal(grants, loss === 'valid' ? 1 : 0, 'no bad schedule may publish a workload grant');
    assert.equal(grantStates.includes('admitted'), loss === 'valid', 'assert every grant write, including transient writes');
    assert.equal(JSON.parse(readFileSync(files.grant)).state, 'aborted');
    if (loss === 'valid') {
      assert.equal(metrics['s1.librawDecodes'], 1, 'readable genuine partial metrics survive later report failure');
      assert.equal(memory.verdict, null);
    } else {
      checkDenied(state, memory, loss);
      assert.ok(memory.summary()?.rendererPeakMB > 0, 'genuine measured bytes remain readable after denial');
    }
  } finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); clearInterval(interval); memory.stop(); }
}
console.log('WebKit admission finish: pending-await losses, fresh request samples, 4 valid grants, 20 caller denials and retained partial metrics passed (tiny fake OS data, real production callers/validator).');
