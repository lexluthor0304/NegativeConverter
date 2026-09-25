import assert from 'node:assert/strict';
import { createDustWorkerClient, dustMaskInfo, forgetDustMaskInfo } from './dustWorkerClient.js';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const image = new ImageData(new Uint8ClampedArray([80, 100, 120, 255]), 1, 1);
image.__image16 = { width: 1, height: 1, data: new Uint16Array([20123, 25234, 30345, 65535]) };
const workers = [];
const client = createDustWorkerClient({ workerFactory: () => {
  const worker = {
    messages: [],
    postMessage(message, transfers) { this.messages.push(structuredClone(message, { transfer: transfers })); },
    terminate() { this.terminated = true; },
    complete(message = this.messages.at(-1)) {
      this.onmessage({ data: { id: message.id, mask: new Uint8Array([255]), particleCount: 1 } });
    }
  };
  workers.push(worker); return worker;
} });
let request = client.detect(image, { strength: 3 });
assert.equal(workers[0].messages[0].image16, undefined, 'detection needs no redundant 16-bit plane');
assert.equal(workers[0].messages[0].reuseSource, false);
workers[0].complete(); await request;
request = client.detect(image, { strength: 5 });
assert.equal(workers[0].messages[1].reuseSource, true);
assert.equal(workers[0].messages[1].rgba, undefined, 'slider updates send settings only');
workers[0].complete(); await request;
const mask = new Uint8Array([255]);
request = client.inpaint(image, mask);
const repair = workers[0].messages[2];
assert.deepEqual(repair.image16, image.__image16.data);
workers[0].onmessage({ data: { id: repair.id, image: { width: 1, height: 1,
  data: image.data.slice(), image16: image.__image16.data.slice() } } });
assert.deepEqual((await request).__image16.data, image.__image16.data);
assert.equal(image.data.byteLength, 4); assert.equal(image.__image16.data.byteLength, 8); assert.equal(mask.byteLength, 1);
const a = client.detect(image), b = client.detect(image);
assert.equal(client.pendingCount, 2);
client.dispose();
await assert.rejects(a, { name: 'AbortError' }); await assert.rejects(b, { name: 'AbortError' });
assert.equal(client.pendingCount, 0); assert.equal(workers[0].terminated, true);
request = client.detect(image); assert.equal(workers[1].messages[0].reuseSource, false);
workers[1].onmessageerror(); await assert.rejects(request, /Invalid/);
assert.equal(workers[1].terminated, true);
request = client.detect(image); workers[2].onerror(); await assert.rejects(request, /crashed/);
let timedWorker;
const timed = createDustWorkerClient({ timeoutMs: 5, workerFactory: () => timedWorker = { postMessage() {}, terminate() { this.terminated = true; } } });
await assert.rejects(timed.detect(image), /timed out/); assert.equal(timedWorker.terminated, true);
let idleWorker;
const idle = createDustWorkerClient({ idleTimeoutMs: 5, workerFactory: () => idleWorker = {
  postMessage(message) { queueMicrotask(() => this.onmessage({ data: { id: message.id, mask, particleCount: 1 } })); },
  terminate() { this.terminated = true; }
} });
await idle.detect(image); await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(idleWorker.terminated, true, 'idle OpenCV/source heap is released');
{
  // The worker's content hash and blocks follow the mask object it returned;
  // a mask without them (or made on the page) never matches a dust pass.
  const info = { hash: 'a'.repeat(32), blocks: { size: 64, columns: 1, keys: Uint32Array.of(0) } };
  let summarize = true;
  const summarizing = createDustWorkerClient({ workerFactory: () => ({
    postMessage(message) {
      const data = { id: message.id, mask: new Uint8Array([255]), particleCount: 1, ...(summarize ? { maskInfo: info } : {}) };
      queueMicrotask(() => this.onmessage({ data }));
    },
    terminate() {}
  }) });
  assert.deepEqual(dustMaskInfo((await summarizing.detect(image)).mask), info);
  summarize = false;
  assert.equal(dustMaskInfo((await summarizing.detect(image)).mask), null);
  assert.equal(dustMaskInfo(new Uint8Array([255])), null);
  // A mask patched in place by a brush stroke drops its summary.
  summarize = true;
  const patched = (await summarizing.detect(image)).mask;
  forgetDustMaskInfo(patched);
  assert.equal(dustMaskInfo(patched), null);
  summarizing.dispose();
}

// ---- #259: a pinned worker keeps both planes and the mask; strokes send points ----
{
  const width = 64, height = 48;
  const frame = new ImageData(new Uint8ClampedArray(width * height * 4).fill(90), width, height);
  frame.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(23130) };
  const frameMask = new Uint8Array(width * height);
  frameMask[100] = 255;
  const posted = [];
  let tasks = 0, current = null, autoReply = true;
  const answer = (message) => {
    if (message.type === 'detect') return { id: message.id, mask: frameMask.slice(), particleCount: 1 };
    if (message.type === 'stroke') return { id: message.id, patch: { rect: { x: 0, y: 0, width: 1, height: 1 }, particleCount: 2 } };
    return { id: message.id };
  };
  const pinnedClient = createDustWorkerClient({
    idleTimeoutMs: 5, planeSliceBytes: 4096,
    yieldTask: () => { tasks++; return new Promise(resolve => setTimeout(resolve, 0)); },
    workerFactory: () => current = {
      postMessage(message, transfers) {
        const copy = structuredClone(message, { transfer: transfers });
        posted.push({ ...copy, task: tasks });
        if (autoReply) queueMicrotask(() => this.onmessage({ data: answer(copy) }));
      },
      terminate() { this.terminated = true; }
    }
  });
  const bytes = (message) => Object.values(message)
    .reduce((sum, value) => sum + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);

  await pinnedClient.detect(frame, { strength: 3, maskTag: 1 });
  assert.equal(pinnedClient.maskTag, 1, 'a tagged detection leaves its mask in the worker');
  assert.equal(posted[0].maskTag, 1);
  posted.length = 0;
  await pinnedClient.pin(frame);
  assert.equal(pinnedClient.pinned, true);
  const slices = posted.filter(message => message.type === 'plane');
  assert.ok(slices.every(message => message.kind === 'image16' && message.chunk.byteLength <= 4096));
  assert.equal(slices.reduce((sum, message) => sum + message.chunk.length, 0), width * height * 4, 'the whole 16-bit plane arrives');
  assert.equal(new Set(slices.map(message => message.task)).size, slices.length, 'one slice per task');
  assert.ok(slices.at(-1).done && !slices[0].done);

  // No idle release while pinned, even after a long pause.
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!current.terminated, 'pinned worker survives idleness');
  posted.length = 0;
  const patch = await pinnedClient.stroke(frame, { baseTag: 1, tag: 2, mask: frameMask,
    points: [{ x: 3, y: 4 }], brushRadius: 5, mode: 'direct' });
  assert.equal(patch.particleCount, 2);
  assert.equal(posted.length, 1, 'a stroke is one message');
  assert.equal(bytes(posted[0]), 0, 'no plane or mask travels with the stroke');
  assert.ok(JSON.stringify(posted[0]).length < 1024, 'a stroke is a few hundred bytes');
  assert.equal(pinnedClient.maskTag, 2);

  // The page's undo follows the worker only when both hold the same mask.
  posted.length = 0;
  assert.equal(await pinnedClient.maskDelta(frame, { baseTag: 2, tag: 3, rect: { x: 0, y: 0, width: 1, height: 1 },
    bytes: new Uint8Array(1), particleCount: 1 }), true);
  assert.equal(await pinnedClient.maskDelta(frame, { baseTag: 9, tag: 10, rect: { x: 0, y: 0, width: 1, height: 1 },
    bytes: new Uint8Array(1) }), false);
  assert.equal(posted.length, 1);
  assert.equal(pinnedClient.maskTag, 3);

  // A mask the worker does not hold is sent with the stroke, once.
  posted.length = 0;
  await pinnedClient.stroke(frame, { baseTag: 8, tag: 9, mask: frameMask, points: [{ x: 1, y: 1 }], brushRadius: 2, mode: 'remove' });
  assert.deepEqual(posted[0].mask, frameMask);
  posted.length = 0;
  await pinnedClient.stroke(frame, { baseTag: 9, tag: 10, mask: frameMask, points: [{ x: 1, y: 1 }], brushRadius: 2, mode: 'remove' });
  assert.equal(posted[0].mask, undefined);

  // A stale-mask reply rejects but keeps the worker and its planes.
  autoReply = false;
  const stale = pinnedClient.stroke(frame, { baseTag: 10, tag: 11, mask: frameMask, points: [{ x: 1, y: 1 }], brushRadius: 2, mode: 'direct' });
  current.onmessage({ data: { id: posted.at(-1).id, error: 'Dust worker mask is out of date', staleMask: true } });
  await assert.rejects(stale, (error) => error.staleMask === true);
  assert.ok(!current.terminated);
  assert.equal(pinnedClient.maskTag, null);
  autoReply = true;

  // Detection on a new source while pinned sends the 16-bit plane behind it.
  const next = new ImageData(new Uint8ClampedArray(width * height * 4).fill(40), width, height);
  next.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(10280) };
  posted.length = 0;
  await pinnedClient.detect(next, { strength: 3, maskTag: 20 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(posted[0].type, 'detect');
  assert.equal(posted[0].pinned, true);
  assert.ok(posted.slice(1).every(message => message.type === 'plane' && message.kind === 'image16'));
  assert.equal(posted.slice(1).reduce((sum, message) => sum + message.chunk.length, 0), width * height * 4);

  // A lost worker is re-seeded once, in slices, before the next stroke.
  current.onerror();
  const lost = current;
  posted.length = 0;
  await pinnedClient.stroke(next, { baseTag: 20, tag: 21, mask: frameMask, points: [{ x: 1, y: 1 }], brushRadius: 2, mode: 'direct' });
  assert.ok(lost.terminated && current !== lost);
  assert.deepEqual([...new Set(posted.filter(m => m.type === 'plane').map(m => m.kind))], ['rgba', 'image16']);
  assert.ok(posted.every(message => bytes(message) <= 4096 || message.type === 'stroke'));
  const strokeMessage = posted.at(-1);
  assert.equal(strokeMessage.type, 'stroke');
  assert.deepEqual(strokeMessage.mask, frameMask, 'the mask is re-sent with the stroke');

  // Pinning again with a mask the worker lacks uploads it in slices too.
  posted.length = 0;
  const bigMask = new Uint8Array(width * height).fill(255);
  await pinnedClient.pin(next, { mask: bigMask, tag: 30, particleCount: 1 });
  const maskSlices = posted.filter(message => message.kind === 'mask');
  assert.ok(maskSlices.length > 0 && maskSlices.every(message => message.tag === 30));
  assert.equal(pinnedClient.maskTag, 30);

  // Unpinning restores the idle release.
  pinnedClient.unpin();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(current.terminated, 'idle release applies again after unpin');
  assert.equal(pinnedClient.pinned, false);
}
console.log('Dust worker client source reuse, precision, pinning, sliced planes, strokes, timeout, cancellation and cleanup passed');
