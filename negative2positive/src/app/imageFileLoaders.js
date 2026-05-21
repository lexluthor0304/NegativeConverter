import { fromImageData8 } from '../silvercore/util/image16.js';

export const RAW_LIKE_EXTENSIONS = [
  '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.dng', '.raf', '.raw', '.rw2',
  '.pef', '.srw', '.3fr', '.mef', '.orf', '.rwl', '.iiq', '.x3f', '.mrw', '.kdc',
  '.dcr', '.tif', '.tiff'
];

export function isRawLikeFileName(fileName) {
  const normalized = String(fileName || '').toLowerCase();
  return RAW_LIKE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

export async function loadRawImageData(buffer, fileName, options) {
  const { loadRawFile } = await import('./rawFileLoader.js');
  return loadRawFile(buffer, fileName, options);
}

export async function loadPngImageData(buffer) {
  const { loadPngFile } = await import('./pngFileLoader.js');
  return loadPngFile(buffer);
}

export async function loadStandardImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let objectUrl = null;

    img.onload = () => {
      try {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = img.width;
        tempCanvas.height = img.height;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(img, 0, 0);
        const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
        imageData.__image16 = fromImageData8(imageData);
        resolve(imageData);
      } catch (err) {
        reject(err);
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    };

    img.onerror = (err) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(err);
    };

    objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
  });
}
