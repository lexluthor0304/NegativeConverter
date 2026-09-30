// #264: a post-decode worker that fails after it started building a shared
// RGBA16 plane. Before the defect pass completed ('packed') the plane may be
// partly repaired, and repairing it again would not be exact: the decode is
// lost (the loader takes its embedded-preview path), as a lost transfer is.
// After the pass ('repaired') the remaining steps only read the plane, so the
// page finishes them with the same result.
import assert from 'node:assert/strict';
import { describeView, runRawPostDecode } from './rawPostDecode.js';
import { makeRawResult, cloneRawResult } from './rawPostDecode.fixtures.mjs';

let failAt = 'packed';
class FakeWorker {
  constructor() { this.onmessage = null; }
  postMessage(message) {
    queueMicrotask(() => {
      if (message.type === 'ping') { this.onmessage?.({ data: { type: 'pong', id: message.id } }); return; }
      // The worker built the shared plane and failed at `failAt`.
      const input = new Uint16Array(message.input.buffer, message.input.byteOffset, message.input.length);
      const reference = runRawPostDecode({ width: message.width, height: message.height, bits: message.bits, colors: message.colors, data: input }, message.options);
      const shared = new Uint16Array(new SharedArrayBuffer(reference.rgba16.byteLength));
      shared.set(reference.rgba16);
      this.onmessage?.({ data: {
        type: 'error', id: message.id, message: 'out of memory', stage: failAt, rgba16: describeView(shared),
        ...(failAt === 'repaired' ? { defects: reference.defects } : {})
      } });
    });
  }
  terminate() {}
}
globalThis.Worker = FakeWorker;
const { startRawPostDecode } = await import('./rawPostDecodeClient.js');

const fixture = makeRawResult({ width: 64, height: 43, seed: 5, channels: 3, bits: 16 });
const options = { suppressSensorDefects: true, filmStats: null, sharedPlanes: true };
{
  failAt = 'packed';
  const handle = startRawPostDecode();
  await assert.rejects(handle.run(cloneRawResult(fixture), options), (error) => error.code === 'RAW_POST_DECODE_LOST',
    'a shared plane lost mid-repair is not repaired again');
  handle.terminate();
}
{
  failAt = 'repaired';
  const handle = startRawPostDecode();
  const outcome = await handle.run(cloneRawResult(fixture), options);
  const expected = runRawPostDecode(cloneRawResult(fixture), { suppressSensorDefects: true, filmStats: null });
  assert.equal(outcome.garbled, false);
  assert.ok(outcome.rgba16.buffer instanceof SharedArrayBuffer, 'the shared plane is kept');
  assert.deepEqual([...outcome.rgba16], [...expected.rgba16]);
  assert.deepEqual([...outcome.rgba8], [...expected.rgba8], 'the 8-bit mirror finished on this thread');
  assert.deepEqual(outcome.defects, expected.defects);
  handle.terminate();
}
delete globalThis.Worker;
console.log('rawPostDecodeClient: a shared plane lost mid-repair is lost; a repaired one finishes');
