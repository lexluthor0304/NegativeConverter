/**
 * Conversion Worker — runs the full SilverCore negative->positive conversion
 * off the main thread. Used for full-resolution renders (deferred background
 * render, export, batch); the 250k-pixel interactive preview stays on the
 * main thread where it cooperates with the WebGL cache.
 */
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';

self.onmessage = async function (e) {
  const msg = e.data;
  if (msg.type !== 'convert') {
    self.postMessage({ type: 'error', id: msg.id, message: `Unknown message type: ${msg.type}` });
    return;
  }

  const { id, width, height, rgba, image16, settings, options } = msg;
  try {
    let imageData;
    if (rgba) {
      imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
      if (image16) {
        imageData.__image16 = { width, height, data: new Uint16Array(image16) };
      }
    } else {
      // 16-bit-only payload (RAW / 16-bit PNG). The adapter reads input via
      // toImage16, which accepts this shape directly — no need to allocate a
      // redundant RGBA plane for a 90+ MP scan.
      imageData = { width, height, data: new Uint16Array(image16) };
    }

    const result = await convertFrameWithRouter({ imageData, settings, options });

    const payload = {
      type: 'result',
      id,
      width: result.width,
      height: result.height,
      rgba: result.data.buffer
    };
    const transfers = [result.data.buffer];
    if (result.__image16 && result.__image16.data instanceof Uint16Array) {
      payload.image16 = result.__image16.data.buffer;
      transfers.push(payload.image16);
    }
    self.postMessage(payload, transfers);
  } catch (err) {
    self.postMessage({ type: 'error', id, message: err?.message || String(err) });
  }
};
