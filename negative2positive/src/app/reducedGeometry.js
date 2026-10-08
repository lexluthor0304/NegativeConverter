import { cropImageDataRegion, downsampleImageDataByStep, downsampleImageDataForMaxDim } from './imageDataOps.js';
import {
  applyRotationToImageData, mirrorImageDataHorizontal, normalizeAngleDegrees, planGeometry, renderGeometry,
  rotatedDimensions, sanitizeCropRect
} from './imageGeometry.js';

// Geometry at tile scale (#247). Light-table tiles, roll samples and their
// tile sources never build the full-resolution frame: the chain keeps its
// order (base -> rotation -> mirror -> crop) at every scale, with the crop
// (full-scale pixels of the post-mirror frame) scaled to the reduced image.

/**
 * Decimates `base`, then rotates, mirrors and crops the small image, the
 * crop scaled by reduced.width / fullWidth. `step` decimates by that step
 * (1 keeps the base), otherwise `maxDim` bounds the long side.
 * `fullWidth`/`fullHeight` are the size of the frame the recipe refers to:
 * a half-size decode passes its full size so the crop scales by the real
 * ratio. With the defaults this is the roll-analysis sample.
 */
export function buildReducedGeometrySample(base, settings, { step = 0, maxDim = 0, fullWidth = base.width } = {}) {
  const reduced = step > 0
    ? (step > 1 ? downsampleImageDataByStep(base, step) : base)
    : downsampleImageDataForMaxDim(base, maxDim);
  const factor = reduced.width / fullWidth;
  let working = reduced;
  const angle = Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0;
  if (Math.abs(angle) > 0.001) working = applyRotationToImageData(working, angle);
  if (settings.mirrored) working = mirrorImageDataHorizontal(working);
  if (settings.cropRegion) {
    const scaled = {
      left: (settings.cropRegion.left ?? settings.cropRegion.x ?? 0) * factor,
      top: (settings.cropRegion.top ?? settings.cropRegion.y ?? 0) * factor,
      width: settings.cropRegion.width * factor,
      height: settings.cropRegion.height * factor
    };
    const region = sanitizeCropRect(scaled, working);
    if (region) working = cropImageDataRegion(working, region);
  }
  return working;
}

/**
 * The frame the export chain would build from a `size.width` x
 * `size.height` base (rotatedDimensions, then the crop sanitised against the
 * rotated frame as the chain does), without building it, and the
 * decimation step that brings its long side to `maxDim`: the step
 * downsampleImageDataForMaxDim applies to that frame.
 */
export function reducedTileGeometry(size, geometry, maxDim, { sanitizeCrop = sanitizeCropRect } = {}) {
  const angle = normalizeAngleDegrees(Number(geometry?.rotationAngle) || 0);
  const frame = Math.abs(angle) > 0.001 ? rotatedDimensions(size.width, size.height, angle) : { width: size.width, height: size.height };
  const crop = geometry?.cropRegion ? sanitizeCrop(geometry.cropRegion, frame) : null;
  const width = crop ? crop.width : frame.width;
  const height = crop ? crop.height : frame.height;
  const step = Math.ceil(Math.max(width / maxDim, height / maxDim, 1));
  return { width, height, step };
}

/**
 * The working image of a reduced tile. On a full-size base the geometry
 * core's strided plan builds exactly the full-resolution chain followed by
 * downsampleImageDataByStep(step), reading only the output pixels. Where
 * the core cannot plan the chain (an 8-bit source at a non-right angle, whose
 * rotation is the 2D canvas's) and for a half-size decode, the base is
 * decimated first and the small image goes through the chain.
 */
export function renderReducedGeometry(base, geometry, { step, fullWidth = base.width, fullHeight = base.height }) {
  if (fullWidth === base.width && fullHeight === base.height) {
    const plan = planGeometry(base, geometry, { step });
    if (plan) return renderGeometry(base, plan);
    return buildReducedGeometrySample(base, geometry, { step });
  }
  const baseStep = Math.max(1, Math.ceil(step * base.width / fullWidth));
  return buildReducedGeometrySample(base, geometry, { step: baseStep, fullWidth });
}

/**
 * Whether renderReducedGeometry gives exactly the full-resolution chain
 * followed by the downsample: the strided plan on a full-size base. An
 * 8-bit source at a non-right angle and a half-size decode are decimated
 * first instead, so a measurement taken on that tile (the automatic gray
 * point, the expired rescue) differs from one taken on the old tile.
 */
export function reducedGeometryExact(base, geometry, { fullWidth = base.width, fullHeight = base.height } = {}) {
  return fullWidth === base.width && fullHeight === base.height && Boolean(planGeometry(base, geometry));
}

/**
 * What a retained tile source depends on besides the recipe's colours: the
 * geometry, the base it was taken from and the analysis area its reference
 * sample covers. A different key means the source no longer shows the frame.
 */
export function tileGeometryKey(settings, baseSize) {
  const crop = settings?.cropRegion;
  const meta = settings?.autoFrameMeta;
  return JSON.stringify([
    Number.isFinite(settings?.rotationAngle) ? settings.rotationAngle : 0,
    Boolean(settings?.mirrored),
    crop ? [crop.left ?? crop.x ?? 0, crop.top ?? crop.y ?? 0, crop.width, crop.height] : null,
    baseSize?.width || 0, baseSize?.height || 0,
    meta?.imageArea || meta?.analysisArea || null
  ]);
}
