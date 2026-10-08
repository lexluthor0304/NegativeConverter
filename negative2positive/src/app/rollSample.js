// The roll-analysis sample of one decoded frame (#247 2b), shared by the
// page and the roll-frame worker (#252): the worker builds it from the planes
// it decoded, so they never travel to the page. Its pixels feed roll recipes
// and so exports; they must not change.
import { buildReducedGeometrySample, reducedTileGeometry, renderReducedGeometry } from './reducedGeometry.js';
import { sampleAnalysisArea } from './analysisRegion.js';
import { sanitizeCropRect } from './imageGeometry.js';
import { TILE_ANALYSIS_REFERENCE_PIXELS } from './thumbnailSources.js';

export const ROLL_SAMPLE_MAX_DIM = 900;

// Downsampled, geometry-applied negative used for the roll measurements.
export function buildRollAnalysisSample(imageData, settings) {
  return buildReducedGeometrySample(imageData, settings, { maxDim: ROLL_SAMPLE_MAX_DIM });
}

// The small 16-bit analysis reference of the frame's image area, or null.
export function tileAnalysisReference(settings, base) {
  const area = settings.autoFrameMeta?.imageArea || settings.autoFrameMeta?.analysisArea;
  return area ? sampleAnalysisArea(base, area, TILE_ANALYSIS_REFERENCE_PIXELS) : null;
}

/**
 * The roll sample plus what its canonical tile needs (#247 2b), taken while
 * the decoded base is in hand: the base's size, a small 16-bit analysis
 * reference of the image area and the tile's working image, which is the
 * lane's own reduced image of this geometry (the core's strided plan reads
 * only its pixels, a few milliseconds even at 60 MP), so a roll tile
 * samples the frame where the lane's tile does. A sample that is the base
 * itself (a small frame without geometry) is wrapped, so the base gains no
 * fields. `tileMax` is the tile preview's long side.
 */
export function buildRollSample(base, settings, { tileMax, sanitizeCrop = sanitizeCropRect, fullSize = null }) {
  // A half-size analysis decode (#252 part 6, off by default): the recipe's
  // geometry refers to the full frame, whose size the decode reports.
  const full = fullSize && (fullSize.width !== base.width || fullSize.height !== base.height) ? fullSize : null;
  const built = full
    ? buildReducedGeometrySample(base, settings, { maxDim: ROLL_SAMPLE_MAX_DIM, fullWidth: full.width })
    : buildRollAnalysisSample(base, settings);
  const sample = built !== base ? built
    : { width: base.width, height: base.height, data: base.data, ...(base.__image16 ? { __image16: base.__image16 } : {}) };
  sample.__baseSize = full ? { width: full.width, height: full.height } : { width: base.width, height: base.height };
  sample.__analysisReference = tileAnalysisReference(settings, base);
  const geometry = {
    rotationAngle: Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0,
    mirrored: Boolean(settings.mirrored),
    cropRegion: settings.cropRegion || null
  };
  const frame = reducedTileGeometry(full || base, geometry, tileMax, { sanitizeCrop });
  const working = full
    ? renderReducedGeometry(base, geometry, { step: frame.step, fullWidth: full.width, fullHeight: full.height })
    : renderReducedGeometry(base, geometry, { step: frame.step });
  sample.__tileWorking = working !== base ? working
    : { width: base.width, height: base.height, data: base.data, ...(base.__image16 ? { __image16: base.__image16 } : {}) };
  return sample;
}

// What the sample reads of a recipe: its geometry and its image area. The
// roll-frame worker receives only this.
export function rollSampleSettings(settings) {
  const meta = settings?.autoFrameMeta;
  return {
    rotationAngle: settings?.rotationAngle,
    mirrored: settings?.mirrored,
    cropRegion: settings?.cropRegion || null,
    autoFrameMeta: meta ? { imageArea: meta.imageArea || null, analysisArea: meta.analysisArea || null } : null
  };
}

// A sample as plain planes for postMessage, and the buffers to transfer
// (each once, though the sample may share them with the base).
export function packRollSample(sample, transfers) {
  const plane = value => {
    if (value?.data?.buffer) transfers.add(value.data.buffer);
    return { width: value.width, height: value.height, data: value.data };
  };
  const image = value => ({ ...plane(value), ...(value.__image16 ? { __image16: plane(value.__image16) } : {}) });
  return {
    ...image(sample),
    __baseSize: { ...sample.__baseSize },
    __analysisReference: sample.__analysisReference ? plane(sample.__analysisReference) : null,
    __tileWorking: image(sample.__tileWorking)
  };
}

// The page's sample again: ImageData over the posted planes, as
// buildRollSample returns it (built samples are ImageData with fields).
export function restoreRollSample(packed, { toImageData = (data, width, height) => new ImageData(data, width, height) } = {}) {
  const image = value => {
    const restored = value.data instanceof Uint8ClampedArray ? toImageData(value.data, value.width, value.height)
      : { width: value.width, height: value.height, data: value.data };
    if (value.__image16) restored.__image16 = { width: value.__image16.width, height: value.__image16.height, data: value.__image16.data };
    return restored;
  };
  const sample = image(packed);
  sample.__baseSize = { ...packed.__baseSize };
  sample.__analysisReference = packed.__analysisReference
    ? { width: packed.__analysisReference.width, height: packed.__analysisReference.height, data: packed.__analysisReference.data }
    : null;
  sample.__tileWorking = image(packed.__tileWorking);
  return sample;
}
