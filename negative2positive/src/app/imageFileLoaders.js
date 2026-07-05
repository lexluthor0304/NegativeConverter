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

export async function loadRawImageDataPreview(buffer, fileName, options) {
  const { loadRawFile } = await import('./rawFileLoader.js');
  return loadRawFile(buffer, fileName, { ...options, preview: true });
}

export async function loadPngImageData(buffer) {
  const { loadPngFile } = await import('./pngFileLoader.js');
  return loadPngFile(buffer);
}

// No eager __image16 in either path below: an 8-bit source holds no extra
// precision, and silverAdapter promotes to 16-bit on demand — on the cropped
// region instead of the full scan. For a 90+ MP scan the eager mirror cost
// ~750 MB and a 370M-iteration loop at load time.

function imageSourceToImageData(source, width, height) {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = width;
  tempCanvas.height = height;
  // willReadFrequently keeps the canvas on the CPU, so the immediate
  // getImageData below avoids a GPU readback of the whole scan.
  const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
  tempCtx.drawImage(source, 0, 0);
  return tempCtx.getImageData(0, 0, width, height);
}

export async function loadStandardImage(file) {
  // Preferred path: createImageBitmap decodes off the main thread.
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        return imageSourceToImageData(bitmap, bitmap.width, bitmap.height);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall through to the <img> path (unsupported format edge cases).
    }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    let objectUrl = null;

    img.onload = () => {
      try {
        resolve(imageSourceToImageData(img, img.width, img.height));
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
