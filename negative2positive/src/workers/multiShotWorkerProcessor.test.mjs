// Standalone Node test for the multi-shot merge worker (#260) - run with:
// node negative2positive/src/workers/multiShotWorkerProcessor.test.mjs
//
// The worker pipeline (page-side sampling in multiShotWorkerClient.js, then
// alignment, plane-only warps, ratios, banded merge and PNG encode in the
// processor) must produce the same PNG as the main-thread path at 1703835
// (multiShot.reference.mjs), on the camera-smoke shots and on 16-bit planes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as pako from 'pako';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');
const UPNG = require('upng-js');

const { createMultiShotWorkerProcessor } = await import('./multiShotWorkerProcessor.js');
const { createMultiShotMergeJob } = await import('../app/multiShotWorkerClient.js');
const { describeMultiShotError } = await import('../app/multiShotErrors.js');
const { encodePng16Blob } = await import('./imageEncoders.js');
const head = await import('../app/multiShot.reference.mjs');

const fixture = (name) => new URL(`../../test-fixtures/${name}`, import.meta.url);
function loadShot(name) {
  const png = UPNG.decode(readFileSync(fixture(name)));
  return new ImageData(new Uint8ClampedArray(UPNG.toRGBA8(png)[0]), png.width, png.height);
}
const shots = Object.fromEntries(['shot-a', 'shot-b', 'shot-c', 'shot-dark'].map((name) => [name, loadShot(`${name}.png`)]));

// A decoded RAW carries a 16-bit plane with detail below the 8-bit samples.
function withPlane(image, salt) {
  const copy = new ImageData(image.data.slice(), image.width, image.height);
  const plane = new Uint16Array(image.data.length);
  for (let i = 0; i < plane.length; i++) plane[i] = i % 4 === 3 ? 65535 : image.data[i] * 257 + ((i * 7919 + salt) % 251);
  copy.__image16 = { width: image.width, height: image.height, data: plane };
  return copy;
}
function nearest(image, width, height) {
  const out = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (Math.floor(y * image.height / height) * image.width + Math.floor(x * image.width / width)) * 4;
    out.data.set(image.data.subarray(s, s + 4), (y * width + x) * 4);
  }
  return out;
}
function clone(image) {
  const copy = new ImageData(image.data.slice(), image.width, image.height);
  if (image.__image16) copy.__image16 = { ...image.__image16, data: image.__image16.data.slice() };
  return copy;
}

// The main-thread merge at 1703835, encoded as the export worker did.
function headMerge(images, mode) {
  let reference = null;
  const frames = [];
  for (const imageData of images) {
    if (!reference) {
      reference = imageData;
      frames.push({ image16: head.toImage16(imageData), ratio: 1 });
      continue;
    }
    let alignment = null;
    try { alignment = head.estimateAlignment(reference, imageData, { maxSide: 1200 }); } catch { /* skipped */ }
    if (!alignment) continue;
    const warped = head.warpImageData(imageData, alignment.homography, reference.width, reference.height);
    const image16 = head.toImage16(warped);
    frames.push({ image16, ratio: head.estimateExposureRatio(frames[0].image16, image16) });
  }
  if (frames.length < 2) return { blob: null, used: frames.length };
  const merged = head.mergeFrames(frames, { mode, region: head.coverageRect(frames), opaque: true });
  return { blob: encodePng16Blob(merged.data, merged.width, merged.height, pako.deflate), used: frames.length };
}

// A Worker stand-in: messages cross with structured clone and transfer (so
// the page's planes detach), replies arrive asynchronously.
class FakeWorker {
  constructor(options = {}) {
    this.terminated = false;
    this.posted = [];
    this.process = createMultiShotWorkerProcessor({ post: (data) => this.emit(data), ...options });
    setTimeout(() => this.emit({ type: 'hello' }), 0);
  }
  emit(data) { setTimeout(() => { if (!this.terminated) this.onmessage?.({ data }); }, 0); }
  postMessage(message, transfer = []) {
    if (this.terminated) return;
    const copy = structuredClone(message, { transfer });
    this.posted.push({ ...copy }); // the processor drops its plane references
    void this.process(copy);
  }
  terminate() { this.terminated = true; }
}

async function workerMerge(images, mode, { bandRows, inline = false } = {}) {
  const workers = [];
  const progress = [];
  const job = createMultiShotMergeJob({
    mode,
    workerFactory: inline ? () => { throw new Error('no module workers'); } : () => { const w = new FakeWorker({ bandRows }); workers.push(w); return w; },
    createInlineProcessor: async ({ post, signal }) => createMultiShotWorkerProcessor({ post, signal, bandRows, pause: () => new Promise((r) => setTimeout(r, 0)) }),
    onProgress: (event) => progress.push(event)
  });
  for (let i = 0; i < images.length; i++) await job.addFrame(i, images[i]);
  const result = await job.merge();
  job.dispose();
  return { result, workers, progress, job };
}

async function samePng(actual, expected, label) {
  assert.ok(actual && expected, `${label}: both paths produced a PNG`);
  const a = new Uint8Array(await actual.arrayBuffer());
  const b = new Uint8Array(await expected.arrayBuffer());
  const da = UPNG.decode(a.buffer); const db = UPNG.decode(b.buffer);
  assert.equal(da.width, db.width, `${label}: width`);
  assert.equal(da.height, db.height, `${label}: height`);
  assert.equal(da.depth, 16, `${label}: 16-bit`);
  const sa = new Uint8Array(da.data); const sb = new Uint8Array(db.data);
  assert.equal(sa.length, sb.length);
  for (let i = 0; i < sb.length; i++) if (sa[i] !== sb[i]) assert.fail(`${label}: decoded byte ${i} differs`);
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, `${label}: PNG bytes identical`);
}

// ---- Parity on the camera-smoke shots (8-bit sources) ----
{
  const images = () => [shots['shot-a'], shots['shot-b'], shots['shot-c']].map(clone);
  const expected = headMerge(images(), 'average');
  assert.equal(expected.used, 3, 'the three shots align at 1703835');
  const { result, workers, progress } = await workerMerge(images(), 'average');
  assert.equal(result.used, 3);
  assert.equal(result.skipped, 0);
  await samePng(result.blob, expected.blob, 'average, 8-bit shots');
  assert.equal(workers.length, 1, 'one worker per merge');
  assert.ok(workers[0].terminated, 'the worker is terminated after the result');
  const stages = progress.map((event) => event.stage);
  for (const stage of ['posted', 'align', 'warp', 'exposure', 'frame', 'merging', 'merge', 'encode']) assert.ok(stages.includes(stage), `progress reports ${stage}`);
  const bands = progress.filter((event) => event.stage === 'merge');
  assert.equal(bands.length, Math.ceil(bands.at(-1).total / 64), 'one progress message per 64-row band');
  assert.equal(bands.at(-1).done, bands.at(-1).total);
  // The 8-bit planes crossed by transfer: the page's copies are detached.
  const sent = images();
  const job = createMultiShotMergeJob({ workerFactory: () => new FakeWorker() });
  await job.addFrame(0, sent[0]);
  assert.equal(sent[0].data.length, 0, 'the 8-bit plane was transferred, not copied');
  job.dispose();

  const hdr = [shots['shot-a'], shots['shot-dark']].map(clone);
  const expectedHdr = headMerge(hdr.map(clone), 'hdr');
  await samePng((await workerMerge(hdr, 'hdr')).result.blob, expectedHdr.blob, 'hdr, 8-bit bracket pair');

  // Small bands and the main-thread fallback give the same PNG.
  await samePng((await workerMerge(images(), 'average', { bandRows: 5 })).result.blob, expected.blob, 'average, 5-row bands');
  const inline = await workerMerge(images(), 'average', { inline: true });
  assert.ok(inline.job.fallback, 'the processor ran on the main thread');
  await samePng(inline.result.blob, expected.blob, 'average, main-thread fallback');
}

// ---- 16-bit planes (every RAW decode): the plane-only warp path ----
{
  const images = () => [withPlane(shots['shot-a'], 1), withPlane(shots['shot-b'], 2), withPlane(shots['shot-c'], 3)];
  const expected = headMerge(images(), 'average');
  const sent = images();
  const { result, workers } = await workerMerge(sent, 'average');
  await samePng(result.blob, expected.blob, 'average, 16-bit planes');
  assert.equal(sent[1].__image16.data.length, 0, 'the 16-bit plane was transferred');
  assert.equal(sent[1].data.length, 900 * 600 * 4, 'the 8-bit plane stays with the page');
  const frame = workers[0].posted.find((message) => message.type === 'frame' && message.index === 1);
  assert.ok(frame.image16 instanceof Uint16Array && !frame.rgba, 'only the 16-bit plane is posted');
  assert.ok(frame.gray.gray instanceof Uint8Array && frame.gray.width === 900, 'grey proxy at the frame size (under 1200 px)');

  const hdr = () => [withPlane(shots['shot-a'], 5), withPlane(shots['shot-dark'], 6), withPlane(shots['shot-c'], 7)];
  await samePng((await workerMerge(hdr(), 'hdr')).result.blob, headMerge(hdr(), 'hdr').blob, 'hdr, 16-bit planes');
}

// ---- A smaller reference: pairs are sampled at the larger frame's side ----
{
  const images = () => [nearest(shots['shot-a'], 600, 400), clone(shots['shot-b']), clone(shots['shot-c'])];
  const expected = headMerge(images(), 'average');
  const { result, workers } = await workerMerge(images(), 'average');
  assert.equal(result.used, expected.used, `same frames used (${expected.used})`);
  assert.equal(expected.used, 3, 'the upscaled pairs still align');
  if (expected.blob) await samePng(result.blob, expected.blob, 'smaller reference');
  else assert.equal(result.blob, null);
  const frame = workers[0].posted.find((message) => message.type === 'frame' && message.index === 1);
  assert.equal(frame.referenceGray?.width, 900, 'the reference is sampled again at the larger side');
}

// ---- Unrelated frames are skipped, as before ----
{
  const noise = new ImageData(new Uint8ClampedArray(900 * 600 * 4), 900, 600);
  for (let i = 0; i < noise.data.length; i++) noise.data[i] = i % 4 === 3 ? 255 : (i * 2654435761) >>> 24;
  const images = () => [clone(shots['shot-a']), clone(noise)];
  assert.equal(headMerge(images(), 'average').blob, null);
  const { result } = await workerMerge(images(), 'average');
  assert.equal(result.blob, null, 'nothing merged');
  assert.equal(result.skipped, 1);
}

// ---- Failures are classified before they leave the worker ----
{
  const posts = [];
  const process = createMultiShotWorkerProcessor({ post: (message) => posts.push(message) });
  const images = [clone(shots['shot-a']), clone(shots['shot-b'])];
  const sampled = images.map((image) => ({ width: image.width, height: image.height, rgba: image.data }));
  const { sampleAlignmentGray } = await import('../app/imageAlignment.js');
  await process({ type: 'start', mode: 'average', fault: 'warp-memory' });
  for (let i = 0; i < 2; i++) await process({ type: 'frame', index: i, ...sampled[i], gray: sampleAlignmentGray(images[i], 900) });
  const error = posts.find((message) => message.type === 'error');
  assert.equal(error?.code, 'memory', 'an OpenCV StsNoMem pointer is a memory failure');
  assert.match(error.message, /Insufficient memory|Failed to allocate/);
  await process({ type: 'merge' });
  assert.equal(posts.filter((message) => message.type === 'result').length, 0, 'a failed processor ignores later requests');

  // Through the client: the job rejects with the memory code and terminates the worker.
  const workers = [];
  const job = createMultiShotMergeJob({ workerFactory: () => { const w = new FakeWorker(); workers.push(w); return w; }, fault: 'warp-memory' });
  await job.addFrame(0, clone(shots['shot-a']));
  await job.addFrame(1, clone(shots['shot-b']));
  await assert.rejects(job.failed, (failure) => failure.code === 'memory');
  await assert.rejects(job.merge(), (failure) => failure.code === 'memory');
  assert.ok(workers[0].terminated, 'the worker is terminated after a failure');
}
{
  let ptr = null;
  try { new cv.Mat(20000, 10000, cv.CV_16UC4); } catch (error) { ptr = error; }
  assert.equal(typeof ptr, 'number', 'this OpenCV.js build throws exception pointers');
  assert.equal(describeMultiShotError(ptr).code, 'memory');
  assert.equal(describeMultiShotError(ptr, null).code, 'failed', 'a pointer without its OpenCV cannot be read');
  assert.equal(describeMultiShotError(new RangeError('Array buffer allocation failed')).code, 'memory');
  assert.equal(describeMultiShotError(new RangeError('Invalid typed array length: 4294967296')).code, 'memory');
  assert.equal(describeMultiShotError(new RangeError('Out of memory')).code, 'memory');
  assert.equal(describeMultiShotError(new RangeError('Maximum call stack size exceeded')).code, 'failed');
  assert.equal(describeMultiShotError(new Error('boom')).code, 'failed');
  assert.equal(describeMultiShotError(new Error('OpenCV(5.0.0) (-4:Insufficient memory) Failed to allocate 480522240 bytes')).code, 'memory');
}

// ---- OpenCV that fails to load reports 'opencv'; requests keep their order ----
{
  const posts = [];
  const process = createMultiShotWorkerProcessor({ loadCv: async () => { throw new Error('offline'); }, post: (message) => posts.push(message) });
  await process({ type: 'start', mode: 'average' });
  assert.deepEqual(posts, [{ type: 'error', code: 'opencv', message: 'offline' }]);

  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const order = [];
  const queued = createMultiShotWorkerProcessor({ loadCv: () => gate, post: (message) => order.push(message.type === 'progress' ? `${message.stage}:${message.index ?? ''}` : message.type) });
  const a = clone(shots['shot-a']); const b = clone(shots['shot-b']);
  const { sampleAlignmentGray } = await import('../app/imageAlignment.js');
  const pending = [
    queued({ type: 'start', mode: 'average' }),
    queued({ type: 'frame', index: 0, width: 900, height: 600, rgba: a.data, gray: sampleAlignmentGray(a, 900) }),
    queued({ type: 'frame', index: 1, width: 900, height: 600, rgba: b.data, gray: sampleAlignmentGray(b, 900) }),
    queued({ type: 'merge' })
  ];
  assert.deepEqual(order, [], 'nothing runs before OpenCV is ready');
  open();
  await Promise.all(pending);
  assert.deepEqual(order.slice(0, 5), ['frame:0', 'align:1', 'warp:1', 'exposure:1', 'frame:1']);
  assert.equal(order.at(-1), 'result');
}

console.log('multiShotWorkerProcessor.test.mjs passed');
