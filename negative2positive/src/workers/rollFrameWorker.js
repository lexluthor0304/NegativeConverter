/**
 * Roll-frame worker (#252 part 2): one per frame in flight, alive for the
 * whole roll analysis. A lane transfers LibRaw's result here; the post-decode
 * steps, the frame detection, the film-edge read and later the roll sample
 * run on this worker's own planes (rollFrameTask.js), so the 60 MP planes
 * never travel back to the page. OpenCV is the page's compiled module.
 */
import { acceptOpenCvMessage, loadOpenCv } from './opencvWorkerRuntime.js';
import { detectFrameAndRotation } from '../app/autoFrameAnalyzer.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';
import { createFilmEdgeReader } from './filmEdgeRead.js';
import { createRollFrameTask } from './rollFrameTask.js';

const task = createRollFrameTask({
  loadCv: loadOpenCv,
  detect: detectFrameAndRotation,
  rotate: applyRotationToImageData,
  readEdge: createFilmEdgeReader(loadOpenCv)
});

self.onmessage = ({ data }) => {
  if (acceptOpenCvMessage(data)) return;
  void task.handle(data, (message, transfer) => self.postMessage(message, transfer || []));
};
