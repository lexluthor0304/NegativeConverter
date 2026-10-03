// Run only under with-test-lock.sh + with-browser-lock.sh + caffeinate -di.
// This validates ownership/guard correctness, never performance acceptance.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildWebKitObserver, WebKitOwnership, processMetadata } from './lib/webkit-ownership.mjs';
import { webkitMemory, launchWebKitScript } from './lib/webkit.mjs';

const run = promisify(execFile), port = Number(process.env.PORT || 5581);
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const library = await buildWebKitObserver(out), binary = join(out, 'tiny-wkwebview');
// Reproduce the installed Tauri shim's interpreter path without running its
// CLI/build. The production script launcher must preserve the real observer.
const envProbe = join(out, 'dyld-env-probe.js');
writeFileSync(envProbe, '#!/usr/bin/env node\nconsole.log(JSON.stringify({observer:process.env.DYLD_INSERT_LIBRARIES||null}));\n', { mode: 0o700, flag: 'wx' });
const env = { ...process.env, DYLD_INSERT_LIBRARIES: library };
const shebang = JSON.parse((await run(envProbe, [], { env })).stdout);
const directNode = JSON.parse((await run(process.execPath, [envProbe], { env })).stdout);
writeFileSync(join(out, 'launcher-environment.json'), JSON.stringify({ shebang, directNode }, null, 2) + '\n');
assert.equal(shebang.observer, null, 'the protected env shebang drops the injected observer on this OS');
assert.equal(directNode.observer, library, 'direct Node preserves the actual observer library');
const launcher = fileURLToPath(new URL('./native/webkit-fixture-launcher.mjs', import.meta.url));
await run('xcrun', ['clang', '-fobjc-arc', '-O1', '-framework', 'AppKit', '-framework', 'WebKit',
  fileURLToPath(new URL('./native/webkit-fixture.m', import.meta.url)), '-o', binary]);
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end('<!doctype html><canvas width=64 height=48></canvas><script>const gl=document.querySelector("canvas").getContext("webgl2");if(gl){gl.clearColor(.1,.2,.3,1);gl.clear(gl.COLOR_BUFFER_BIT)}setInterval(()=>fetch("/alive"),250)</script>');
});
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [], children = [], owners = [];
function launch(ownership, label, memory = {
  processEnv: () => ownership.environment(), bindProcess: child => ownership.bindProcess(child), stopOwnedProcess: signal => ownership.killOwnedProcess(signal)
}) {
  const { child, unregister } = launchWebKitScript(launcher, [binary, `http://127.0.0.1:${port}/?instance=${label}`], { memory });
  children.push(child); owners.push(ownership);
  child.once('exit', unregister);
  let output = '', errors = '';
  child.stdout.on('data', part => { output += part; });
  child.stderr.on('data', part => { errors += part; });
  child.on('error', error => { errors += String(error); });
  return { child, direct: () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1), errors: () => errors };
}
async function waitFor(ownership, fixture) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const found = ownership.resolve();
    if (found && fixture.direct()) return found;
    if (fixture.child.exitCode !== null) break;
    await sleep(100);
  }
  throw new Error(`native attribution unavailable: ${fixture.errors().slice(-1500)}`);
}
try {
  for (const guard of ['scope', 'memory-ceiling', 'swap-growth', 'low-disk']) {
    const ownership = new WebKitOwnership({ library, file: join(out, `${guard}.jsonl`), port });
    let crossing = false;
    const memory = await webkitMemory({ label: guard, port, outDir: out, args: {}, ownership, start: false,
      swapAtStart: 0, ceilingBytes: guard === 'memory-ceiling' ? 1 : 2 * 1024 ** 3,
      readSwap: async () => ({ used: crossing && guard === 'swap-growth' ? 3 * 1024 ** 3 : 0 }),
      readDisk: () => crossing && guard === 'low-disk' ? 19 * 1024 ** 3 : 100 * 1024 ** 3 });
    const fixture = launch(ownership, guard, memory);
    try {
      const association = await waitFor(ownership, fixture);
      const direct = fixture.direct();
      assert.notEqual(association.owner.pid, ownership.root.pid, 'the native producer is a descendant of the exact bound launcher');
      assert.equal(association.renderer.identity.pid, direct.renderer);
      assert.equal(association.gpu.identity.pid, direct.gpu);
      await memory.assertScope();
      let outsider;
      if (guard === 'scope') {
        const other = new WebKitOwnership({ library, file: join(out, 'other-instance.jsonl'), port });
        outsider = launch(other, 'other');
        const foreign = await waitFor(other, outsider);
        assert.notEqual(foreign.gpu.identity.pid, direct.gpu, 'two native host instances have distinct one-shot GPUs');
        const root = ownership.root;
        ownership.root = other.root;
        assert.equal(ownership.resolve(), null, 'even the same origin/port cannot associate the other owned test process');
        ownership.root = root;
      }
      const expected = [ownership.root, association.owner, association.renderer.identity];
      const stale = expected.map((p, i) => i === 2 ? { ...p, unique: 'stale' } : p);
      assert.equal(processMetadata(expected.map(p => p.pid), {
        expected: stale, signal: { ...association.renderer, number: 0 }
      }).signalled, false, 'identity revalidation rejects stale cleanup without signalling');
      crossing = true;
      await memory.sampler.tick();
      const sampled = memory.sampler.samples.at(-1);
      assert.deepEqual(sampled.renderer.map(p => p.pid), [direct.renderer]);
      assert.deepEqual(sampled.gpu.map(p => p.pid), [direct.gpu]);
      assert.ok(sampled.rendererBytes > 0 && sampled.gpuBytes > 0, 'both actual native footprints were read');
      if (guard === 'scope') {
        assert.equal(memory.verdict, null);
        assert.ok(processMetadata([outsider.direct().renderer])[outsider.direct().renderer], 'unrelated instance remains alive');
        const cleaned = ownership.kill(direct.renderer);
        writeFileSync(join(out, 'cleanup-attempts.json'), JSON.stringify(ownership.cleanupAttempts, null, 2) + '\n');
        assert.equal(cleaned, true, `versioned SIGKILL must clean the proven owned renderer: ${JSON.stringify(ownership.cleanupAttempts)}`);
      } else {
        assert.equal(memory.verdict?.reason, 'memory-ceiling');
        assert.match(memory.verdict.detail, guard === 'swap-growth' ? /swap grew/ : guard === 'low-disk' ? /free disk fell/ : /browser footprint/);
      }
      results.push({ guard, launcher: ownership.root.pid, direct, rendererBytes: sampled.rendererBytes, gpuBytes: sampled.gpuBytes,
        verdict: memory.verdict, cleanupAttempts: ownership.cleanupAttempts,
        assertions: 'native getters, one-shot endpoints, PID identity, scoped sampling and safe cleanup',
        empiricalPerformance: false, policyInputsSynthetic: guard !== 'scope' });
    } finally { memory.stop(); ownership.killOwnedProcess('SIGTERM'); }
  }
  const outsider = owners[1];
  assert.ok(outsider.resolve(), 'the other instance remains owned by its separate launcher after every guarded cleanup');
  writeFileSync(join(out, 'proof.json'), JSON.stringify({ status: 'passed', results, empiricalPerformance: false }, null, 2) + '\n');
  console.log('native WebKit ownership proof passed (tiny correctness fixture; performance unmeasured)');
} finally {
  for (const owner of owners) owner.killOwnedProcess('SIGTERM');
  await sleep(500);
  for (const owner of owners) owner.killOwnedProcess('SIGKILL');
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
