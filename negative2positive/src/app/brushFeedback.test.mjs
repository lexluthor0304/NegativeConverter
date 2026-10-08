// Standalone Node test for brushFeedback.js (#254 A) - run with:
// node negative2positive/src/app/brushFeedback.test.mjs
import assert from 'node:assert/strict';
import {
  resampleStrokePoints, pointerSamples, movedEnough, overlayMapping, mapToOverlay, createBrushFeedback, BRUSH_FEEDBACK_STYLES,
} from './brushFeedback.js';
import { sanitizeRepairStrokes } from './repairBrush.js';

// A 5 s stroke at 120 Hz keeps its end point (resampled, not truncated), with
// the index formula the repair sanitiser uses.
{
  const points = Array.from({ length: 600 }, (_, i) => ({ x: i / 600, y: 0.5, p: 1 }));
  const kept = resampleStrokePoints(points);
  assert.equal(kept.length, 400);
  assert.equal(kept[0], points[0]);
  assert.equal(kept[399], points[599], 'the end point survives');
  const viaRepair = sanitizeRepairStrokes([{ size: 0.1, points }])[0].points;
  assert.deepEqual(kept.map(p => p.x.toFixed(5)), viaRepair.map(p => p.x.toFixed(5)));
  const short = points.slice(0, 12);
  assert.equal(resampleStrokePoints(short), short);
}

// Coalesced samples where the browser has them; the event itself otherwise.
{
  const plain = { clientX: 1 };
  assert.deepEqual(pointerSamples(plain), [plain]);
  const coalesced = [{ clientX: 1 }, { clientX: 2 }];
  assert.equal(pointerSamples({ getCoalescedEvents: () => coalesced }), coalesced);
  const empty = { getCoalescedEvents: () => [] };
  assert.deepEqual(pointerSamples(empty), [empty]);
  assert.ok(movedEnough(null, 0, 0, 2));
  assert.ok(!movedEnough({ clientX: 0, clientY: 0 }, 0.4, 0, 2), '0.8 device px is dropped');
  assert.ok(movedEnough({ clientX: 0, clientY: 0 }, 0.5, 0, 2), '1 device px is kept');
}

// Working pixels -> overlay device pixels, through the image area on screen.
{
  const mapping = overlayMapping({
    surface: { left: 110, top: 60, width: 400, height: 300 },
    box: { left: 100, top: 50, width: 800, height: 600 },
    backingWidth: 1600, backingHeight: 1200, frameWidth: 4000, frameHeight: 3000,
  });
  assert.deepEqual(mapToOverlay(mapping, { x: 0, y: 0 }), { x: 20, y: 20 });
  assert.deepEqual(mapToOverlay(mapping, { x: 4000, y: 3000 }), { x: 820, y: 620 });
  assert.equal(mapping.scale, 0.2);
}

// The controller: container x DPR while active, 1 x 1 otherwise; each frame
// strokes only the new segments, from the last point drawn; pen-up clears the
// stroke's box only; a remap redraws the stroke once.
{
  const calls = [];
  const context = new Proxy({}, {
    get: (target, key) => (key in target ? target[key] : (...args) => calls.push([key, ...args])),
    set: (target, key, value) => { target[key] = value; calls.push(['set', key, value]); return true; },
  });
  const canvas = { width: 1, height: 1, style: {}, getContext: () => context };
  const frames = [];
  let box = { left: 0, top: 0, width: 500, height: 400 };
  const feedback = createBrushFeedback({ canvas, measure: () => ({ width: box.width, height: box.height, dpr: 2, box }),
    requestFrame: (fn) => frames.push(fn), cancelFrame: () => {} });
  const flush = () => { while (frames.length) frames.shift()(); };
  feedback.sync(true);
  assert.deepEqual([canvas.width, canvas.height, canvas.style.display], [1000, 800, 'block']);
  const surface = { left: 50, top: 0, width: 400, height: 400 };
  feedback.begin({ tool: 'dodge', color: BRUSH_FEEDBACK_STYLES.dodge.colors.burn, radius: 10, frameWidth: 200, frameHeight: 200, surface });
  assert.equal(canvas.style.opacity, '0.45');
  feedback.add([{ x: 10, y: 10 }]);
  flush();
  const dot = calls.filter(([key]) => key === 'moveTo' || key === 'lineTo');
  assert.deepEqual(dot[0], ['moveTo', 140, 40]);
  assert.equal(dot.length, 2, 'the pen-down dab');
  calls.length = 0;
  feedback.add([{ x: 20, y: 10 }, { x: 30, y: 10 }]);
  feedback.add([{ x: 40, y: 10 }]);
  flush();
  const path = calls.filter(([key]) => key === 'moveTo' || key === 'lineTo');
  assert.deepEqual(path, [['moveTo', 140, 40], ['lineTo', 180, 40], ['lineTo', 220, 40], ['lineTo', 260, 40]], 'one path per frame, from the last point drawn');
  assert.ok(calls.some(([key, name, value]) => key === 'set' && name === 'lineWidth' && value === 80), 'width 2r at the view scale');
  assert.equal(calls.filter(([key]) => key === 'stroke').length, 1, 'one stroke call per frame');
  assert.equal(calls.filter(([key]) => key === 'clearRect').length, 0, 'nothing is cleared while painting');
  // Zoom moved the image: clear the stroke's box and redraw it all once.
  calls.length = 0;
  feedback.remap({ left: 0, top: 0, width: 800, height: 800 });
  flush();
  assert.equal(calls.filter(([key]) => key === 'clearRect').length, 1);
  assert.deepEqual(calls.filter(([key]) => key === 'moveTo')[0], ['moveTo', 80, 80]);
  // Pen-up clears only the stroke's box.
  calls.length = 0;
  feedback.end();
  const clear = calls.find(([key]) => key === 'clearRect');
  assert.ok(clear && clear[3] < canvas.width && clear[4] < canvas.height, 'only the stroke box is cleared: ' + JSON.stringify(clear));
  assert.equal(feedback.drawing, false);
  // A resize while active follows the container; off shrinks to 1 x 1.
  box = { left: 0, top: 0, width: 300, height: 200 };
  feedback.sync(true);
  assert.deepEqual([canvas.width, canvas.height], [1000, 800], 'an active overlay is not measured again on every sync');
  feedback.sync(true, { resize: true });
  assert.deepEqual([canvas.width, canvas.height], [600, 400]);
  feedback.sync(false);
  assert.deepEqual([canvas.width, canvas.height, canvas.style.display], [1, 1, 'none']);
  assert.ok(feedback.state().counters.maxBacking <= 1000 * 800);
}

console.log('brushFeedback.test.mjs passed');
