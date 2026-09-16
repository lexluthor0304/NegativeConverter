export function sanitizeFilmTypeOverride(value) {
  if (!value || !['color', 'bw', 'positive'].includes(value.filmType)) return null;
  return { filmType: value.filmType, positiveMode: value.positiveMode === 'edit' ? 'edit' : 'correct' };
}

// Change only the interpretation of the source, retaining each frame's edits.
// Analysis shared with another film type and automatic WB are no longer valid.
export function applyFilmTypeOverride(settings, override) {
  const choice = sanitizeFilmTypeOverride(override);
  if (!choice) return settings;
  const next = { ...settings, ...choice, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null, rollFrame: null };
  if (next.wbAutoConfidence && !next.wbUserOverride && !next.grayPointSampled) {
    next.wbR = next.wbG = next.wbB = 1;
    next.wbAutoConfidence = null; next.wbSemanticApplied = false;
  }
  return next;
}
