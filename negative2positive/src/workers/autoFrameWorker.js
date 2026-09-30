import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { acceptOpenCvMessage, loadOpenCv, openCvRealmStats } from './opencvWorkerRuntime.js';
import { detectFrameAndRotation } from '../app/autoFrameAnalyzer.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';
import { createFilmEdgeReader } from './filmEdgeRead.js';
import { isOpenCvAnalysisType, runOpenCvAnalysisTask } from '../app/openCvAnalysisTasks.js';
import { detectFrameForRequest, packFrameResult, runImportRequest } from './autoFrameImportTask.js';
import { createHelperLink, detectFrameAndRotationParallel } from './autoFrameParallel.js';

// The page's compiled OpenCV module, instantiated here (#252 part 5).
const loadCv = loadOpenCv;

// Perforation lanes and the DX edge barcode need no OpenCV; the edge text does.
const readEdge = createFilmEdgeReader(loadCv);

// The OpenCV heap this worker holds, reported with every reply so the page's
// memory ledger can count it (#258). 0 until OpenCV is loaded.
function cvHeapBytes() {
  try { return Number(globalThis.cv?.HEAPU8?.buffer?.byteLength) || 0; } catch { return 0; }
}
const postReply = (payload, transfers) => self.postMessage({ ...payload, heapBytes: cvHeapBytes() }, transfers);

// Two detection helpers the page may connect (#252 part 4): the foreground
// detection spreads its independent stages over them. Without them, or
// after the page released them, it runs serially here.
let helpers = null;
function setHelpers(ports) {
  helpers?.b.close();
  helpers?.c.close();
  helpers = ports?.length === 2 ? { b: createHelperLink(ports[0]), c: createHelperLink(ports[1]) } : null;
}
function detectForeground(image, options) {
  if (helpers && !(helpers.b.broken && helpers.c.broken)) return detectFrameAndRotationParallel(image, options, helpers);
  return detectFrameAndRotation(image, options);
}

self.onmessage = async ({ data: message }) => {
  if (acceptOpenCvMessage(message)) return;
  try {
    if (message.type === 'warm-up') {
      // Instantiate OpenCV while the first photo is still decoding, so the
      // first detection does not pay for it.
      await loadCv();
      postReply({ id: message.id, result: { ready: true, opencv: openCvRealmStats() } });
      return;
    }
    if (message.type === 'read-film-edge') {
      const image = { width: message.width, height: message.height, data: message.rgba };
      postReply({ id: message.id, result: await readEdge(image, message.options) });
      return;
    }
    if (message.type === 'helpers') {
      setHelpers(message.ports || []);
      return;
    }
    if (message.type === 'analyze-import') {
      const { reply, transfers } = await runImportRequest(message, {
        loadCv, detect: detectForeground, rotate: applyRotationToImageData, readEdge
      });
      postReply({ id: message.id, result: reply }, transfers);
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
        postReply({ id: message.id, error: String(error?.message || error), taskError: true });
        return;
      }
      postReply({ id: message.id, result: output.result }, output.transfers);
      return;
    }
    if (message.type !== 'analyze-frame') throw new Error(`Unknown auto-frame worker request: ${message.type}`);
    await loadCv();
    const image = new ImageData(message.rgba, message.width, message.height);
    if (message.image16) image.__image16 = { width: image.width, height: image.height, data: message.image16 };
    const transfers = [];
    const result = packFrameResult(await detectFrameForRequest(image, message, message.options, {
      detect: detectForeground, rotate: applyRotationToImageData
    }), transfers);
    postReply({ id: message.id, result }, transfers);
  } catch (error) {
    postReply({ id: message.id, error: String(error?.message || error) });
  }
};
