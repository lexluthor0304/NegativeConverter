import opencvScriptUrl from '@techstark/opencv-js/dist/opencv.js?url';
import { detectFrameAndRotation } from '../app/autoFrameAnalyzer.js';
import { applyRotationToImageData } from '../app/imageGeometry.js';

let ready;
async function loadCv() {
  if (!ready) ready = (async () => {
    await import(/* @vite-ignore */ opencvScriptUrl);
    globalThis.cv = await globalThis.cv;
    if (!globalThis.cv?.Mat) throw new Error('OpenCV worker initialization failed');
  })();
  return ready;
}

self.onmessage = async ({ data: message }) => {
  try {
    await loadCv();
    const image = new ImageData(message.rgba, message.width, message.height);
    if (message.image16) image.__image16 = { width: image.width, height: image.height, data: message.image16 };
    const result = detectFrameAndRotation(image, { ...message.options, rotateImageData: applyRotationToImageData });
    const transfers = [];
    if (result?.rotatedImageData) {
      // ImageDataの拡張プロパティはstructured cloneに含まれないため明示する。
      const rotated = result.rotatedImageData;
      result.rotatedImageData = { width: rotated.width, height: rotated.height, data: rotated.data, image16: rotated.__image16?.data };
      transfers.push(rotated.data.buffer);
      if (rotated.__image16) transfers.push(rotated.__image16.data.buffer);
    }
    self.postMessage({ id: message.id, result }, transfers);
  } catch (error) {
    self.postMessage({ id: message.id, error: String(error?.message || error) });
  }
};
