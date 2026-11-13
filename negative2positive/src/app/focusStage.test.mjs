// Standalone Node test for focusStage.js - run with:
// node negative2positive/src/app/focusStage.test.mjs
//
// The stage keeps the open photo's recovered frame current: of which frame,
// at which revision of its pixels, at which strength. A fake recoverer stands
// in for the GPU.
import assert from 'node:assert/strict';
import { createFocusStage, INERT_FOCUS_STAGE } from './focusStage.js';

const frameOf = (name) => ({ name, width: 400, height: 300, data: new Uint8ClampedArray(16) });
function harness({ supported = true, soft = true } = {}) {
  const editor = { frame: frameOf('a'), revision: 0, strength: 0, active: true, repairs: false, preview: false };
  const calls = { recover: [], changed: 0, status: [], fullFrame: 0, created: 0 };
  const timers = [];
  let lost = false, failNext = null;
  const stage = createFocusStage({
    createRecoverer: () => { calls.created++; lost = false; return { supported, get lost() { return lost; }, dispose() {},
      recover: async (frame, plan, { isCurrent }) => {
        calls.recover.push({ frame: frame.name, sigma: plan.sigma });
        await Promise.resolve();
        if (failNext) { const error = failNext; failNext = null; throw error; }
        if (isCurrent && !isCurrent()) throw Object.assign(new Error('superseded'), { name: 'AbortError' });
        return { ...frameOf(`${frame.name}+focus`), of: frame };
      } }; },
    estimate: () => (soft ? { sigma: 5, grain: 0.01 } : { sigma: 1, grain: 0.01 }),
    plan: (w, h, estimate, strength) => (estimate.sigma > 2 && strength > 0 ? { sigma: +(strength * 4).toFixed(2), damp: 0.03, iterations: 20 } : null),
    frame: () => editor.frame, revision: () => editor.revision, strength: () => editor.strength, active: () => editor.active,
    repairsPending: () => editor.repairs, frameIsPreview: () => editor.preview,
    requestFullFrame: async () => { calls.fullFrame++; editor.preview = false; editor.frame = frameOf('full'); stage.noteSourceChanged(); },
    onChanged: () => { calls.changed++; }, onStatus: (status) => calls.status.push(status.kind),
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); },
    yieldTask: async () => {}, warn: () => {}
  });
  const fire = async () => { const due = timers.splice(0); for (const timer of due) await timer.fn(); await new Promise(resolve => setImmediate(resolve)); };
  return { stage, editor, calls, timers, fire, lose: () => { lost = true; }, fail: (error) => { failNext = error; } };
}

// Off: the frame itself is what is shown and exported, and nothing runs.
{
  const { stage, editor, calls } = harness();
  assert.equal(stage.wanted(), false);
  assert.equal(stage.sourceOf(editor.frame), editor.frame);
  await stage.run();
  await stage.ensureForExport();
  assert.equal(calls.recover.length, 0);
  assert.deepEqual(calls.status, ['off']);
}

// On: the recovered frame becomes the source of the editor's frame, and of no other frame.
{
  const { stage, editor, calls } = harness();
  editor.strength = 60;
  assert.equal(stage.wanted(), true);
  await stage.run();
  assert.deepEqual(calls.recover, [{ frame: 'a', sigma: 2.4 }]);
  assert.deepEqual(calls.status, ['working', 'done']);
  assert.equal(calls.changed, 1);
  assert.equal(stage.current(), true);
  assert.equal(stage.sourceOf(editor.frame).name, 'a+focus');
  const other = frameOf('other');
  assert.equal(stage.sourceOf(other), other, 'another frame is never swapped');
  assert.ok(stage.retainedBytes > 0);
  await stage.run();
  assert.equal(calls.recover.length, 1, 'a current recovery is not repeated');

  // Another strength, patched pixels or another frame: stale at once, recomputed when the timer fires.
  for (const change of [() => { editor.strength = 80; }, () => { editor.revision++; }, () => { editor.frame = frameOf('b'); }]) {
    change();
    assert.equal(stage.current(), false);
    assert.equal(stage.sourceOf(editor.frame), editor.frame, 'a stale recovery is not shown');
    stage.noteSourceChanged();
    assert.equal(stage.retainedBytes, 0, 'nor kept');
  }
}

// noteSourceChanged schedules one run; a second note replaces the timer.
{
  const { stage, editor, calls, timers, fire } = harness();
  editor.strength = 50;
  stage.noteSourceChanged();
  stage.noteSourceChanged();
  assert.equal(timers.length, 1);
  await fire();
  assert.equal(calls.recover.length, 1);
  assert.equal(stage.current(), true);
  editor.strength = 0;
  await stage.run();
  assert.equal(stage.sourceOf(editor.frame), editor.frame, 'strength 0 drops the recovered frame');
  assert.equal(calls.changed, 2, 'and tells the readers');
}

// A sharp frame: nothing to undo, and that is current too (an export does not wait for more).
{
  const { stage, editor, calls } = harness({ soft: false });
  editor.strength = 60;
  await stage.run();
  assert.equal(calls.recover.length, 0);
  assert.deepEqual(calls.status, ['working', 'sharp']);
  assert.equal(stage.current(), true);
  assert.equal(stage.sourceOf(editor.frame), editor.frame);
  await stage.ensureForExport();
}

// Repairs first: the run waits; a display-size frame asks for the full one, and recovers that.
{
  const { stage, editor, calls, timers, fire } = harness();
  editor.strength = 60;
  editor.repairs = true;
  await stage.run();
  assert.equal(calls.recover.length, 0);
  assert.equal(timers.length, 1);
  editor.repairs = false;
  editor.preview = true;
  await fire();
  assert.equal(calls.fullFrame, 1);
  await fire();
  assert.deepEqual(calls.recover, [{ frame: 'full', sigma: 2.4 }], 'the full-resolution frame is the one recovered');
  assert.equal(stage.sourceOf(editor.frame).name, 'full+focus');
}

// A run overtaken while the GPU works is dropped; the export barrier ends with a current frame or throws.
{
  const { stage, editor, calls } = harness();
  editor.strength = 60;
  const first = stage.run();
  editor.revision++;
  await first;
  assert.equal(stage.current(), false, 'the overtaken result is not installed');
  await stage.ensureForExport();
  assert.equal(stage.current(), true);
  assert.equal(calls.recover.length, 2);

  const broken = harness();
  broken.editor.strength = 60;
  broken.fail(new Error('context lost'));
  await broken.stage.run();
  assert.deepEqual(broken.calls.status, ['working', 'error']);
  assert.equal(broken.stage.current(), false);
  const failing = harness();
  failing.editor.strength = 60;
  failing.editor.repairs = true;   // never settles
  const pump = setInterval(() => { for (const timer of failing.timers.splice(0)) timer.fn(); }, 1);
  await assert.rejects(failing.stage.ensureForExport(), /could not finish/);
  clearInterval(pump);
  assert.equal(failing.calls.recover.length, 0);
}

// A lost context: a new recoverer is made on the next question.
{
  const { stage, editor, calls, lose } = harness();
  editor.strength = 60;
  assert.equal(stage.supported(), true);
  lose();
  assert.equal(stage.supported(), true);
  assert.equal(calls.created, 2);
}

// Unsupported: off, and recoverFrame (the batch's entry) says why instead of exporting something else.
{
  const { stage, editor, calls } = harness({ supported: false });
  editor.strength = 60;
  assert.equal(stage.wanted(), false);
  await stage.run();
  assert.deepEqual(calls.status, ['unsupported']);
  await assert.rejects(stage.recoverFrame(editor.frame, 60), /GPU/);
  assert.equal(await stage.recoverFrame(editor.frame, 0), editor.frame, 'strength 0 needs no GPU');
}

// recoverFrame: any frame, a new object when there is something to undo.
{
  const { stage } = harness();
  const frame = frameOf('batch');
  assert.equal((await stage.recoverFrame(frame, 60)).name, 'batch+focus');
  const sharp = harness({ soft: false });
  assert.equal(await sharp.stage.recoverFrame(frame, 60), frame);
}

// The inert stage answers as one that is off.
assert.equal(INERT_FOCUS_STAGE.wanted(), false);
assert.equal(INERT_FOCUS_STAGE.sourceOf('frame'), 'frame');
assert.equal(await INERT_FOCUS_STAGE.recoverFrame('frame', 60), 'frame');

console.log('focusStage: off, on, stale, scheduled, sharp, repairs and previews first, overtaken, lost context, unsupported');
