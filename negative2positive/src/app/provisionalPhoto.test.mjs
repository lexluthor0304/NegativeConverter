// The provisional window of a two-stage RAW import (#255), pure parts:
// - the twoStageMinMp flag and the concurrent/sequential start of stage 2;
// - crop units: a saved full-resolution crop restored on the half-size
//   stand-in and extracted again is the saved crop exactly (rotated, mirrored,
//   reaching or leaving the frame, the issue's {400, 300, 8700, 5800}); a crop
//   drawn in the window converts to full units once; the swap re-converts a
//   converted crop against the real full size and keeps a saved one;
// - window edits: what the user changed wins, automatic values come from the
//   full decode, white balance only when the user took it over.
import assert from 'node:assert/strict';
import {
  twoStageMinPixels, stageTwoStartMode, projectCropRegion, geometryFrame, createExactGeometry,
  windowEditKeys, windowEdits, overlayWindowEdits, geometryEdits, hasWindowEdits, sameGeometry
} from './provisionalPhoto.js';
import { sanitizeCropRect } from './imageGeometry.js';

// ---- flag and start mode ----------------------------------------------------------
for (const off of [null, undefined, '', 'off', 0, '0', -1, 'abc']) assert.equal(twoStageMinPixels(off), null, String(off));
assert.equal(twoStageMinPixels('40'), 40e6);
assert.equal(twoStageMinPixels(1), 1e6);
assert.equal(stageTwoStartMode({ deviceMemory: 8, hardwareConcurrency: 8 }), 'concurrent');
assert.equal(stageTwoStartMode({ deviceMemory: 16, hardwareConcurrency: 6 }), 'concurrent');
assert.equal(stageTwoStartMode({ deviceMemory: 8, hardwareConcurrency: 4 }), 'sequential');
assert.equal(stageTwoStartMode({ deviceMemory: 4, hardwareConcurrency: 12 }), 'sequential', 'below 8 GB');
assert.equal(stageTwoStartMode({ hardwareConcurrency: 12 }), 'sequential', 'no deviceMemory (WebKit)');
assert.equal(stageTwoStartMode({ deviceMemory: 8, hardwareConcurrency: 8, override: 'sequential' }), 'sequential');
assert.equal(stageTwoStartMode({ hardwareConcurrency: 2, override: 'concurrent' }), 'concurrent');

// ---- crop projection ----------------------------------------------------------------
const FULL = { width: 9536, height: 6336 };
const HALF = { width: 4768, height: 3168 };
assert.deepEqual(projectCropRegion({ left: 400, top: 300, width: 8700, height: 5800 }, 0, FULL, HALF, { outward: true }),
  { left: 200, top: 150, width: 4350, height: 2900 });
assert.deepEqual(projectCropRegion({ left: 401, top: 301, width: 8700, height: 5801 }, 0, FULL, HALF, { outward: true }),
  { left: 200, top: 150, width: 4351, height: 2901 }, 'outward: odd edges widen');
assert.deepEqual(projectCropRegion({ x: 10, y: 20, width: 100, height: 50 }, 0, HALF, FULL), { left: 20, top: 40, width: 200, height: 100 }, 'legacy x/y');
assert.equal(projectCropRegion(null, 0, FULL, HALF), null);
// A tilted frame does not scale by exactly 2.
const tiltFull = geometryFrame(FULL, -0.75), tiltHalf = geometryFrame(HALF, -0.75);
assert.deepEqual([tiltFull.width - 2 * tiltHalf.width, tiltFull.height - 2 * tiltHalf.height], [-1, -1]);

// A live geometry after the chain sanitised a projected crop (what
// applyGeometryFromBase installs on the stand-in).
function install(size, geometry, crop) {
  return { ...geometry, cropRegion: crop ? sanitizeCropRect(crop, geometryFrame(size, geometry.rotationAngle)) : null };
}

// ---- restore then extract gives the saved crop exactly --------------------------------
const saved = [
  { rotationAngle: 0, mirrored: false, cropRegion: { left: 400, top: 300, width: 8700, height: 5800 } },
  { rotationAngle: 1.3, mirrored: false, cropRegion: { left: 377, top: 281, width: 8801, height: 5733 } },
  { rotationAngle: -0.75, mirrored: true, cropRegion: { left: 123, top: 457, width: 9001, height: 5555 } },
  { rotationAngle: 90, mirrored: true, cropRegion: { left: 11, top: 13, width: 6000, height: 9000 } },
  // Reaching the frame's edge, and past it (a clamped-looking crop).
  { rotationAngle: 0, mirrored: false, cropRegion: { left: 400, top: 300, width: 9136, height: 6036 } },
  { rotationAngle: 0, mirrored: false, cropRegion: { left: 9000, top: 6000, width: 900, height: 700 } },
  { rotationAngle: 2.5, mirrored: false, cropRegion: null }
];
for (const settings of saved) {
  const exact = createExactGeometry({ size: HALF, fullSize: FULL });
  const projected = exact.project(settings);
  const live = install(HALF, settings, projected);
  exact.installed(live);
  const out = exact.exact(live);
  assert.deepEqual(out, { rotationAngle: settings.rotationAngle, mirrored: settings.mirrored, cropRegion: settings.cropRegion },
    `restore -> extract keeps ${JSON.stringify(settings)}`);
  assert.deepEqual(exact.exact(live), out, 'and again');
  // Swapped onto the real full decode: no clamp, no x2, no drift.
  assert.deepEqual(exact.rebase(FULL, live), out, 'the swap installs the saved crop');
  if (settings.cropRegion && settings.cropRegion.left + settings.cropRegion.width <= geometryFrame(FULL, settings.rotationAngle).width) {
    const onFull = sanitizeCropRect(out.cropRegion, geometryFrame(FULL, settings.rotationAngle));
    assert.deepEqual(onFull, settings.cropRegion, 'the full frame takes it as saved');
  }
}
// HEAD's defect for comparison: clamp to the half-size frame, then x2.
{
  const clamped = sanitizeCropRect({ left: 400, top: 300, width: 8700, height: 5800 }, HALF);
  assert.deepEqual(clamped, { left: 400, top: 300, width: 4368, height: 2868 });
  const exact = createExactGeometry({ size: HALF, fullSize: FULL });
  const settings = { rotationAngle: 0, mirrored: false, cropRegion: { left: 400, top: 300, width: 8700, height: 5800 } };
  const live = install(HALF, settings, exact.project(settings));
  exact.installed(live);
  assert.deepEqual(exact.rebase(FULL, live).cropRegion, { left: 400, top: 300, width: 8700, height: 5800 }, 'not {800, 600, 8736, 5736}');
}

// ---- a crop drawn in the window converts once --------------------------------------------
{
  const exact = createExactGeometry({ size: HALF, fullSize: FULL });
  const start = { rotationAngle: 0, mirrored: false, cropRegion: null };
  exact.installed(install(HALF, start, exact.project(start)));
  const user = { rotationAngle: 0, mirrored: false, cropRegion: { left: 101, top: 77, width: 2001, height: 1333 } };
  const first = exact.exact(user);
  assert.deepEqual(first.cropRegion, { left: 202, top: 154, width: 4002, height: 2666 });
  assert.equal(exact.derived, true);
  assert.deepEqual(exact.exact(user), first, 'converted once, not again');
  // The stand-in's full size was an estimate one pixel off: the swap converts
  // the user's crop against the real frame.
  const real = { width: 9534, height: 6336 };
  const rebased = exact.rebase(real, user);
  assert.deepEqual(rebased.cropRegion, projectCropRegion(user.cropRegion, 0, HALF, real));
  // Undo in the window: the entry's saved state comes back with its crop.
  const entry = exact.save();
  const other = { rotationAngle: 90, mirrored: false, cropRegion: { left: 5, top: 6, width: 100, height: 200 } };
  exact.exact(other);
  exact.restore(entry, user);
  assert.deepEqual(exact.exact(user), first, 'undo restores the converted crop');
}
// toExact: an analysis result on the stand-in (the auto-frame crop) in full
// units, without recording it; the installed projection maps to the saved crop.
{
  const exact = createExactGeometry({ size: HALF, fullSize: FULL });
  const settings = { rotationAngle: 0, mirrored: false, cropRegion: { left: 400, top: 300, width: 8700, height: 5800 } };
  const live = install(HALF, settings, exact.project(settings));
  exact.installed(live);
  assert.deepEqual(exact.toExact(live), settings);
  const framed = { rotationAngle: 0.6, mirrored: false, cropRegion: { left: 90, top: 60, width: 4500, height: 3000 } };
  assert.deepEqual(exact.toExact(framed).cropRegion, projectCropRegion(framed.cropRegion, 0.6, HALF, FULL));
  assert.deepEqual(exact.exact(live), settings, 'toExact records nothing');
}
// Rotation in the window (a user edit): the new geometry converts once.
{
  const exact = createExactGeometry({ size: HALF, fullSize: FULL });
  const settings = { rotationAngle: 0, mirrored: false, cropRegion: { left: 400, top: 300, width: 8700, height: 5800 } };
  const live = install(HALF, settings, exact.project(settings));
  exact.installed(live);
  const rotated = { rotationAngle: 90, mirrored: false, cropRegion: { left: 150, top: 200, width: 2900, height: 4350 } };
  assert.deepEqual(exact.exact(rotated), { rotationAngle: 90, mirrored: false, cropRegion: { left: 300, top: 400, width: 5800, height: 8700 } });
  assert.equal(sameGeometry(rotated, rotated), true);
}

// ---- window edits -----------------------------------------------------------------------------
{
  const settled = {
    cropRegion: { left: 10, top: 10, width: 100, height: 80 }, rotationAngle: 0.4, mirrored: false, autoFrameMeta: { confidence: 0.9 },
    filmType: 'color', positiveMode: 'correct', filmTypeSource: 'auto', filmTypeConfidence: 'high', filmTypeReason: null,
    filmBase: { r: 200, g: 140, b: 90, method: 'border' }, coreExposure: 0, exposure: 0,
    wbR: 1.1, wbG: 1, wbB: 0.9, wbAutoConfidence: 'high', wbUserOverride: false, grayPointSampled: false, wbSemanticApplied: false,
    curvePoints: { r: [{ x: 0, y: 0 }, { x: 255, y: 255 }] }, curves: { r: new Uint8Array([0, 1, 2]) },
    filmEdge: { checked: true, found: false }, expiredAnalysis: null, learnedDefaults: null
  };
  const clone = () => structuredClone(settled);
  assert.deepEqual(windowEditKeys(settled, clone()), [], 'nothing changed');
  // A later conversion re-estimating the automatic WB is not an edit, nor
  // are the analyses' own fields.
  let live = clone(); live.wbR = 1.2; live.wbAutoConfidence = 'medium'; live.filmEdge = { checked: true, found: true }; live.expiredAnalysis = { a: 1 };
  assert.deepEqual(windowEditKeys(settled, live), []);
  live = clone(); live.coreExposure = 25;
  assert.deepEqual(windowEdits(settled, live), { coreExposure: 25 });
  live = clone(); live.cropRegion = { left: 20, top: 10, width: 90, height: 80 };
  assert.deepEqual(windowEditKeys(settled, live).sort(), ['autoFrameMeta', 'cropRegion', 'mirrored', 'rotationAngle']);
  live = clone(); live.grayPointSampled = true; live.wbR = 1.3;
  assert.deepEqual(windowEditKeys(settled, live).sort(), ['grayPointSampled', 'wbAutoConfidence', 'wbB', 'wbG', 'wbR', 'wbSemanticApplied', 'wbUserOverride']);
  live = clone(); live.filmType = 'bw'; live.filmTypeSource = 'manual';
  assert.deepEqual(windowEditKeys(settled, live).sort(), ['filmType', 'filmTypeConfidence', 'filmTypeReason', 'filmTypeSource', 'positiveMode']);
  live = clone(); live.curvePoints = { r: [{ x: 0, y: 10 }, { x: 255, y: 255 }] }; live.curves = { r: new Uint8Array([9, 9, 9]) };
  assert.deepEqual(windowEditKeys(settled, live).sort(), ['curvePoints', 'curves']);
  live = clone(); live.filmBase = { r: 210, g: 150, b: 95, method: 'manual' };
  const edits = windowEdits(settled, live);
  assert.deepEqual(Object.keys(edits), ['filmBase']);
  // The merge: full-decode automatic values, the user's filmBase on top.
  const automatic = { ...clone(), filmBase: { r: 199, g: 141, b: 91, method: 'border' }, wbR: 1.05, cropRegion: { left: 21, top: 20, width: 200, height: 160 } };
  const merged = overlayWindowEdits(automatic, edits);
  assert.deepEqual(merged.filmBase, live.filmBase);
  assert.deepEqual(merged.cropRegion, automatic.cropRegion);
  assert.equal(merged.wbR, 1.05);
  edits.filmBase.r = 0;
  assert.equal(merged.filmBase.r, 210, 'the merge copies');
  assert.equal(hasWindowEdits({}), false);
  assert.deepEqual(geometryEdits({ coreExposure: 5 }), null);
  assert.deepEqual(geometryEdits({ cropRegion: null, rotationAngle: 90, mirrored: false, autoFrameMeta: null, coreExposure: 1 }),
    { cropRegion: null, rotationAngle: 90, mirrored: false, autoFrameMeta: null });
}

console.log('Provisional window: flag, start mode, exact crop units, convert-once edits and window edit merge passed');
