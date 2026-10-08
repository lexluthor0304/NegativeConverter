// When a conversion runs at the original resolution, and when the pixels it
// left behind are still current (#237). Above 16 MP interactive work stays at
// display resolution; export, the dust-detection and AI-brush barriers and the
// idle repair pass ask for the original explicitly (`exact`).

// `wantsFull` is what the caller asked for, `exact` marks the explicit
// original-resolution requests (startFullResolutionRender only). A frame with
// repairs converts at full resolution only when it has no separate display
// preview: that frame is display-sized already, and its repairs have no idle
// pass to settle them. Every other repaired frame settles once on idle.
export function routeCoreConversion({ wantsFull = false, exact = false, large = false, repairs = false, separatePreview = false } = {}) {
  const full = Boolean((wantsFull && (exact || !large)) || (repairs && !separatePreview));
  return { full, downgraded: Boolean(wantsFull) && !full };
}

// A downgraded request drops a full-resolution plane it would leave stale,
// except where a brush paints on that plane: the repairs' dust brush and mask
// overlay, and the AI brush.
export function keepsFullPlaneOnDowngrade({ repairs = false, aiBrush = false } = {}) {
  return Boolean(repairs || aiBrush);
}

// Whether the full-resolution pixels lag the settings: a display-sized frame,
// a conversion input changed since the last exact render, or a plane that is
// not the size of the conversion source (only ever a flag bug; treating it as
// stale re-renders instead of exporting at display size).
export function fullResolutionIsStale({ processedImageDataIsPreview = false, fullResolutionPending = false, processedImageData = null, conversionSourceImageData = null } = {}) {
  if (processedImageDataIsPreview || fullResolutionPending) return true;
  if (!processedImageData || !conversionSourceImageData) return false;
  return processedImageData.width !== conversionSourceImageData.width
    || processedImageData.height !== conversionSourceImageData.height;
}

// The flags a restored snapshot puts back. A caller's explicit previewOnly
// wins (a photo session may have swapped the plane for its display preview),
// then the flags captured with the snapshot. A plane that is not the size of
// the conversion source is a preview whatever the flags say, since a
// conversion keeps the size of its source.
export function restoredFrameFlags({ frame = null, previewOnly, processedImageData = null, conversionSourceImageData = null } = {}) {
  const displaySized = Boolean(processedImageData && conversionSourceImageData
    && (processedImageData.width !== conversionSourceImageData.width
      || processedImageData.height !== conversionSourceImageData.height));
  let preview = displaySized;
  if (typeof previewOnly === 'boolean') preview = previewOnly || displaySized;
  else if (frame && typeof frame.previewOnly === 'boolean') preview = frame.previewOnly || displaySized;
  const pending = preview || Boolean(frame && frame.fullResolutionPending);
  return { previewOnly: preview, fullResolutionPending: pending };
}

// A zoom, window resize or DPR change needs new display planes, never new
// conversion inputs:
// - 'resample': the full-resolution pixels are current (repairs settled, or an
//   export left them); resample the display fields from them.
// - 'repair-pass': a repair pass is pending or in flight and builds the
//   display fields at the current size when it lands.
// - 'reconvert': a preview-only frame (the default above 16 MP); convert the
//   display preview again at the new size, without superseding anything.
export function viewportRefreshBranch({ processedImageData = null, processedImageDataIsPreview = false, fullResolutionPending = false, repairs = false } = {}) {
  if (processedImageData && !processedImageDataIsPreview && !fullResolutionPending) return 'resample';
  if (repairs) return 'repair-pass';
  return 'reconvert';
}

// An export has to wait for the repairs the idle pass owes: no mask yet (or
// one built on another clean source), a detection waiting on its debounce or
// running, or a brush repair still in flight.
export function repairsNeedSettling({ repairs = false, mask = null, maskStale = false, detectionScheduled = false, processing = false, pendingBrushRepairs = 0 } = {}) {
  if (!repairs) return false;
  return !mask || Boolean(maskStale) || Boolean(detectionScheduled) || Boolean(processing) || pendingBrushRepairs > 0;
}
