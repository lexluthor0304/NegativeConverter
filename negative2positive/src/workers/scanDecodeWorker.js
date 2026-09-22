import { loadPngFile } from '../app/pngFileLoader.js';
import { decodeTiffBuffer } from '../app/tiffFileLoader.js';

self.onmessage = ({ data: { buffer, format } }) => {
  try {
    const result = format === 'png' ? loadPngFile(buffer) : decodeTiffBuffer(buffer);
    const image16 = result.__image16;
    const transfers = [result.data.buffer];
    if (image16) transfers.push(image16.data.buffer);
    self.postMessage({ width: result.width, height: result.height, data: result.data, image16 }, transfers);
  } catch (error) {
    self.postMessage({ error: error.message || String(error), code: error.code });
  }
};
self.postMessage({ ready: true });
