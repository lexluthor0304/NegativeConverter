export function downsampleImageDataByStep(imageData, step) {
  const { width, height, data } = imageData;
  const outW = Math.max(1, Math.floor(width / step));
  const outH = Math.max(1, Math.floor(height / step));
  const out = new ImageData(new Uint8ClampedArray(outW * outH * 4), outW, outH);
  const outData = out.data;
  const srcRowStride = width * 4;
  const dstRowStride = outW * 4;
  const srcStep = step * 4;

  for (let y = 0; y < outH; y++) {
    const srcRow = Math.min(height - 1, y * step) * srcRowStride;
    let srcIdx = srcRow;
    let dstIdx = y * dstRowStride;
    for (let x = 0; x < outW; x++) {
      outData[dstIdx] = data[srcIdx];
      outData[dstIdx + 1] = data[srcIdx + 1];
      outData[dstIdx + 2] = data[srcIdx + 2];
      outData[dstIdx + 3] = 255;
      srcIdx += srcStep;
      dstIdx += 4;
    }
  }

  return out;
}

export function downsampleImageDataForMaxPixels(imageData, maxPixels) {
  if (!imageData) return null;
  const totalPixels = imageData.width * imageData.height;
  if (totalPixels <= maxPixels) return imageData;
  return downsampleImageDataByStep(imageData, Math.ceil(Math.sqrt(totalPixels / maxPixels)));
}

export function downsampleImageDataForMaxDim(imageData, maxDim) {
  if (!imageData) return null;
  const scale = Math.max(imageData.width / maxDim, imageData.height / maxDim, 1);
  const step = Math.ceil(scale);
  return step <= 1 ? imageData : downsampleImageDataByStep(imageData, step);
}

export function resizeImageDataToMaxSide(imageData, maxSide) {
  if (!imageData) return null;
  const longest = Math.max(imageData.width, imageData.height);
  if (longest <= maxSide) return imageData;

  const scale = maxSide / longest;
  const targetW = Math.max(1, Math.round(imageData.width * scale));
  const targetH = Math.max(1, Math.round(imageData.height * scale));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imageData.width;
  srcCanvas.height = imageData.height;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.putImageData(imageData, 0, 0);

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = targetW;
  dstCanvas.height = targetH;
  const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
  dstCtx.drawImage(srcCanvas, 0, 0, targetW, targetH);
  return dstCtx.getImageData(0, 0, targetW, targetH);
}

export function cropImageDataRegion(imageData, cropRegion) {
  const { left, top, width, height } = cropRegion;
  const croppedData = new ImageData(
    new Uint8ClampedArray(width * height * 4),
    width,
    height
  );

  const srcData = imageData.data;
  const dstData = croppedData.data;
  const rowLength = width * 4;
  for (let y = 0; y < height; y++) {
    const srcRow = ((top + y) * imageData.width + left) * 4;
    const dstRow = y * rowLength;
    dstData.set(srcData.subarray(srcRow, srcRow + rowLength), dstRow);
    for (let alpha = dstRow + 3; alpha < dstRow + rowLength; alpha += 4) {
      dstData[alpha] = 255;
    }
  }

  const src16 = imageData.__image16;
  if (src16 && src16.data instanceof Uint16Array) {
    const dst16 = new Uint16Array(width * height * 4);
    const srcW = imageData.width;
    const row16Length = width * 4;
    for (let y = 0; y < height; y++) {
      const srcRow = ((top + y) * srcW + left) * 4;
      const dstRow = y * row16Length;
      dst16.set(src16.data.subarray(srcRow, srcRow + row16Length), dstRow);
    }
    croppedData.__image16 = { width, height, data: dst16 };
  }

  return croppedData;
}
