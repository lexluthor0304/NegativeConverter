import assert from 'node:assert/strict';
import { createCpuPreviewRenderer } from './cpuPreviewRenderer.js';

const tick = () => new Promise(setImmediate);
function fixture() {
  const calls = [], frames = [], fallbacks = [];
  let available = true;
  const workers = {
    isWorkerAvailable: () => available, workerAlive: true, residentBytes: 12,
    workerApplyPreviewAdjustments(source, settings, revision) {
      return new Promise((resolve, reject) => calls.push({ source, settings, revision, resolve, reject }));
    },
    cancelWorkerRequests() {
      for (const call of calls) call.reject(Object.assign(new Error('released'), { name: 'AbortError' }));
    }
  };
  const renderer = createCpuPreviewRenderer({ workers });
  const source = { width: 512, height: 256, data: { byteLength: 524288 } };
  const job = (id, current = () => true) => ({ source, settings: { id }, revision: 7, current,
    present: frame => frames.push(frame), fallback: () => fallbacks.push(id) });
  return { renderer, calls, frames, fallbacks, source, job, unavailable: () => { available = false; } };
}

{
  const f = fixture();
  for (let id = 0; id < 100; id++) assert.equal(f.renderer.request(f.job(id)), true);
  assert.equal(f.calls.length, 1, 'only one frame is copied and posted during a burst');
  assert.equal(f.renderer.diagnostics.coalesced, 98);
  f.calls[0].resolve('first');
  await tick();
  assert.deepEqual(f.frames, ['first'], 'continuous input does not starve presentation');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].settings.id, 99, 'only the latest waiting recipe runs');
  assert.equal(f.calls[1].revision, 7, 'the revision of mutable source pixels reaches the bridge');
  f.calls[1].resolve('last');
  await tick();
  assert.deepEqual(f.frames, ['first', 'last']);
  assert.equal(f.renderer.busy, false);
  assert.equal(f.renderer.residentBytes, 12, 'completed jobs retain no input wrapper');
}

for (const invalidate of ['cancel', 'source', 'release']) {
  const f = fixture();
  let current = true;
  f.renderer.request(f.job(1, () => current));
  f.renderer.request(f.job(2, () => current));
  if (invalidate === 'source') current = false;
  else f.renderer[invalidate]();
  f.calls[0].resolve('obsolete');
  await tick();
  assert.deepEqual(f.frames, [], invalidate);
  assert.deepEqual(f.fallbacks, [], 'obsolete/cancelled frames never run on main');
  assert.equal(f.calls.length, 1, 'obsolete queued input was not copied');
  assert.equal(f.renderer.busy, false);
  f.renderer.request(f.job(3));
  f.calls[1].resolve('new');
  await tick();
  assert.deepEqual(f.frames, ['new'], 'the lane resumes after invalidation');
}

for (const failure of ['null', 'error', 'abort']) {
  const f = fixture();
  f.renderer.request(f.job(1));
  if (failure === 'null') f.calls[0].resolve(null);
  else f.calls[0].reject(Object.assign(new Error(failure), { name: failure === 'abort' ? 'AbortError' : 'Error' }));
  await tick();
  assert.deepEqual(f.fallbacks, failure === 'abort' ? [] : [1]);
  assert.equal(f.renderer.busy, false);
}

{
  const f = fixture();
  assert.equal(f.renderer.request({ ...f.job(1), source: { width: 64, height: 64 } }), false);
  f.unavailable();
  assert.equal(f.renderer.request(f.job(2)), false);
  assert.equal(f.calls.length, 0);
}
console.log('cpuPreviewRenderer: bounded coalescing, continuous presentation, cancellation, ownership and failure recovery passed');
