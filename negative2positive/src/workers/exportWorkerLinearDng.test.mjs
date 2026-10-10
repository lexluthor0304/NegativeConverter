// Standalone Node test (#293): the linear DNG built in the export worker.
// Run with: node negative2positive/src/workers/exportWorkerLinearDng.test.mjs
//
// The worker's `encodeLinearDng` request (the real exportWorker.js handler,
// in process) writes the bytes the main thread's encodeLinearDngBlob writes
// for the same plane, settings and metadata, which are the bytes of the
// frozen 1703835 kernel (linearDng.reference.mjs). The bridge copies or
// transfers the plane, hands a transferred plane back when the worker
// fails before it is used, and falls back (null) on a crash.
import assert from 'node:assert/strict';

let deliver = null;
globalThis.self = { onmessage: null, postMessage(message) { deliver(message); } };
await import('./exportWorker.js');
const workerHandler = self.onmessage;

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { createExportWorkerBridge, createExportWorkerPool, isExportInputLostError, resetWorkerFallbackWarnings } = await import('./workerBridge.js');
const { buildLinearPositive, encodeLinearDngBlob, buildLinearDngParts } = await import('../app/linearDng.js');
const { toImage16 } = await import('../app/multiShot.js');
const { markOwnedPlanes, setLiveReferenceProbe } = await import('../app/planeRelease.js');
const HEAD = await import('../app/linearDng.reference.mjs');

setLiveReferenceProbe(() => new Set());

function createWorkerFactory({ behaviour = () => 'run' } = {}) {
  const stats = { posts: [] };
  class InProcessWorker {
    constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.terminated = false; }
    postMessage(message, transfers = []) {
      const received = structuredClone(message, { transfer: transfers });
      stats.posts.push({ type: received.type, transfers: transfers.length, bytes: received.inputBuffer?.byteLength ?? 0 });
      const plan = behaviour(received);
      setTimeout(() => {
        if (this.terminated) return;
        if (plan === 'crash') { this.onerror(new Error('worker crashed')); return; }
        const replies = [];
        deliver = (reply) => replies.push(reply);
        workerHandler({ data: received });
        for (const reply of replies) if (!this.terminated) this.onmessage({ data: reply });
      }, 1);
    }
    terminate() { this.terminated = true; }
  }
  return { factory: () => new InProcessWorker(), stats };
}

const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
let seed = 0x293;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
function negative16(width, height, { extremes = false } = {}) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) { data[i] = 65535; continue; }
    const r = random();
    data[i] = extremes && (r & 15) === 0 ? ((r >>> 4) & 1 ? 65535 : 0) : (r & 3) === 0 ? r >>> 16 : 8000 + ((r >>> 16) % 30000);
  }
  const image = new ImageData(Uint8ClampedArray.from(data, (v) => v >>> 8), width, height);
  image.__image16 = { width, height, data };
  return image;
}
function negative8(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : random() >>> 24;
  return new ImageData(data, width, height);
}

const metadata = { exif: { make: 'NeoAnalogLab', model: 'Nikon FM2', software: 'NeoAnalogLab Negative Converter', dateTime: '2026:10:10 09:00:00', imageDescription: 'frame 7' }, xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>' };
const cases = [
  ['16-bit, film base', negative16(733, 421), { r: 212, g: 131, b: 77 }, false],
  ['16-bit, no base', negative16(733, 421), null, false],
  ['16-bit positive', negative16(401, 299), null, true],
  ['16-bit extremes', negative16(401, 299, { extremes: true }), { r: 255, g: 1, b: 0.5 }, false],
  ['8-bit frame', negative8(512, 320), { r: 200, g: 120, b: 60 }, false]
];

// The handler's bytes equal the main thread's and the frozen kernel's.
for (const [label, image, filmBase, positive] of cases) {
  const plane = image.__image16 || toImage16(image);
  const expected = await bytesOf(encodeLinearDngBlob(buildLinearPositive(plane, filmBase, { positive }), { metadata }));
  const frozen = concat(buildLinearDngParts(HEAD.buildLinearPositive(plane, filmBase, { positive }), { metadata, littleEndianHost: false }));
  assert.deepEqual(expected, frozen, `${label}: the main-thread bytes are the frozen kernel's`);
  const { factory, stats } = createWorkerFactory();
  const bridge = createExportWorkerBridge({ workerFactory: factory });
  const copy = image.__image16 ? new ImageData(image.data.slice(), image.width, image.height) : new ImageData(image.data.slice(), image.width, image.height);
  if (image.__image16) copy.__image16 = { width: image.width, height: image.height, data: image.__image16.data.slice() };
  const result = await bridge.workerEncodeLinearDng(copy, { filmBase, positive, metadata });
  assert.ok(result && result.blob, `${label}: a result`);
  assert.deepEqual(await bytesOf(result.blob), expected, `${label}: worker bytes`);
  assert.equal(result.blob.type, 'image/x-adobe-dng');
  assert.ok(Number.isFinite(result.buildMs) && Number.isFinite(result.blobMs), `${label}: timings`);
  assert.deepEqual(result.gain.map(Number), buildLinearPositive(plane, filmBase, { positive }).gain, `${label}: gain`);
  // Copied, not transferred: the caller's plane is intact.
  assert.equal(stats.posts[0].transfers, 1);
  assert.equal((copy.__image16 ? copy.__image16.data : copy.data).byteLength, (image.__image16 ? image.__image16.data : image.data).byteLength, `${label}: the plane was copied`);
  bridge.dispose();
}

// A pool lane answers the same request.
{
  const [, image, filmBase] = cases[0];
  const expected = await bytesOf(encodeLinearDngBlob(buildLinearPositive(image.__image16, filmBase, {}), { metadata }));
  const pool = createExportWorkerPool({ size: 2, workerFactory: createWorkerFactory().factory });
  const result = await pool.workerEncodeLinearDng(image, { filmBase, positive: false, metadata });
  assert.deepEqual(await bytesOf(result.blob), expected, 'pool lane bytes');
  pool.dispose();
}

// Transfer: an export-owned plane moves to the worker (detached here) and the
// bytes are the same; a worker error before the kernel ran hands it back.
{
  const [, image, filmBase] = cases[1];
  const expected = await bytesOf(encodeLinearDngBlob(buildLinearPositive(image.__image16, filmBase, {}), { metadata }));
  const owned = new ImageData(image.data.slice(), image.width, image.height);
  owned.__image16 = { width: image.width, height: image.height, data: image.__image16.data.slice() };
  markOwnedPlanes(owned, owned.__image16.data);
  const { factory, stats } = createWorkerFactory();
  const bridge = createExportWorkerBridge({ workerFactory: factory });
  const result = await bridge.workerEncodeLinearDng(owned, { filmBase, positive: false, metadata, transferPlane: true });
  assert.deepEqual(await bytesOf(result.blob), expected, 'transferred plane bytes');
  assert.equal(stats.posts[0].bytes, image.width * image.height * 8, 'the plane itself was posted');
  assert.equal(owned.__image16.data.byteLength, 0, 'the plane left this thread');
  bridge.dispose();

  // A plane of the wrong size: the worker rejects before reading it and
  // hands the buffer back; the bridge re-attaches it and resolves null.
  resetWorkerFallbackWarnings();
  const wrong = { width: 10, height: 10, data: new Uint8ClampedArray(400), __image16: { width: 10, height: 10, data: new Uint16Array(400) } };
  markOwnedPlanes(wrong.__image16.data);
  const plane = wrong.__image16.data;
  const bridge2 = createExportWorkerBridge({ workerFactory: createWorkerFactory({ behaviour: (message) => { message.width = 11; return 'run'; } }).factory });
  const failed = await bridge2.workerEncodeLinearDng(wrong, { filmBase: null, positive: false, metadata: null, transferPlane: true });
  assert.equal(failed, null, 'a worker error falls back');
  assert.notEqual(wrong.__image16.data, plane, 'the returned buffer is re-attached as a new view');
  assert.equal(wrong.__image16.data.byteLength, 800, 'the plane is back');
  bridge2.dispose();

  // A crash while the worker holds the plane: the input is lost.
  const lost = { width: 10, height: 10, data: new Uint8ClampedArray(400), __image16: { width: 10, height: 10, data: new Uint16Array(400) } };
  markOwnedPlanes(lost.__image16.data);
  const bridge3 = createExportWorkerBridge({ workerFactory: createWorkerFactory({ behaviour: () => 'crash' }).factory });
  await assert.rejects(bridge3.workerEncodeLinearDng(lost, { transferPlane: true }), (err) => isExportInputLostError(err));
  bridge3.dispose();

  // A crash on a copied plane: null, and the caller's plane is intact.
  const kept = { width: 10, height: 10, data: new Uint8ClampedArray(400), __image16: { width: 10, height: 10, data: new Uint16Array(400) } };
  const bridge4 = createExportWorkerBridge({ workerFactory: createWorkerFactory({ behaviour: () => 'crash' }).factory });
  assert.equal(await bridge4.workerEncodeLinearDng(kept, {}), null);
  assert.equal(kept.__image16.data.byteLength, 800);
  bridge4.dispose();

  // Cancellation rejects with an AbortError.
  const controller = new AbortController();
  controller.abort();
  const bridge5 = createExportWorkerBridge({ workerFactory: createWorkerFactory().factory });
  await assert.rejects(bridge5.workerEncodeLinearDng(kept, { signal: controller.signal }), (err) => err.name === 'AbortError');
  bridge5.dispose();

  // Inputs the worker cannot take: null.
  assert.equal(await createExportWorkerBridge({ workerFactory: createWorkerFactory().factory }).workerEncodeLinearDng(null, {}), null);
  assert.equal(await createExportWorkerBridge({ workerFactory: createWorkerFactory().factory }).workerEncodeLinearDng({ width: 4, height: 4, data: new Uint8ClampedArray(3) }, {}), null);
}

// A small plane in shared memory (#264) is copied into a plain buffer: the
// request reaches the worker (a shared slice could not be transferred) and
// the bytes are the same.
if (typeof SharedArrayBuffer === 'function') {
  const [, image, filmBase] = cases[2];
  const shared = new Uint16Array(new SharedArrayBuffer(image.__image16.data.byteLength));
  shared.set(image.__image16.data);
  const sharedImage = new ImageData(image.data.slice(), image.width, image.height);
  sharedImage.__image16 = { width: image.width, height: image.height, data: shared };
  const expected = await bytesOf(encodeLinearDngBlob(buildLinearPositive(image.__image16, filmBase, { positive: true }), { metadata }));
  const { factory, stats } = createWorkerFactory();
  const bridge = createExportWorkerBridge({ workerFactory: factory });
  const result = await bridge.workerEncodeLinearDng(sharedImage, { filmBase, positive: true, metadata, transferPlane: true });
  assert.ok(result && result.blob, 'a shared plane reaches the worker as a plain copy');
  assert.deepEqual(await bytesOf(result.blob), expected, 'shared plane bytes');
  assert.equal(stats.posts[0].bytes, shared.byteLength);
  assert.equal(sharedImage.__image16.data, shared, 'the shared plane stays attached');
  bridge.dispose();
}

// The handler reports a wrong length without touching the input, and an
// unknown film base shape is tolerated (null).
{
  const posted = [];
  deliver = (reply) => posted.push(reply);
  const buffer = new Uint16Array(16).buffer;
  workerHandler({ data: { type: 'encodeLinearDng', id: 7, inputBuffer: buffer, width: 3, height: 3, bits: 16, filmBase: null, positive: false, metadata: null } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, 'error');
  assert.equal(posted[0].id, 7);
  assert.ok(posted[0].returned && posted[0].returned.input instanceof ArrayBuffer, 'the input goes back');
}

console.log('exportWorkerLinearDng.test.mjs passed');
