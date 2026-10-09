// #281 acceptance: undo and redo of a history step that history's memory
// budget made cold, on a Leica M11-sized frame (9504×6320) with the real
// 768 MiB budget, through main.js's real history, conversion landing,
// detection, keep steps and cold-entry compaction (dustUndoTestHarness.mjs:
// real OpenCV detection and TELEA, real DustBrush strokes, a stand-in
// conversion). Too heavy for `npm test` (several GB); run it alone, one heavy
// job at a time.
//   node scripts/dust-cold-undo-60mp.mjs [width] [height] [specks] [budget bytes]
// (A smaller frame needs a smaller budget for its entries to go cold.)
// Checks: the step before an Exposure change goes cold at the next edit with
// its dust state compacted; undoing it detects nothing and gives back the
// mask, the repaired 8- and 16-bit planes and the particle count bit for bit
// (two brush refinements included); redo and a second undo do too; history
// stays within its budget. Reports the bytes the cold entry keeps, the edit's
// own time, the compaction's wall time and longest slice, and the cold undo.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { opened, refine } from '../negative2positive/src/app/dustUndoTestHarness.mjs';

const width = Number(process.argv[2]) || 9504;
const height = Number(process.argv[3]) || 6320;
const specks = Number(process.argv[4]) || 400;
const BUDGET = Number(process.argv[5]) || 768 * 1024 * 1024;
const ms = (start) => Math.round(performance.now() - start);

let t = performance.now();
const f = await opened({ width, height, specks, budget: BUDGET });
console.log(`opened ${width}x${height}: ${f.state.dustRemoval.particleCount} particles detected in ${ms(t)} ms`);
const c = f.context;
const exclusive = () => c.historyExclusiveBytes(c.hotGeometrySnapshot());

// Time every slice of the compaction (the steps between two yields).
const slices = [];
const compact = f.target.compactDustSteps;
f.target.compactDustSteps = function* timed(...args) {
  const steps = compact(...args);
  for (;;) {
    const start = performance.now();
    const { done, value } = steps.next();
    slices.push(performance.now() - start);
    if (done) return value;
    yield;
  }
};

// Two refinements no detection makes (direct strokes), then an Exposure change.
refine(f, Math.round(width * 0.31), Math.round(height * 0.42));
refine(f, Math.round(width * 0.72), Math.round(height * 0.18));
await f.idle();
const before = f.fingerprint();
const masked = f.state.dustRemoval.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
t = performance.now();
await f.slider('coreExposure', 2);
console.log(`Exposure: converted and detected again in ${ms(t)} ms (${f.state.dustRemoval.particleCount} particles)`);
const moved = f.fingerprint();
assert.notEqual(moved.clean8, before.clean8);

// A later edit: the budget strips the step before the Exposure change. The
// edit's own task only drops references; the compaction runs in slices.
t = performance.now();
c.pushUndo('coreContrast');
const pushMs = ms(t);
f.state.coreContrast = 1;
const entry = f.target.undoStack.at(-2);
assert.equal(entry.label, 'coreExposure');
assert.equal(entry.refs.cold, true, 'the step before the Exposure change is cold');
assert.equal(entry.refs.dust?.kind, 'compact', 'with its dust state compacted');
t = performance.now();
await f.idle();
const compactMs = ms(t);
const record = entry.refs.dust.pixels.record;
assert.ok(record, 'the record is filled');
const bytes = f.target.coldDustRecordBytes(record);
const held = exclusive();
assert.ok(held <= BUDGET, `history holds ${held} bytes, within its budget`);
assert.equal(f.target.undoStack.some(e => e.dustDelta), false, 'the strokes that held its planes are gone (as before)');

// Undo the contrast step, then the cold step.
const detections = f.calls.detect;
await f.undo();
assert.deepEqual(f.fingerprint(), moved, 'undo of the contrast step');
t = performance.now();
await f.undo();
const coldUndoMs = ms(t);
assert.equal(f.calls.detect, detections, 'the cold undo detected nothing');
assert.deepEqual(f.fingerprint(), before, 'mask, repaired 8- and 16-bit planes and count as before the Exposure change');
assert.equal(f.target.coldDustDiagnostics.kept, 1);
await f.redo();
assert.deepEqual(f.fingerprint(), moved, 'redo');
await f.undo();
assert.deepEqual(f.fingerprint(), before, 'a second undo');
assert.equal(f.calls.detect, detections, 'the round trip detected nothing');
assert.ok(exclusive() <= BUDGET);
assert.deepEqual(f.target.errors, []);

const longest = Math.max(...slices);
console.log(JSON.stringify({
  frame: `${width}x${height}`, particles: before.count, maskedPixels: masked,
  coldEntryBytes: bytes, bytesPerMaskedPixel: +(bytes / masked).toFixed(2),
  maskRuns: record.mask.runs.length / 2, repairedPixels: record.diff ? record.diff.rgba8.length / 4 : 0,
  editTaskMs: pushMs, compactionWallMs: compactMs, compactionSlices: slices.length, longestSliceMs: +longest.toFixed(1),
  coldUndoMs, historyBytes: held, keptDust: f.target.coldDustDiagnostics.kept
}));
console.log('ok: a cold history step undoes and redoes with its mask, repaired planes and particle count bit for bit, no detection');
