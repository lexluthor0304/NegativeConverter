// Roll-level film type for one import transaction (#231). A frame alone often
// carries no polarity evidence: a camera-scanned B&W negative without a
// visible rebate is `monochrome` at low confidence, and a leader with a dark
// holder edge stays `noMask`. Frames of one roll are contiguous in import
// order, so a B&W majority settles its uncertain neighbours.
//
// Input frames, in import order: { id, verdict, locked }. `verdict` is the
// frame's own detection ({ filmType, confidence, reason, edge }) or null while
// it is still unknown; `locked` marks a manual choice, a roll override, saved
// or recovered settings and user edits. Locked frames vote but never change.

export const ROLL_MONOCHROME = Object.freeze({ filmType: 'bw', confidence: 'medium', reason: 'rollMonochrome' });

// Verdicts without film evidence. A noMask frame can also be a colour negative
// whose mask auto white balance neutralised, so a segment takes at most one of
// them at each end and never a run of them.
const NO_EVIDENCE = new Set(['noMask', 'empty']);

export function rollFrameClass(frame) {
  const verdict = frame?.verdict;
  if (!verdict) return 'unknown';
  if (verdict.filmType === 'bw') return 'bw';
  if (!frame.locked && NO_EVIDENCE.has(verdict.reason) && !verdict.edge) return 'open';
  return 'break';
}

// Returns the B&W segments and the frames they type. `retype` frames change
// from their own type to B&W; the others are uncertain monochrome frames that
// the roll confirms (low -> medium confidence).
export function decideRollFilmType(frames, { minimum = 3 } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const classes = list.map(rollFrameClass);
  // Neither neighbour may take an end of a multi-frame run between B&W
  // cores. At an import end, a segment still takes at most one open frame.
  const betweenRuns = new Set();
  for (let i = 0; i < classes.length; i++) {
    if (classes[i] !== 'open') continue;
    const start = i;
    while (classes[i + 1] === 'open') i++;
    if (i > start && classes[start - 1] === 'bw' && classes[i + 1] === 'bw') {
      betweenRuns.add(start); betweenRuns.add(i);
    }
  }
  const segments = [];
  const typed = new Map();
  let index = 0;
  while (index < list.length) {
    if (classes[index] !== 'bw') { index++; continue; }
    // A core runs from B&W frame to B&W frame across single open frames.
    const start = index;
    let end = start;
    for (;;) {
      if (classes[end + 1] === 'bw') end += 1;
      else if (classes[end + 1] === 'open' && classes[end + 2] === 'bw') end += 2;
      else break;
    }
    index = end + 1;
    let bw = 0;
    for (let i = start; i <= end; i++) if (classes[i] === 'bw') bw++;
    const lead = classes[start - 1] === 'open' && !betweenRuns.has(start - 1) ? start - 1 : null;
    const trail = classes[end + 1] === 'open' && !betweenRuns.has(end + 1) ? end + 1 : null;
    const fits = (a, b) => {
      const count = end - start + 1 + (a === null ? 0 : 1) + (b === null ? 0 : 1);
      return count >= minimum && bw * 3 >= count * 2;
    };
    // Prefer both ends, then the leader (usually the first photo opened).
    const choice = [[lead, trail], [lead, null], [null, trail], [null, null]].find(([a, b]) => fits(a, b));
    if (!choice) continue;
    const segment = { start: choice[0] ?? start, end: choice[1] ?? end, bw, ids: [], typed: [] };
    for (let i = segment.start; i <= segment.end; i++) {
      const frame = list[i];
      segment.ids.push(frame.id);
      const own = frame.verdict;
      const retype = classes[i] === 'open';
      const confirm = classes[i] === 'bw' && !frame.locked && own.confidence === 'low' && own.reason === 'monochrome';
      if (!retype && !confirm) continue;
      typed.set(frame.id, { ...ROLL_MONOCHROME, retype });
      segment.typed.push(frame.id);
    }
    segments.push(segment);
  }
  return { segments, typed };
}

// A recipe's own verdict: automatic detection with its reason, or the manual
// type. A roll retype is not a verdict; the caller keeps the earlier one.
export function ownFilmTypeVerdict(settings) {
  if (!settings?.filmType || settings.filmTypeReason === ROLL_MONOCHROME.reason) return null;
  return { filmType: settings.filmType, confidence: settings.filmTypeConfidence ?? null, reason: settings.filmTypeReason ?? null,
    edge: Boolean(settings.filmEdge?.found), manual: settings.filmTypeSource !== 'auto' };
}

// Decision input for one frame. A frame the user owns votes with the type it
// has now, which is the type the user accepted.
export function rollDecisionFrame(id, own, { locked = false, live = null } = {}) {
  const isLocked = Boolean(locked || own?.manual);
  const verdict = own && isLocked && live
    ? { filmType: live.filmType, confidence: live.filmTypeConfidence ?? null, reason: live.filmTypeReason ?? null } : own || null;
  return { id, verdict, locked: isLocked };
}

// Until pass 1 ends a decision only adds frames, so a frame does not flip
// back and forth while its neighbours are still being read. The final
// decision is authoritative.
export function mergeRollDecision(previous, next, { final = false } = {}) {
  const merged = new Map(next);
  if (!final && previous) for (const [key, target] of previous) if (!merged.has(key)) merged.set(key, target);
  return merged;
}

// The film type an automatic recipe should have now, or null when it already
// has it or is not the decision's to change: manual verdicts, and recipes
// whose reason is neither the frame's own verdict nor a roll retype.
export function rollFilmTypeTarget({ own, live, typed = null, final = false }) {
  if (!own || own.manual || !live) return null;
  const target = typed || (final ? { filmType: own.filmType, confidence: own.confidence, reason: own.reason } : null);
  if (!target || (live.filmType === target.filmType && live.filmTypeConfidence === target.confidence
    && live.filmTypeReason === target.reason)) return null;
  return [own.reason, ROLL_MONOCHROME.reason].includes(live.filmTypeReason) ? target : null;
}
