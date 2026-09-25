// #254 D1/D4/D5 in the adapter: a stroke added or undone in an interactive slot
// updates the stops map and the post-exposure level inside the stroke's box only,
// and full-resolution (transient) requests use a tiled map. Every frame is compared
// with the frozen 1703835 adapter (full raster, dense map) by SHA-256 of both planes.
import assert from 'node:assert/strict';
import { convertBoth, resetBoth, live } from './oracle/adapterParity.mjs';
import { sanitizeLocalExposureForSettings } from '../app/localExposure.js';

const W = 72, H = 52;

function negative(seed = 1, w = W, h = H) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (w + h);
      data[i] = Math.min(65535, Math.round(52000 - 30000 * t + ((x * 131 + y * 71 * seed) % 900)));
      data[i + 1] = Math.min(65535, Math.round(36000 - 22000 * t + ((x * 97 + y * 53 * seed) % 700)));
      data[i + 2] = Math.min(65535, Math.round(24000 - 15000 * t + ((x * 61 + y * 89 * seed) % 500)));
      data[i + 3] = (x < 2 && y < 2) ? 0 : 65535;
    }
  }
  return { width: w, height: h, data };
}

let seed = 254;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function stroke(i) {
  const points = [];
  let x = random(), y = random();
  const count = 1 + Math.floor(random() * 12);
  for (let k = 0; k < count; k++) { points.push({ x, y, p: i % 3 === 0 ? 0.3 + random() * 0.7 : 1 }); x += (random() - 0.5) * 0.2; y += (random() - 0.5) * 0.2; }
  return { stops: (random() - 0.5) * 3, size: 0.05 + random() * 0.25, feather: [0, 0.3, 0.5, 1][i % 4], points };
}
const all = Array.from({ length: 12 }, (_, i) => stroke(i));

const geometries = [
  { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null },
  { baseWidth: 80, baseHeight: 60, rotatedWidth: 80, rotatedHeight: 60, rotationAngle: 0, mirrored: true, cropRegion: { left: 4, top: 4, width: W, height: H } },
];
const BASE = { color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } }, bw: { colorModel: 'standard' }, positive: { positiveMode: 'correct' } };

let frames = 0;
async function expectSame(label, mode, image, settings, options) {
  const { live: a, oracle: b } = await convertBoth(mode, image, settings, options);
  assert.deepEqual(a, b, label);
  frames++;
}

for (const mode of ['color', 'bw', 'positive']) {
  for (const geometry of geometries) {
    const image = negative(mode === 'bw' ? 3 : 1);
    const settingsFor = (count) => ({ ...BASE[mode],
      localExposure: count ? sanitizeLocalExposureForSettings({ strokes: all.slice(0, count) }) : null,
      localExposureGeometry: geometry });
    // Interactive: strokes painted one by one, then undone, like the Retouch tab.
    resetBoth();
    const before = live.getSilverCoreCacheStats();
    for (let count = 0; count <= all.length; count++) {
      // structuredClone: the worker receives a copy of the settings every time.
      await expectSame(`${mode} paint ${count}`, mode, image, structuredClone(settingsFor(count)), { preview: true, includeAnalysisPreview: false });
    }
    // A slider tick between strokes keeps the level.
    await expectSame(`${mode} tick`, mode, image, { ...structuredClone(settingsFor(all.length)), contrast: 12 }, { preview: true, includeAnalysisPreview: false });
    for (let count = all.length - 1; count >= all.length - 3; count--) {
      await expectSame(`${mode} undo ${count}`, mode, image, structuredClone(settingsFor(count)), { preview: true, includeAnalysisPreview: false });
    }
    const after = live.getSilverCoreCacheStats();
    const maps = (key) => after.exposureMaps[key] - before.exposureMaps[key];
    assert.equal(maps('extended'), all.length - 1, `${mode}: every stroke after the first extends the map`);
    assert.ok(maps('undone') >= 1, `${mode}: the last stroke is undone in place`);
    assert.ok(maps('full') <= 4, `${mode}: full rasters only for the first stroke and multi-step undos (${maps('full')})`);
    assert.ok(after.exposedUpdates - before.exposedUpdates >= all.length - 1, `${mode}: the post-exposure level follows each stroke inside its box`);
    assert.equal(after.preview.exposureMapTiled, false);

    // Full resolution (forceFullProcess, as the settle and exports ask): tiled maps.
    resetBoth();
    for (const count of [1, 5, all.length]) {
      await expectSame(`${mode} forced ${count}`, mode, image, structuredClone(settingsFor(count)), { forceFullProcess: true });
      const stats = live.getSilverCoreCacheStats();
      assert.equal(stats.full.exposureMapTiled, true, `${mode}: a transient request uses a tiled map`);
    }
  }
}

console.log(`silverAdapter.strokes: ${frames} frames identical to 1703835 (strokes added and undone in place, tiled full-resolution maps)`);
