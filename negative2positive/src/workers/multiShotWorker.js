import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { createMultiShotWorkerProcessor } from './multiShotWorkerProcessor.js';

let ready;
function loadCv() {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ opencvScriptUrl);
    globalThis.cv = await globalThis.cv;
    if (!globalThis.cv?.Mat) throw new Error('OpenCV multi-shot worker initialization failed');
  })();
  return ready;
}
const process = createMultiShotWorkerProcessor({
  loadCv,
  // Blobs are posted by reference; nothing else large travels back.
  post: (message) => self.postMessage(message)
});
self.onmessage = ({ data }) => { void process(data); };
// The page posts no pixels until this arrives, so a worker that cannot start
// never swallows a transferred plane.
self.postMessage({ type: 'hello' });
