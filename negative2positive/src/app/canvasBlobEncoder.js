export function canvasToBlobWithType(targetCanvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    targetCanvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to render export image.'));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

function releaseCanvasBackingStore(targetCanvas) {
  // A full-resolution export can pin hundreds of MB in the canvas backing store
  // for the rest of the session. Reallocating on the next export is cheap
  // compared with putImageData + encode. toBlob() has already snapshotted the
  // bitmap by the time its promise settles, so this is safe.
  try {
    targetCanvas.width = 0;
    targetCanvas.height = 0;
  } catch {
    // Nothing actionable if the canvas refuses to shrink.
  }
}

export function createImageDataCanvasBlobEncoder() {
  const sharedCanvas = document.createElement('canvas');
  let sharedCanvasBusy = false;

  return async function imageDataToCanvasBlob(imageData, mimeType, quality) {
    const reuseSharedCanvas = !sharedCanvasBusy;
    const targetCanvas = reuseSharedCanvas ? sharedCanvas : document.createElement('canvas');
    if (reuseSharedCanvas) sharedCanvasBusy = true;

    try {
      if (targetCanvas.width !== imageData.width) targetCanvas.width = imageData.width;
      if (targetCanvas.height !== imageData.height) targetCanvas.height = imageData.height;
      const targetCtx = targetCanvas.getContext('2d');
      if (!targetCtx) {
        // Happens when the requested size exceeds the browser's canvas limit.
        throw new Error('Failed to render export image.');
      }
      targetCtx.putImageData(imageData, 0, 0);
      return await canvasToBlobWithType(targetCanvas, mimeType, quality);
    } finally {
      releaseCanvasBackingStore(targetCanvas);
      if (reuseSharedCanvas) sharedCanvasBusy = false;
    }
  };
}
