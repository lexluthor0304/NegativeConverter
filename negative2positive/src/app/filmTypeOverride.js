import { defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';

export function sanitizeFilmTypeOverride(value) {
  if (!value || !['color', 'bw', 'positive'].includes(value.filmType)) return null;
  return { filmType: value.filmType, positiveMode: value.positiveMode === 'edit' ? 'edit' : 'correct' };
}

// Change only the interpretation of the source, retaining each frame's edits.
// Analysis shared with another film type and automatic WB are no longer valid.
export function applyFilmTypeOverride(settings, override) {
  const choice = sanitizeFilmTypeOverride(override);
  if (!choice) return settings;
  return applyInterpretationPatch(settings, { ...choice, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null });
}

// An automatic retype (the roll decision of #231) changes the type the same
// way but stays automatic, so later detection and the review queue still see
// it as a suggestion. Only the confidence changes when the type is the same.
export function applyAutomaticFilmType(settings, { filmType, confidence, reason }) {
  return applyInterpretationPatch(settings, { filmType, filmTypeSource: 'auto', filmTypeConfidence: confidence, filmTypeReason: reason });
}

// The interpretation the expired rescue measures, as main.js keys it
// (expiredSourceKey): the film type and the positive mode.
function interpretationOf(settings) {
  return `${settings.filmType || 'color'}|${settings.positiveMode === 'edit' ? 'edit' : 'correct'}`;
}

export function filmInterpretationChanged(previous, next) {
  return interpretationOf(previous) !== interpretationOf(next);
}

// A patch reinterprets this frame's existing pixels, rather than restoring a
// stored frame and its matching analysis. Invalidate before applying explicit
// WB or strength values: those edits must win over automatic-value resets.
export function applyInterpretationPatch(settings, patch) {
  const choice = { ...settings };
  for (const key of ['filmType', 'positiveMode']) if (Object.hasOwn(patch, key)) choice[key] = patch[key];
  const changed = filmInterpretationChanged(settings, choice);
  const next = changed ? withoutFilmTypeAnalysis(settings, choice) : { ...settings };
  const result = { ...next, ...patch };
  // Window overlays may contain the old snapshot's analysis as well as the
  // user's edits. Only a paired restore can adopt those measurements.
  if (changed) result.rollFrame = result.semanticMap = result.expiredAnalysis = null;
  return result;
}

export function withoutFilmTypeAnalysis(previous, next) {
  if (!filmInterpretationChanged(previous, next)) return next;
  next.rollFrame = null;
  // Semantic anchors were measured on the old interpretation's positive too.
  next.semanticMap = null;
  if (next.wbAutoConfidence && !next.wbUserOverride && !next.grayPointSampled) {
    next.wbR = next.wbG = next.wbB = 1;
    next.wbAutoConfidence = null; next.wbSemanticApplied = false;
  }
  // The expired rescue's measurement was taken on the old interpretation's
  // positive: drop it, so the frame is measured again in its new mode (when
  // it is opened or converted, or in its export), as on a first measurement.
  // Brightness and contrast still holding the values that measurement set go
  // back to the defaults for the new one to fill; values the user moved stay
  // (#229 review R1-017).
  if (next.expiredAnalysis) {
    const measured = defaultExpiredRescueParams(next.expiredAnalysis);
    for (const key of ['expiredBrightness', 'expiredContrast']) {
      if (!next[`${key}UserOverride`] && next[key] === measured[key]) next[key] = EXPIRED_RESCUE_DEFAULTS[key];
    }
    next.expiredAnalysis = null;
  }
  return next;
}
