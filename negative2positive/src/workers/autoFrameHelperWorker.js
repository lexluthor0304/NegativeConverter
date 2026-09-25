/**
 * Detection helper (#252 part 4): one of the two workers the shared
 * auto-frame worker spreads a foreground detection over. The page hands it a
 * MessagePort to that worker; it receives only the detection's 1600 px
 * preview and answers with plain data (autoFrameHelperTask.js). OpenCV is
 * the page's compiled module.
 */
import { acceptOpenCvMessage, loadOpenCv } from './opencvWorkerRuntime.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';
import { createAutoFrameHelperTask } from './autoFrameHelperTask.js';

const task = createAutoFrameHelperTask({ loadCv: loadOpenCv, rotate: applyRotationToImageData });

self.onmessage = ({ data }) => {
  if (acceptOpenCvMessage(data)) return;
  if (data?.type === 'port' && data.port) {
    const port = data.port;
    port.onmessage = ({ data: request }) => {
      void task.handle(request, message => port.postMessage(message));
    };
    return;
  }
  if (data?.type === 'warm-up') {
    loadOpenCv().then(() => self.postMessage({ type: 'warmed' }), error => self.postMessage({ type: 'warm-failed', error: String(error?.message || error) }));
  }
};
