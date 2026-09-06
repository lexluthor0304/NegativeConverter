// Synthetic 35mm strip scan used by filmEdgeReader.test.mjs and the smoke
// fixture generator (scripts/make-film-edge-fixture.mjs): light box, orange
// base, two perforation lanes, exposed frames, edge text blocks and ISO 1007
// DX edge barcodes with known content.

import { encodeDxDataBits } from '../src/app/filmEdgeReader.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const FILM_WIDTH_MM = 34.98;
const PITCH_MM = 4.75;
const HOLE_ALONG_MM = 1.98;
const HOLE_ACROSS_MM = 2.8;
const HOLE_MARGIN_MM = 2.0;

export function makeStrip({
  widthMm = 120,
  pxPerMm = 16,
  marginMm = 6,
  base = [215, 150, 95],
  bars = [70, 45, 30],
  lightBox = [250, 250, 250],
  frameDark = [120, 80, 55],
  dx = { dx1: 95, dx2: 7 },
  firstFrame = 30,
  noise = 4,
  polarity = 'dark'
} = {}) {
  const width = Math.round(widthMm * pxPerMm);
  const height = Math.round((FILM_WIDTH_MM + 2 * marginMm) * pxPerMm);
  const data = new Uint8ClampedArray(width * height * 4);
  const top = marginMm * pxPerMm;
  const bottom = top + FILM_WIDTH_MM * pxPerMm;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    const n = (rnd() - 0.5) * noise;
    data[i] = rgb[0] + n; data[i + 1] = rgb[1] + n; data[i + 2] = rgb[2] + n; data[i + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, rgb) => {
    for (let y = Math.round(y0); y < Math.round(y1); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) put(x, y, rgb);
  };
  fillRect(0, 0, width, height, lightBox);
  fillRect(0, top, width, bottom, base);
  // Exposed frames: 36 mm wide with 2 mm gaps between the perforation rows.
  const imageTop = top + 5.5 * pxPerMm;
  const imageBottom = bottom - 5.5 * pxPerMm;
  for (let x0 = 4; x0 < widthMm; x0 += 38) {
    for (let y = Math.round(imageTop); y < Math.round(imageBottom); y++) {
      for (let x = Math.round(x0 * pxPerMm); x < Math.round((x0 + 36) * pxPerMm); x++) {
        const t = ((x - x0 * pxPerMm) / (36 * pxPerMm) + (y - imageTop) / (imageBottom - imageTop)) / 2;
        put(x, y, [frameDark[0] + 60 * t, frameDark[1] + 40 * t, frameDark[2] + 30 * t]);
      }
    }
  }
  // Perforations (rounded rectangles) on both edges.
  const holeRect = (cx, cy) => {
    const hw = HOLE_ALONG_MM * pxPerMm / 2;
    const hh = HOLE_ACROSS_MM * pxPerMm / 2;
    const radius = Math.min(hw, hh) * 0.35;
    for (let y = Math.round(cy - hh); y < Math.round(cy + hh); y++) for (let x = Math.round(cx - hw); x < Math.round(cx + hw); x++) {
      const dx0 = Math.max(0, Math.abs(x - cx) - (hw - radius));
      const dy0 = Math.max(0, Math.abs(y - cy) - (hh - radius));
      if (dx0 * dx0 + dy0 * dy0 <= radius * radius) put(x, y, lightBox);
    }
  };
  for (let x = 2.5; x < widthMm; x += PITCH_MM) {
    holeRect(x * pxPerMm, top + (HOLE_MARGIN_MM + HOLE_ACROSS_MM / 2) * pxPerMm);
    holeRect(x * pxPerMm, bottom - (HOLE_MARGIN_MM + HOLE_ACROSS_MM / 2) * pxPerMm);
  }
  // Edge text blocks on the top rebate (stand-ins for "KODAK 400").
  const mark = polarity === 'light' ? [205, 195, 175] : bars;
  for (let x0 = 8; x0 < widthMm; x0 += 38) {
    let x = x0;
    for (let k = 0; k < 8; k++) {
      const w = 0.6 + (k % 3) * 0.4;
      fillRect(x * pxPerMm, top + 0.4 * pxPerMm, (x + w) * pxPerMm, top + 1.7 * pxPerMm, mark);
      x += w + 0.35;
    }
  }
  // DX codes on the bottom rebate every half frame (19 mm): clock 1.0-1.9 mm
  // from the edge, data 0.15-1.0 mm from the edge.
  const codes = [];
  const moduleMm = 13 / 31;
  let frame = firstFrame;
  let half = false;
  for (let x0 = 6; x0 + 13 < widthMm; x0 += 19) {
    const bits = encodeDxDataBits({ ...dx, frameNumber: frame, halfFrame: half });
    const clockModules = [1, 1, 1, 1, 1];
    for (let k = 0; k < 23; k++) clockModules.push(k % 2 === 0 ? 0 : 1);
    clockModules.push(1, 1, 1);
    const dataModules = [1, 0, 1, 0, 1, ...bits, 1, 0, 1];
    for (let m = 0; m < 31; m++) {
      const xa = (x0 + m * moduleMm) * pxPerMm;
      const xb = (x0 + (m + 1) * moduleMm) * pxPerMm;
      if (clockModules[m]) fillRect(xa, bottom - 1.9 * pxPerMm, xb, bottom - 1.0 * pxPerMm, mark);
      if (dataModules[m]) fillRect(xa, bottom - 1.0 * pxPerMm, xb, bottom - 0.15 * pxPerMm, mark);
    }
    codes.push({ frameNumber: frame, halfFrame: half, xMm: x0 + 6.5 });
    if (half) frame++;
    half = !half;
  }
  return { image: new ImageData(data, width, height), codes, pxPerMm, base };
}

