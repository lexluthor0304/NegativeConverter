// This is a display histogram, independent from the full-precision conversion
// analysis. Stratified sampling bounds redraw work even for very large scans.
export const HISTOGRAM_MAX_SAMPLES = 262144;

export function fillHistogramBins(imageData, bins, maxSamples = HISTOGRAM_MAX_SAMPLES) {
  const source = imageData.__image16?.data instanceof Uint16Array ? imageData.__image16 : imageData;
  const { data, width, height } = source;
  const is16 = data instanceof Uint16Array;
  const { rHist, gHist, bHist, lHist } = bins;
  rHist.fill(0); gHist.fill(0); bHist.fill(0); lHist.fill(0);
  if (!width || !height || !data.length) return 0;
  maxSamples = Math.max(1, Math.floor(maxSamples));
  const step = Math.max(1, Math.ceil(Math.sqrt(width * height / maxSamples)));
  const columns = Math.max(1, Math.min(maxSamples, Math.floor(width / step)));
  const rows = Math.max(1, Math.min(Math.floor(height / step), Math.floor(maxSamples / columns)));
  for (let y = 0; y < rows; y++) {
    const sy = Math.floor((y + 0.5) * height / rows);
    for (let x = 0; x < columns; x++) {
      const sx = Math.floor((x + 0.5) * width / columns);
      const i = (sy * width + sx) * 4;
      const r = is16 ? data[i] >>> 8 : data[i];
      const g = is16 ? data[i + 1] >>> 8 : data[i + 1];
      const b = is16 ? data[i + 2] >>> 8 : data[i + 2];
      rHist[r]++; gHist[g]++; bHist[b]++;
      lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
    }
  }
  return columns * rows;
}

export class Histogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.rHist = new Uint32Array(256);
    this.gHist = new Uint32Array(256);
    this.bHist = new Uint32Array(256);
    this.lHist = new Uint32Array(256);
  }

  draw(imageData) {
    if (!imageData) return;
    const { rHist, gHist, bHist, lHist } = this;
    fillHistogramBins(imageData, this);

    // Find max for scaling (ignore extremes)
    let maxVal = 0;
    for (let i = 2; i < 254; i++) {
      maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i], lHist[i]);
    }
    if (maxVal <= 0) {
      for (let i = 0; i < 256; i++) {
        maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i], lHist[i]);
      }
    }

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);
    if (maxVal <= 0) return;

    // Draw channels
    const channels = [
      { hist: rHist, color: 'rgba(255,80,80,0.5)' },
      { hist: gHist, color: 'rgba(80,255,80,0.5)' },
      { hist: bHist, color: 'rgba(80,80,255,0.5)' },
      { hist: lHist, color: 'rgba(200,200,200,0.4)' },
    ];

    for (const ch of channels) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * w;
        const y = h - (ch.hist[i] / maxVal) * h;
        ctx.lineTo(x, Math.max(0, y));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = ch.color;
      ctx.fill();
    }
  }
}
