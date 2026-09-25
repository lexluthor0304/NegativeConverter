// Geometry worker pool (#244 stage 2): banded worker output equals the
// synchronous core, the shared base is never transferred, stale jobs stop
// posting, and any worker failure falls back to the same core. The last
// scenario runs the real worker script on real threads.
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { this.width = data; this.height = width; this.data = new Uint8ClampedArray(data * width * 4); return; }
    this.data = data; this.width = width; this.height = height;
  }
};
const { planGeometry, renderGeometry } = await import('./imageGeometry.js');
const { createGeometryPool, runGeometryBand, geometryBandCount, defaultGeometryPoolSize, yieldToEventLoop } = await import('./geometryPool.js');
const { buildDisplayLevel, displayLevelGeometry } = await import('./displayPreview.js');

function makeSource(width, height, seed = 1) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i++) { data16[i] = rnd() % 65536; data8[i] = data16[i] >>> 8; }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}
const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function assertSame(actual, expected, label) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], label);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit`);
  assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit`);
}

// An in-process Worker: messages are structured-cloned with their transfer
// lists (so transferred buffers really detach) and answered asynchronously.
function fakeWorkerFactory(log, { failOn = null, crashOn = null, throwOnPost = false, tracker = null } = {}) {
  return () => {
    const worker = {
      terminated: false,
      postMessage(message, transfers) {
        if (throwOnPost) throw new Error('DataCloneError');
        const copy = structuredClone(message, { transfer: transfers });
        log.push({ y0: copy.y0, y1: copy.y1, rows: copy.src.height, has8: Boolean(copy.src.data8) });
        const index = log.length - 1;
        if (tracker) { tracker.inFlight++; tracker.peak = Math.max(tracker.peak, tracker.inFlight); }
        setTimeout(() => {
          if (tracker) tracker.inFlight--;
          if (worker.terminated) return;
          if (crashOn !== null && index === crashOn) { worker.onerror?.({ message: 'boom' }); return; }
          if (failOn !== null && index === failOn) { worker.onmessage?.({ data: { id: copy.id, error: 'band failed' } }); return; }
          const { payload, transfers: back } = runGeometryBand(copy);
          worker.onmessage?.({ data: structuredClone(payload, { transfer: back }) });
        }, 1);
      },
      terminate() { worker.terminated = true; }
    };
    return worker;
  };
}

assert.equal(defaultGeometryPoolSize(8), 6);
assert.equal(defaultGeometryPoolSize(4), 2);
assert.equal(defaultGeometryPoolSize(2), 1);

const source = makeSource(120, 80, 5);
const base16 = Buffer.from(bytes(source.__image16.data));
const base8 = Buffer.from(bytes(source.data));
const geometries = [
  { rotationAngle: 1.3, mirrored: true, cropRegion: { left: 7, top: 5, width: 100, height: 60 } },
  { rotationAngle: -44.5, mirrored: false, cropRegion: null },
  { rotationAngle: 90, mirrored: true, cropRegion: { left: 3, top: 9, width: 70, height: 100 } },
  { rotationAngle: 180, mirrored: false, cropRegion: null },
  { rotationAngle: 0, mirrored: true, cropRegion: { left: 10, top: 10, width: 50, height: 40 } },
  { rotationAngle: 0, mirrored: false, cropRegion: { left: 10, top: 10, width: 50, height: 40 } }
];

for (const geometry of geometries) {
  const plan = planGeometry(source, geometry);
  const expected = renderGeometry(source, plan);
  for (const size of [1, 2, 3]) {
    for (const bands of [1, 4, 6]) {
      const log = [];
      const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: true, size, idleTimeoutMs: 5 });
      const actual = await pool.render(source, plan, { bands });
      assertSame(actual, expected, `${JSON.stringify(geometry)} pool ${size} bands ${bands}`);
      assert.equal(log.length, Math.min(bands, plan.outHeight), 'one worker message per band');
      if (plan.kind === 'bilinear') assert.ok(log.every(entry => !entry.has8), 'bilinear bands post only 16-bit rows');
      assert.equal(pool.counters.syncBands, 0);
      pool.dispose();
    }
  }
}
// `planes: '16'` (#256): the 16-bit plane only, the same samples, no 8-bit
// plane, on workers and on this thread (a broken pool).
for (const geometry of geometries) {
  const plan = planGeometry(source, geometry);
  const expected = renderGeometry(source, plan);
  for (const broken of [false, true]) {
    const pool = createGeometryPool({ workerFactory: fakeWorkerFactory([]), workersSupported: !broken, size: 2, idleTimeoutMs: 5 });
    const actual = await pool.render(source, plan, { bands: 3, planes: '16' });
    assert.equal(actual.data, undefined, `${JSON.stringify(geometry)}: no 8-bit plane`);
    assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
    assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${JSON.stringify(geometry)} broken=${broken}: 16-bit`);
    pool.dispose();
  }
}
{
  // An 8-bit source has no 16-bit plane to keep: both planes as before.
  const eight = new ImageData(new Uint8ClampedArray(source.data), 120, 80);
  const plan = planGeometry(eight, geometries[2]);
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory([]), workersSupported: true, size: 2, idleTimeoutMs: 5 });
  const actual = await pool.render(eight, plan, { bands: 2, planes: '16' });
  assert.ok(bytes(actual.data).equals(bytes(renderGeometry(eight, plan).data)));
  pool.dispose();
}
assert.ok(bytes(source.__image16.data).equals(base16) && bytes(source.data).equals(base8), 'the base is copied, never transferred');
assert.equal(source.__image16.data.length, 120 * 80 * 4);

// Bands in flight are capped; concurrent jobs share the workers.
{
  const log = [];
  const tracker = { inFlight: 0, peak: 0 };
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log, { tracker }), workersSupported: true, size: 3, maxBandsInFlight: 2 });
  const planA = planGeometry(source, geometries[0]);
  const planB = planGeometry(source, geometries[2]);
  const a = await pool.render(source, planA, { bands: 6 });
  assert.ok(tracker.peak <= 2, `one job keeps at most 2 bands in flight (${tracker.peak})`);
  tracker.peak = 0;
  const [b, c] = await Promise.all([pool.render(source, planB, { bands: 5 }), pool.render(source, planA, { bands: 4 })]);
  assert.ok(tracker.peak <= 3, 'never more bands than workers');
  assertSame(a, renderGeometry(source, planA), 'capped job');
  assertSame(b, renderGeometry(source, planB), 'concurrent job B');
  assertSame(c, renderGeometry(source, planA), 'concurrent job C');
  assert.equal(log.length, 15);
  pool.dispose();
}

// A stale job stops posting bands and resolves null.
{
  const log = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: true, size: 1 });
  let current = true;
  const plan = planGeometry(source, geometries[1]);
  const pending = pool.render(source, plan, { bands: 6, isCurrent: () => current });
  await yieldToEventLoop();
  current = false;
  assert.equal(await pending, null);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(log.length <= 2, `superseded job posted ${log.length} of 6 bands`);
  // The worker is free again for the next job.
  assertSame(await pool.render(source, plan, { bands: 2 }), renderGeometry(source, plan), 'next job after a stale one');
  pool.dispose();
}

// Failures: an error reply, a crash, or a post that throws. The job still
// completes with identical pixels on this thread, and the pool stays there.
for (const failure of [{ failOn: 1 }, { crashOn: 0 }, { throwOnPost: true }]) {
  const log = [];
  const warnings = [];
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log, failure), workersSupported: true, size: 2, onError: error => warnings.push(error.message) });
  const plan = planGeometry(source, geometries[0]);
  assertSame(await pool.render(source, plan, { bands: 4 }), renderGeometry(source, plan), `fallback after ${JSON.stringify(failure)}`);
  assert.equal(pool.available, false);
  assert.equal(warnings.length, 1, 'one warning per pool');
  assert.ok(pool.counters.syncBands >= 1);
  const again = pool.counters.workerBands;
  assertSame(await pool.render(source, plan, { bands: 3 }), renderGeometry(source, plan), 'later jobs run synchronously');
  assert.equal(pool.counters.workerBands, again);
  pool.dispose();
}

// Worker disabled: the same core band by band, yielding in between.
{
  let yields = 0;
  const pool = createGeometryPool({ workersSupported: false, size: 4, yieldTask: async () => { yields++; } });
  for (const geometry of geometries) {
    const plan = planGeometry(source, geometry);
    assertSame(await pool.render(source, plan, { bands: 4 }), renderGeometry(source, plan), `no Worker ${JSON.stringify(geometry)}`);
  }
  assert.ok(yields >= geometries.length * 3, 'the synchronous path yields between bands');
  assert.equal(pool.counters.workerBands, 0);
  assert.equal(pool.counters.rotations, 4);
}

// Identity plans return the source object.
{
  const pool = createGeometryPool({ workersSupported: false });
  assert.equal(await pool.render(source, planGeometry(source, {})), source);
}

// #249: a frame's display level (#248) rendered band by band, each band
// sending back only its box-averaged level rows, equals buildDisplayLevel of
// the whole output, byte for byte, on workers and on this thread, for 16-bit
// and 8-bit sources; the geometry of the level is kept.
{
  const eight = makeSource(120, 80, 13);
  delete eight.__image16;
  const sameLevel = (actual, expected, label) => {
    assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], label);
    assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: level`);
    assert.deepEqual(displayLevelGeometry(actual), displayLevelGeometry(expected), `${label}: geometry`);
  };
  const identity = { rotationAngle: 0, mirrored: false, cropRegion: null };
  for (const [label, image] of [['16-bit', source], ['8-bit', eight]]) {
    for (const geometry of [...geometries, identity]) {
      const plan = planGeometry(image, geometry);
      if (!plan) continue; // an 8-bit source at a free angle rotates on a canvas
      const whole = plan.identity ? image : renderGeometry(image, plan);
      for (const k of [2, 3]) {
        const expected = buildDisplayLevel(whole, k);
        for (const levelRowsPerBand of [1, 5, 16]) {
          const log = [];
          const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: true, size: 2 });
          sameLevel(await pool.renderDisplayLevel(image, plan, { k, levelRowsPerBand }), expected, `${label} level ${JSON.stringify(geometry)} k ${k} bands ${levelRowsPerBand}`);
          assert.ok(log.length > 0 && pool.counters.syncBands === 0, 'banded on workers');
          pool.dispose();
        }
        const sync = createGeometryPool({ workersSupported: false, size: 2 });
        sameLevel(await sync.renderDisplayLevel(image, plan, { k }), expected, `${label} level here ${JSON.stringify(geometry)} k ${k}`);
      }
    }
  }
  assert.ok(bytes(source.__image16.data).equals(base16), 'the base is never transferred or changed');
  const stale = createGeometryPool({ workersSupported: false, size: 1 });
  let calls = 0;
  assert.equal(await stale.renderDisplayLevel(source, planGeometry(source, geometries[0]), { k: 2, levelRowsPerBand: 1, isCurrent: () => ++calls < 3 }), null,
    'a superseded level stops');
  assert.equal(await stale.renderDisplayLevel(source, planGeometry(source, geometries[0]), { k: 1 }), null, 'a k = 1 level is the output itself');
}

// Band counts: 4-6 for full-resolution outputs, fewer for small ones.
assert.equal(geometryBandCount({ outWidth: 9000, outHeight: 6000 }, 6), 6);
assert.equal(geometryBandCount({ outWidth: 9000, outHeight: 6000 }, 2), 4);
assert.equal(geometryBandCount({ outWidth: 1000, outHeight: 1500 }, 6), 1);
assert.equal(geometryBandCount({ outWidth: 4000, outHeight: 2000 }, 6), 6);

// The real worker script on real threads (self.* shimmed over parentPort).
{
  const workerUrl = new URL('../workers/geometryWorker.js', import.meta.url).href;
  const shim = `
    const { parentPort } = require('node:worker_threads');
    globalThis.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
    globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
    // Messages may arrive before the module has installed its handler.
    const early = [];
    let loaded = false;
    parentPort.on('message', data => loaded ? self.onmessage?.({ data }) : early.push(data));
    import(${JSON.stringify(workerUrl)}).then(() => { loaded = true; for (const data of early) self.onmessage?.({ data }); });
  `;
  const threads = [];
  const pool = createGeometryPool({
    workersSupported: true, size: 3, idleTimeoutMs: 10,
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
  const big = makeSource(640, 420, 9);
  for (const geometry of [{ rotationAngle: 0.3, mirrored: true, cropRegion: { left: 20, top: 11, width: 600, height: 390 } },
    { rotationAngle: -90, mirrored: false, cropRegion: null }]) {
    const plan = planGeometry(big, geometry);
    assertSame(await pool.render(big, plan, { bands: 5 }), renderGeometry(big, plan), `threads ${JSON.stringify(geometry)}`);
    const only16 = await pool.render(big, plan, { bands: 3, planes: '16' });
    assert.ok(bytes(only16.__image16.data).equals(bytes(renderGeometry(big, plan).__image16.data)), `threads, 16-bit only ${JSON.stringify(geometry)}`);
    // A display level on the same threads (#249).
    const level = await pool.renderDisplayLevel(big, plan, { k: 2 });
    assert.ok(bytes(level.__image16.data).equals(bytes(buildDisplayLevel(renderGeometry(big, plan), 2).__image16.data)), `thread level ${JSON.stringify(geometry)}`);
  }
  assert.equal(pool.counters.syncBands, 0, 'every band ran on a worker thread');
  pool.dispose();
  await Promise.all(threads.map(thread => thread.terminate()));
}

// #248: the pool builds the output's display level with the bands (bands
// start on multiples of k), on workers and on this thread, and the output
// pixels do not change.
{
  const { buildDisplayLevel, displayLevelGeometry } = await import('./displayPreview.js');
  for (const k of [2, 3]) {
    for (const geometry of [geometries[0], geometries[2], geometries[4]]) {
      const plan = planGeometry(source, geometry);
      const expected = renderGeometry(source, plan);
      const expectedLevel = buildDisplayLevel(expected, k);
      for (const [label, options] of [['workers', {}], ['this thread', { throwOnPost: true }]]) {
        const log = [];
        const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log, options), workersSupported: true, size: 3, onError: () => {} });
        const actual = await pool.render(source, plan, { bands: 5, level: k });
        assertSame(actual, expected, `level ${k} ${label}: output unchanged`);
        const level = actual.__displayLevel;
        assert.ok(level, `level ${k} ${label}: built with the bands`);
        assert.deepEqual(displayLevelGeometry(level), { sourceWidth: plan.outWidth, sourceHeight: plan.outHeight, k });
        assert.ok(bytes(level.__image16.data).equals(bytes(expectedLevel.__image16.data)), `level ${k} ${label}: equals the whole-frame level`);
        if (label === 'workers') assert.ok(log.every(entry => entry.y0 % k === 0), 'bands start on multiples of k');
        pool.dispose();
      }
    }
  }
  // Without `level` nothing is built (batch export) and bands are as before.
  const pool = createGeometryPool({ workerFactory: fakeWorkerFactory([]), workersSupported: true, size: 2 });
  assert.equal((await pool.render(source, planGeometry(source, geometries[0]), { bands: 4 })).__displayLevel, undefined);
  pool.dispose();
}

console.log('geometry pool tests passed');
