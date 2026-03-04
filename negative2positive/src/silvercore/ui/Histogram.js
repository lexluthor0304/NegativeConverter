export class Histogram {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
  }

  draw(imageData) {
    const { data } = imageData;
    const rHist = new Uint32Array(256);
    const gHist = new Uint32Array(256);
    const bHist = new Uint32Array(256);
    const lHist = new Uint32Array(256);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      rHist[r]++;
      gHist[g]++;
      bHist[b]++;
      // Luminance
      lHist[Math.round(0.299 * r + 0.587 * g + 0.114 * b)]++;
    }

    // Find max for scaling (ignore extremes)
    let maxVal = 0;
    for (let i = 2; i < 254; i++) {
      maxVal = Math.max(maxVal, rHist[i], gHist[i], bHist[i], lHist[i]);
    }

    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    ctx.clearRect(0, 0, w, h);

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
