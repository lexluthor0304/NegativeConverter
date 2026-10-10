// The 2D-canvas rotation of an 8-bit frame on a worker (#293): the pool
// admits a worker's canvas only when its rotation of the fixture equals the
// page's by the bytes, hands the frame over by a sliced copy, returns the
// worker's frame, keeps the page canvas when the worker's differs or fails,
// and the real geometryWorker.js without an OffscreenCanvas (Node) declines
// gracefully while its bands keep working. Node has no canvas: a pure
// rotation stands in for both sides. Run with:
// node negative2positive/src/app/geometryPool.rotate.test.mjs
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { this.width = data; this.height = width; this.data = new Uint8ClampedArray(data * width * 4); return; }
    this.data = data; this.width = width; this.height = height;
  }
};
const { createGeometryPool, runGeometryBand, runCanvasRotation, canvasRotationFixture, CANVAS_ROTATION_CHECK_ANGLES } = await import('./geometryPool.js');
const { planGeometry, renderGeometry, rotatedDimensions, normalizeAngleDegrees } = await import('./imageGeometry.js');

const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
// A declined rotation is `false`; a frame would be an ImageData, which assert
// must never diff (it would inspect every sample).
const declined = (value, label) => assert.equal(value === false ? 'false' : (value === null ? 'null' : typeof value), 'false', label);

// A stand-in for the canvas: nearest-neighbour inverse map of the canvas
// transform, alpha 255 inside the source and 0 outside; `salt` perturbs it
// (another rasteriser).
function stubRotate(image, angle, salt = 0) {
  const normalized = normalizeAngleDegrees(angle);
  if (Math.abs(normalized) < 0.001) return image;
  const { width: w, height: h, data } = image;
  const { width: newW, height: newH } = rotatedDimensions(w, h, normalized);
  const rad = normalized * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const out = new Uint8ClampedArray(newW * newH * 4);
  for (let y = 0; y < newH; y++) {
    for (let x = 0; x < newW; x++) {
      const u = x + 0.5 - newW / 2, v = y + 0.5 - newH / 2;
      const sx = Math.floor(w / 2 + u * cos + v * sin), sy = Math.floor(h / 2 - u * sin + v * cos);
      const o = (y * newW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const i = (sy * w + sx) * 4;
      out[o] = data[i] ^ salt; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2]; out[o + 3] = 255;
    }
  }
  return new ImageData(out, newW, newH);
}

function makeSource(width, height, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : rnd() % 256;
  return new ImageData(data, width, height);
}

// An in-process worker running the real band code and the real rotation
// handler with the injected stand-in (`workerRotate`).
function fakeWorkerFactory(log, { workerRotate = stubRotate, crashOn = null, throwOn = null } = {}) {
  return () => {
    const worker = {
      terminated: false,
      postMessage(message, transfers) {
        const copy = structuredClone(message, { transfer: transfers });
        log.push({ type: copy.type, width: copy.width, height: copy.height, angle: copy.angle, bytes: copy.data?.byteLength || 0 });
        const index = log.length - 1;
        setTimeout(() => {
          if (worker.terminated) return;
          if (crashOn !== null && crashOn(copy, index)) { worker.onerror?.({ message: 'boom' }); return; }
          try {
            if (copy.type === 'geometry-rotate') {
              if (throwOn && throwOn(copy)) throw new Error('OffscreenCanvas is not defined');
              const { payload, transfers: back } = runCanvasRotation(copy, workerRotate);
              worker.onmessage?.({ data: structuredClone(payload, { transfer: back }) });
            } else {
              const { payload, transfers: back } = runGeometryBand(copy);
              worker.onmessage?.({ data: structuredClone(payload, { transfer: back }) });
            }
          } catch (error) {
            worker.onmessage?.({ data: { id: copy.id, error: String(error?.message || error) } });
          }
        }, 1);
      },
      terminate() { worker.terminated = true; }
    };
    return worker;
  };
}

const fixture = canvasRotationFixture();
assert.deepEqual([fixture.width, fixture.height], [61, 47]);
assert.ok(bytes(canvasRotationFixture().data).equals(bytes(fixture.data)), 'the fixture is deterministic');
assert.equal(CANVAS_ROTATION_CHECK_ANGLES.length, 4);

const source = makeSource(300, 200, 9);
const sourceBefore = Buffer.from(bytes(source.data));

// 1. The same rasteriser on both sides: the check passes, the frame comes
//    from the worker, the mirror and crop follow as index plans.
{
  const log = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: true, size: 2, idleTimeoutMs: 5, pageRotate: stubRotate });
  assert.deepEqual(pool.canvasRotation, { checked: false, supported: false });
  const rotated = await pool.rotateCanvas(source, 3.7);
  assert.ok(rotated instanceof ImageData, 'a rotated frame');
  const expected = stubRotate(source, 3.7);
  assert.deepEqual([rotated.width, rotated.height], [expected.width, expected.height]);
  assert.ok(bytes(rotated.data).equals(bytes(expected.data)), 'the worker frame is the page frame');
  assert.deepEqual(pool.canvasRotation, { checked: true, supported: true });
  assert.equal(log.filter(entry => entry.type === 'geometry-rotate').length, CANVAS_ROTATION_CHECK_ANGLES.length + 1, 'four check rotations and the job');
  assert.deepEqual(log.slice(0, 4).map(entry => entry.angle), [...CANVAS_ROTATION_CHECK_ANGLES]);
  assert.equal(log[4].bytes, source.data.byteLength, 'the frame goes by a copy of its bytes');
  assert.ok(bytes(source.data).equals(sourceBefore), 'the source is untouched');
  assert.equal(pool.counters.canvasRotations, 1);
  assert.equal(pool.counters.rotations, 1);
  assert.equal(pool.counters.copiedBytes, source.data.byteLength);
  // A second rotation checks nothing again.
  await pool.rotateCanvas(source, -12.25);
  assert.equal(log.filter(entry => entry.type === 'geometry-rotate').length, CANVAS_ROTATION_CHECK_ANGLES.length + 2);
  // Mirror and crop of the rotated frame as one index plan equal the steps.
  const plan = planGeometry(rotated, { rotationAngle: 0, mirrored: true, cropRegion: { left: 11, top: 7, width: 200, height: 150 } });
  const chained = await pool.render(rotated, plan, { bands: 3 });
  assert.ok(bytes(chained.data).equals(bytes(renderGeometry(rotated, plan).data)), 'mirror + crop in the pool');
  // Stale: null, nothing counted.
  let calls = 0;
  assert.equal((await pool.rotateCanvas(source, 5, { isCurrent: () => ++calls < 2 })) === null, true, 'a stale job resolves null');
  assert.equal(pool.counters.canvasRotations, 2);
  // Without workers (disableWorkers, as a failure would leave the pool) the
  // page rotates; dispose() only releases the workers.
  pool.disableWorkers();
  declined(await pool.rotateCanvas(source, 5), 'a pool without workers declines');
  pool.dispose();
}

// 2. Another rasteriser on the worker: the check fails, the page rotates.
{
  const log = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log, { workerRotate: (image, angle) => stubRotate(image, angle, angle === 44.9 ? 1 : 0) }), workersSupported: true, size: 2, idleTimeoutMs: 5, pageRotate: stubRotate });
  declined(await pool.rotateCanvas(source, 3.7), 'another rasteriser declines');
  assert.deepEqual(pool.canvasRotation, { checked: true, supported: false });
  assert.equal(log.filter(entry => entry.type === 'geometry-rotate').length, 3, 'the check stops at the first differing angle');
  assert.equal(pool.counters.canvasRotations, 0);
  assert.equal(pool.available, true, 'the pool still renders bands');
  const plan = planGeometry(source, { mirrored: true });
  assert.ok(bytes((await pool.render(source, plan, { bands: 2 })).data).equals(bytes(renderGeometry(source, plan).data)));
  pool.dispose();
}

// 3. A worker that cannot rotate (an error reply): the page rotates, the
//    pool is not broken; the same when the check itself errors.
{
  const log = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log, { throwOn: copy => copy.width === 300 }), workersSupported: true, size: 2, idleTimeoutMs: 5, pageRotate: stubRotate });
  declined(await pool.rotateCanvas(source, 3.7), 'an error reply declines');
  assert.deepEqual(pool.canvasRotation, { checked: true, supported: false });
  assert.equal(pool.available, true);
  declined(await pool.rotateCanvas(source, 3.7), 'declined from then on');
  assert.equal(log.filter(entry => entry.type === 'geometry-rotate').length, 5);
  pool.dispose();
  const failing = createGeometryPool({ workerFactory: fakeWorkerFactory([], { throwOn: () => true }), workersSupported: true, size: 1, idleTimeoutMs: 5, pageRotate: stubRotate });
  declined(await failing.rotateCanvas(source, 3.7), 'a failing check declines');
  assert.equal(failing.available, true);
  failing.dispose();
}

// 4. A crash during the rotation: the page rotates and, as for a band, the
//    pool falls back to the synchronous path for good.
{
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory([], { crashOn: (copy) => copy.type === 'geometry-rotate' && copy.width === 300 }), workersSupported: true, size: 2, idleTimeoutMs: 5, pageRotate: stubRotate });
  declined(await pool.rotateCanvas(source, 3.7), 'a crash declines');
  assert.equal(pool.available, false);
  pool.dispose();
}

// 5. No workers: false at once, nothing posted.
{
  const log = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: false, size: 2, pageRotate: stubRotate });
  declined(await pool.rotateCanvas(source, 3.7), 'no workers declines');
  assert.equal(log.length, 0);
  assert.deepEqual(pool.canvasRotation, { checked: false, supported: false });
  pool.dispose();
}

// 6. The real worker script on a real thread has no OffscreenCanvas here:
//    the check fails with its error reply, the page rotates, and the
//    thread still renders bands.
{
  const workerUrl = new URL('../workers/geometryWorker.js', import.meta.url).href;
  const shim = `
    const { parentPort } = require('node:worker_threads');
    globalThis.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    const early = [];
    let loaded = false;
    parentPort.on('message', data => loaded ? self.onmessage?.({ data }) : early.push(data));
    import(${JSON.stringify(workerUrl)}).then(() => { loaded = true; for (const data of early) self.onmessage?.({ data }); });
  `;
  const threads = [];
  const pool = createGeometryPool({
    workersSupported: true, size: 2, idleTimeoutMs: 10, pageRotate: stubRotate,
    workerFactory: () => {
      const thread = new NodeWorker(shim, { eval: true });
      threads.push(thread);
      const worker = {
        postMessage: (message, transfers) => thread.postMessage(message, transfers),
        terminate: () => thread.terminate()
      };
      thread.on('message', data => worker.onmessage?.({ data }));
      thread.on('error', error => worker.onerror?.(error));
      return worker;
    }
  });
  declined(await pool.rotateCanvas(source, 3.7), 'no OffscreenCanvas on a Node thread');
  assert.deepEqual(pool.canvasRotation, { checked: true, supported: false });
  assert.equal(pool.available, true);
  const plan = planGeometry(source, { mirrored: true, cropRegion: { left: 5, top: 5, width: 100, height: 100 } });
  assert.ok(bytes((await pool.render(source, plan, { bands: 2 })).data).equals(bytes(renderGeometry(source, plan).data)), 'bands on the thread');
  pool.dispose();
  for (const thread of threads) await thread.terminate();
}

// runCanvasRotation returns the rotation's bytes by transfer.
{
  const { payload, transfers } = runCanvasRotation({ id: 3, width: source.width, height: source.height, angle: 9.5, data: source.data.slice().buffer }, stubRotate);
  const expected = stubRotate(source, 9.5);
  assert.equal(payload.id, 3);
  assert.deepEqual([payload.width, payload.height], [expected.width, expected.height]);
  assert.ok(bytes(payload.data8).equals(bytes(expected.data)));
  assert.equal(transfers[0], payload.data8.buffer);
}

console.log('geometryPool.rotate.test.mjs passed');
