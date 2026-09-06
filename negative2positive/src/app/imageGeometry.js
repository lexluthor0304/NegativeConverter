import { createImageCanvas } from './imageDataOps.js';

export function normalizeAngleDegrees(angle) {
  let normalized = Number.isFinite(angle) ? angle : 0;
  while (normalized > 180) normalized -= 360;
  while (normalized <= -180) normalized += 360;
  return normalized;
}

export function copyRotatedRgbaBuffer(source, width, height, angle) {
  const normalized = normalizeAngleDegrees(angle);
  const rightAngle = Math.round(normalized / 90) * 90;
  const dstWidth = Math.abs(rightAngle) === 90 ? height : width;
  const dstHeight = Math.abs(rightAngle) === 90 ? width : height;
  const output = source instanceof Uint16Array
    ? new Uint16Array(source.length)
    : new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let dstX;
      let dstY;
      if (rightAngle === 90) {
        dstX = height - 1 - y;
        dstY = x;
      } else if (rightAngle === -90) {
        dstX = y;
        dstY = width - 1 - x;
      } else {
        dstX = width - 1 - x;
        dstY = height - 1 - y;
      }

      const srcIdx = (y * width + x) * 4;
      const dstIdx = (dstY * dstWidth + dstX) * 4;
      output[dstIdx] = source[srcIdx];
      output[dstIdx + 1] = source[srcIdx + 1];
      output[dstIdx + 2] = source[srcIdx + 2];
      output[dstIdx + 3] = source[srcIdx + 3];
    }
  }

  return { width: dstWidth, height: dstHeight, data: output };
}

function copyMirroredRgbaBuffer(source, width, height) {
  const output = source instanceof Uint16Array
    ? new Uint16Array(source.length)
    : new Uint8ClampedArray(source.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = (y * width + (width - 1 - x)) * 4;
      output[dstIdx] = source[srcIdx];
      output[dstIdx + 1] = source[srcIdx + 1];
      output[dstIdx + 2] = source[srcIdx + 2];
      output[dstIdx + 3] = source[srcIdx + 3];
    }
  }

  return { width, height, data: output };
}

function attachTransformedImage16(target, sourceImageData, transform) {
  const source16 = sourceImageData?.__image16;
  if (!source16 || !(source16.data instanceof Uint16Array)) return target;
  target.__image16 = transform(source16.data, source16.width, source16.height);
  return target;
}

export function rotateImageDataRightAngle(imageData, angle) {
  const rotated = copyRotatedRgbaBuffer(imageData.data, imageData.width, imageData.height, angle);
  const result = new ImageData(rotated.data, rotated.width, rotated.height);
  return attachTransformedImage16(result, imageData, (data, width, height) => {
    const image16 = copyRotatedRgbaBuffer(data, width, height, angle);
    return { width: image16.width, height: image16.height, data: image16.data };
  });
}

export function mirrorImageDataHorizontal(imageData) {
  const mirrored = copyMirroredRgbaBuffer(imageData.data, imageData.width, imageData.height);
  const result = new ImageData(mirrored.data, mirrored.width, mirrored.height);
  return attachTransformedImage16(result, imageData, (data, width, height) => {
    const image16 = copyMirroredRgbaBuffer(data, width, height);
    return { width: image16.width, height: image16.height, data: image16.data };
  });
}

export function applyRotationToImageData(imageData, angle) {
  if (!imageData) return null;
  const normalized = normalizeAngleDegrees(Number(angle) || 0);
  if (Math.abs(normalized) < 0.001) return imageData;
  const rightAngle = Math.round(normalized / 90) * 90;
  if (Math.abs(normalized - rightAngle) < 0.001 && Math.abs(rightAngle) % 90 === 0) {
    return rotateImageDataRightAngle(imageData, rightAngle);
  }

  const rad = normalized * Math.PI / 180;
  const w = imageData.width;
  const h = imageData.height;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const newW = Math.max(1, Math.ceil(w * cos + h * sin));
  const newH = Math.max(1, Math.ceil(w * sin + h * cos));

  // A 2D canvas is 8-bit only, so straightening a RAW or 16-bit scan by a
  // non-right angle (which is what auto-frame does on nearly every frame)
  // used to throw the 16-bit plane away. Resample both planes here instead
  // when the source carries one, and derive the 8-bit view from the 16-bit
  // result so the two stay exactly consistent.
  const plane16 = imageData.__image16;
  if (
    plane16
    && plane16.data instanceof Uint16Array
    && plane16.width === w
    && plane16.height === h
    && plane16.data.length === imageData.data.length
  ) {
    return rotateImageDataArbitrary16(imageData, plane16, rad, newW, newH);
  }

  const srcCanvas = createImageCanvas();
  srcCanvas.width = w;
  srcCanvas.height = h;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  srcCtx.putImageData(imageData, 0, 0);

  const dstCanvas = createImageCanvas();
  dstCanvas.width = newW;
  dstCanvas.height = newH;
  const dstCtx = dstCanvas.getContext('2d', { willReadFrequently: true });
  dstCtx.translate(newW / 2, newH / 2);
  dstCtx.rotate(rad);
  dstCtx.drawImage(srcCanvas, -w / 2, -h / 2);

  return dstCtx.getImageData(0, 0, newW, newH);
}

// Bilinear inverse-map matching the canvas transform used above:
// translate(newW/2, newH/2) -> rotate(rad) -> drawImage(src, -w/2, -h/2).
function rotateImageDataArbitrary16(imageData, plane16, rad, newW, newH) {
  const w = imageData.width;
  const h = imageData.height;
  const src = plane16.data;
  const out16 = new Uint16Array(newW * newH * 4);
  const out8 = new Uint8ClampedArray(newW * newH * 4);
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const halfW = w / 2;
  const halfH = h / 2;

  for (let y = 0; y < newH; y++) {
    const v = y + 0.5 - newH / 2;
    for (let x = 0; x < newW; x++) {
      const u = x + 0.5 - newW / 2;
      // Source pixel-centre coordinates, shifted to array indices.
      const sx = halfW + u * cos + v * sin - 0.5;
      const sy = halfH - u * sin + v * cos - 0.5;
      if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) {
        continue; // outside the source: transparent, as the canvas path leaves it
      }

      const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(h - 1, Math.floor(sy)));
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, sx - x0));
      const fy = Math.max(0, Math.min(1, sy - y0));

      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const outIdx = (y * newW + x) * 4;

      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bottom = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        const value = Math.round(top + (bottom - top) * fy);
        const clamped = value < 0 ? 0 : (value > 65535 ? 65535 : value);
        out16[outIdx + c] = clamped;
        out8[outIdx + c] = clamped >>> 8;
      }
      out16[outIdx + 3] = 65535;
      out8[outIdx + 3] = 255;
    }
  }

  const result = new ImageData(out8, newW, newH);
  result.__image16 = { width: newW, height: newH, data: out16 };
  return result;
}
