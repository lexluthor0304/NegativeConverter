import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as detail from './detailLayer.js';
import { createConversionWorkerClient } from './conversionWorkerClient.js';

const { DETAIL_MAX_NATIVE_PIXELS: nativeLimit, DETAIL_MAX_OUTPUT_PIXELS: outputLimit } = detail;
const valid = { width: 2, height: 2, outWidth: 2, outHeight: 2, slotWidth: 64, slotHeight: 64, fromLevel: false };
const invalid = [
  { ...valid, width: 4001, height: 4000 },
  { ...valid, fromLevel: true, levelFactor: 2, width: 8002, height: 8000 },
  { ...valid, outWidth: 8192, outHeight: 8192 },
  { ...valid, slotWidth: 8192, slotHeight: 8192 },
  // Each surface alone fits; their padded bounding rectangle does not.
  { ...valid, slotWidth: 8192, slotHeight: 512, outWidth: 512, outHeight: 8192 },
];
let factories = 0;
const client = createConversionWorkerClient({ workerFactory: () => { factories++; throw new Error('must reject before posting'); } });
for (const region of invalid) await assert.rejects(client.roi({ settings: {}, region }), /Detail allocation/);
await assert.rejects(client.roi({ settings: {}, warm: true, region: invalid[3] }), /Detail allocation/);
await assert.rejects(client.resample({ width: 4001, height: 4000, get data() { throw new Error('must reject before slicing'); } },
  { width: 2, height: 2 }, { detail: true }), /Detail allocation/);
await assert.rejects(client.resample({ width: 2, height: 2, get data() { throw new Error('must reject before slicing'); } },
  { width: 8192, height: 8192 }, { detail: true }), /Detail allocation/);
assert.equal(factories, 0, 'the real client rejects oversized payloads before worker creation');

// Descriptor-only allocator traps: a regression fails before a large typed
// array is constructed. The extracted functions are the actual worker callers.
const workerSource = readFileSync(new URL('../workers/conversionWorker.js', import.meta.url), 'utf8');
const fn = name => {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(workerSource).index;
  return workerSource.slice(start, workerSource.indexOf('\n}', start) + 2);
};
let requested = [], replies = [];
const trapped = (Plane, limit) => class extends Plane {
  constructor(length) {
    if (typeof length === 'number') {
      requested.push(length);
      if (length > limit * 4) throw new Error('unbounded allocator reached');
    }
    super(length);
  }
};
const context = vm.createContext({
  ...detail, Math, Number,
  Uint16Array: trapped(Uint16Array, nativeLimit), Uint8ClampedArray: trapped(Uint8ClampedArray, outputLimit),
  self: { postMessage: msg => replies.push(msg) }, releaseSlotBuffers: () => {}, resolveConversionMode: () => 'color',
  cachedSource: { width: 4, height: 4 }, cancelledRequests: new Set(),
});
vm.runInContext(['roi', 'resample', 'cropPlane', 'padPlane'].map(fn).join('\n'), context);
for (const region of invalid) {
  requested = []; replies = [];
  await context.roi({ id: 1, settings: {}, region, base: { levelWidth: 4, levelHeight: 4 } });
  assert.match(replies[0].message, /Detail allocation/);
  assert.equal(requested.length, 0, 'ROI rejects before row/level/pad/result allocation');
}
requested = []; replies = [];
await context.roi({ id: 2, settings: {}, region: invalid[3], warm: true });
assert.match(replies[0].message, /Detail allocation/);
assert.equal(requested.length, 0, 'warm-up cannot allocate an oversized blank slot');
context.resample({ id: 3, detail: true, width: 4001, height: 4000, target: { width: 2, height: 2 } });
assert.match(replies.at(-1).message, /Detail allocation/);
assert.equal(requested.length, 0, 'exact-frame resample rejects before building a level');
assert.throws(() => context.cropPlane({ width: 9536, height: 6336 }, { x: 0, y: 0, width: 7695, height: 5148 }), /Detail allocation/);
assert.throws(() => context.padPlane({ width: 2, height: 2 }, 8192, 8192), /Detail allocation/);
assert.equal(requested.length, 0, 'direct crop and pad allocators are bounded');
assert.throws(() => detail.copyRegionRows({}, 9536, { x: 0, y: 0, width: 7695, height: 5148 }), /Detail allocation/);
assert.equal(detail.detailSlotSize(1600, 1000, 2).width, 3584);
assert.equal(detail.detailSlotSize(7680, 4320, 2), null, 'an unsupported viewport falls back before warm-up');
assert.equal(detail.planDetailRegion({ sourceWidth: 9536, sourceHeight: 6336, baseWidth: 1809, fit: 0.1, zoom: 10,
  dpr: 2, panX: 0, panY: 0, baseX: 0, baseY: 0, containerWidth: 7680, containerHeight: 4320, levelFactor: 3 }), null);
console.log('detailAllocationGuards: native/level crops, warm-up, padded slots, exact resample, client posting and zoom outputs reject before allocation');
