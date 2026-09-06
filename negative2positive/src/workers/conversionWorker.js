/**
 * Conversion Worker — runs the full SilverCore negative->positive conversion
 * off the main thread. Preview and full-resolution clients use separate workers.
 */
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { fromImageData8 } from '../silvercore/util/image16.js';

let cachedSource = null;
let cachedAnalysis = null;

self.onmessage = async function (e) {
  const msg = e.data;
  if (msg.type !== 'convert') {
    self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
    return;
  }

  const { id, width, height, rgba, image16, settings, options } = msg;
  try {
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
    if (msg.cacheInput) {
      cachedSource = imageData;
      if (!msg.reuseAnalysis) cachedAnalysis = options.analysisImageData || null;
      conversionOptions.analysisImageData = cachedAnalysis;
    }
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
    if (result.__image16 && result.__image16.data instanceof Uint16Array) {
      payload.image16 = result.__image16.data.buffer;
      transfers.push(payload.image16);
    }
    self.postMessage(payload, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
