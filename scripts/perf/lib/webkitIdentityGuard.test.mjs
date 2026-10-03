import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebKitOwnership, sameProcess } from './webkit-ownership.mjs';
import { webkitMemory, tauriScenario } from './webkit.mjs';
import { admissionPaths } from '../preview-plugin.mjs';

const identity = (pid, path, parentPid = 1, parentUnique = '0') => ({ pid, path, parentPid, parentUnique, unique: String(pid + 100), version: 7, uid: 501 });
const root = identity(900000071, '/owned/launcher'), host = identity(900000072, '/owned/native-host', root.pid, root.unique);
const renderer = identity(900000073, '/framework/com.apple.WebKit.WebContent'), gpu = identity(900000074, '/framework/com.apple.WebKit.GPU');
const outsider = identity(900000075, '/another/owned-host');
const endpoint = (identity, instance) => ({ identity, instance, auditToken: [0, 501, 501, 501, 501, identity.pid, 0, identity.version] });
const initial = { source: 'wkwebview+xpc-oneshot', owner: host, ancestors: [root], port: 5631, views: [{
  renderer: endpoint(renderer, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), gpu: endpoint(gpu, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb') }] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function world({ automatic = false, pending = false } = {}) {
  const state = { snapshot: structuredClone(initial), current: Object.fromEntries([root, host, renderer, gpu, outsider].map(p => [p.pid, structuredClone(p)])),
    listed: [], reads: [], signals: [], aborts: [], readMode: 'valid', listMode: 'valid', swapUsed: 0, diskBytes: 100 * 1024 ** 3 };
  if (pending) state.snapshot.views = [];
  const ownership = new WebKitOwnership({ library: '/fake/observer', file: '/fake/log', port: 5631, write() {},
    read: () => JSON.stringify(state.snapshot) + '\n', metadata: (pids, request = {}) => {
      const current = Object.fromEntries(pids.map(pid => [pid, state.current[pid]]));
      if (request.descendantsOf) current.descendants = [{ chain: [state.current[host.pid], root] }, { chain: [outsider] }];
      if (request.signal) {
        const chain = request.ownedChain;
        const valid = request.expected.every(p => sameProcess(p, state.current[p.pid]))
          && (!chain || chain.slice(0, -1).every((p, i) => p.parentPid === chain[i + 1].pid && p.parentUnique === chain[i + 1].unique));
        if (valid) state.signals.push({ pid: request.signal.identity.pid, number: request.signal.number, native: !!chain });
        return { signalled: valid };
      }
      return current;
    } });
  const memory = await webkitMemory({ label: 'pure-real-caller', port: 5631, outDir: '.', args: {}, ownership,
    start: automatic, intervalMs: 5, sampleTimeoutMs: 20, swapAtStart: 0, ceilingBytes: 1024 ** 3,
    readSwap: async () => ({ used: state.swapUsed }), readDisk: () => state.diskBytes,
    list: async () => state.listMode === 'hang' ? new Promise(() => {}) : state.listed,
    reader: { start: async () => {}, stop() {}, read: async pids => {
      state.reads.push(pids);
      if (state.readMode === 'hang') return new Promise(() => {});
      if (state.readMode === 'error') throw new Error('controlled footprint reader failure');
      return Object.fromEntries(pids.filter(pid => !(state.readMode === 'missing' && pid === gpu.pid))
        .map(pid => [pid, { footprint: state.readMode === 'zero' || (state.readMode === 'zero-gpu' && pid === gpu.pid) ? 0 : 2 * 1024 ** 2 }]));
    } }, onAbort: verdict => state.aborts.push(verdict) });
  state.listed = [renderer, gpu].map(p => ({ pid: p.pid, command: p.path }));
  memory.bindProcess({ pid: root.pid, exitCode: null });
  return { state, memory, ownership };
}

for (const loss of ['version', 'reuse', 'missing', 'revoked', 'ambiguous', 'updated-version', 'missing-footprint', 'reader-error', 'reader-timeout', 'provider-timeout']) {
  const { state, memory } = await world();
  try {
    await memory.sampler.tick();
    await memory.waitForScope({ timeoutMs: 50 });
    const before = memory.summary();
    if (loss === 'version') state.current[gpu.pid].version++;
    if (loss === 'reuse') state.current[gpu.pid].unique = 'reused';
    if (loss === 'missing') delete state.current[gpu.pid];
    if (loss === 'revoked') state.snapshot.views = [];
    if (loss === 'ambiguous') state.snapshot.views.push(structuredClone(state.snapshot.views[0]));
    if (loss === 'updated-version') {
      state.current[gpu.pid].version++;
      state.snapshot.views[0].gpu.identity.version++;
      state.snapshot.views[0].gpu.auditToken[7]++;
    }
    if (loss === 'missing-footprint') state.readMode = 'missing';
    if (loss === 'reader-error') state.readMode = 'error';
    if (loss === 'reader-timeout') state.readMode = 'hang';
    if (loss === 'provider-timeout') state.listMode = 'hang';
    await memory.sampler.tick();
    assert.equal(memory.verdict?.reason, 'error', `${loss} must automatically abort the real sampler caller`);
    assert.equal(state.aborts.length, 1);
    assert.equal(memory.sampler.samples.length, before.samples, 'no zero/partial replacement can erase the valid samples');
    assert.deepEqual(memory.summary(), before, 'partial metrics survive the failure');
    assert.ok(state.signals.some(p => p.native && p.pid === host.pid), 'verified cleanup stops the actual native host');
    assert.ok(state.signals.some(p => p.native && p.pid === root.pid), 'verified cleanup stops its launcher too');
    assert.ok(!state.signals.some(p => p.pid === outsider.pid), 'a second owned instance remains untouched');
    if (['version', 'reuse', 'missing', 'revoked', 'ambiguous', 'updated-version'].includes(loss)) {
      assert.ok(!state.signals.some(p => p.pid === gpu.pid), 'changed/reused/revoked/ambiguous endpoints never receive signals');
    }
    await memory.sampler.tick();
    assert.equal(state.aborts.length, 1, 'abort is latched');
  } finally { memory.stop(); }
  console.log(`native identity guard: ${loss} passed (pure OS data)`);
}

// A previously acquired scope is not a reusable admission grant. This loss
// precedes the next automatic timer tick and the page's first gate request.
{
  const { state, memory } = await world();
  try {
    await memory.sampler.tick();
    const before = memory.summary();
    state.current[gpu.pid].version++;
    await assert.rejects(memory.waitForScope({ timeoutMs: 50 }), /identity|attribution/);
    assert.equal(memory.verdict?.reason, 'error');
    assert.deepEqual(memory.summary(), before);
    assert.ok(state.signals.some(p => p.native && p.pid === host.pid));
    assert.ok(!state.signals.some(p => p.pid === gpu.pid));
  } finally { memory.stop(); }
}

for (const outcome of ['ready', 'timeout', 'zero', 'zero-gpu', 'initial-invalid', 'initial-reuse', 'initial-ambiguous', 'changed-launcher']) {
  const { state, memory, ownership } = await world({ pending: true });
  try {
    await memory.sampler.tick();
    assert.equal(memory.summary(), null, 'pending initial scope is absent, never zero-byte metrics');
    assert.equal(memory.scopeAcquired, false);
    const waiting = memory.waitForScope({ timeoutMs: 30 });
    const checked = outcome === 'ready' ? waiting : assert.rejects(waiting, /attribution|identity/);
    if (['ready', 'initial-invalid', 'initial-reuse', 'initial-ambiguous'].includes(outcome)) {
      state.snapshot = structuredClone(initial);
      if (outcome === 'initial-invalid') state.current[gpu.pid].version++;
      if (outcome === 'initial-reuse') state.current[gpu.pid].unique = 'reused';
      if (outcome === 'initial-ambiguous') state.snapshot.views.push(structuredClone(state.snapshot.views[0]));
      await memory.sampler.tick();
    }
    if (outcome === 'zero') { state.snapshot = structuredClone(initial); state.readMode = 'zero'; await memory.sampler.tick(); }
    if (outcome === 'zero-gpu') { state.snapshot = structuredClone(initial); state.readMode = 'zero-gpu'; await memory.sampler.tick(); }
    if (outcome === 'changed-launcher') state.current[root.pid].version++;
    await checked;
    if (outcome === 'ready') assert.equal(memory.scopeAcquired, true);
    else {
      assert.equal(memory.verdict?.reason, 'error');
      if (outcome === 'zero-gpu') {
        assert.equal(memory.summary().rendererPeakMB, 2);
        assert.equal(memory.summary().gpuPeakMB, null, 'zero GPU placeholder remains unavailable, never a zero measurement');
      } else assert.equal(memory.summary(), null);
      if (outcome === 'changed-launcher') assert.deepEqual(state.signals, [], 'changed launcher invalidates stop authority');
      else assert.ok(state.signals.some(p => p.pid === host.pid), 'missing initial association still stops the ancestry-verified host');
    }
    assert.ok(!ownership.cleanupAttempts.some(p => p.pid === outsider.pid));
  } finally { memory.stop(); }
}

for (const guard of ['swap', 'disk']) {
  const { state, memory } = await world({ pending: true });
  try {
    if (guard === 'swap') state.swapUsed = 3 * 1024 ** 3; else state.diskBytes = 19 * 1024 ** 3;
    await memory.sampler.tick();
    assert.equal(memory.verdict?.reason, 'memory-ceiling', 'swap/disk guards remain active before attribution');
    assert.equal(memory.summary(), null);
    assert.ok(state.signals.some(p => p.pid === host.pid));
  } finally { memory.stop(); }
}

// A legacy origin/GPU hint can supply partial observations but cannot grant
// actual native workload admission or bypass the identity-aware cleanup.
{
  const raw = [], kill = process.kill;
  process.kill = (...args) => { raw.push(args); return true; };
  let listed = [];
  const memory = await webkitMemory({ label: 'no-native-authority', port: 5631, outDir: '.', args: {}, start: false,
    ceilingBytes: 1, swapAtStart: 0, readSwap: async () => ({ used: 0 }), readDisk: () => 100 * 1024 ** 3,
    list: async () => listed, connected: async () => [renderer.pid], associatedGpu: async () => [gpu.pid],
    reader: { start: async () => {}, stop() {}, read: async pids => Object.fromEntries(pids.map(pid => [pid, { footprint: 1024 ** 2 }])) } });
  try {
    memory.bindProcess({ pid: root.pid, exitCode: null });
    listed = [renderer, gpu].map(p => ({ pid: p.pid, command: p.path }));
    await memory.sampler.tick();
    await assert.rejects(memory.waitForScope(), /native workload ownership/);
    assert.equal(memory.stopOwnedProcess('SIGKILL'), false);
  } finally { memory.stop(); process.kill = kill; }
  assert.deepEqual(raw, [], 'no PID-only launcher or endpoint kill fallback');
}

// The actual Tauri launcher/caller writes the grant only after a valid sample.
// A tiny fake child supplies bootstrap, a completed partial report and exit.
for (const outcome of ['success', 'initial-timeout', 'midrun-loss', 'launcher-error', 'scenario-timeout', 'grant-io-error']) {
  const out = mkdtempSync(process.env.NC_PERF_TEST_TMP_PREFIX || '/private/tmp/nc229-codex-handoff/native-identity-guard-unit-');
  const resultsDir = join(out, 'results'); mkdirSync(resultsDir);
  const { state, memory } = await world({ automatic: true, pending: true });
  let files, admitted = false, runner, interval, metrics = {};
  try {
    const promise = tauriScenario('s1', { ref: { port: 5631, resultsDir, worktree: { path: process.cwd() } },
      fixtureNames: ['tiny.png'], record: (key, value) => { metrics[key] = value; }, note() {}, log() {}, outDir: out,
      label: outcome, memory, release: false, scopeTimeoutMs: outcome === 'initial-timeout' ? 35 : 1000,
      timeoutMs: outcome === 'scenario-timeout' ? 250 : 1500,
      spawnProcess: (bin, argv) => {
        runner = new EventEmitter(); Object.assign(runner, { pid: root.pid, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
        const config = JSON.parse(argv[argv.indexOf('--config') + 1]);
        const token = new URL(config.build.devUrl).searchParams.get('admission');
        files = admissionPaths(resultsDir, token);
        if (outcome === 'launcher-error') setTimeout(() => runner.emit('error', new Error('controlled launcher failure')), 1);
        else if (outcome !== 'scenario-timeout') writeFileSync(files.request, '{}');
        if (outcome === 'grant-io-error') mkdirSync(files.grant); // EISDIR on grant/revocation writes.
        else interval = setInterval(() => {
          if (!existsSync(files.grant) || JSON.parse(readFileSync(files.grant)).state !== 'admitted' || admitted) return;
          admitted = true;
          assert.equal(memory.scopeAcquired, true, 'heavy workload cannot run on an unknown/zero scope');
          if (outcome === 'midrun-loss') state.current[gpu.pid].version++;
          writeFileSync(join(resultsDir, 'result-pure.json'), JSON.stringify({ scenario: 's1', error: outcome === 'midrun-loss' ? 'later interruption' : undefined,
            parts: [{ name: 'import', before: 0, events: [{ k: 'req', t: 1, cls: 'libraw', fn: 'open' }] }] }));
        }, 2);
        return runner;
      } });
    const checked = outcome === 'success' ? promise : assert.rejects(promise, /attribution|identity|interruption|launcher failure|no result|EISDIR/);
    if (['success', 'midrun-loss', 'grant-io-error'].includes(outcome)) {
      await sleep(10);
      assert.equal(admitted, false);
      if (outcome !== 'grant-io-error') assert.ok(!existsSync(files.grant), 'bootstrap alone cannot grant workload');
      state.snapshot = structuredClone(initial);
    }
    await checked;
    if (outcome !== 'grant-io-error') assert.equal(JSON.parse(readFileSync(files.grant)).state, 'aborted', 'every exit revokes its unique grant');
    assert.ok(state.signals.some(p => p.pid === host.pid), 'caller errors/timeouts stop the actual verified workload');
    if (outcome === 'success' || outcome === 'midrun-loss') assert.equal(metrics['s1.librawDecodes'], 1, 'genuine partial metrics survive');
    else assert.equal(admitted, false);
    if (outcome === 'midrun-loss') {
      assert.equal(memory.verdict?.reason, 'error', 'this is an automatic sampler abort, not the final result assertion');
      assert.equal(state.aborts.length, 1);
    }
  } finally { clearInterval(interval); memory.stop(); }
  console.log(`native identity guard: actual Tauri caller ${outcome} passed (fake child, no native workload)`);
}
