import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ISOLATION_PROBE } from './crossOriginIsolation.js';
import { probeWorker, collectIsolationReport, formatIsolationLine, WORKER_PROBES } from './isolationReport.js';

const here = dirname(fileURLToPath(import.meta.url));
const workersDir = join(here, '..', 'workers');

// A worker that answers the probe like workers/isolationProbe.js does, after
// an unrelated message of its own (a worker's "ready").
class FakeWorker {
  constructor({ isolated = true, answer = true, throwOnPost = false, wrongId = false } = {}) {
    Object.assign(this, { isolated, answer, throwOnPost, wrongId, terminated: false, onmessage: null, onerror: null });
  }
  postMessage(message) {
    if (this.throwOnPost) throw new Error('post refused');
    queueMicrotask(() => {
      this.onmessage?.({ data: { ready: true } });
      if (!this.answer) return;
      const id = this.wrongId ? message.id + 1 : message.id;
      this.onmessage?.({ data: { type: ISOLATION_PROBE, id, crossOriginIsolated: this.isolated, sharedArrayBuffer: this.isolated, secureContext: true } });
    });
  }
  terminate() { this.terminated = true; }
}

{
  const worker = new FakeWorker();
  const answer = await probeWorker(() => worker);
  assert.deepEqual(answer, { crossOriginIsolated: true, sharedArrayBuffer: true, secureContext: true });
  assert.equal(worker.terminated, true, 'the probed worker is terminated');
}
{
  const answer = await probeWorker(() => new FakeWorker({ isolated: false }));
  assert.equal(answer.crossOriginIsolated, false);
}
{
  const answer = await probeWorker(() => { throw new Error('blocked by COEP'); });
  assert.match(answer.error, /blocked by COEP/);
}
{
  const answer = await probeWorker(() => new FakeWorker({ throwOnPost: true }));
  assert.match(answer.error, /post refused/);
}
{
  const worker = new FakeWorker({ answer: false });
  const answer = await probeWorker(() => worker, { timeoutMs: 20 });
  assert.equal(answer.error, 'no answer');
  assert.equal(worker.terminated, true);
}
{
  const answer = await probeWorker(() => new FakeWorker({ wrongId: true }), { timeoutMs: 20 });
  assert.equal(answer.error, 'no answer', 'an answer to another probe is not this one');
}
{
  let failing;
  const answer = await probeWorker(() => {
    failing = new FakeWorker({ answer: false });
    queueMicrotask(() => failing.onerror?.({ message: 'script failed to load', preventDefault() {} }));
    return failing;
  });
  assert.match(answer.error, /script failed to load/);
}

// ---- the whole report (Node's page is not isolated)
{
  const probes = { a: () => new FakeWorker(), b: () => new FakeWorker({ isolated: false }), c: () => new FakeWorker() };
  const report = await collectIsolationReport({ probes, libraw: false, concurrency: 2 });
  assert.deepEqual(Object.keys(report.workers).sort(), ['a', 'b', 'c']);
  assert.equal(report.workers.b.crossOriginIsolated, false);
  assert.equal(report.page.crossOriginIsolated, false);
  assert.equal(report.allIsolated, false);
  assert.equal(typeof report.planeGuard.enabled, 'boolean');
  const only = await collectIsolationReport({ probes, names: ['a'], libraw: false });
  assert.deepEqual(Object.keys(only.workers), ['a']);
  const line = formatIsolationLine({ page: { crossOriginIsolated: true, sharedArrayBuffer: true, secureContext: true },
    workers: { a: { crossOriginIsolated: true }, libraw: { crossOriginIsolated: true, inferred: true }, heif: { error: 'no answer' } } });
  assert.equal(line, 'isolation page=1 sab=1 secure=1 workers: a=1 libraw=1~ heif=error(no answer)');
}

// ---- every worker entry answers the probe, and the report knows every worker
{
  const entries = readdirSync(workersDir).filter((name) => /Worker\.js$/.test(name));
  assert.ok(entries.length >= 11);
  for (const name of entries) {
    const source = readFileSync(join(workersDir, name), 'utf8');
    const firstImport = source.split('\n').find((line) => line.startsWith('import '));
    assert.match(firstImport || '', /^import '\.\/isolationProbe\.js';/, `${name} must import the isolation probe first`);
  }
  const reportSource = readFileSync(join(here, 'isolationReport.js'), 'utf8');
  const probed = new Set([...reportSource.matchAll(/new URL\('\.\.\/workers\/([A-Za-z]+\.js)'/g)].map((m) => m[1]));
  for (const name of entries) assert.ok(probed.has(name), `isolationReport.js must probe ${name}`);

  // Every worker the app starts from a workers/ script is one of them.
  const started = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory()) walk(path);
      else if (/\.js$/.test(name.name) && !/\.test\./.test(name.name)) {
        const source = readFileSync(path, 'utf8');
        for (const m of source.matchAll(/new URL\('(?:\.\.\/workers\/|\.\/)([A-Za-z]+Worker\.js)'/g)) started.add(m[1]);
      }
    }
  };
  walk(join(here, '..'));
  for (const name of started) assert.ok(entries.includes(name), `${name} is started but is not a workers/ entry`);

  const heif = readFileSync(join(here, '..', '..', 'public', 'codecs', 'heif-worker.js'), 'utf8');
  assert.ok(heif.indexOf(ISOLATION_PROBE) >= 0 && heif.indexOf(ISOLATION_PROBE) < heif.indexOf('self.onmessage'),
    'the classic HEIF worker answers the probe before its decode handler');
  assert.ok(typeof WORKER_PROBES.heif === 'function' && typeof WORKER_PROBES.blob === 'function');
}

console.log('isolationReport tests passed');
