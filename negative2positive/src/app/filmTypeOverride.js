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
  return withoutFilmTypeAnalysis(settings, { ...settings, ...choice, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null, rollFrame: null });
}

// An automatic retype (the roll decision of #231) changes the type the same
// way but stays automatic, so later detection and the review queue still see
// it as a suggestion. Only the confidence changes when the type is the same.
export function applyAutomaticFilmType(settings, { filmType, confidence, reason }) {
  const next = { ...settings, filmType, filmTypeSource: 'auto', filmTypeConfidence: confidence, filmTypeReason: reason };
  return settings.filmType === filmType ? next : withoutFilmTypeAnalysis(settings, { ...next, rollFrame: null });
}

// The interpretation the expired rescue measures, as main.js keys it
// (expiredSourceKey): the film type and the positive mode.
function interpretationOf(settings) {
  return `${settings.filmType || 'color'}|${settings.positiveMode === 'edit' ? 'edit' : 'correct'}`;
}

function withoutFilmTypeAnalysis(previous, next) {
  // Semantic anchors were measured on the old interpretation's positive too.
  if (next.semanticMap && interpretationOf(previous) !== interpretationOf(next)) next.semanticMap = null;
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
  if (next.expiredAnalysis && interpretationOf(previous) !== interpretationOf(next)) {
    const measured = defaultExpiredRescueParams(next.expiredAnalysis);
    for (const key of ['expiredBrightness', 'expiredContrast']) {
      if (next[key] === measured[key]) next[key] = EXPIRED_RESCUE_DEFAULTS[key];
    }
    next.expiredAnalysis = null;
  }
  return next;
}
