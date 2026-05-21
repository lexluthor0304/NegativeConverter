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
      targetCtx.putImageData(imageData, 0, 0);
      return await canvasToBlobWithType(targetCanvas, mimeType, quality);
    } finally {
      if (reuseSharedCanvas) sharedCanvasBusy = false;
    }
  };
}
