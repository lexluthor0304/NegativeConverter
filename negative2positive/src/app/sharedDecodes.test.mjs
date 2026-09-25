import assert from 'node:assert/strict';
import { createSharedDecodes } from './sharedDecodes.js';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function harness() {
  const decodes = [];
  const shared = createSharedDecodes({
    decode(file, { signal, context }) {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const record = { file, signal, context, resolve, reject, aborted: false };
      signal.addEventListener('abort', () => { record.aborted = true; reject(signal.reason); }, { once: true });
      decodes.push(record);
      return promise;
    }
  });
  return { shared, decodes };
}
const fileA = { name: 'a.dng' };
const fileB = { name: 'b.dng' };
const base = { width: 2, height: 2, data: new Uint8ClampedArray(16) };
const meta = { lensModel: 'Summilux', cameraModel: 'M11' };

// One decode for the lane and the foreground that adopts it; both get the
// same base and rawMetadata.
{
  const { shared, decodes } = harness();
  assert.equal(shared.adopt(fileA), null, 'nothing to adopt before a lane opens the file');
  const lane = shared.open(fileA);
  assert.equal(decodes.length, 1);
  assert.equal(shared.inFlight(fileA), true);
  const foreground = shared.adopt(fileA);
  assert.ok(foreground);
  assert.equal(decodes.length, 1, 'adoption never starts a second decode');
  decodes[0].resolve({ base, rawMetadata: meta });
  const [fromLane, fromForeground] = await Promise.all([lane.result, foreground.result]);
  assert.equal(fromLane.base, base);
  assert.equal(fromForeground.base, base, 'the same base object');
  assert.equal(fromForeground.rawMetadata, meta, 'with its rawMetadata');
  assert.deepEqual([...shared.bases()], [base]);
  foreground.release();
  assert.equal(shared.has(fileA), true, 'the owning job still holds the base');
  lane.release();
  assert.equal(shared.has(fileA), false, 'released by the owner: gone');
  assert.equal(decodes[0].aborted, false);
}

// Finished but still held (the lane is analysing it): the foreground adopts it.
{
  const { shared, decodes } = harness();
  const lane = shared.open(fileA);
  decodes[0].resolve({ base, rawMetadata: meta });
  await lane.result;
  assert.equal(shared.inFlight(fileA), false);
  const foreground = shared.adopt(fileA);
  assert.equal((await foreground.result).base, base);
  assert.equal(decodes.length, 1);
  foreground.release();
  lane.release();
  assert.equal(shared.size, 0);
}

// A superseded foreground detaches without cancelling the lane's decode.
{
  const { shared, decodes } = harness();
  const lane = shared.open(fileA);
  const activation = new AbortController();
  const foreground = shared.adopt(fileA, { signal: activation.signal });
  activation.abort(new DOMException('Superseded photo activation', 'AbortError'));
  await assert.rejects(foreground.result, { name: 'AbortError' });
  assert.equal(decodes[0].aborted, false, 'the lane still wants it');
  decodes[0].resolve({ base, rawMetadata: meta });
  assert.equal((await lane.result).base, base);
  lane.release();
}

// A lane job that gives up leaves the decode running for the adopter.
{
  const { shared, decodes } = harness();
  const job = new AbortController();
  const lane = shared.open(fileA, { signal: job.signal });
  const foreground = shared.adopt(fileA);
  job.abort();
  await assert.rejects(lane.result, { name: 'AbortError' });
  assert.equal(decodes[0].aborted, false, 'the foreground still waits');
  decodes[0].resolve({ base, rawMetadata: null });
  assert.equal((await foreground.result).base, base);
  foreground.release();
  assert.equal(shared.size, 0);
}

// Every consumer aborted: the decode is aborted and forgotten.
{
  const { shared, decodes } = harness();
  const job = new AbortController();
  const activation = new AbortController();
  const lane = shared.open(fileA, { signal: job.signal });
  const foreground = shared.adopt(fileA, { signal: activation.signal });
  activation.abort();
  assert.equal(decodes[0].aborted, false);
  job.abort();
  assert.equal(decodes[0].aborted, true, 'nobody waits: the decode stops');
  assert.equal(shared.has(fileA), false);
  await assert.rejects(lane.result, { name: 'AbortError' });
  await assert.rejects(foreground.result, { name: 'AbortError' });
  // The next open starts a fresh decode.
  const again = shared.open(fileA);
  assert.equal(decodes.length, 2);
  again.release();
  assert.equal(decodes[1].aborted, true, 'released before it finished');
}

// A pre-aborted lease never starts anything it would keep alive.
{
  const { shared, decodes } = harness();
  const pre = new AbortController();
  pre.abort();
  const lane = shared.open(fileA, { signal: pre.signal });
  await assert.rejects(lane.result, { name: 'AbortError' });
  assert.equal(decodes[0].aborted, true);
  assert.equal(shared.size, 0);
}

// Errors reach every waiting lease and are never adopted later.
{
  const { shared, decodes } = harness();
  const lane = shared.open(fileA);
  const foreground = shared.adopt(fileA);
  decodes[0].reject(Object.assign(new Error('garbled'), { code: 'RAW_DECODE_GARBLED' }));
  await assert.rejects(lane.result, { code: 'RAW_DECODE_GARBLED' });
  await assert.rejects(foreground.result, { code: 'RAW_DECODE_GARBLED' });
  assert.equal(shared.has(fileA), false);
  assert.equal(shared.adopt(fileA), null);
}

// Files are independent; a second lane on the same file joins, never duplicates.
{
  const { shared, decodes } = harness();
  const a = shared.open(fileA);
  const b = shared.open(fileB);
  const joined = shared.open(fileA);
  assert.equal(decodes.length, 2);
  decodes[0].resolve({ base, rawMetadata: null });
  decodes[1].resolve({ base: { ...base }, rawMetadata: null });
  await Promise.all([a.result, b.result, joined.result]);
  a.release();
  assert.equal(shared.has(fileA), true);
  joined.release(); b.release();
  assert.equal(shared.size, 0);
  // Releasing twice is harmless.
  a.release();
}

// The lease that starts a decode hands its context (its memory claim, #258)
// to decode(); a lease joining a running decode does not replace it.
{
  const { shared, decodes } = harness();
  const claim = { name: 'lane claim' };
  const lane = shared.open(fileB, { context: claim });
  shared.open(fileB, { context: { name: 'other' } });
  assert.equal(decodes.length, 1);
  assert.equal(decodes[0].context, claim);
  decodes[0].resolve({ base, rawMetadata: null });
  await lane.result;
}

await flush();
console.log('sharedDecodes tests passed');
