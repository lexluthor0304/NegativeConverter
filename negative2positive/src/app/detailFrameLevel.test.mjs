import assert from 'node:assert/strict';
import { buildDetailFrameLevel, copyRegionRows, estimateDetailRoiBytes, detailSlotSize, planDetailRegion } from './detailLayer.js';
import { filterDisplayImage, buildDisplayLevel } from './displayPreview.js';
import { createConversionWorkerClient } from './conversionWorkerClient.js';

globalThis.ImageData = class {
  constructor(a, b, c) {
    if (typeof a === 'number') Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) });
    else Object.assign(this, { width: b, height: c, data: a });
  }
};
let bridge;
globalThis.self = { postMessage: (data, transfers = []) => bridge.onmessage({ data: structuredClone(data, { transfer: transfers }) }) };
await import('../workers/conversionWorker.js');
bridge = { postMessage: (data, transfers = []) => { void self.onmessage({ data: structuredClone(data, { transfer: transfers }) }); }, terminate() {} };
const client = createConversionWorkerClient({ cacheInput: true, workerFactory: () => bridge });
const frame = new ImageData(191, 137);
for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
  const i = (y * frame.width + x) * 4;
  frame.data.set([(x * 17 + y * 13) % 256, (x * 5 + y * 7) % 256, (x * 23 + y * 19) % 256, 255], i);
}
const rect = { x: 11, y: 7, width: 173, height: 121 };
const crop = new ImageData(copyRegionRows(frame.data, frame.width, rect), rect.width, rect.height);
for (const k of [2, 3]) {
  let bands = 0;
  const level = await buildDetailFrameLevel(frame, rect, { k, tilePixels: rect.width * k * 2, pause: async () => { bands++; } });
  assert.ok(bands > 1, 'exercise multiple bands and discarded edge cells');
  const fullLevel = buildDisplayLevel(crop, k);
  assert.deepEqual(level.data, fullLevel.__image16.data, 'bounded bands keep the original box kernel byte for byte');
  for (const target of [{ width: 83, height: 57 }, { width: 19, height: 13 }]) {
    const expected = filterDisplayImage(crop, target, { k });
    const geometry = level.geometry;
    const image = { ...level, data: level.data.slice() };
    const result = await client.resample(image, target, { detail: true, geometry, transfer: true });
    assert.deepEqual(result.data, expected.data, `actual client/worker exact crop k${k}, ${target.width}x${target.height}`);
    assert.equal(image.data.byteLength, 0, 'transfer releases the page level');
    assert.equal(result.__image16, undefined, 'the exact RGBA8 crop does not retain a duplicate 16-bit output');
  }
}
client.dispose();
const controller = new AbortController();
let pauses = 0;
assert.equal(await buildDetailFrameLevel(frame, rect, { k: 2, signal: controller.signal, tilePixels: rect.width * 4,
  pause: async () => { pauses++; controller.abort(); } }), null);
assert.equal(pauses, 1, 'cancellation stops before the next native band');
assert.deepEqual(frame.data.length, 191 * 137 * 4, 'the exact source remains owned by the page');

// Separate accounting for exact crops uses their own filter k, never fromLevel.
for (const [width, height, budgetMiB] of [[1110, 700, 384], [1600, 1000, 512]]) {
  const sourceWidth = 9536, sourceHeight = 6336, fit = Math.min((width - 20) / sourceWidth, (height - 20) / sourceHeight);
  const view = { sourceWidth, sourceHeight, baseWidth: 1809, fit, zoom: 1.5, dpr: 2,
    panX: -(0.5 * sourceWidth * fit) / 2, panY: -(0.5 * sourceHeight * fit) / 2,
    baseX: (width - sourceWidth * fit) / 2, baseY: (height - sourceHeight * fit) / 2, containerWidth: width, containerHeight: height, levelFactor: 3 };
  const plan = planDetailRegion(view);
  assert.ok(detailSlotSize(width, height, 2), 'a supported viewport');
  const exact = estimateDetailRoiBytes(plan, { exactFrame: true });
  assert.ok(exact > estimateDetailRoiBytes(plan), 'exact input accounting cannot assume the retained source level');
  assert.ok(exact <= budgetMiB * 1024 * 1024, `${exact} bytes exceeds ${budgetMiB} MiB`);
  console.log(`exact detail ${width}x${height} descriptor allocation estimate: ${exact} bytes (not RSS)`);
}
console.log('detailFrameLevel: bounded exact bands match the original filter through the actual client/worker, with transfer, cancellation and exact-input accounting');
