// Reasons are translation keys. Merely opening a frame never acknowledges it.
export function frameNeedsReview(item, liveState = null) {
  const s = liveState || item?.settings || {};
  const reasons = [];
  if (item?.status === 'error' || item?.error) reasons.push('reviewLoadError');
  if (!s.reviewed) {
    const meta = liveState?.autoFrame?.lastDiagnostics || s.autoFrameMeta;
    const manualCrop = (s.cropRegion && !meta?.importAuto) || (String(meta?.method || '').startsWith('manual-') && !meta?.analysisNeedsReview);
    if (!manualCrop && (meta?.confidenceLevel === 'low' || meta?.analysisNeedsReview || meta?.frameIncomplete)) reasons.push('reviewFrame');
    if (s.filmTypeSource !== 'manual' && s.filmTypeConfidence === 'low') reasons.push('reviewFilmType');
    if (!s.grayPointSampled && !s.wbUserOverride && s.wbAutoConfidence === 'low') reasons.push('reviewWhiteBalance');
    if (s.rollFrame?.outlier) reasons.push('reviewRoll');
    if (s.filmTypeSource !== 'manual' && s.filmEdge?.found && s.filmEdge.polarity === 'light' && s.filmEdge.filmKind && s.filmEdge.filmKind !== 'positive') reasons.push('reviewDx');
  }
  return { needs: reasons.length > 0, reasons };
}
