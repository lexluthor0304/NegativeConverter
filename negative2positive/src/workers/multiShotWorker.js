import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { acceptOpenCvMessage, loadOpenCv } from './opencvWorkerRuntime.js';
import { createMultiShotWorkerProcessor } from './multiShotWorkerProcessor.js';

// The page's compiled OpenCV module, instantiated here (#252 part 5).
const loadCv = loadOpenCv;
const process = createMultiShotWorkerProcessor({
  loadCv,
  // Blobs are posted by reference; nothing else large travels back.
  post: (message) => self.postMessage(message)
});
self.onmessage = ({ data }) => {
  if (acceptOpenCvMessage(data)) return;
  void process(data);
};
// The page posts no pixels until this arrives, so a worker that cannot start
// never swallows a transferred plane.
self.postMessage({ type: 'hello' });
