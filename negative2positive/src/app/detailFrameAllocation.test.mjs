import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as detail from './detailLayer.js';
import { computeZoomGeometry } from './zoomGeometry.js';

// R1-092: the review's exact frame and view, with no large pixel allocation.
// Run the actual helper, not just the planner or its memory estimate.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const match = /^    async function detailFromFrame\(/m.exec(source);
assert.ok(match);
const body = source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
const frame = { width: 9536, height: 6336, data: { buffer: new ArrayBuffer(4) } };
const fit = Math.min(1090 / frame.width, 680 / frame.height);
const zoom = 1.5;
const geometry = computeZoomGeometry({ wrapperW: frame.width * fit, wrapperH: frame.height * fit, containerW: 1110, containerH: 700, zoom });
const view = { sourceWidth: frame.width, sourceHeight: frame.height, baseWidth: 1809, fit, zoom, dpr: 2,
  panX: (geometry.minPanX + geometry.maxPanX) / 2, panY: (geometry.minPanY + geometry.maxPanY) / 2,
  baseX: geometry.baseX, baseY: geometry.baseY, containerWidth: 1110, containerHeight: 700, levelFactor: 3 };
const plan = detail.planDetailRegion(view);
assert.equal(plan.fromLevel, true);
assert.deepEqual([plan.width, plan.height], [7695, 5148], 'keep the original review geometry');
const copies = [], resamples = [], levels = [];
const context = vm.createContext({
  ...detail,
  ImageData: class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } },
  Uint8ClampedArray,
  detailLayer: { counters: { crops: 0 } },
  copyRegionRows: (data, width, rect) => {
    copies.push({ ...rect, bytes: rect.width * rect.height * 4 });
    return new Uint8ClampedArray(4);
  },
  buildDetailFrameLevel: async (image, rect) => {
    levels.push({ image, rect });
    return { width: rect.width / 3, height: rect.height / 3, data: new Uint16Array(4), geometry: { sourceWidth: rect.width, sourceHeight: rect.height, k: 3 } };
  },
  convertPreviewFrameInWorker: { resample: async (image, target, options) => {
    resamples.push({ image, target, options });
    return { width: target.width, height: target.height, data: new Uint8ClampedArray(4) };
  } },
});
vm.runInContext(body, context);
const result = await context.detailFromFrame(frame, plan, new AbortController().signal);
assert.ok(copies.every(copy => copy.bytes <= 16_000_000 * 4), `native exact-frame crop bypassed the limit: ${JSON.stringify(copies)}`);
assert.equal(levels.length, 1, 'an oversized exact crop uses bounded level bands');
assert.equal(levels[0].image, frame, 'the level comes from the exact frame, never the conversion source');
assert.equal(levels[0].rect, plan, 'retain the entire source rectangle and display coordinates');
assert.deepEqual([result.width, result.height], [plan.outWidth, plan.outHeight]);
assert.equal(resamples.length, 1);
assert.equal(resamples[0].options.detail, true, 'the actual worker allocator is bounded too');
assert.deepEqual(resamples[0].options.geometry, { sourceWidth: plan.width, sourceHeight: plan.height, k: 3 });

// Invoke the actual band builder at the original dimensions too. All planes
// below are descriptors: record requested sizes and abort after the first band.
const layerSource = readFileSync(new URL('./detailLayer.js', import.meta.url), 'utf8');
const begin = layerSource.indexOf('export async function buildDetailFrameLevel(');
const builder = layerSource.slice(begin + 'export '.length, layerSource.indexOf('\n}', begin) + 2);
const allocations = [], bandCopies = [];
const controller = new AbortController();
const bandContext = vm.createContext({
  ...detail,
  displayLevelFactor: () => 3,
  Uint16Array: class { constructor(length) { allocations.push(length * 2); } set() {} },
  copyRegionRows: (data, width, rect) => { bandCopies.push(rect.width * rect.height * 4); return {}; },
  displayLevelRows: (image, k, width) => { allocations.push(width * (image.height / k) * 8); return {}; },
});
vm.runInContext(builder, bandContext);
assert.equal(await bandContext.buildDetailFrameLevel(frame, plan, { signal: controller.signal,
  pause: async () => { controller.abort(); } }), null);
assert.equal(bandCopies.length, 1);
assert.ok(bandCopies[0] <= detail.DETAIL_MAX_TILE_PIXELS * 4, 'actual exact-frame builder caps native band copies');
assert.ok(allocations[0] <= detail.DETAIL_MAX_NATIVE_PIXELS * 8, 'actual level allocator is bounded');
assert.ok(allocations[1] <= detail.DETAIL_MAX_TILE_PIXELS * 8, 'actual band-level scratch is bounded');
console.log('exact-frame descriptor allocator requests:', { nativeBand: bandCopies[0], level: allocations[0], bandLevel: allocations[1] });
console.log('detailFrameAllocation: original 60 MP descriptor/fromLevel exact-frame caller retains the region without a 158 MB crop');
