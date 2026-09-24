export function sanitizeFilmTypeOverride(value) {
  if (!value || !['color', 'bw', 'positive'].includes(value.filmType)) return null;
  return { filmType: value.filmType, positiveMode: value.positiveMode === 'edit' ? 'edit' : 'correct' };
}

// Change only the interpretation of the source, retaining each frame's edits.
// Analysis shared with another film type and automatic WB are no longer valid.
export function applyFilmTypeOverride(settings, override) {
  const choice = sanitizeFilmTypeOverride(override);
  if (!choice) return settings;
  return withoutFilmTypeAnalysis({ ...settings, ...choice, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null, rollFrame: null });
}

// An automatic retype (the roll decision of #231) changes the type the same
// way but stays automatic, so later detection and the review queue still see
// it as a suggestion. Only the confidence changes when the type is the same.
export function applyAutomaticFilmType(settings, { filmType, confidence, reason }) {
  const next = { ...settings, filmType, filmTypeSource: 'auto', filmTypeConfidence: confidence, filmTypeReason: reason };
  return settings.filmType === filmType ? next : withoutFilmTypeAnalysis({ ...next, rollFrame: null });
}

function withoutFilmTypeAnalysis(next) {
  if (next.wbAutoConfidence && !next.wbUserOverride && !next.grayPointSampled) {
    next.wbR = next.wbG = next.wbB = 1;
    next.wbAutoConfidence = null; next.wbSemanticApplied = false;
  }
  return next;
}
