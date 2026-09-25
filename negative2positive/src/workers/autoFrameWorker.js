import { readTextInBands, borderTextBands } from '../app/filmEdgeText.js';
import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { detectFrameAndRotation } from '../app/autoFrameAnalyzer.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';
import { readFilmEdge, rectifyLaneBand } from '../app/filmEdgeReader.js';
import { isOpenCvAnalysisType, runOpenCvAnalysisTask } from '../app/openCvAnalysisTasks.js';
import { detectFrameForRequest, packFrameResult, runImportRequest } from './autoFrameImportTask.js';

let ready;
async function loadCv() {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ opencvScriptUrl);
    globalThis.cv = await globalThis.cv;
    if (!globalThis.cv?.Mat) throw new Error('OpenCV worker initialization failed');
  })();
  return ready;
}

// Perforation lanes and the DX edge barcode need no OpenCV; the result is
// plain data (no ImageData), so it clones without transfers.
async function readEdge(image, options) {
  const result = readFilmEdge(image, options || {});
  try {
    await loadCv();
    const textBands = result.geometry
      ? result.geometry.lanes.map(lane => rectifyLaneBand(image, result.geometry, lane, { columnStepMm: 0.04, rowStepMm: 0.04 }))
      : borderTextBands(image);
    const text = readTextInBands(textBands, { cv: globalThis.cv });
    if (text) { result.text = text; result.found = true; }
  } catch (error) { console.warn('Film edge text unavailable:', error.message); }
  return result;
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
      const image = { width: message.width, height: message.height, data: message.rgba };
      self.postMessage({ id: message.id, result: await readEdge(image, message.options) });
      return;
    }
    if (message.type === 'analyze-import') {
      const { reply, transfers } = await runImportRequest(message, {
        loadCv, detect: detectFrameAndRotation, rotate: applyRotationToImageData, readEdge
      });
      self.postMessage({ id: message.id, result: reply }, transfers);
      return;
    }
    if (isOpenCvAnalysisType(message.type)) {
      // The page's OpenCV analyses (#245): inputs built on the page, the
      // OpenCV half here. An error from the analysis itself is its result
      // (`taskError`); only a failed load makes the page fall back.
      await loadCv();
      let output;
      try {
        output = runOpenCvAnalysisTask(message);
      } catch (error) {
        self.postMessage({ id: message.id, error: String(error?.message || error), taskError: true });
        return;
      }
      self.postMessage({ id: message.id, result: output.result }, output.transfers);
      return;
    }
    if (message.type !== 'analyze-frame') throw new Error(`Unknown auto-frame worker request: ${message.type}`);
    await loadCv();
    const image = new ImageData(message.rgba, message.width, message.height);
    if (message.image16) image.__image16 = { width: image.width, height: image.height, data: message.image16 };
    const transfers = [];
    const result = packFrameResult(detectFrameForRequest(image, message, message.options, {
      detect: detectFrameAndRotation, rotate: applyRotationToImageData
    }), transfers);
    self.postMessage({ id: message.id, result }, transfers);
  } catch (error) {
    self.postMessage({ id: message.id, error: String(error?.message || error) });
  }
};
