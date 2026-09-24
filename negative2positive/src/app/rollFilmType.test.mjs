import assert from 'node:assert/strict';
import { decideRollFilmType, mergeRollDecision, ownFilmTypeVerdict, rollDecisionFrame, rollFilmTypeTarget, rollFrameClass, ROLL_MONOCHROME } from './rollFilmType.js';

const mono = { filmType: 'bw', confidence: 'low', reason: 'monochrome' };
const rebate = { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' };
const noMask = { filmType: 'positive', confidence: 'medium', reason: 'noMask' };
const empty = { filmType: 'positive', confidence: 'low', reason: 'empty' };
const warm = { filmType: 'positive', confidence: 'low', reason: 'warmScene' };
const orangeMask = { filmType: 'color', confidence: 'medium', reason: 'orangeMask' };
const dxColor = { filmType: 'color', confidence: 'high', reason: 'dx' };
const frames = (...verdicts) => verdicts.map((verdict, i) => ({ id: `f${i}`, verdict, locked: false }));
const typedIds = decision => [...decision.typed.keys()];
const retyped = decision => [...decision.typed].filter(([, entry]) => entry.retype).map(([id]) => id);

assert.equal(rollFrameClass({ verdict: null }), 'unknown');
assert.equal(rollFrameClass({ verdict: noMask }), 'open');
assert.equal(rollFrameClass({ verdict: empty }), 'open');
assert.equal(rollFrameClass({ verdict: noMask, locked: true }), 'break', 'a manual or edited frame never changes');
assert.equal(rollFrameClass({ verdict: { ...noMask, edge: true } }), 'break', 'film-edge evidence is evidence');
assert.equal(rollFrameClass({ verdict: warm }), 'break');
assert.equal(rollFrameClass({ verdict: dxColor }), 'break');
assert.equal(rollFrameClass({ verdict: rebate, locked: true }), 'bw', 'a locked B&W frame still votes');

// Monochrome majority: every uncertain frame is confirmed, none is retyped.
{
  const decision = decideRollFilmType(frames(...Array(12).fill(mono)));
  assert.equal(decision.segments.length, 1);
  assert.equal(decision.typed.size, 12);
  assert.deepEqual(retyped(decision), []);
  assert.deepEqual(decision.typed.get('f0'), { ...ROLL_MONOCHROME, retype: false });
  assert.deepEqual(decideRollFilmType(frames(mono, mono)).typed.size, 0, 'two frames are not a roll');
}

// L1000617: a noMask leader (dark holder edge) joins the B&W roll, also as
// soon as two B&W neighbours are known while the rest is still unknown.
{
  const decision = decideRollFilmType(frames(noMask, ...Array(11).fill(mono)));
  assert.deepEqual(retyped(decision), ['f0']);
  assert.equal(decision.typed.size, 12);
  assert.deepEqual(decision.segments[0].ids.length, 12);
  const early = decideRollFilmType(frames(noMask, mono, mono, null, null, null));
  assert.deepEqual(retyped(early), ['f0'], 'incremental decision with the minimum segment');
  assert.equal(decideRollFilmType(frames(noMask, mono, null, mono)).typed.size, 0, 'unknown frames break a segment');
  const rebates = decideRollFilmType(frames(noMask, rebate, rebate, rebate));
  assert.deepEqual(typedIds(rebates), ['f0'], 'frames with their own rebate evidence keep their reason');
}

// A warm colour frame inside the import is never retyped and splits the roll.
{
  const decision = decideRollFilmType(frames(mono, mono, mono, warm, mono, mono, mono));
  assert.equal(decision.segments.length, 2);
  assert.equal(decision.typed.has('f3'), false);
  assert.equal(decision.typed.size, 6);
  for (const verdict of [orangeMask, dxColor, { ...noMask, edge: true }, { filmType: 'color', confidence: 'high', reason: 'edge-text' }, { filmType: 'color', confidence: 'high', reason: 'orangeRebate' }]) {
    assert.equal(decideRollFilmType(frames(mono, mono, verdict, mono, mono)).typed.has('f2'), false, verdict.reason);
  }
}

// A run of noMask frames after a B&W segment (a colour roll whose mask auto WB
// neutralised): at most one of them joins the segment.
{
  const decision = decideRollFilmType(frames(...Array(6).fill(mono), ...Array(5).fill(noMask)));
  assert.deepEqual(retyped(decision), ['f6']);
  assert.deepEqual(decideRollFilmType(frames(...Array(12).fill(noMask))).typed.size, 0, 'a noMask roll stays positive');
  const between = decideRollFilmType(frames(mono, mono, mono, noMask, noMask, noMask, noMask, mono, mono, mono));
  assert.deepEqual(retyped(between), ['f3', 'f6'], 'each B&W neighbour takes one end of the run, the middle stays');
  const single = decideRollFilmType(frames(mono, mono, mono, noMask, mono, mono, mono));
  assert.deepEqual(retyped(single), ['f3'], 'a single noMask frame inside the roll is retyped');
  assert.equal(decideRollFilmType(frames(mono, noMask, mono, noMask, mono)).typed.size, 0, 'at least two thirds must be B&W');
  const ends = decideRollFilmType(frames(noMask, mono, mono, noMask));
  assert.deepEqual(retyped(ends), ['f0'], 'if both ends break the two-thirds rule the leader wins');
}

// Overridden, saved or edited frames vote but are never changed.
{
  const list = frames(noMask, mono, mono, mono, mono);
  list[0].locked = true;
  list[2].locked = true;
  const decision = decideRollFilmType(list);
  assert.deepEqual(typedIds(decision), ['f1', 'f3', 'f4']);
  const manual = frames(mono, mono, { filmType: 'positive', confidence: null, reason: null }, mono);
  manual[2].locked = true;
  assert.equal(decideRollFilmType(manual).typed.size, 0, 'a manual positive breaks the segment');
  const manualBw = frames(noMask, { filmType: 'bw', confidence: null, reason: null }, mono);
  manualBw[1].locked = true;
  assert.deepEqual(typedIds(decideRollFilmType(manualBw)), ['f0', 'f2'], 'a manual B&W choice supports the roll');
}

// Two segments in one import, separated by a colour roll.
{
  const decision = decideRollFilmType(frames(noMask, mono, mono, mono, orangeMask, orangeMask, orangeMask, noMask, mono, mono, mono, mono, empty));
  assert.equal(decision.segments.length, 2);
  assert.deepEqual(retyped(decision), ['f0', 'f7', 'f12']);
  assert.deepEqual(decision.segments.map(segment => [segment.start, segment.end]), [[0, 3], [7, 12]]);
  assert.equal(decision.typed.size, 10);
}

assert.deepEqual(decideRollFilmType(null), { segments: [], typed: new Map() });

// Recipe helpers used by the Studio.
assert.deepEqual(ownFilmTypeVerdict({ filmType: 'positive', filmTypeSource: 'auto', filmTypeConfidence: 'medium', filmTypeReason: 'noMask', filmEdge: { found: false } }),
  { filmType: 'positive', confidence: 'medium', reason: 'noMask', edge: false, manual: false });
assert.equal(ownFilmTypeVerdict({ filmType: 'bw', filmTypeSource: 'auto', filmTypeReason: 'rollMonochrome' }), null, 'a roll retype is not a verdict');
assert.equal(ownFilmTypeVerdict({ filmType: 'bw', filmTypeSource: 'manual' }).manual, true);
assert.equal(ownFilmTypeVerdict(null), null);
assert.deepEqual(rollDecisionFrame('a', noMask), { id: 'a', verdict: noMask, locked: false });
assert.deepEqual(rollDecisionFrame('a', noMask, { locked: true, live: { filmType: 'bw', filmTypeConfidence: 'medium', filmTypeReason: 'rollMonochrome' } }),
  { id: 'a', verdict: { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' }, locked: true }, 'an edited retyped frame keeps voting B&W');
assert.equal(rollDecisionFrame('a', { ...noMask, manual: true }).locked, true);
assert.equal(rollDecisionFrame('a', null, { locked: true, live: { filmType: 'bw' } }).verdict, null, 'unknown until the frame has a verdict');
{
  // An edited frame inside the roll does not split it.
  const list = frames(mono, mono, noMask, mono, mono);
  list[2] = rollDecisionFrame('f2', noMask, { locked: true, live: { filmType: 'bw', filmTypeConfidence: 'medium', filmTypeReason: 'rollMonochrome' } });
  assert.deepEqual(typedIds(decideRollFilmType(list)), ['f0', 'f1', 'f3', 'f4']);
}
const early = new Map([['leader', ROLL_MONOCHROME]]);
assert.deepEqual([...mergeRollDecision(early, new Map()).keys()], ['leader'], 'intermediate decisions only add');
assert.deepEqual([...mergeRollDecision(early, new Map(), { final: true }).keys()], [], 'the final decision is authoritative');
assert.deepEqual([...mergeRollDecision(early, new Map([['b', ROLL_MONOCHROME]])).keys()].sort(), ['b', 'leader']);
const live = (filmType, confidence, reason) => ({ filmType, filmTypeConfidence: confidence, filmTypeReason: reason });
const target = { filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' };
assert.deepEqual(rollFilmTypeTarget({ own: noMask, live: live('positive', 'medium', 'noMask'), typed: target }), target);
assert.equal(rollFilmTypeTarget({ own: noMask, live: live('bw', 'medium', 'rollMonochrome'), typed: target }), null, 'already applied');
assert.equal(rollFilmTypeTarget({ own: noMask, live: live('bw', 'medium', 'rollMonochrome') }), null, 'an intermediate decision never reverts');
assert.deepEqual(rollFilmTypeTarget({ own: noMask, live: live('bw', 'medium', 'rollMonochrome'), final: true }), { filmType: 'positive', confidence: 'medium', reason: 'noMask' }, 'the final decision reverts');
assert.equal(rollFilmTypeTarget({ own: noMask, live: live('color', 'high', 'dx'), typed: target }), null, 'later evidence wins');
assert.equal(rollFilmTypeTarget({ own: { ...noMask, manual: true }, live: live('positive', null, null), typed: target }), null);
assert.equal(rollFilmTypeTarget({ own: null, live: live('positive', 'medium', 'noMask'), typed: target }), null);
assert.deepEqual(rollFilmTypeTarget({ own: mono, live: live('bw', 'low', 'monochrome'), typed: target }), target, 'confirmation of an uncertain frame');
console.log('rollFilmType: segments, leader, warm frames, noMask runs, locked frames and two rolls passed');
