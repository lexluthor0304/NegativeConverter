import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { acceptOpenCvMessage, loadOpenCv } from './opencvWorkerRuntime.js';
import { createDustWorkerProcessor } from './dustWorkerProcessor.js';

// The page's compiled OpenCV module, instantiated here (#252 part 5).
const loadCv = loadOpenCv;
const process = createDustWorkerProcessor({ loadCv });
self.onmessage = async ({ data }) => {
  if (acceptOpenCvMessage(data)) return;
  try {
    const { payload, transfers } = await process(data);
    self.postMessage(payload, transfers);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error), staleMask: Boolean(error?.staleMask) });
  }
};
