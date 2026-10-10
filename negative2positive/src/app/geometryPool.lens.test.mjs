// The lens remap of a whole image in the geometry pool (#293): the row bands
// the workers return (the real geometryWorker.js band code, in process and on
// real threads) assemble into applyLensMapsToImage's output byte for byte,
// for 16-bit, 8-bit and shared 16-bit images, every combination of maps and
// modes, any band count, the synchronous fallback, a failing band, the
// in-flight cap and a stale job. Run with:
// node negative2positive/src/app/geometryPool.lens.test.mjs
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { this.width = data; this.height = width; this.data = new Uint8ClampedArray(data * width * 4); return; }
    this.data = data; this.width = width; this.height = height;
  }
};
const { createGeometryPool, runGeometryBand, planLensRemapBands, lensRemapReads16 } = await import('./geometryPool.js');
const { applyLensMapsToImage, lensSourceRows, lensRowExtents } = await import('./lensMaps.js');
const { lensTestMaps } = await import('./lensTestMaps.mjs');
const { isSharedPlane } = await import('./crossOriginIsolation.js');

const bytes = a => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
function makeSource(width, height, seed = 1, { eightBit = false, shared = false } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = shared ? new Uint16Array(new SharedArrayBuffer(width * height * 8)) : new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i++) {
    const v = i % 4 === 3 ? 65535 : rnd() % 65536;
    data16[i] = v;
    data8[i] = eightBit ? rnd() % 256 : v >>> 8;
  }
  const image = new ImageData(data8, width, height);
  if (!eightBit) image.__image16 = { width, height, data: data16 };
  return image;
}
function assertSame(actual, expected, label) {
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], label);
  assert.ok(bytes(actual.data).equals(bytes(expected.data)), `${label}: 8-bit`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane present`);
  if (expected.__image16) assert.ok(bytes(actual.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit`);
}

// An in-process worker: messages are structured-cloned with their transfer
// lists and answered asynchronously by the real band code.
function fakeWorkerFactory(log, { failOn = null, crashOn = null, tracker = null } = {}) {
  return () => {
    const worker = {
      terminated: false,
      postMessage(message, transfers) {
        const copy = structuredClone(message, { transfer: transfers });
        const copied = (copy.src.data8?.byteLength || 0) + (copy.src.data16?.byteLength || 0);
        log.push({ y0: copy.y0, y1: copy.y1, window: copy.lensRemap?.window, shared: Boolean(copy.src.shared16), copied, gridRow0: copy.lensRemap?.maps.gridRow0 });
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

assert.deepEqual(planLensRemapBands(10, 3), [{ y0: 0, y1: 4 }, { y0: 4, y1: 8 }, { y0: 8, y1: 10 }]);
assert.deepEqual(planLensRemapBands(2, 5), [{ y0: 0, y1: 1 }, { y0: 1, y1: 2 }]);
assert.equal(lensRemapReads16(makeSource(4, 4)), true);
assert.equal(lensRemapReads16(makeSource(4, 4, 1, { eightBit: true })), false);
{
  const odd = makeSource(4, 4);
  odd.__image16 = { width: 4, height: 3, data: new Uint16Array(48) };
  assert.equal(lensRemapReads16(odd), false, 'a plane of another size is not read');
}

const W = 97, H = 71;
const sources = {
  '16-bit': makeSource(W, H, 3),
  '8-bit': makeSource(W, H, 5, { eightBit: true }),
  'shared 16-bit': makeSource(W, H, 7, { shared: true })
};
const mapSets = {
  'distortion + TCA + vignetting': lensTestMaps(W, H, 3),
  'distortion only': lensTestMaps(W, H, 4, { tca: false, vignetting: false }),
  'no distortion calibration (TCA, vignetting)': lensTestMaps(W, H, 3, { distortion: false }),
  'strong': lensTestMaps(W, H, 2, { strength: 0.08 }),
  'shifted': lensTestMaps(W, H, 5, { shift: 9 }),
  'poisoned nodes': lensTestMaps(W, H, 3, { poison: true })
};
const modeSets = [
  { includeTca: true, includeVignetting: true },
  { includeTca: false, includeVignetting: true },
  { includeTca: true, includeVignetting: false },
  { includeTca: false, includeVignetting: false }
];
const before = Object.fromEntries(Object.entries(sources).map(([name, image]) => [name, {
  data8: Buffer.from(bytes(image.data)), data16: image.__image16 ? Buffer.from(bytes(image.__image16.data)) : null
}]));

for (const [sourceName, source] of Object.entries(sources)) {
  for (const [mapName, maps] of Object.entries(mapSets)) {
    for (const modes of modeSets) {
      const label = `${sourceName} / ${mapName} / tca=${modes.includeTca} vig=${modes.includeVignetting}`;
      const expected = applyLensMapsToImage(source, maps, modes);
      for (const [size, bands] of [[1, 1], [2, 3], [3, 5], [6, 8]]) {
        const log = [];
        const pool = createGeometryPool({ workerFactory: fakeWorkerFactory(log), workersSupported: true, size, idleTimeoutMs: 5 });
        const actual = await pool.renderLensRemap(source, maps, modes, { bands });
        assertSame(actual, expected, `${label} pool ${size} bands ${bands}`);
        assert.equal(log.length, Math.min(bands, H), 'one worker message per band');
        assert.equal(pool.counters.syncBands, 0);
        assert.equal(pool.counters.lensRemaps, 1);
        // Each band got exactly the rows lensSourceRows names, from the
        // plane the remap reads (a view of a shared one, copied otherwise).
        const extents = lensRowExtents(maps, modes);
        for (const entry of log) {
          const window = lensSourceRows(maps, modes, entry.y0, entry.y1, H, extents);
          assert.deepEqual(entry.window, window, `${label}: band window`);
          if (sourceName === 'shared 16-bit') assert.ok(entry.shared && entry.copied === 0, `${label}: a shared plane is read through views`);
          else assert.equal(entry.copied, (window.y1 - window.y0) * W * 4 * (sourceName === '8-bit' ? 1 : 2), `${label}: the band's rows were copied`);
        }
        if (sourceName === 'shared 16-bit') {
          assert.ok(isSharedPlane(actual.__image16.data) === isSharedPlane(expected.__image16.data), `${label}: the output is shared like the whole-image remap's`);
        }
        pool.dispose();
      }
      // The synchronous fallback (no workers): the same output, in bands.
      {
        const pool = createGeometryPool({ workerFactory: fakeWorkerFactory([]), workersSupported: false, size: 2 });
        assertSame(await pool.renderLensRemap(source, maps, modes), expected, `${label} sync`);
        assert.ok(pool.counters.syncBands >= 1);
        pool.dispose();
      }
    }
  }
}
for (const [name, image] of Object.entries(sources)) {
  assert.ok(bytes(image.data).equals(before[name].data8), `${name}: the 8-bit plane is untouched`);
  if (image.__image16) assert.ok(bytes(image.__image16.data).equals(before[name].data16), `${name}: the 16-bit plane is untouched`);
}

// A failing band and a crashing worker fall back to this thread for the
// remaining bands, with the same pixels; a stale job resolves null.
{
  const source = sources['16-bit'];
  const maps = mapSets['distortion + TCA + vignetting'];
  const modes = modeSets[0];
  const expected = applyLensMapsToImage(source, maps, modes);
  const failing = createGeometryPool({ workerFactory: fakeWorkerFactory([], { failOn: 1 }), workersSupported: true, size: 2, idleTimeoutMs: 5 });
  assertSame(await failing.renderLensRemap(source, maps, modes, { bands: 4 }), expected, 'a failed band');
  assert.ok(failing.counters.syncBands >= 1 && failing.counters.fallbacks === 1);
  assert.equal(failing.available, false);
  failing.dispose();
  const crashing = createGeometryPool({ workerFactory: fakeWorkerFactory([], { crashOn: 0 }), workersSupported: true, size: 2, idleTimeoutMs: 5 });
  assertSame(await crashing.renderLensRemap(source, maps, modes, { bands: 4 }), expected, 'a crashed worker');
  crashing.dispose();
  const stale = createGeometryPool({ workerFactory: fakeWorkerFactory([]), workersSupported: true, size: 2, idleTimeoutMs: 5 });
  let calls = 0;
  assert.equal(await stale.renderLensRemap(source, maps, modes, { bands: 4, isCurrent: () => ++calls < 3 }), null, 'a stale job resolves null');
  stale.dispose();
  // The in-flight cap bounds the bands posted at once.
  const tracker = { inFlight: 0, peak: 0 };
  const capped = createGeometryPool({ workerFactory: fakeWorkerFactory([], { tracker }), workersSupported: true, size: 4, idleTimeoutMs: 5 });
  assertSame(await capped.renderLensRemap(source, maps, modes, { bands: 8, maxInFlight: 2 }), expected, 'capped');
  assert.ok(tracker.peak <= 2, `at most 2 bands in flight (${tracker.peak})`);
  capped.dispose();
}

// The real worker script on real threads, a larger frame.
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
  const big = makeSource(640, 420, 11);
  const bigShared = makeSource(640, 420, 11, { shared: true });
  const big8 = makeSource(640, 420, 13, { eightBit: true });
  const maps = lensTestMaps(640, 420, 6);
  for (const modes of modeSets) {
    for (const [name, image] of [['plain', big], ['shared', bigShared], ['8-bit', big8]]) {
      const expected = applyLensMapsToImage(image, maps, modes);
      assertSame(await pool.renderLensRemap(image, maps, modes, { bands: 5 }), expected, `threads ${name} tca=${modes.includeTca} vig=${modes.includeVignetting}`);
    }
  }
  pool.dispose();
  for (const thread of threads) await thread.terminate();
}

console.log('geometryPool.lens.test.mjs passed');
