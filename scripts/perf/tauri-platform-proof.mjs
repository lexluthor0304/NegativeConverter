// Both global locks + caffeinate are required. Tiny native caller correctness,
// never a benchmark: debug app, 64x48 synthetic page, synthetic guard inputs.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildWebKitObserver, WebKitOwnership, processMetadata, sameProcess } from './lib/webkit-ownership.mjs';
import { launchWebKitScript, tauriScenario, webkitMemory } from './lib/webkit.mjs';
import { freeDiskBytes, GiB } from './lib/guards.mjs';

const run = promisify(execFile), out = resolve(process.argv[2]), port = Number(process.env.PORT || 5591);
mkdirSync(out, { recursive: true });
assert.ok(process.env.CARGO_TARGET_DIR, 'source the shared tools/env.sh before this proof');
assert.ok(freeDiskBytes(out) > 4 * GiB, 'tiny proof admission needs 4 GiB free');
const head = (await run('git', ['rev-parse', 'HEAD'])).stdout.trim();
const library = await buildWebKitObserver(out), binary = join(out, 'unrelated-tiny-webview');
await run('xcrun', ['clang', '-fobjc-arc', '-O1', '-framework', 'AppKit', '-framework', 'WebKit',
  fileURLToPath(new URL('./native/webkit-fixture.m', import.meta.url)), '-o', binary]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const resultsDir = join(out, 'results');
mkdirSync(resultsDir, { recursive: true });
let active = null, outsider = null, sequence = 0;
const owners = [], results = [];
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', request.url === '/tiny.js' ? 'text/javascript' : 'text/html');
  if (request.url === '/tiny.js') {
    response.end(`const gl=document.querySelector('canvas').getContext('webgl2');
      if(gl){gl.clearColor(.1,.2,.3,1);gl.clear(gl.COLOR_BUFFER_BIT)}
      (async()=>{let native=null,error=null;
        try{native=await window.__TAURI__.core.invoke('get_memory_info')}catch(e){error=String(e)}
        if(window.__TAURI_INTERNALS__)await fetch('/native-probe',{method:'POST',body:JSON.stringify({guard:${JSON.stringify(active?.guard)},tauri:true,native,error,webgl:!!gl})});
      })();setInterval(()=>fetch('/alive'),250);`);
  } else if (request.url === '/native-probe') {
    let body = '';
    for await (const part of request) body += part;
    const probe = JSON.parse(body);
    if (active && probe.guard === active.guard) active.nativeProbe = probe;
    response.end('ok');
  } else if (request.url === '/alive') response.end('ok');
  else response.end('<!doctype html><canvas width="64" height="48"></canvas><script src="/tiny.js"></script>');
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
function owner(name) {
  const ownership = new WebKitOwnership({ library, file: join(out, `${name}.jsonl`), port });
  owners.push(ownership);
  return ownership;
}
async function startOutsider() {
  const ownership = owner('other-instance');
  const memory = { processEnv: () => ownership.environment(), bindProcess: child => ownership.bindProcess(child),
    stopOwnedProcess: signal => ownership.killOwnedProcess(signal) };
  const launcher = fileURLToPath(new URL('./native/webkit-fixture-launcher.mjs', import.meta.url));
  const launched = launchWebKitScript(launcher, [binary, `http://127.0.0.1:${port}/?instance=other`], { memory });
  launched.child.once('exit', launched.unregister);
  launched.child.stdout.on('data', part => appendFileSync(join(out, 'other-instance.log'), part));
  launched.child.stderr.on('data', part => appendFileSync(join(out, 'other-instance.log'), part));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const association = ownership.resolve();
    if (association) return { ownership, association };
    await sleep(50);
  }
  throw new Error('the independent tiny instance did not provide exclusive endpoint evidence');
}
function checkOutsider() {
  const current = outsider.ownership.resolve();
  assert.ok(current, 'the unrelated tiny instance remains attributed and alive');
  for (const key of ['owner', 'renderer', 'gpu']) {
    const a = key === 'owner' ? current.owner : current[key].identity;
    const b = key === 'owner' ? outsider.association.owner : outsider.association[key].identity;
    assert.ok(sameProcess(a, b), `unrelated ${key} identity must survive every guarded cleanup`);
  }
}
let failure = null;
try {
  for (const guard of ['scope', 'memory-ceiling', 'swap-growth', 'low-disk']) {
    const previousCaches = new Set(readdirSync(out).filter(name => name.startsWith('tauri-cache-')));
    const ownership = owner(guard);
    const state = { guard, nativeProbe: null, association: null, triggerAt: null, abortAt: null, crossing: false };
    active = state;
    const originalResolve = ownership.resolve.bind(ownership);
    ownership.resolve = () => {
      const association = originalResolve();
      if (association && !state.association) state.association = structuredClone(association);
      return association;
    };
    const memory = await webkitMemory({ label: guard, port, outDir: out, args: {}, ownership, swapAtStart: 0,
      ceilingBytes: guard === 'memory-ceiling' ? 1 : 2 * GiB,
      readSwap: async () => ({ used: state.crossing && guard === 'swap-growth' ? 3 * GiB : 0 }),
      readDisk: () => state.crossing && guard === 'low-disk' ? 19 * GiB : 100 * GiB,
      onAbort: verdict => { state.abortAt = Date.now(); state.verdict = verdict; } });
    const metrics = {}, notes = [];
    const started = Date.now();
    let settled = false, posted = false, pendingError = null;
    const scenario = tauriScenario('s1', { ref: { port, resultsDir, worktree: { path: process.cwd() } }, fixtureNames: [],
      record: (key, value) => { metrics[key] = value; }, note: value => notes.push(value), log: value => notes.push(value),
      outDir: out, label: guard, memory, release: false, timeoutMs: 180_000,
      launchLog: text => appendFileSync(join(out, `${guard}-tauri-launch.log`), text)
    }).then(value => { settled = true; return value; }, error => { settled = true; pendingError = error; return null; });
    try {
      while (!settled && Date.now() - started < 185_000) {
        assert.ok(freeDiskBytes(out) > 3.5 * GiB, 'real disk margin must stay above 3.5 GiB during synthetic guard proof');
        const measured = memory.sampler.samples.find(sample => sample.rendererBytes > 0 && sample.gpuBytes > 0);
        if (state.association && measured && guard === 'scope' && !outsider) outsider = await startOutsider();
        if (state.association && measured && state.nativeProbe?.native?.totalBytes > 0 && !state.crossing) {
          if (outsider) checkOutsider();
          state.crossing = true;
          state.triggerAt = Date.now();
          if (guard === 'scope') {
            writeFileSync(join(resultsDir, `result-${Date.now()}-${++sequence}.json`), JSON.stringify({ scenario: 's1', parts: [],
              synthetic: true, nativeCallerProof: state.nativeProbe }));
            posted = true;
          }
        }
        await sleep(50);
      }
      await scenario;
      const measured = memory.sampler.samples.find(sample => sample.rendererBytes > 0 && sample.gpuBytes > 0);
      assert.ok(measured, 'both real footprints must be captured by the automatic sampler');
      assert.ok(state.association?.owner.path.endsWith('/negative-converter'), 'the observer producer is the actual NegativeConverter app');
      assert.equal(state.nativeProbe?.tauri, true);
      assert.ok(state.nativeProbe?.native?.totalBytes > 0, `actual get_memory_info caller failed: ${JSON.stringify(state.nativeProbe)}`);
      if (guard === 'scope') {
        assert.equal(pendingError, null);
        assert.equal(posted, true);
        assert.equal(memory.verdict, null);
      } else {
        assert.ok(pendingError, 'the production scenario caller must reject automatic guard aborts');
        assert.equal(memory.verdict?.reason, 'memory-ceiling');
        assert.match(memory.verdict.detail, guard === 'swap-growth' ? /swap grew/ : guard === 'low-disk' ? /free disk fell/ : /browser footprint/);
        if (guard === 'memory-ceiling') state.triggerAt = measured.t;
        assert.ok(state.abortAt - state.triggerAt >= 0 && state.abortAt - state.triggerAt < 1500, 'observed guard response must be bounded');
      }
      checkOutsider();
      const cacheRoots = readdirSync(out).filter(name => name.startsWith('tauri-cache-') && !previousCaches.has(name));
      assert.equal(cacheRoots.length, 1, 'this exact application launch creates one fresh cache claim');
      const cacheRoot = join(out, cacheRoots[0]);
      assert.ok(existsSync(join(cacheRoot, 'display-proxies', 'session')), 'this exact application startup used its isolated cache');
      results.push({ ...state, crossing: undefined, startedAt: started, settledAt: Date.now(), responseMs: state.abortAt === null ? null : state.abortAt - state.triggerAt,
        callerResponseMs: state.triggerAt === null ? null : Date.now() - state.triggerAt, samples: memory.sampler.samples,
        cleanupAttempts: ownership.cleanupAttempts, root: ownership.root, cacheRoot, metrics, notes, unrelated: outsider.association,
        automaticSampler: true, manualProofTicks: 0, policyInputsSynthetic: true, pageSynthetic: true, nativeFootprintsReal: true });
    } finally { memory.stop(); }
  }
} catch (error) { failure = String(error.stack || error); }
finally {
  active = null;
  for (const ownership of owners) ownership.killOwnedProcess('SIGTERM');
  await sleep(500);
  for (const ownership of owners) ownership.killOwnedProcess('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await sleep(1000);
  const observed = owners.flatMap(ownership => {
    const items = readFileSync(ownership.file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { const item = JSON.parse(line); return [item.owner, ...(item.views || []).flatMap(view => [view.renderer?.identity, view.gpu?.identity])]; }
      catch { return []; }
    });
    return [ownership.root, ...items].filter(Boolean);
  });
  const current = processMetadata(observed.map(item => item.pid));
  const surviving = observed.filter(item => sameProcess(item, current[item.pid]));
  if (surviving.length && !failure) failure = 'original owned native identities remain after bounded cleanup';
  writeFileSync(join(out, 'proof.json'), JSON.stringify({ status: failure ? 'failed' : 'passed', head, failure, results, surviving,
    empiricalPerformance: false, releaseOrHardenedRuntimeProof: false, wholeBenchmarkStarted: false }, null, 2) + '\n');
}
if (failure) throw new Error(failure);
console.log('actual Tauri caller proof passed: automatic synthetic guards, real native footprints, independent tiny-instance preservation');
