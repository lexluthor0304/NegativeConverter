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
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { releaseSlotBuffers } from '../pipeline/silverAdapter.js';
import { fromImageData8 } from '../silvercore/util/image16.js';
import { downsampleImageDataForMaxPixels } from '../app/imageDataOps.js';

let cachedSource = null;
let cachedAnalysis = null;
// The 16-bit plane of the last interactive frame that main asked to retain
// (#233). During a slider drag main draws the 8-bit plane only, so this one
// stays here, becomes the next frame's work buffer, and crosses to main only
// when main commits it. `id` is the request that produced it.
let retained = null;
const DEFAULT_HISTOGRAM_SAMPLES = 24_576;
let cachedLocalExposure = null;

function slotNameFor(options) {
  if (options && options.scratch) return 'scratch';
  return options && options.preview ? 'preview' : 'full';
}

async function convert(msg) {
  const { id, width, height, rgba, image16, settings, options } = msg;
  // A lent source goes back whatever happens; nothing here writes it.
  const lent = Boolean(msg.returnSource) && image16 instanceof ArrayBuffer && !(options && options.ownedSource);
  try {
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
    if (msg.cacheInput) {
      cachedSource = imageData;
      if (!msg.reuseAnalysis) cachedAnalysis = options.analysisImageData || null;
      conversionOptions.analysisImageData = cachedAnalysis;
    }
    // A newer frame supersedes the retained one. A retaining request writes
    // its output into that plane; any other request just lets it go.
    const reuse = retained;
    retained = null;
    if (msg.retain16 && reuse) conversionOptions.workBuffer16 = reuse.image16.data;
    const result = await convertFrameWithRouter({ imageData, settings, options: conversionOptions });

    const payload = {
      type: 'result',
      id,
      width: result.width,
      height: result.height,
      rgba: result.data.buffer
    };
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
  if (msg.type === 'convert') return convert(msg);
  if (msg.type === 'commit') return commit(msg);
  self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
}

// One message at a time, in arrival order: a commit must see every
// conversion posted before it, and a conversion must not start while an
// earlier one still awaits a profile load.
let queue = Promise.resolve();
self.onmessage = function (e) {
  const run = queue.then(() => handleMessage(e.data));
  queue = run.catch(() => {});
  return run;
};
