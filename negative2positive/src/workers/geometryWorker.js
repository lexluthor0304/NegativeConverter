// Geometry pool worker (#244): renders one row band of a geometry plan from
// the source rows posted with it, and transfers the band back. Also the
// 2D-canvas rotation of a whole 8-bit frame on an OffscreenCanvas (#293).
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { runGeometryBand, runCanvasRotation } from '../app/geometryPool.js';

self.onmessage = ({ data }) => {
  if (data?.type === 'geometry-rotate') {
    try {
      const { payload, transfers } = runCanvasRotation(data);
      self.postMessage(payload, transfers);
    } catch (error) {
      self.postMessage({ id: data.id, error: String(error?.message || error) });
    }
    return;
  }
  if (data?.type !== 'geometry-band') return;
  try {
    const { payload, transfers } = runGeometryBand(data);
    self.postMessage(payload, transfers);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error) });
  }
};
