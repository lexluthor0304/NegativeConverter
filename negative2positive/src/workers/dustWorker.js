import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { createDustWorkerProcessor } from './dustWorkerProcessor.js';

let ready;
function loadCv() {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ opencvScriptUrl);
    globalThis.cv = await globalThis.cv;
    if (!globalThis.cv?.Mat) throw new Error('OpenCV dust worker initialization failed');
  })();
  return ready;
}
const process = createDustWorkerProcessor({ loadCv });
self.onmessage = async ({ data }) => {
  try {
    const { payload, transfers } = await process(data);
    self.postMessage(payload, transfers);
  } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
};
