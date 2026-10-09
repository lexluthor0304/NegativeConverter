// The auto-frame worker's requests that carry a frame (#251), kept apart
// from the worker shell so they run in Node tests with the real analyzer.
import { deriveEightBit } from '../app/crossOriginIsolation.js';

/**
 * The 8-bit plane of a request: posted, or (`derive8`, #264) derived here from
 * the shared 16-bit plane the page sent instead, exactly as the page's own
 * plane was made (>>> 8).
 */
export function requestRgba(message) {
  if (message.derive8 && message.image16) return deriveEightBit(message.image16);
  return message.rgba;
}

// Only ArrayBuffers can be transferred; a shared plane is posted as it is.
const transferable = (buffer) => buffer instanceof ArrayBuffer;

// A frame result for posting. A rotated frame goes back as its planes
// (ImageDataの拡張プロパティはstructured cloneに含まれないため明示する);
// a frame that is the input itself (`rotatedIsSource`) is not sent back:
// the page already holds it.
export function packFrameResult(result, transfers) {
  if (!result?.rotatedImageData) return result;
  if (result.rotatedIsSource) {
    delete result.rotatedImageData;
    return result;
  }
  const rotated = result.rotatedImageData;
  result.rotatedImageData = { width: rotated.width, height: rotated.height, data: rotated.data, image16: rotated.__image16?.data };
  transfers.push(rotated.data.buffer);
  if (rotated.__image16) transfers.push(rotated.__image16.data.buffer);
  return result;
}

// `image16Omitted`: the page kept the 16-bit plane of a 16-bit frame, so a
// full-resolution rotation here would not be the exact one; the analyzer
// asks for it instead (needsFullResolution).
export function detectFrameForRequest(image, message, options, { detect, rotate }) {
  return detect(image, { ...options, rotateImageData: rotate, deferFullResolution: Boolean(message.image16Omitted) });
}

const clock = () => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());
const elapsedMs = started => Math.round((clock() - started) * 10) / 10;

/**
 * 'analyze-import': one frame, both analyses, on the same buffer: the frame
 * detection (`message.frame`: analyzer options), then the film-edge read
 * (`message.filmEdge`: reader options). Each reports its own error, so one
 * failing does not lose the other. With `returnPlanes` the page's own planes
 * (transferred here, never copied) go back with the result.
 * Each part's own time in this worker goes back too (`frameMs`,
 * `filmEdgeMs`, #273): the page's round trip covers both parts, and the
 * film-edge stage has a budget of its own (#236). Timing only.
 * Resolves { reply, transfers }.
 */
export async function runImportRequest(message, { loadCv, detect, rotate, readEdge }) {
  const image = new ImageData(requestRgba(message), message.width, message.height);
  if (message.image16) image.__image16 = { width: image.width, height: image.height, data: message.image16 };
  const reply = {};
  const transfers = [];
  if (message.frame) {
    const started = clock();
    try {
      await loadCv();
      // `detect` may resolve later (the parallel detector, #252).
      reply.frame = packFrameResult(await detectFrameForRequest(image, message, message.frame, { detect, rotate }), transfers);
    } catch (error) { reply.frameError = String(error?.message || error); }
    reply.frameMs = elapsedMs(started);
  }
  if (message.filmEdge) {
    const started = clock();
    try { reply.filmEdge = await readEdge(image, message.filmEdge); }
    catch (error) { reply.filmEdgeError = String(error?.message || error); }
    reply.filmEdgeMs = elapsedMs(started);
  }
  if (message.returnPlanes) {
    if (message.rgba) {
      reply.rgba = message.rgba;
      transfers.push(message.rgba.buffer);
    }
    // A shared 16-bit plane stayed the page's: it is not sent back.
    if (message.image16 && transferable(message.image16.buffer)) {
      reply.image16 = message.image16;
      transfers.push(message.image16.buffer);
    }
  }
  return { reply, transfers };
}
