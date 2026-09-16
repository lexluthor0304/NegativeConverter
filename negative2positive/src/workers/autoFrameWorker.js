import { readTextInBands, borderTextBands } from '../app/filmEdgeText.js';
import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { detectFrameAndRotation } from '../app/autoFrameAnalyzer.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';
import { readFilmEdge, rectifyLaneBand } from '../app/filmEdgeReader.js';

let ready;
async function loadCv() {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ opencvScriptUrl);
    globalThis.cv = await globalThis.cv;
    if (!globalThis.cv?.Mat) throw new Error('OpenCV worker initialization failed');
  })();
  return ready;
}

self.onmessage = async ({ data: message }) => {
  try {
    if (message.type === 'warm-up') {
      // Load and compile OpenCV while the first photo is still decoding, so
      // the first detection does not pay for it.
      await loadCv();
      self.postMessage({ id: message.id, result: { ready: true } });
      return;
    }
    if (message.type === 'read-film-edge') {
      // Perforation lanes and the DX edge barcode need no OpenCV; the result
      // is plain data (no ImageData), so it clones without transfers.
      const image = { width: message.width, height: message.height, data: message.rgba };
      const result = readFilmEdge(image, message.options || {});
      try {
        await loadCv();
        const textBands = result.geometry
          ? result.geometry.lanes.map(lane => rectifyLaneBand(image, result.geometry, lane, { columnStepMm: 0.04, rowStepMm: 0.04 }))
          : borderTextBands(image);
        const text = readTextInBands(textBands, { cv: globalThis.cv });
        if (text) { result.text = text; result.found = true; }
      } catch (error) { console.warn('Film edge text unavailable:', error.message); }
      self.postMessage({ id: message.id, result });
      return;
    }
    await loadCv();
    const image = new ImageData(message.rgba, message.width, message.height);
    if (message.image16) image.__image16 = { width: image.width, height: image.height, data: message.image16 };
    const result = detectFrameAndRotation(image, { ...message.options, rotateImageData: applyRotationToImageData });
    const transfers = [];
    if (result?.rotatedImageData) {
      // ImageDataの拡張プロパティはstructured cloneに含まれないため明示する。
      const rotated = result.rotatedImageData;
      result.rotatedImageData = { width: rotated.width, height: rotated.height, data: rotated.data, image16: rotated.__image16?.data };
      transfers.push(rotated.data.buffer);
      if (rotated.__image16) transfers.push(rotated.__image16.data.buffer);
    }
    self.postMessage({ id: message.id, result }, transfers);
  } catch (error) {
    self.postMessage({ id: message.id, error: String(error?.message || error) });
  }
};
