/**
 * Conversion Worker — runs the full SilverCore negative->positive conversion
 * off the main thread. Preview and full-resolution clients use separate workers.
 *
 * Batch frames (#250) may hand their 16-bit source over instead of cloning it:
 * `returnSource` (lent: the adapter never writes it, and it goes back with the
 * result or the error) or `options.ownedSource` (consumed: the adapter writes
 * the result into it). `releaseAfter` drops the slot's cached planes once the
 * result is posted, so a lane holds no source or pristine plane between frames.
 */
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { convertFrameWithRouter, resolveConversionMode } from '../pipeline/conversionRouter.js';
import { releaseSlotBuffers, prepareSilverCorePreview, analyzeSilverCorePreview, renderLiveExposureRect, liveExposureGeometry } from '../pipeline/silverAdapter.js';
import { createLiveStrokeCoverage, addLiveStrokePoints, unionRect } from '../app/localExposure.js';
import { convertAdjustedFrame } from '../pipeline/adjustedFrame.js';
import { createAdjustmentLutScratch } from '../app/adjustmentPipeline.js';
import { fromImageData8 } from '../silvercore/util/image16.js';
import { downsampleImageDataForMaxPixels } from '../app/imageDataOps.js';
import { resampleDisplayLevel, filterDisplayImage, buildDisplayLevel, displayLevelFactor } from '../app/displayPreview.js';
import { assertDetailAllocation, assertDetailRoiAllocation, assertDetailGeometry, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION } from '../app/detailLayer.js';

let cachedSource = null;
let cachedAnalysis = null;
// The 16-bit plane of the last interactive frame that main asked to retain
// (#233). During a slider drag main draws the 8-bit plane only, so this one
// stays here, becomes the next frame's work buffer, and crosses to main only
// when main commits it. `id` is the request that produced it.
let retained = null;
const DEFAULT_HISTOGRAM_SAMPLES = 24_576;
let cachedLocalExposure = null;
// The live loupe's recipe (router settings and prepared adjustments), posted
// once per recipe rather than with every camera frame (#261).
let cachedRecipe = null;
const adjustmentLutScratch = createAdjustmentLutScratch();
// Display negatives resampled from the cached level (#248 part 3), newest
// first: at most one per preview tier. The adapter's preview slot keys its
// planes by buffer identity, so a size keeps converting from the same plane.
let displayNegatives = [];
const MAX_DISPLAY_NEGATIVES = 2;
// The auto-WB sample: the level reduced to this long side (#248 part 3).
const WB_SAMPLE_LONG_SIDE = 1024;
// The dodge-and-burn stroke being painted (#254 C): { slot, frameSeq, store },
// and the committed strokes main last sent with a live request.
let liveStroke = null;
let liveCommitted = null;

function planeOf(image) {
  if (image.data instanceof Uint16Array) return image;
  if (image.__image16 && image.__image16.data instanceof Uint16Array) return image.__image16;
  return fromImageData8(image);
}

// The display negative of `display.target` resampled from `level` with the
// source's geometry (bilinear up to 2x over the level, area average above).
// A target the level already fits is the level itself.
function displayNegativeFor(level, display) {
  const { target, geometry } = display;
  if (geometry.k === 1 && target.width >= level.width && target.height >= level.height) return level;
  const index = displayNegatives.findIndex(entry => entry.level === level && entry.width === target.width && entry.height === target.height);
  if (index >= 0) {
    const [entry] = displayNegatives.splice(index, 1);
    displayNegatives.unshift(entry);
    return entry.image;
  }
  const image = resampleDisplayLevel(planeOf(level), geometry, target);
  displayNegatives = [{ level, width: target.width, height: target.height, image },
    ...displayNegatives.filter(entry => entry.level === level)].slice(0, MAX_DISPLAY_NEGATIVES);
  return image;
}

function slotNameFor(options) {
  if (options && options.scratch) return 'scratch';
  return options && options.preview ? 'preview' : 'full';
}

// The source, settings and options of a request, with the cached source, analysis
// sample and strokes of the preview worker's contract filled in (and updated).
// `settings` is the loupe's cached recipe when the request reuses one.
function resolveRequest(msg, settings = msg.settings) {
  const { width, height, rgba, image16, options } = msg;
  // Unchanged dodge-and-burn strokes are not posted again. Track every
  // message, even one that fails below, as the client does.
  if (msg.cacheInput && !msg.reuseLocalExposure) cachedLocalExposure = settings?.localExposure || null;
  if (msg.reuseLocalExposure) {
    if (!cachedLocalExposure) throw new Error('Missing dodge-and-burn strokes');
    settings.localExposure = cachedLocalExposure;
  }
  let imageData;
  if (msg.reuseSource) {
    if (!cachedSource || cachedSource.width !== width || cachedSource.height !== height) {
      throw new Error('Missing preview source');
    }
    imageData = cachedSource;
  } else if (rgba) {
    imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
    if (image16) {
      imageData.__image16 = { width, height, data: new Uint16Array(image16) };
    } else if (msg.cacheInput) {
      // JPEG 等の 8bit 入力も一度だけ昇格し、操作ごとの再コピーを避ける。
      imageData.__image16 = fromImageData8(imageData);
    }
  } else {
    // 16-bit-only payload (RAW / 16-bit PNG). The adapter reads input via
    // toImage16, which accepts this shape directly — no need to allocate a
    // redundant RGBA plane for a 90+ MP scan.
    imageData = { width, height, data: new Uint16Array(image16) };
  }

  const conversionOptions = { ...options };
  delete conversionOptions.retain16;
  delete conversionOptions.histogramSamples;
  delete conversionOptions.displayTarget;
  if (msg.cacheInput) {
    // Resampled negatives of another level are dropped with it.
    if (cachedSource !== imageData) displayNegatives = displayNegatives.filter(entry => entry.level === imageData);
    cachedSource = imageData;
    if (!msg.reuseAnalysis) cachedAnalysis = options.analysisImageData || null;
    conversionOptions.analysisImageData = cachedAnalysis;
  }
  // `imageData` is the level; the request converts the display negative.
  const level = imageData;
  if (msg.display) imageData = displayNegativeFor(level, msg.display);
  return { imageData, settings, conversionOptions, level };
}

// The auto-WB sample (#248 part 3): the level reduced to a long side of 1024
// px and converted with the frame's settings in the scratch slot. It depends
// on the source and the settings only, never on the viewport. `spec.fromSource`
// (the full-resolution client) builds the level from the frame itself.
async function convertWbSample(level, spec, settings, conversionOptions) {
  const geometry = spec.geometry;
  let base = level;
  if (spec.fromSource) {
    const k = displayLevelFactor(level.width, level.height);
    base = k > 1 ? buildDisplayLevel(level, k) : level;
    geometry.k = k;
  }
  const scale = Math.min(1, WB_SAMPLE_LONG_SIDE / Math.max(geometry.sourceWidth, geometry.sourceHeight));
  const target = { width: Math.max(1, Math.floor(geometry.sourceWidth * scale)), height: Math.max(1, Math.floor(geometry.sourceHeight * scale)) };
  const plane = planeOf(base);
  const negative = geometry.k === 1 && target.width >= plane.width && target.height >= plane.height
    ? plane : resampleDisplayLevel(plane, geometry, target);
  const options = { ...conversionOptions, preview: false, scratch: true, forceFullProcess: true, includeAnalysisPreview: false };
  delete options.workBuffer16;
  delete options.ownedSource;
  const sample = await convertFrameWithRouter({ imageData: negative, settings, options });
  return { width: sample.width, height: sample.height, rgba: sample.data.buffer };
}

// The display preview of a full-resolution result (#248 part 4), built here with
// the display filter so main only uploads it: both planes, and the histogram
// sample main would take of it. Null when the result already fits.
function displayPreviewPayload(result, target, histogramSamples) {
  const preview = filterDisplayImage(result, target);
  if (preview === result) return null;
  const transfers = [preview.data.buffer];
  const payload = { width: preview.width, height: preview.height, rgba: preview.data.buffer };
  if (preview.__image16) {
    payload.image16 = preview.__image16.data.buffer;
    transfers.push(payload.image16);
  }
  const sample = downsampleImageDataForMaxPixels(preview, Number(histogramSamples) || DEFAULT_HISTOGRAM_SAMPLES);
  if (sample !== preview) {
    payload.histogram = { width: sample.width, height: sample.height, rgba: sample.data.buffer };
    transfers.push(sample.data.buffer);
    if (sample.__image16?.data instanceof Uint16Array) {
      payload.histogram.image16 = sample.__image16.data.buffer;
      transfers.push(payload.histogram.image16);
    }
  }
  return { payload, transfers };
}

async function convert(msg) {
  const { id, image16, options } = msg;
  let { settings } = msg;
  let adjust = msg.adjust || null;
  // A lent source goes back whatever happens; nothing here writes it.
  const lent = Boolean(msg.returnSource) && image16 instanceof ArrayBuffer && !(options && options.ownedSource);
  try {
    if (msg.cacheRecipe) cachedRecipe = { settings, adjust };
    if (msg.reuseRecipe) {
      if (!cachedRecipe) throw new Error('Missing loupe recipe');
      ({ settings, adjust } = cachedRecipe);
    }
    const resolved = resolveRequest(msg, settings);
    const { imageData, conversionOptions, level } = resolved;
    settings = resolved.settings;
    const displayTarget = options && options.displayTarget;
    // A newer frame supersedes the retained one. A retaining request writes
    // its output into that plane; any other request just lets it go.
    const reuse = retained;
    retained = null;
    // With prepared adjustments (the live loupe) the reply is the adjusted
    // 8-bit frame only, exactly as the main thread would make it.
    if (adjust) {
      const frame = await convertAdjustedFrame({ imageData, settings, adjust, options: conversionOptions, lutScratch: adjustmentLutScratch });
      if (!frame) throw new Error('Conversion returned no frame');
      self.postMessage({ type: 'result', id, width: frame.width, height: frame.height, rgba: frame.data.buffer }, [frame.data.buffer]);
      return;
    }
    if (msg.retain16 && reuse) conversionOptions.workBuffer16 = reuse.image16.data;
    const result = await convertFrameWithRouter({ imageData, settings, options: conversionOptions });

    const payload = {
      type: 'result',
      id,
      width: result.width,
      height: result.height,
      rgba: result.data.buffer
    };
    // An interactive frame a live dodge-and-burn stroke can be painted over (#254).
    if (Number.isInteger(result.__liveFrame)) payload.liveFrame = { seq: result.__liveFrame, slot: slotNameFor(options) };
    const transfers = [result.data.buffer];
    if (result.__analysisPreview) {
      const sample = result.__analysisPreview;
      payload.analysisPreview = { width: sample.width, height: sample.height, rgba: sample.data.buffer };
      transfers.push(sample.data.buffer);
    }
    const plane = result.__image16 && result.__image16.data instanceof Uint16Array ? result.__image16 : null;
    // Main builds its histogram from a downsample of the full plane; send that
    // sample so the histogram stays the same without the plane.
    const sample = msg.retain16 && plane
      ? downsampleImageDataForMaxPixels(result, Number(options?.histogramSamples) || DEFAULT_HISTOGRAM_SAMPLES)
      : null;
    if (sample && sample !== result) {
      retained = { id, image16: plane };
      payload.retained16 = true;
      payload.histogram = { width: sample.width, height: sample.height, rgba: sample.data.buffer };
      transfers.push(sample.data.buffer);
      if (sample.__image16?.data instanceof Uint16Array) {
        payload.histogram.image16 = sample.__image16.data.buffer;
        transfers.push(payload.histogram.image16);
      }
    } else if (plane) {
      payload.image16 = plane.data.buffer;
      transfers.push(payload.image16);
    }
    if (displayTarget && !msg.retain16) {
      const built = displayPreviewPayload(result, displayTarget, options.histogramSamples);
      if (built) {
        payload.displayPreview = built.payload;
        transfers.push(...built.transfers);
      }
    }
    if (msg.wbSample) {
      try {
        const sample = await convertWbSample(msg.wbSample.fromSource ? imageData : level, { ...msg.wbSample, geometry: { ...msg.wbSample.geometry } },
          settings, conversionOptions);
        payload.wbSample = sample;
        transfers.push(sample.rgba);
      } catch (err) {
        // The frame stands; auto WB then reads its display preview.
        console.warn('Auto-WB sample failed:', err?.message || err);
      }
    }
    if (lent && !transfers.includes(image16)) {
      payload.source16 = image16;
      transfers.push(image16);
    }
    self.postMessage(payload, transfers);
  } catch (err) {
    const message = err?.message || String(err);
    if (lent && image16.byteLength > 0) {
      try {
        self.postMessage({ type: 'error', id, message, returned: { source16: image16 } }, [image16]);
      } catch {
        self.postMessage({ type: 'error', id, message });
      }
    } else {
      self.postMessage({ type: 'error', id, message });
    }
  } finally {
    if (msg.releaseAfter) releaseSlotBuffers(slotNameFor(options));
  }
}

// The GPU preview's inputs (#239): the prepared display-size negative, its stops
// and their histogram samples. Nothing here writes to the retained plane.
async function prepare(msg) {
  const { id, options } = msg;
  try {
    const { imageData, settings, conversionOptions } = resolveRequest(msg);
    const prepared = prepareSilverCorePreview(imageData, settings, resolveConversionMode(settings),
      { ...conversionOptions, histogramSamples: options?.histogramSamples });
    const { histogram } = prepared;
    // Main holds no display negative of a display target (#248): send the
    // resampled one when it is the prepared plane itself.
    const pristine = prepared.pristine || (msg.display ? new Uint16Array(planeOf(imageData).data) : null);
    const payload = {
      type: 'prepared', id, width: prepared.width, height: prepared.height,
      pristine: pristine ? pristine.buffer : null,
      stops: prepared.stops ? prepared.stops.buffer : null,
      histogram: { width: histogram.width, height: histogram.height, image16: histogram.data.buffer,
        stops: histogram.stops ? histogram.stops.buffer : null },
    };
    const transfers = [payload.pristine, payload.stops, payload.histogram.image16, payload.histogram.stops].filter(Boolean);
    self.postMessage(payload, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
}

// The analysis the next frame of these settings uses, run now and kept for it.
async function analyze(msg) {
  const { id } = msg;
  try {
    const { imageData, settings, conversionOptions } = resolveRequest(msg);
    const analysis = await analyzeSilverCorePreview(imageData, settings, resolveConversionMode(settings), conversionOptions);
    self.postMessage({ type: 'analyzed', id, key: msg.key ?? null, ...analysis });
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
}

// A copy of the display negative of a display target (#248 part 3), for main's
// repaired preview: main keeps no display negative of its own.
function displayNegative(msg) {
  const { id } = msg;
  try {
    const { imageData } = resolveRequest(msg);
    const plane = planeOf(imageData);
    const copy = new Uint16Array(plane.data);
    // The 8-bit plane as resizeDisplayPreview makes it from 16 bits.
    const rgba = new Uint8ClampedArray(copy.length);
    for (let i = 0; i < copy.length; i++) rgba[i] = Math.round(copy[i] / 257);
    self.postMessage({ type: 'displayNegative', id, width: plane.width, height: plane.height, image16: copy.buffer, rgba: rgba.buffer },
      [copy.buffer, rgba.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
}

// The display preview of a full-resolution frame at a new display size
// (#248 part 4). Nothing of it is kept: the cached source stays the level.
function resample(msg) {
  const { id, width, height, rgba, image16, target } = msg;
  try {
    if (msg.detail) {
      assertDetailAllocation(width, height);
      assertDetailAllocation(target.width, target.height, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
    }
    if (msg.geometry) assertDetailGeometry(msg.geometry, width, height);
    const image = { width, height, data: rgba ? new Uint8ClampedArray(rgba) : null };
    if (image16) image.__image16 = { width, height, data: new Uint16Array(image16) };
    let preview;
    if (msg.geometry) {
      const plane = resampleDisplayLevel(planeOf(image), msg.geometry, target);
      const data = plane.data instanceof Uint16Array ? new Uint8ClampedArray(plane.data.length) : plane.data;
      if (data !== plane.data) for (let i = 0; i < data.length; i++) data[i] = Math.round(plane.data[i] / 257);
      preview = { ...target, data };
    } else preview = filterDisplayImage(image, target);
    const payload = { type: 'resampled', id, width: preview.width, height: preview.height, rgba: preview.data.buffer };
    const transfers = [preview.data.buffer];
    if (preview.__image16 && image16) {
      payload.image16 = preview.__image16.data.buffer;
      transfers.push(payload.image16);
    }
    self.postMessage(payload, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
}

// Rows [y, y + height) and columns [x, x + width) of an RGBA16 plane.
function cropPlane(plane, rect) {
  assertDetailAllocation(rect.width, rect.height);
  if (!Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y) || rect.x < 0 || rect.y < 0
    || rect.x + rect.width > plane.width || rect.y + rect.height > plane.height) throw new RangeError('Invalid detail level crop');
  const data = new Uint16Array(rect.width * rect.height * 4);
  for (let row = 0; row < rect.height; row++) {
    const from = ((rect.y + row) * plane.width + rect.x) * 4;
    data.set(plane.data.subarray(from, from + rect.width * 4), row * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data };
}

// `plane` at the top-left of a width x height plane, its last column and row
// repeated into the rest.
function padPlane(plane, width, height) {
  assertDetailAllocation(width, height, DETAIL_MAX_OUTPUT_PIXELS, DETAIL_MAX_DIMENSION);
  if (plane.width === width && plane.height === height) return plane;
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(plane.height - 1, y);
    const row = plane.data.subarray(sy * plane.width * 4, (sy + 1) * plane.width * 4);
    data.set(row, y * width * 4);
    const last = row.subarray((plane.width - 1) * 4);
    for (let x = plane.width; x < width; x++) data.set(last, (y * width + x) * 4);
  }
  return { width, height, data };
}

// A detail region (#248 part 5): source pixels of a region of the conversion
// source (or of the cached level, when it holds enough detail), converted in
// the fixed roi slot with the base display image's analysis and with the
// stops and flat field of its place in the frame, so it meets the base without
// a seam. It leaves the cached source, analysis and strokes alone.
async function roi(msg) {
  const { id, settings, region, base } = msg;
  try {
    assertDetailRoiAllocation(region, msg.warm);
    const mode = resolveConversionMode(settings);
    if (msg.warm) {
      // A first conversion costs engine set-up and compilation: done at idle.
      const blank = { width: region.slotWidth, height: region.slotHeight, data: new Uint16Array(region.slotWidth * region.slotHeight * 4) };
      await convertFrameWithRouter({ imageData: blank, settings, options: { region: { originX: 0, originY: 0, frameWidth: blank.width, frameHeight: blank.height },
        forceFullProcess: true, ownedSource: true, includeAnalysisPreview: false } });
      self.postMessage({ type: 'roi', id, warm: true, width: 0, height: 0 });
      return;
    }
    const level = cachedSource;
    if (!level || level.width !== base.levelWidth || level.height !== base.levelHeight) throw new Error('Missing preview source');
    // The analysis the base's next frame of these settings uses (the preview
    // slot keeps it, as the GPU preview's `analyze` does).
    const baseNegative = base.display ? displayNegativeFor(level, base.display) : level;
    const analysis = await analyzeSilverCorePreview(baseNegative, settings, mode, { preview: true, analysisImageData: cachedAnalysis });
    if (cancelledRequests.has(id)) return;
    const out = { width: region.outWidth, height: region.outHeight };
    let plane;
    if (region.fromLevel) {
      const k = region.levelFactor;
      const block = cropPlane(planeOf(level), { x: region.x / k, y: region.y / k, width: region.width / k, height: region.height / k });
      plane = resampleDisplayLevel(block, { sourceWidth: region.width, sourceHeight: region.height, k }, out);
    } else {
      const rows = msg.image16
        ? { width: region.width, height: region.height, data: new Uint16Array(msg.image16) }
        : fromImageData8({ width: region.width, height: region.height, data: new Uint8ClampedArray(msg.rgba) });
      if (out.width === rows.width && out.height === rows.height) plane = rows;
      else {
        // Below full density the native rows are box-decimated first.
        const k = Math.max(1, Math.floor(Math.min(rows.width / out.width, rows.height / out.height)));
        const box = k > 1 ? buildDisplayLevel({ width: rows.width, height: rows.height, data: rows.data }, k).__image16 : rows;
        plane = resampleDisplayLevel(box, { sourceWidth: rows.width, sourceHeight: rows.height, k }, out);
      }
    }
    const density = out.width / region.width;
    const padded = padPlane(plane, Math.max(region.slotWidth, out.width), Math.max(region.slotHeight, out.height));
    // The padded plane is private. Release received rows and resampling scratch
    // before the adapter awaits profile loading, then convert this plane in place.
    plane = null;
    msg.image16 = null;
    msg.rgba = null;
    const result = await convertFrameWithRouter({
      imageData: padded,
      settings,
      options: {
        region: density === 1
          ? { originX: region.x, originY: region.y, frameWidth: region.frameWidth, frameHeight: region.frameHeight }
          : { originX: Math.round(region.x * density), originY: Math.round(region.y * density),
            frameWidth: Math.round(region.frameWidth * density), frameHeight: Math.round(region.frameHeight * density) },
        forceFullProcess: true,
        ownedSource: true,
        includeAnalysisPreview: false,
        sharedAnalysis: { channelData: analysis.channelData, positiveAnalysis: analysis.positiveAnalysis }
      }
    });
    if (cancelledRequests.has(id)) return;
    const rgba = out.width === result.width && out.height === result.height
      ? result.data : new Uint8ClampedArray(out.width * out.height * 4);
    if (rgba !== result.data) for (let row = 0; row < out.height; row++) {
      rgba.set(result.data.subarray(row * padded.width * 4, (row * padded.width + out.width) * 4), row * out.width * 4);
    }
    self.postMessage({ type: 'roi', id, width: out.width, height: out.height, rgba: rgba.buffer }, [rgba.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  } finally {
    releaseSlotBuffers('roi');
  }
}

// One step of a live dodge-and-burn stroke (#254 C): adds the new points to
// the stroke's coverage and converts the rectangle they touched over the live
// frame `frameSeq` of `slot`. Messages run in order behind any conversion, so a
// request never interleaves with one. Replies { rect, rgba, committedRgba },
// { stale } when the slot no longer holds that frame, { needsReset } when the
// stroke has to be sent again from its first point.
function exposureLive(msg) {
  const { id, slot, frameSeq } = msg;
  try {
    if (msg.probe) {
      self.postMessage({ type: 'exposureLive', id, hasLive: Boolean(liveStroke), hasCommitted: Boolean(liveCommitted) });
      return;
    }
    if (msg.end) {
      // A late final reply from the previous stroke cannot clear a new one.
      if (!liveStroke || msg.strokeId == null || liveStroke.strokeId === msg.strokeId) {
        liveStroke = null;
        liveCommitted = null;
      }
      self.postMessage({ type: 'exposureLive', id, ended: true });
      return;
    }
    if ('committed' in msg) liveCommitted = msg.committed || null;
    const geometry = liveExposureGeometry(slot, frameSeq);
    if (!geometry) {
      liveStroke = null;
      self.postMessage({ type: 'exposureLive', id, stale: true });
      return;
    }
    if (msg.reset) liveStroke = { slot, frameSeq, strokeId: msg.strokeId, store: createLiveStrokeCoverage(msg.stroke, geometry) };
    if (!liveStroke || liveStroke.slot !== slot || liveStroke.frameSeq !== frameSeq) {
      self.postMessage({ type: 'exposureLive', id, needsReset: true });
      return;
    }
    const { store } = liveStroke;
    let rect = addLiveStrokePoints(store, msg.points || []);
    if (msg.fullStroke) rect = unionRect(rect, store.bounds);
    if (!rect) {
      self.postMessage({ type: 'exposureLive', id, rect: null });
      return;
    }
    const reply = renderLiveExposureRect(slot, { frameSeq, committed: liveCommitted, store, rect, withCommitted: Boolean(msg.withCommitted) });
    if (reply.stale) {
      liveStroke = null;
      self.postMessage({ type: 'exposureLive', id, stale: true });
      return;
    }
    const transfers = [reply.rgba.buffer];
    if (reply.committedRgba) transfers.push(reply.committedRgba.buffer);
    self.postMessage({ type: 'exposureLive', id, rect, rgba: reply.rgba.buffer,
      committedRgba: reply.committedRgba ? reply.committedRgba.buffer : null }, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
}

// Hands the retained plane of request `resultId` to main, or null when a
// newer request has taken it over (main then converts that frame again).
function commit(msg) {
  const plane = retained && retained.id === msg.resultId ? retained.image16 : null;
  if (plane) retained = null;
  self.postMessage(
    { type: 'committed', id: msg.id, resultId: msg.resultId, image16: plane ? plane.data.buffer : null },
    plane ? [plane.data.buffer] : []
  );
}

async function handleMessage(msg) {
  // The import warm-up only needs this module (and the engine it imports)
  // loaded; the cached preview source stays as it is.
  if (msg.type === 'warm-up') {
    self.postMessage({ type: 'ready', id: msg.id });
    return;
  }
  if (msg.type === 'convert') return convert(msg);
  if (msg.type === 'commit') return commit(msg);
  if (msg.type === 'prepare') return prepare(msg);
  if (msg.type === 'analyze') return analyze(msg);
  if (msg.type === 'displayNegative') return displayNegative(msg);
  if (msg.type === 'resample') return resample(msg);
  if (msg.type === 'roi') return roi(msg);
  if (msg.type === 'exposureLive') return exposureLive(msg);
  self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
}

// One message at a time, in arrival order: a commit must see every
// conversion posted before it, and a conversion must not start while an
// earlier one still awaits a profile load.
let queue = Promise.resolve();
const queuedMessages = new Map();
const cancelledRequests = new Set();
let activeRequest = null;
self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'cancel') {
    // Drop queued rows immediately; the queue closes over IDs, never planes.
    queuedMessages.delete(msg.id);
    if (activeRequest === msg.id) cancelledRequests.add(msg.id);
    return;
  }
  queuedMessages.set(msg.id, msg);
  const id = msg.id;
  const run = queue.then(async () => {
    const request = queuedMessages.get(id);
    queuedMessages.delete(id);
    if (!request) return;
    activeRequest = id;
    try { await handleMessage(request); }
    finally { activeRequest = null; cancelledRequests.delete(id); }
  });
  queue = run.catch(() => {});
  return run;
};
