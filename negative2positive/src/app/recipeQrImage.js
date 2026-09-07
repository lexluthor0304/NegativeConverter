// Loaded only when an image is selected; no camera or native barcode API required.
import jsQR from 'jsqr';
import { extractRecipeCode } from './recipes.js';

export function readRecipeQrPixels({ data, width, height }) {
  const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
  return extractRecipeCode(result?.data);
}

export async function readRecipeQrImage(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('size');
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('image'));
      image.src = url;
    });
    // Try a bounded full-resolution pass and a smaller pass for large screenshots.
    for (const limit of [2400, 1200]) {
      const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const code = readRecipeQrPixels(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (code) return code;
      if (scale === 1) break;
    }
    return '';
  } finally {
    image.src = '';
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 1;
  }
}
