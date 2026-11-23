// Apply Crop's diagnostics (#245) as one function (#255 review R2-052): the
// two-stage swap applies a window's crop and confirmed image area again on
// the full base with appliedCropDiagnostics, which the click handler now
// calls. Old against new: on synthetic frames (rotated, mirrored, with and
// without a crop, a stored image area or analysis area, a crop inside the
// image window and one past its corner, Apply and Confirm image area) it
// gives exactly the diagnostics and the detection decision of the handler's
// inline code at d9bb55b.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { imageAreaFromWorkingRect, imageAreaFromDetection } from './analysisRegion.js';
import { isSameAnalysisFrame, cropWithinArea } from './cropColorAnalysis.js';
import { rotatedDimensions } from './imageGeometry.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
// Execute the click handler's calculation and helper call. This covers its
// forwarded draft, geometry and prior frame even when the selected area is
// also named for recording provisional crop intent.
const handler = source.slice(source.indexOf("    applyCropBtn.addEventListener('click', async () => {"));
const callStart = handler.indexOf('        const selectedArea =');
const callEnd = handler.indexOf("\n\n        const edit = pushUndo('crop');", callStart);
assert.ok(callStart >= 0 && callEnd > callStart, 'the handler calculates diagnostics before recording its edit');

const context = vm.createContext({ structuredClone, imageAreaFromWorkingRect, isSameAnalysisFrame, cropWithinArea });
vm.runInContext(functionSource('appliedCropDiagnostics'), context);
vm.runInContext(`function applyFromHandler(state, draft, cropRegion, nextGeometry, base) {
${handler.slice(callStart, callEnd)}
return { meta: nextMeta, detect };
}`, context);
const fresh = (state, draft, cropRegion, nextGeometry, base) => context.applyFromHandler(state, draft, cropRegion, nextGeometry, base);
// d9bb55b's handler, from `const selectedArea` to `nextMeta.importAuto = true`,
// with the one rule added since (marked below).
function inline(state, draft, cropRegion, nextGeometry, base) {
  const selectedArea = imageAreaFromWorkingRect(cropRegion, nextGeometry, base);
  const nextMeta = structuredClone(state.autoFrame.lastDiagnostics || {});
  nextMeta.analysisArea ||= imageAreaFromWorkingRect(state.cropRegion || { left: 0, top: 0, width: state.originalImageData.width, height: state.originalImageData.height }, state, base);
  let detect = false;
  if (draft.analysisOnly) {
    nextMeta.imageArea = selectedArea;
    nextMeta.analysisNeedsReview = false;
    nextMeta.frameIncomplete = false;
    nextMeta.method = 'manual-analysis-area';
  } else if (!isSameAnalysisFrame(nextMeta.imageArea, selectedArea)) {
    nextMeta.analysisNeedsReview = true;
    detect = true;
    // Since 2026-11-23: a crop that reaches outside the stored image area (or
    // with none stored) is what the analysis reads until the detection hits.
    if (!cropWithinArea(nextMeta.imageArea, selectedArea)) {
      nextMeta.imageArea = null;
      nextMeta.analysisArea = selectedArea;
    }
  }
  nextMeta.importAuto = true;
  return { meta: nextMeta, detect };
}

let cases = 0, detected = 0;
for (const size of [{ width: 90, height: 64 }, { width: 1600, height: 1066 }]) {
  const base = { width: size.width, height: size.height };
  for (const angle of [0, 1.3, -0.5, 90]) for (const mirrored of [false, true]) {
    const frame = rotatedDimensions(base.width, base.height, angle);
    const scale = r => ({ left: Math.round(r.left * frame.width), top: Math.round(r.top * frame.height), width: Math.round(r.width * frame.width), height: Math.round(r.height * frame.height) });
    const window = scale({ left: 0.1, top: 0.12, width: 0.8, height: 0.76 });
    const area = imageAreaFromDetection({ cropRegion: window, angle }, base);
    const metas = [null, { method: 'hough', appliedMode: 'crop', imageArea: area, analysisArea: null, analysisNeedsReview: false, frameIncomplete: true },
      { method: 'unavailable', imageArea: null, analysisArea: null }, { method: 'manual-analysis-area', imageArea: area, analysisArea: area, importAuto: false }];
    for (const meta of metas) for (const crop of [null, scale({ left: 0.15, top: 0.15, width: 0.7, height: 0.7 })]) {
      for (const next of [scale({ left: 0.2, top: 0.2, width: 0.6, height: 0.55 }), scale({ left: 0, top: 0, width: 0.4, height: 0.35 })]) {
        for (const analysisOnly of [false, true, undefined]) {
          const state = { rotationAngle: angle, mirrored, cropRegion: crop, originalImageData: frame, autoFrame: { lastDiagnostics: meta ? structuredClone(meta) : null } };
          const nextGeometry = { rotationAngle: angle, mirrored };
          const a = inline(state, { analysisOnly }, next, nextGeometry, base);
          const b = fresh(state, { analysisOnly }, next, nextGeometry, base);
          assert.equal(JSON.stringify(b), JSON.stringify(a), `angle ${angle} mirrored ${mirrored} meta ${meta?.method} crop ${Boolean(crop)} analysisOnly ${analysisOnly}`);
          assert.equal(state.autoFrame.lastDiagnostics === null ? meta : JSON.stringify(state.autoFrame.lastDiagnostics), meta === null ? null : JSON.stringify(meta), 'the photo\'s diagnostics are not touched');
          cases++;
          if (a.detect) detected++;
        }
      }
    }
  }
}
assert.ok(detected > 0 && detected < cases, 'both detection decisions are covered');

// What the analysis reads when the detection has not hit (and when it misses).
{
  const base = { width: 1600, height: 1066 }, geometry = { rotationAngle: 0, mirrored: false };
  const rect = (left, top, width, height) => ({ left, top, width, height });
  const picture = imageAreaFromDetection({ cropRegion: rect(160, 128, 1280, 810), angle: 0 }, base);
  const apply = (meta, crop) => fresh({ rotationAngle: 0, mirrored: false, cropRegion: null, originalImageData: base, autoFrame: { lastDiagnostics: meta } },
    { analysisOnly: false }, crop, geometry, base);
  const areaOf = crop => JSON.stringify(imageAreaFromWorkingRect(crop, geometry, base));
  // A detail well inside the picture, off its centre: the picture stays.
  const detail = rect(162, 130, 90, 70);
  let applied = apply({ imageArea: picture }, detail);
  assert.ok(applied.detect && applied.meta.analysisNeedsReview, 'an off-centre detail is looked at again');
  assert.equal(JSON.stringify(applied.meta.imageArea), JSON.stringify(picture), 'a crop inside the picture keeps the picture for the analysis');
  // A crop past the picture's corner frames something else: the crop is read.
  const beyond = rect(0, 0, 640, 373);
  applied = apply({ imageArea: picture }, beyond);
  assert.equal(applied.meta.imageArea, null, 'the stored picture is not the picture of a crop that leaves it');
  assert.equal(JSON.stringify(applied.meta.analysisArea), areaOf(beyond), 'the analysis reads the crop');
  // No picture known (the frame was never detected): a crop that cuts the borders away is read, not the frame before it.
  const tightened = rect(300, 200, 1000, 660);
  applied = apply({ imageArea: null, analysisArea: null }, tightened);
  assert.equal(JSON.stringify(applied.meta.analysisArea), areaOf(tightened), 'without a picture the analysis follows the crop');
  applied = apply({ imageArea: null, analysisArea: imageAreaFromWorkingRect(rect(0, 0, 1600, 1066), geometry, base) }, tightened);
  assert.equal(JSON.stringify(applied.meta.analysisArea), areaOf(tightened), 'an earlier frame kept as the analysis area gives way to the crop');
}
console.log(`cropApplyDiagnostics: appliedCropDiagnostics equals the Apply handler's inline diagnostics in ${cases} cases (${detected} detect)`);
