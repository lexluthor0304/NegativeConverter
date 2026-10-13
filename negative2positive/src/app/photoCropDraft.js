// Per-photo crop work that has not been applied. Keep only scalars, never
// the draft's source image or canvas, so navigation can release those planes.
function geometryKey(geometry) {
  const crop = geometry.cropRegion;
  return JSON.stringify([geometry.rotationAngle || 0, Boolean(geometry.mirrored),
    crop ? [crop.left, crop.top, crop.width, crop.height] : null]);
}

export function capturePhotoCropDraftState(draft, geometry, ratioChoice) {
  if (!draft?.rect || !draft.rotatedSize?.width || !draft.rotatedSize?.height) return null;
  const { rect, rotatedSize: size } = draft;
  return {
    geometryKey: geometryKey(geometry),
    rect: { left: rect.left / size.width, top: rect.top / size.height,
      width: rect.width / size.width, height: rect.height / size.height },
    rotationBase: draft.rotationBase,
    straightenAngle: draft.straightenAngle,
    straightenLineAngles: [...draft.straightenLineAngles],
    analysisOnly: Boolean(draft.analysisOnly),
    ratioOrientation: draft.ratioOrientation,
    ratioChoice: { ...ratioChoice }
  };
}

export function photoCropDraftMatches(saved, geometry) {
  return Boolean(saved && saved.geometryKey === geometryKey(geometry));
}

export function restorePhotoCropDraftState(draft, saved, geometry) {
  if (!draft || !photoCropDraftMatches(saved, geometry)) return false;
  const { width, height } = draft.rotatedSize;
  Object.assign(draft, {
    rect: { left: saved.rect.left * width, top: saved.rect.top * height,
      width: saved.rect.width * width, height: saved.rect.height * height },
    rotationBase: saved.rotationBase,
    straightenAngle: saved.straightenAngle,
    straightenLineAngles: [...saved.straightenLineAngles],
    analysisOnly: saved.analysisOnly,
    ratioOrientation: saved.ratioOrientation
  });
  return true;
}
