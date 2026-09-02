/**
 * Sensor-defect suppression worker — runs the isolated-outlier repair over a
 * freshly decoded 16-bit RAW off the main thread. The pixel buffer is
 * transferred in, repaired in place, and transferred back (zero-copy).
 */
import { suppressSensorDefects } from '../silvercore/util/sensorDefects.js';

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === 'ping') {
    self.postMessage({ type: 'pong', id: msg.id });
    return;
  }
  if (msg.type !== 'suppress') {
    self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
    return;
  }
  const { id, width, height, buffer } = msg;
  try {
    const data = new Uint16Array(buffer);
    const stats = suppressSensorDefects({ width, height, data });
    self.postMessage({ type: 'result', id, buffer, stats }, [buffer]);
  } catch (err) {
    // Hand the buffer back so the caller keeps its pixels even when we fail.
    self.postMessage({ type: 'error', id, message: err?.message || String(err), buffer }, [buffer]);
  }
};
