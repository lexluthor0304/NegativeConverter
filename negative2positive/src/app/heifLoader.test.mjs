import assert from 'node:assert/strict';
import { decodeHeifInWorker } from './heifLoader.js';
let terminated = 0;
const good = () => ({ terminate() { terminated++; }, postMessage() { queueMicrotask(() => this.onmessage({ data: { width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) } })); } });
assert.equal((await decodeHeifInWorker({}, { workerFactory: good })).width, 1);
assert.equal(terminated, 1);
await assert.rejects(decodeHeifInWorker({}, { timeoutMs: 2, workerFactory: () => ({ postMessage() {}, terminate() { terminated++; } }) }), /timed out/);
assert.equal(terminated, 2);
assert.equal((await decodeHeifInWorker({}, { workerFactory: good })).height, 1, 'a timeout must not poison the next decode');
console.log('HEIF worker timeout, retry and heap disposal passed');

// Abort must never become HEIC_DECODE_FAILED or retain a decoder heap.
{
  const c = new AbortController(); c.abort(); let created = 0;
  await assert.rejects(decodeHeifInWorker({}, { signal: c.signal, workerFactory: () => { created++; } }), { name: 'AbortError' });
  assert.equal(created, 0);
}
for (const duringFactory of [false, true]) {
  const c = new AbortController(); let stopped = 0, posts = 0, lateReply;
  const worker = { terminate() { stopped++; }, postMessage() { posts++; lateReply = this.onmessage; } };
  const result = decodeHeifInWorker({}, { signal: c.signal, workerFactory: () => {
    if (duringFactory) c.abort();
    return worker;
  } });
  const rejection = assert.rejects(result, { name: 'AbortError' });
  c.abort(); await rejection;
  lateReply?.({ data: { width: 1, height: 1 } });
  assert.equal(stopped, 1, 'abort/late reply dispose exactly once');
  assert.equal(posts, duringFactory ? 0 : 1);
  assert.equal(worker.onmessage, null); assert.equal(worker.onerror, null);
}
assert.equal((await decodeHeifInWorker({}, { workerFactory: good })).width, 1, 'abort does not poison another decode');
console.log('HEIF pre-dispatch/in-flight abort, late reply and recovery passed');
