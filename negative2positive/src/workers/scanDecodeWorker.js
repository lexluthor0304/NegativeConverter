// Scan decode (PNG/TIFF), embedded RAW preview and HE NEF JPEG jobs.
//
// Scan jobs keep one worker per decode (the client terminates it after the
// planes arrive). Image jobs are multiplexed by id: the embedded-preview pool
// keeps up to two of these workers alive while it has work.
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { fromImageData8 } from '../silvercore/util/image16.js';
import { renderEmbeddedPreview } from '../app/embeddedPreviewRender.js';
import { allocPlane16, sharedPlanesAvailable } from '../app/crossOriginIsolation.js';

// UPNG and UTIF load only when a scan job needs them, so an image-only worker
// starts without paying for them.
const scanLoaders = {
  png: () => import('../app/pngFileLoader.js').then(module => (buffer, options) => module.loadPngFile(buffer, options)),
  tiff: () => import('../app/tiffFileLoader.js').then(module => (buffer, options) => module.decodeTiffBuffer(buffer, options)),
};

// A real 1x1 baseline JPEG (libjpeg, with EOI). Decoding it and drawing it into an OffscreenCanvas
// is the capability probe: OffscreenCanvas support differs across WebKit
// versions and build flags, so feature detection is not enough.
const PROBE_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAA//2Q==';

async function decodeImage(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch (error) {
    // Engines that predate the option value reject the dictionary.
    if (error?.name === 'TypeError') return await createImageBitmap(blob);
    throw error;
  }
}

async function probeImageDecoding() {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return false;
    const binary = atob(PROBE_JPEG);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    if (!context) return false;
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return context.getImageData(0, 0, 1, 1).data[3] === 255;
  } catch {
    return false;
  }
}

function blobToDataUrl(blob) {
  if (typeof FileReaderSync === 'function') return Promise.resolve(new FileReaderSync().readAsDataURL(blob));
  return blob.arrayBuffer().then(buffer => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
  });
}

const env = {
  createCanvas: (width, height) => new OffscreenCanvas(width, height),
  decode: decodeImage,
  async finish(canvas, job) {
    if (job.output === 'dataUrl') {
      return blobToDataUrl(await canvas.convertToBlob({ type: 'image/jpeg', quality: job.quality || 0.8 }));
    }
    return canvas.transferToImageBitmap();
  },
};

// The HE NEF fallback contract scanDecodeClient already consumes:
// { data, width, height, image16 } with both planes transferred.
async function decodeJpeg({ id, bytes }) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const { width, height } = bitmap;
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, width, height);
    const image16 = fromImageData8(image);
    self.postMessage({ id, width, height, data: image.data.buffer, image16: image16.data.buffer },
      [image.data.buffer, image16.data.buffer]);
  } catch (error) {
    // Hand the stashed bytes back so the main-thread decoder can still run.
    self.postMessage({ id, error: error?.message || String(error), bytes }, [bytes]);
  } finally { bitmap?.close?.(); }
}

async function embeddedPreview(message) {
  const { id } = message;
  try {
    const result = await renderEmbeddedPreview(message, env);
    const { output, ...rest } = result;
    const reply = { id, ...rest };
    if (output && typeof output === 'object') {
      reply.bitmap = output;
      self.postMessage(reply, [output]);
    } else {
      if (output) reply.dataUrl = output;
      self.postMessage(reply);
    }
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
}

async function scan({ buffer, format, sharedPlanes = false }) {
  try {
    const decode = await (format === 'png' ? scanLoaders.png() : scanLoaders.tiff());
    // The editor's scan (#264): its 16-bit plane in shared memory, built here;
    // a shared buffer is posted as it is, never in the transfer list.
    const alloc = sharedPlanes && sharedPlanesAvailable() ? (length) => allocPlane16(length, { shared: true }) : null;
    const result = decode(buffer, { alloc });
    const image16 = result.__image16;
    const transfers = [result.data.buffer];
    if (image16 && image16.data.buffer instanceof ArrayBuffer) transfers.push(image16.data.buffer);
    self.postMessage({ width: result.width, height: result.height, data: result.data, image16 }, transfers);
  } catch (error) {
    self.postMessage({ error: error.message || String(error), code: error.code });
  }
}

self.onmessage = ({ data }) => {
  if (data?.type === 'jpeg') return decodeJpeg(data);
  if (data?.type === 'embedded-preview') return embeddedPreview(data);
  return scan(data);
};
probeImageDecoding().then(canDecodeImages => self.postMessage({ ready: true, canDecodeImages }));
