// Geometry pool worker (#244): renders one row band of a geometry plan from
// the source rows posted with it, and transfers the band back.
import { runGeometryBand } from '../app/geometryPool.js';

self.onmessage = ({ data }) => {
  if (data?.type !== 'geometry-band') return;
  try {
    const { payload, transfers } = runGeometryBand(data);
    self.postMessage(payload, transfers);
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error) });
  }
};
