// Undo and redo of history entries the memory budget made cold (#281), in
// main.js's real history, conversion, detection and keep steps
// (dustUndoTestHarness.mjs). The budget is scaled down so that, at this size,
// entries go cold the way 768 MiB makes them cold from about 30 MP: after a
// later edit, an Undo or a Redo, and under memory pressure. A cold entry used
// to rebuild its planes and detect dust again, dropping the settled mask, the
// particle count and the brush refinements. Now it keeps its dust state,
// compacted (or by reference while strokes still hold it), and its undo and
// redo give back the mask, the repaired image and the count bit for bit, with
// no detection, and the exports made before the step.
import assert from 'node:assert/strict';
import { fixture, opened, refine, settle } from './dustUndoTestHarness.mjs';

let seed = 29;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

// One state of a 200 x 150 frame not on screen: clean source and repaired
// image (8 + 16 bits) and the mask, about 750 KB. The budget holds less, as
// 768 MiB holds less than the 1.5 GB of a 60 MP state.
const WIDTH = 200, HEIGHT = 150;
const STATE_BYTES = WIDTH * HEIGHT * (12 + 12 + 1);
const BUDGET = Math.floor(STATE_BYTES * 0.54);
const exclusive = f => f.context.historyExclusiveBytes(f.context.hotGeometrySnapshot());
const coldKinds = f => [...f.target.undoStack, ...f.target.redoStack].filter(entry => entry.refs?.cold)
  .map(entry => entry.refs.dust?.kind || 'none');

// ---- 1. Every step that stays in history undoes and redoes bit for bit,
// cold entries included, and nothing is detected again. A stroke entry still
// holds the state it patched, so when that state is no longer on screen the
// budget drops the stroke with every older step (as before, #259): with
// strokes between the conversions, history keeps the latest steps; with
// conversions in a row, it keeps every step as a cold entry. ----
async function walkHistory(actions, { cold = 0 } = {}) {
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  const steps = [f.fingerprint()];
  for (const name of actions) {
    if (name === 'stroke') refine(f, 20 + Math.floor(random() * 150), 20 + Math.floor(random() * 100));
    else if (name === 'slider') await f.slider('coreExposure', f.state.coreExposure + 1);
    else if (name === 'strength') await f.strength(f.state.dustRemoval.strength === 5 ? 7 : 5);
    else if (name === 'crop') await f.crop({ x: 6, y: 4, width: WIDTH - 12, height: HEIGHT - 8 });
    await f.idle();
    steps.push(f.fingerprint());
    // The budget applies when the next edit, Undo or Redo is pushed.
    f.context.pruneHistoryForMemory();
    assert.ok(exclusive(f) <= BUDGET, `after ${name}: history holds at most its budget`);
  }
  await f.idle();
  assert.equal(new Set(steps.map(step => JSON.stringify(step))).size, steps.length, 'every step changed the state');
  const kinds = coldKinds(f);
  assert.ok(kinds.filter(kind => kind === 'compact').length >= cold, `cold entries keep a compacted dust state: ${kinds}`);
  const depth = f.target.undoStack.length;
  const detections = f.calls.detect;
  const kept = f.target.coldDustDiagnostics.kept;
  const n = actions.length;
  for (let i = 1; i <= depth; i++) {
    await f.undo();
    assert.deepEqual(f.fingerprint(), steps[n - i], `undo ${i}: the state after action ${n - i}`);
    assert.ok(exclusive(f) <= BUDGET, `undo ${i}: within the budget`);
  }
  for (let i = 1; i <= depth; i++) {
    await f.redo();
    assert.deepEqual(f.fingerprint(), steps[n - depth + i], `redo ${i}`);
    // Redo applies the budget before it restores, so the entry it pushed for
    // the state it left is stripped by the next edit, Undo or Redo.
    f.context.pruneHistoryForMemory();
    assert.ok(exclusive(f) <= BUDGET, `redo ${i}: within the budget`);
  }
  assert.equal(f.calls.detect, detections, 'no detection in either direction');
  assert.deepEqual(f.target.errors, []);
  return { depth, kept: f.target.coldDustDiagnostics.kept - kept, compacted: f.target.coldDustDiagnostics.compacted };
}
{
  // The sequence of dustUndoKeep.test.mjs's case 2.
  const interleaved = await walkHistory(['stroke', 'slider', 'stroke', 'stroke', 'slider', 'stroke', 'strength', 'stroke', 'crop', 'stroke', 'slider', 'stroke', 'slider'], { cold: 1 });
  assert.ok(interleaved.depth >= 1 && interleaved.kept >= 2, `interleaved: ${JSON.stringify(interleaved)}`);
  // A refinement, then conversions in a row: every step stays, cold.
  const inARow = await walkHistory(['stroke', 'slider', 'slider', 'strength', 'slider', 'crop', 'slider', 'strength', 'slider'], { cold: 5 });
  assert.ok(inARow.depth >= 7, `in a row: ${JSON.stringify(inARow)}`);
  assert.ok(inARow.kept >= 10, `undo and redo went through cold entries: ${JSON.stringify(inARow)}`);
}

// ---- 2. The issue's case: a stroke, a slider, then a later edit makes the
// step before the slider cold; its undo keeps the refinement and the export
// equals the one made before the slider. Its redo (cold too) and a second
// undo round-trip as well. ----
{
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  refine(f);
  const before = f.fingerprint();
  const exportedBefore = await f.exportFiles();
  await f.slider('coreExposure', 2);
  const moved = f.fingerprint();
  const exportedMoved = await f.exportFiles();
  await f.slider('coreContrast', 0); // a later edit: the budget strips the step before the slider
  const entry = f.target.undoStack.at(-2);
  assert.equal(entry.label, 'coreExposure');
  assert.equal(entry.refs.cold, true, 'the step before the slider is cold');
  assert.equal(entry.refs.dust.kind, 'compact');
  assert.ok(entry.refs.dust.pixels.record, 'its dust state is compacted');
  assert.equal(f.target.undoStack.some(e => e.dustDelta), false, 'the stroke that held its objects is gone (as before)');
  const bytes = f.target.coldDustRecordBytes(entry.refs.dust.pixels.record);
  assert.ok(bytes > 0 && bytes < STATE_BYTES / 10, `a cold entry keeps ${bytes} bytes of dust state (${before.count} particles)`);
  const detections = f.calls.detect, conversions = f.calls.convert;
  await f.undo(); // the contrast step (hot)
  assert.deepEqual(f.fingerprint(), moved);
  await f.undo(); // the cold step
  assert.equal(f.calls.convert, conversions + 2, 'both undos converted the frame again');
  assert.equal(f.calls.detect, detections, 'no detection after the cold undo');
  assert.deepEqual(f.fingerprint(), before, 'mask, repaired image and count as before the slider');
  assert.equal(f.status(), `Detected ${before.count} dust particles`);
  assert.ok(f.context.dustStateSettled(), 'settled again');
  assert.deepEqual(await f.exportFiles(), exportedBefore, 'PNG 8-bit and TIFF 16-bit as exported before the slider');
  await f.redo();
  assert.deepEqual(f.fingerprint(), moved, 'redo: the slider step as it was');
  assert.deepEqual(await f.exportFiles(), exportedMoved);
  await f.undo();
  assert.deepEqual(f.fingerprint(), before, 'a second undo');
  assert.equal(f.calls.detect, detections, 'the round trip detected nothing');
  // The rebuilt state is a working state: a new stroke patches it and undoes.
  refine(f, 120, 90);
  const stroked = f.fingerprint();
  await f.undo();
  assert.deepEqual(f.fingerprint(), before);
  await f.redo();
  assert.deepEqual(f.fingerprint(), stroked);
  assert.deepEqual(f.target.errors, []);
}

// ---- 3. Under memory pressure (#258: strip only, every step stays): the
// step before the slider is cold while the stroke still holds its objects,
// so it keeps them by reference and its undo puts back those very objects. ----
{
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30 });
  refine(f);
  const dust = f.state.dustRemoval;
  const before = { fingerprint: f.fingerprint(), mask: dust.mask, image: dust.inpaintedImageData, clean: dust.cleanSource };
  await f.slider('coreExposure', 2);
  f.context.pruneHistoryForMemory({ limit: 0, stripOnly: true });
  const entry = f.target.undoStack.at(-1);
  assert.equal(entry.refs.cold, true);
  assert.equal(entry.refs.dust.kind, 'objects', 'held by the stroke entry: kept by reference');
  assert.ok(f.target.undoStack.at(-2).dustDelta, 'the stroke stays');
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.fingerprint(), before.fingerprint);
  assert.equal(dust.mask, before.mask, 'the very mask the stroke refined');
  assert.equal(dust.inpaintedImageData, before.image);
  assert.equal(dust.cleanSource, before.clean, 'the clean source the stroke entry names');
  // So the stroke still undoes in place.
  await f.undo();
  assert.notEqual(f.fingerprint().mask, before.fingerprint.mask);
  await f.redo();
  assert.deepEqual(f.fingerprint(), before.fingerprint);
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.target.errors, []);
}

// ---- 4. An undo right after the edit that made the entry cold: its
// compaction is still running when the conversion lands, and the keep step
// waits for it. ----
{
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  refine(f);
  const before = f.fingerprint();
  await f.slider('coreExposure', 2);
  // Hold the compaction's slices until the keep step waits for them.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const yieldTask = f.target.yieldTaskForJob;
  f.target.yieldTaskForJob = () => gate.then(yieldTask);
  f.context.pushUndo('coreContrast');
  f.state.coreContrast = 1;
  const entry = f.target.undoStack.at(-2);
  assert.equal(entry.refs.dust.kind, 'compact');
  assert.equal(entry.refs.dust.pixels.pending, true, 'compacting');
  const detections = f.calls.detect;
  f.context.performUndo();
  f.context.performUndo();
  for (let i = 0; i < 20; i++) await settle();
  for (const timer of [...f.clock.timers.values()]) timer.callback();
  f.clock.timers.clear();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(f.state.dustRemoval.processing, true, 'the detection after the conversion');
  assert.equal(f.state.dustRemoval.mask, null, 'waits for the compaction');
  assert.equal(entry.refs.dust.pixels.pending, true);
  release();
  await f.idle();
  assert.equal(entry.refs.dust.pixels.pending, false);
  assert.equal(f.calls.detect, detections, 'no detection');
  assert.deepEqual(f.fingerprint(), before);
  assert.deepEqual(f.target.errors, []);
}

// ---- 5. In doubt, detect again (as before). ----
async function coldStep(options = {}) {
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET, ...options });
  refine(f);
  const before = f.fingerprint();
  await f.slider('coreExposure', 2);
  await f.slider('coreContrast', 0);
  await f.undo();
  return { f, before };
}
{
  // An input no snapshot holds moved the conversion: the frame has other
  // pixels than the clean source (its digest differs).
  const { f, before } = await coldStep();
  f.setDrift(3);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'other pixels: detected again');
  assert.notEqual(f.fingerprint().clean8, before.clean8);
  assert.notEqual(f.fingerprint().mask, before.mask, 'the refinement is not pasted onto other pixels');
}
{
  // Other dust inputs between the restore and the detection after it.
  const { f } = await coldStep();
  const detections = f.calls.detect;
  f.context.performUndo();
  f.state.dustRemoval.strength = 7;
  await f.idle();
  assert.equal(f.calls.detect, detections + 1, 'other dust inputs: detected again');
}
{
  // Another inpainter: the AI model was reloaded on another provider.
  const { f } = await coldStep({ ai: true });
  f.target.aiRepair.revision += 1;
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'another model revision: detected again');
}
{
  // A record over its cap is not kept.
  const { f } = await coldStep({ coldDustMaxBytes: 64 });
  const entry = f.target.undoStack.at(-1);
  assert.equal(entry.refs.dust.pixels.record, null, 'nothing kept');
  assert.equal(f.target.coldDustDiagnostics.failed > 0, true);
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1, 'detected again');
}
{
  // A state its snapshot had not settled keeps nothing.
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  refine(f);
  f.target.dustAiRefresh.rects.push({ x: 1, y: 1, width: 4, height: 4 });
  f.context.pushUndo('coreExposure');
  f.target.dustAiRefresh.rects.length = 0;
  f.state.coreExposure = 2;
  await f.context.runCoreReprocess({ full: true });
  await f.idle();
  await f.slider('coreContrast', 0);
  const entry = f.target.undoStack.at(-2);
  assert.equal(entry.refs.cold, true);
  assert.equal(entry.refs.dust, undefined, 'no dust state kept');
  await f.undo();
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections + 1);
}

// ---- 6. AI repair on: the committed repair's stamp carries over to the
// rebuilt image, so the export takes it as before the slider, with no pass. ----
{
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET, ai: true });
  const before = f.fingerprint();
  const exportedBefore = await f.exportFiles();
  await f.slider('coreExposure', -1);
  await f.slider('coreContrast', 0);
  assert.equal(f.target.undoStack.at(-2).refs.dust.kind, 'compact');
  await f.undo();
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections);
  assert.deepEqual(f.fingerprint(), before);
  const inpaints = f.calls.inpaint;
  assert.deepEqual(await f.exportFiles(), exportedBefore);
  assert.equal(f.calls.inpaint, inpaints, 'the carried stamp: no pass on export');
}

// ---- 7. Entries that share one dust state share one record, which ends with
// the last entry that wants it; history's photo-session and parking paths
// finish compactions at once. ----
{
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  // Two fine adjustments on the same frame, then a slider: both entries hold
  // the same dust state.
  f.context.pushUndo('exposure');
  f.context.pushUndo('contrast');
  await f.slider('coreExposure', 3);
  f.context.pruneHistoryForMemory({ limit: 0 });
  const [first, second] = f.target.undoStack.slice(-3, -1);
  assert.notEqual(first.refs.dust, second.refs.dust, 'each entry keeps its own count and inpainter');
  assert.equal(first.refs.dust.pixels, second.refs.dust.pixels, 'one pixel record for both');
  assert.equal(first.refs.dust.pixels.pending, true);
  assert.equal(f.target.coldDustJobs.size, 1, 'compacted once');
  f.context.finishColdDustJobs();
  assert.equal(first.refs.dust.pixels.pending, false, 'finished at once');
  assert.ok(first.refs.dust.pixels.record);
  // A photo session kept without its planes (coldHistory) keeps a compacted
  // dust state, never one kept by reference (it would pin the planes).
  const byReference = { label: 'x', settings: {}, refs: { cold: true, dust: { kind: 'objects', mask: new Uint8Array(4) } } };
  const [kept, stripped] = f.context.coldHistory([first, byReference]);
  assert.equal(kept, first, 'a compacted state stays with its entry');
  assert.deepEqual({ ...stripped.refs }, { cold: true }, 'one kept by reference goes with the planes');
  // A record no entry wants any more is not compacted.
  await f.slider('coreExposure', 4);
  f.context.pruneHistoryForMemory({ limit: 0 });
  const pending = f.target.undoStack.at(-1).refs.dust.pixels;
  assert.equal(pending.pending, true);
  f.target.undoStack.length = 0;
  await f.idle();
  assert.equal(pending.pending, false);
  assert.equal(pending.record, null, 'abandoned with its entries');
  assert.equal(f.target.heldJobFrames.size, 0, 'nothing held');
}

// ---- 8. Parking (#241) archives the history with its cold entries' dust
// states: two entries' shared pixel record comes back shared, byte for byte,
// and a cold undo after it keeps the dust state. ----
{
  const { createDustHistoryArchive } = await import('./dustHistoryArchive.js');
  const { archiveDatabaseFixture } = await import('./dustHistoryArchiveHarness.mjs');
  const f = await opened({ width: WIDTH, height: HEIGHT, specks: 30, budget: BUDGET });
  refine(f);
  const before = f.fingerprint();
  f.context.pushUndo('exposure');
  await f.slider('coreExposure', 2);
  await f.slider('coreContrast', 0);
  const entries = f.target.undoStack.slice(0, 2);
  assert.ok(entries.every(entry => entry.refs.dust?.kind === 'compact'));
  const archive = createDustHistoryArchive({ indexedDB: archiveDatabaseFixture().indexedDB, chunkBytes: 4096 });
  const key = await archive.save({ entries: entries.map(entry => ({ refs: entry.refs })) });
  const stored = await archive.load(key);
  const [a, b] = stored.entries.map(entry => entry.refs);
  assert.equal(a.dust.pixels, b.dust.pixels, 'still one pixel record');
  assert.deepEqual(a.dust.pixels.record, entries[0].refs.dust.pixels.record, 'byte for byte');
  assert.equal(a.dust.particleCount, entries[0].refs.dust.particleCount);
  // Unparking puts the stored refs back (unparkOpenPhoto).
  entries.forEach((entry, i) => { entry.refs = stored.entries[i].refs; });
  await f.undo();
  const detections = f.calls.detect;
  await f.undo();
  assert.equal(f.calls.detect, detections, 'the archived dust state is kept');
  assert.deepEqual(f.fingerprint(), before);
}

// ---- 9. Bytes: a cold entry keeps the runs, a byte per masked pixel and
// 12 bytes per repaired pixel, a small fraction of the state it stands for. ----
{
  const f = await opened({ width: 800, height: 600, specks: 400, budget: 800 * 600 * 13 });
  refine(f, 300, 200);
  const masked = f.state.dustRemoval.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
  await f.slider('coreExposure', 2);
  await f.slider('coreContrast', 0);
  const record = f.target.undoStack.at(-2).refs.dust.pixels.record;
  const bytes = f.target.coldDustRecordBytes(record);
  const runs = record.mask.runs.length / 2 + record.diff.runs.length / 2;
  assert.ok(bytes <= masked * 13 + runs * 8, `${bytes} bytes for ${masked} masked pixels and ${runs} runs`);
  assert.ok(bytes < 800 * 600 * 25 / 20, 'under a twentieth of the 12 MB state it stands for');
  console.log(`  a cold entry at 0.48 MP with ${f.fingerprint().count} particles (${masked} masked pixels) keeps ${bytes} bytes of dust state`);
}

console.log('Cold history entries (#281): undo and redo keep the settled mask, repaired image and particle count bit for bit with no detection (compacted, or by reference under memory pressure), exports equal the ones before the step, and a changed frame, other dust inputs, another inpainter, an oversized record or an unsettled state detect again');
