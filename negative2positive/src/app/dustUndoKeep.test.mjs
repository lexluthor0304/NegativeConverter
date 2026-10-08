// Undo and redo across a step that converts the frame again (#259, #229
// review R1-105), in the app itself: main.js's real history (captureSnapshot,
// restoreSnapshot, performUndo/performRedo and the dust-stroke deltas), its
// real conversion landing (runCoreReprocess, rerenderWithCoreControls), its
// real detection pass with the keep step, and the export's repair step, run
// in a vm. SilverCore is a stand-in (an exposure offset, a new frame object
// per conversion); detection and TELEA are the real OpenCV ones and brush
// strokes the real regional DustBrush patches. Undoing a slider, strength or
// crop step used to detect dust again once the conversion landed, which
// dropped every brush refinement. Now the restored mask, repaired image and
// particle count stay, bit for bit, when the new frame has the restored clean
// source's pixels, and the export equals the one made before that step. A
// frame whose pixels really changed, a dust state its snapshot had not
// settled, other dust inputs or another inpainter detect again, as before.
import assert from 'node:assert/strict';
import { opened, refine, settle } from './dustUndoTestHarness.mjs';

let seed = 7;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

// ---- 1. Stroke D1, move a slider, undo: the state before the slider, bit for
// bit, also once the conversion and the detection after it have landed. ----
{
  const f = await opened();
  refine(f);
  const dust = f.state.dustRemoval;
  const before = { fingerprint: f.fingerprint(), mask: dust.mask, image: dust.inpaintedImageData, clean: dust.cleanSource };
  const exportedBefore = await f.exportFiles();
  await f.slider('coreExposure', 2);
  const moved = f.fingerprint();
  assert.notEqual(moved.clean8, before.fingerprint.clean8, 'the slider converted the frame again');
  assert.equal(f.calls.detect, 2, 'and detected dust on it');
  const detections = f.calls.detect, inpaints = f.calls.inpaint, conversions = f.calls.convert;

  f.context.performUndo();
  assert.ok(f.context.restoredDust?.settled, 'the restore leaves its settled dust state for the conversion');
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'restored at once');
  await f.idle();
  assert.equal(f.calls.convert, conversions + 1, 'the undo converted the frame again');
  assert.equal(f.calls.detect, detections, 'no detection after the conversion landed');
  assert.equal(f.calls.inpaint, inpaints, 'no repair pass');
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'mask, repaired image and count as before the slider');
  assert.equal(dust.mask, before.mask, 'the very mask the stroke refined');
  assert.equal(dust.inpaintedImageData, before.image);
  assert.equal(dust.cleanSource, before.clean, 'the clean source its history entries name');
  assert.equal(f.status(), `Detected ${before.fingerprint.count} dust particles`);
  assert.equal(f.context.restoredDust, null, 'nothing left behind');
  assert.ok(f.context.dustStateSettled(), 'settled again');
  assert.deepEqual(await f.exportFiles(), exportedBefore, 'PNG 8-bit and TIFF 16-bit as exported before the slider');
  assert.equal(f.calls.detect, detections, 'the export detected nothing');

  // Undo D1 (in place), redo D1, redo the slider, undo it again: every step
  // as it was.
  await f.undo();
  const unrefined = f.fingerprint();
  assert.notEqual(unrefined.mask, before.fingerprint.mask);
  await f.redo();
  assert.deepEqual(f.fingerprint(), before.fingerprint);
  await f.redo();
  assert.deepEqual(f.fingerprint(), moved, 'redo brings the slider step back as it was');
  await f.undo();
  assert.deepEqual(f.fingerprint(), before.fingerprint, 'a second undo round-trip');
  await f.undo();
  assert.deepEqual(f.fingerprint(), unrefined);
  assert.equal(f.calls.detect, detections, 'the whole round trip detected nothing');
  assert.deepEqual(f.target.errors, []);
}

// ---- 2. Core sliders, the strength field and Apply Crop interleaved with
// strokes: undo all the way and redo all the way, bit-identical at every
// step, with no detection. ----
{
  const f = await opened({ width: 200, height: 150, specks: 30 });
  const steps = [f.fingerprint()];
  const act = async (name) => {
    if (name === 'stroke') refine(f, 20 + Math.floor(random() * 150), 20 + Math.floor(random() * 100));
    else if (name === 'slider') await f.slider('coreExposure', f.state.coreExposure + 1);
    else if (name === 'strength') await f.strength(f.state.dustRemoval.strength === 5 ? 7 : 5);
    else if (name === 'crop') await f.crop({ x: 6, y: 4, width: f.state.conversionSourceImageData.width - 12, height: f.state.conversionSourceImageData.height - 8 });
    steps.push(f.fingerprint());
  };
  for (const name of ['stroke', 'slider', 'stroke', 'stroke', 'slider', 'stroke', 'strength', 'stroke', 'crop', 'stroke', 'slider', 'stroke']) await act(name);
  assert.equal(new Set(steps.map(step => JSON.stringify(step))).size, steps.length, 'every step changed the state');
  const detections = f.calls.detect;
  for (let i = steps.length - 1; i > 0; i--) {
    await f.undo();
    assert.deepEqual(f.fingerprint(), steps[i - 1], `undo back to step ${i - 1}`);
  }
  for (let i = 1; i < steps.length; i++) {
    await f.redo();
    assert.deepEqual(f.fingerprint(), steps[i], `redo to step ${i}`);
  }
  assert.equal(f.calls.detect, detections, 'no detection in either direction');
  // Down again, past the crop and both sliders.
  for (let i = steps.length - 1; i > 3; i--) await f.undo();
  assert.deepEqual(f.fingerprint(), steps[3]);
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.target.errors, []);
}

// ---- 3. In doubt, detect again (today's behaviour). ----
{
  // The clean source really changed: the snapshot was taken while its frame
  // still lagged its settings (a second edit before the first converted), so
  // the frame converted for the restored settings has other pixels.
  const f = await opened();
  refine(f);
  const settled = f.fingerprint();
  f.context.pushUndo('coreExposure');
  f.state.coreExposure = 1;
  await f.slider('coreExposure', 2);
  const lagging = f.context.undoStack.at(-1).refs;
  assert.ok(lagging.dustSettled, 'its dust state was settled; its frame was not');
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'a lagging frame is detected again');
  const after = f.fingerprint();
  assert.equal(after.exposure, 1);
  assert.notEqual(after.clean8, settled.clean8, 'the clean source has the new pixels');
  assert.notEqual(f.state.dustRemoval.cleanSource, lagging.dustCleanSource, 'and is the new frame');
  assert.notEqual(f.state.dustRemoval.mask, lagging.dustMask);
  assert.deepEqual(f.target.errors, []);
}
{
  // An input no snapshot holds moved the conversion (a roll analysis): the
  // restored frame's pixels are not the new frame's.
  const f = await opened();
  refine(f);
  await f.slider('coreExposure', 2);
  f.setDrift(3);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'other pixels: detected again');
}
{
  // A dust state its snapshot had not settled: a detection was still due.
  const f = await opened();
  refine(f);
  f.state.dustRemoval.strength = 6;
  f.context.scheduleDustDetection();
  f.context.pushUndo('coreExposure');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null, 'not settled while a detection is due');
  f.state.coreExposure = 2;
  await f.context.runCoreReprocess({ full: true });
  await f.idle();
  f.context.performUndo();
  assert.equal(f.context.restoredDust?.settled, false, 'restored with its mark');
  // Captured again before its conversion landed: the mark travels with it.
  f.context.pushUndo('coreContrast');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null, 'the mark travels with the restored state');
  const detections = f.calls.detect;
  await f.idle();
  assert.equal(f.calls.detect, detections + 1, 'an unsettled restore is detected again');
  assert.equal(f.state.dustRemoval.strength, 6);
  assert.deepEqual(f.target.errors, []);
}
{
  // A learned refresh still owed (TELEA stand-ins in the repaired image).
  const f = await opened();
  refine(f);
  f.target.dustAiRefresh.rects.push({ x: 1, y: 1, width: 4, height: 4 });
  f.context.pushUndo('coreExposure');
  assert.equal(f.context.undoStack.at(-1).refs.dustSettled, null);
  f.target.dustAiRefresh.rects.length = 0;
}
{
  // Another dust strength between the landing and the detection after it.
  const f = await opened();
  refine(f);
  await f.slider('coreExposure', 2);
  f.context.performUndo();
  await settle();
  assert.ok(f.context.restoredDust?.landed, 'the conversion landed; detection is due');
  f.state.dustRemoval.strength = 7;
  f.context.scheduleDustDetection();
  const detections = f.calls.detect;
  await f.idle();
  assert.equal(f.calls.detect, detections + 1, 'other dust inputs: detected again');
}
{
  // Another inpainter: the AI model was reloaded on another provider.
  const f = await opened({ ai: true });
  await f.slider('coreExposure', 2);
  f.target.aiRepair.revision += 1;
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'another model revision: detected again');
}

// ---- 4. AI repair on: a settled commit keeps its stamp across the undo, and
// the export takes it as before the slider (no pass). ----
{
  const f = await opened({ ai: true });
  const before = f.fingerprint();
  const inpaints = f.calls.inpaint;
  const exportedBefore = await f.exportFiles();
  assert.equal(f.calls.inpaint, inpaints, 'the stamped commit is exported as it is');
  await f.slider('coreExposure', -1);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.fingerprint(), before);
  const inpaintsAfter = f.calls.inpaint;
  assert.deepEqual(await f.exportFiles(), exportedBefore);
  assert.equal(f.calls.inpaint, inpaintsAfter, 'the carried stamp: no pass on export');
}

// ---- 5. Parity with the old behaviour (the landing detects again), on a
// 1.9 MP frame. Without brush refinements both exports equal the one made
// before the slider: nothing changes. With one, only the kept state does. ----
for (const refined of [false, true]) {
  const runs = {};
  for (const mode of ['old', 'new']) {
    const f = await opened({ width: 1600, height: 1200, specks: 400 });
    if (refined) refine(f, 700, 500);
    const before = f.fingerprint();
    const exportedBefore = await f.exportFiles();
    await f.slider('coreExposure', 3);
    f.context.performUndo();
    // The old landing: no restored state for the conversion to keep.
    if (mode === 'old') f.context.restoredDust = null;
    await f.idle();
    runs[mode] = { before, exportedBefore, after: f.fingerprint(), exported: await f.exportFiles(), detections: f.calls.detect };
  }
  assert.deepEqual(runs.old.exportedBefore, runs.new.exportedBefore);
  assert.deepEqual(runs.new.after, runs.new.before, `${refined ? 'refined' : 'detected'}: kept`);
  assert.deepEqual(runs.new.exported, runs.new.exportedBefore, `${refined ? 'refined' : 'detected'}: the export before the slider`);
  assert.equal(runs.new.detections, 2);
  assert.equal(runs.old.detections, 3);
  if (refined) {
    assert.notEqual(runs.old.after.mask, runs.old.before.mask, 'old: the refinement is gone');
    assert.notDeepEqual(runs.old.exported, runs.old.exportedBefore, 'old: the export lost it too');
  } else {
    assert.deepEqual(runs.old.after, runs.old.before, 'old: a fresh detection of the same pixels');
    assert.deepEqual(runs.old.exported, runs.new.exported, 'no refinement: old and new export the same bytes');
  }
}

console.log('Dust undo across a conversion: the restored mask, repaired image and count are kept bit for bit (sliders, strength, crop, strokes, redo), exports equal the ones before the step, and a changed frame, an unsettled state, other dust inputs or another inpainter detect again');
