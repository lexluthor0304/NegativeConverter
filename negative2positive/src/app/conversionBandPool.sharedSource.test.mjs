// The conversion band pool with a source that is itself in shared memory
// (#264 Part A phase 2: the editor's plane on a cross-origin isolated page).
// Each band copies its own rows from the source into the pool's plane in its
// worker (the 'load' message carries `sourceRows`), so this thread copies
// nothing into shared memory; the pixels equal the whole-frame conversion,
// and the source is only read.
// Run with: node negative2positive/src/app/conversionBandPool.sharedSource.test.mjs
import assert from 'node:assert/strict';
import { sha } from '../pipeline/oracle/adapterParity.mjs';
import { bandThreadFactory } from './bandWorkerThreads.mjs';
import { hashPlane, configurePlaneGuard, planeGuardReport } from './crossOriginIsolation.js';

const { createConversionBandPool } = await import('./conversionWorkerClient.js');
const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
const { invalidateSilverCoreCache } = await import('../pipeline/silverAdapter.js');

configurePlaneGuard({ enabled: true });
const threads = [];
const loads = [];
const factory = bandThreadFactory({ threads });
const spyFactory = () => {
  const worker = factory();
  const post = worker.postMessage;
  worker.postMessage = (message, transfers) => {
    if (message?.type === 'load') loads.push({ sourceRows: Boolean(message.sourceRows), shared: Boolean(message.shared) });
    return post(message, transfers);
  };
  return worker;
};

function negative(seed, w, h, plane) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (w + h);
      plane[i] = Math.min(65535, Math.round(52000 - 30000 * t + ((x * 131 + y * 71 * seed) % 900)));
      plane[i + 1] = Math.min(65535, Math.round(36000 - 22000 * t + ((x * 97 + y * 53 * seed) % 700)));
      plane[i + 2] = Math.min(65535, Math.round(24000 - 15000 * t + ((x * 61 + y * 89 * seed) % 500)));
      plane[i + 3] = 65535;
    }
  }
  return plane;
}
function frame(width, height, plane) {
  const image = new ImageData(Uint8ClampedArray.from(plane, (v) => v >>> 8), width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}

const W = 241, H = 127;
const length = W * H * 4;
const shared = negative(5, W, H, new Uint16Array(new SharedArrayBuffer(length * 2)));
const plain = negative(5, W, H, new Uint16Array(length));
const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
invalidateSilverCoreCache();
const expected = await convertFrameWithRouter({ imageData: frame(W, H, plain), settings: structuredClone(settings), options: { forceFullProcess: true } });

const pool = createConversionBandPool({ size: 3, workerFactory: spyFactory, shared: true });
const before = hashPlane(shared);
for (const bands of [1, 3, 4]) {
  loads.length = 0;
  const converted = await pool.convert({ imageData: frame(W, H, shared), settings: structuredClone(settings), options: { forceFullProcess: true } }, { bands });
  assert.equal(sha(converted.__image16.data), sha(expected.__image16.data), `${bands} band(s): the same 16-bit pixels`);
  assert.equal(sha(converted.data), sha(expected.data), `${bands} band(s): the same 8-bit pixels`);
  assert.equal(loads.length, bands);
  assert.ok(loads.every((load) => load.sourceRows && load.shared), 'every band copied its rows of the shared source itself');
}
assert.equal(hashPlane(shared), before, 'the shared source was only read');
assert.equal(planeGuardReport().violations.length, 0);
assert.ok(planeGuardReport().checks >= 3, 'the guard checked the source around every conversion');

// A plain source in a shared pool: sliced here as before (no sourceRows).
loads.length = 0;
const fromPlain = await pool.convert({ imageData: frame(W, H, plain), settings: structuredClone(settings), options: { forceFullProcess: true } }, { bands: 2 });
assert.equal(sha(fromPlain.__image16.data), sha(expected.__image16.data));
assert.ok(loads.every((load) => !load.sourceRows), 'a plain source is copied into the pool plane on this thread');

pool.dispose();
for (const thread of threads) await thread.terminate();
configurePlaneGuard({ enabled: null });
console.log('conversion band pool: a shared source is copied by the bands, not by this thread');
