const HISTOGRAM_BINS = 256;

export class HistogramService {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rHist = new Uint32Array(HISTOGRAM_BINS);
    this.gHist = new Uint32Array(HISTOGRAM_BINS);
    this.bHist = new Uint32Array(HISTOGRAM_BINS);
    this.lHist = new Uint32Array(HISTOGRAM_BINS);
  }

  resizeToDisplaySize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round((this.canvas.offsetWidth || this.canvas.clientWidth || 300) * dpr));
    const h = Math.max(1, Math.round((this.canvas.offsetHeight || this.canvas.clientHeight || 150) * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  draw(imageData) {
    if (!imageData) return;
    const { w, h } = this.resizeToDisplaySize();

    // Prefer the attached 16-bit handle when available (loaders + SilverCore output
    // attach __image16). Falls back to the 8-bit ImageData.data otherwise.
    const source = imageData.__image16 && imageData.__image16.data instanceof Uint16Array
      ? imageData.__image16
      : imageData;
    const { data } = source;
    const is16 = data instanceof Uint16Array;

    this.rHist.fill(0);
    this.gHist.fill(0);
    this.bHist.fill(0);
    this.lHist.fill(0);

    if (is16) {
      // 16-bit input → 256-bin via >>8 indexing. Keeps bin count stable for the
      // rendering code below; precision gain comes from the 16-bit pixel domain
      // itself (visible on smooth gradients without re-quantization).
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i] >>> 8;
        const g = data[i + 1] >>> 8;
        const b = data[i + 2] >>> 8;
        this.rHist[r]++;
        this.gHist[g]++;
        this.bHist[b]++;
        this.lHist[(r * 77 + g * 150 + b * 29) >> 8]++;
      }
    } else {
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        this.rHist[r]++;
        this.gHist[g]++;
        this.bHist[b]++;
        this.lHist[(r * 77 + g * 150 + b * 29) >> 8]++;
      }
    }

    let maxVal = 0;
    for (let i = 2; i < 254; i++) {
      maxVal = Math.max(maxVal, this.rHist[i], this.gHist[i], this.bHist[i], this.lHist[i]);
    }
    if (maxVal <= 0) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    const channels = [
      { hist: this.lHist, color: 'rgba(200,200,200,0.24)', stroke: 'rgba(230,230,230,0.45)' },
      { hist: this.rHist, color: 'rgba(255,80,80,0.2)', stroke: 'rgba(255,110,110,0.7)' },
      { hist: this.gHist, color: 'rgba(80,255,120,0.2)', stroke: 'rgba(120,245,145,0.7)' },
      { hist: this.bHist, color: 'rgba(90,160,255,0.2)', stroke: 'rgba(135,200,255,0.72)' },
    ];

    for (const ch of channels) {
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < HISTOGRAM_BINS; i++) {
        const x = (i / 255) * w;
        const y = h - (ch.hist[i] / maxVal) * h;
        ctx.lineTo(x, Math.max(0, y));
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fillStyle = ch.color;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < HISTOGRAM_BINS; i++) {
        const x = (i / 255) * w;
        const y = h - (ch.hist[i] / maxVal) * h;
        if (i === 0) ctx.moveTo(x, Math.max(0, y));
        else ctx.lineTo(x, Math.max(0, y));
      }
      ctx.strokeStyle = ch.stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
