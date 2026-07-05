// Pure zoom/pan geometry for the preview canvas. All DOM reads happen in the
// caller (main.js); this module only does the math, so it is unit-testable.

/**
 * Compute the scaled-content geometry and pan limits for a zoom level.
 *
 * The wrapper is centered inside the container at zoom 1 (baseX/baseY). Pan
 * offsets are applied on top of that base position. When the scaled content
 * fits inside the container on an axis, the only legal pan re-centers it;
 * otherwise panning may slide content edge-to-edge but never past it.
 */
export function computeZoomGeometry({ wrapperW, wrapperH, containerW, containerH, zoom }) {
  const baseX = (containerW - wrapperW) / 2;
  const baseY = (containerH - wrapperH) / 2;
  const scaledW = wrapperW * zoom;
  const scaledH = wrapperH * zoom;

  const centeredPanX = ((containerW - scaledW) / 2) - baseX;
  const centeredPanY = ((containerH - scaledH) / 2) - baseY;

  const minPanX = scaledW <= containerW ? centeredPanX : containerW - baseX - scaledW;
  const maxPanX = scaledW <= containerW ? centeredPanX : -baseX;
  const minPanY = scaledH <= containerH ? centeredPanY : containerH - baseY - scaledH;
  const maxPanY = scaledH <= containerH ? centeredPanY : -baseY;

  return {
    wrapperW,
    wrapperH,
    containerW,
    containerH,
    baseX,
    baseY,
    scaledW,
    scaledH,
    minPanX,
    maxPanX,
    minPanY,
    maxPanY,
  };
}

/** Clamp pan offsets into the legal range for the given geometry. */
export function clampPanValues(panX, panY, geometry) {
  return {
    panX: Math.max(geometry.minPanX, Math.min(geometry.maxPanX, panX)),
    panY: Math.max(geometry.minPanY, Math.min(geometry.maxPanY, panY)),
  };
}
