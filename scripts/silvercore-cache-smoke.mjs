// #238 in Chrome: a slider drag through a fresh conversion worker, with the preview
// worker's contract (cached source and analysis sample), in B&W, positive and colour
// mode with pre-saturation 120 and dodge-and-burn strokes. The worker takes the
// prepared-plane, grey-table and packed-store paths; every tick must equal the frozen
// 1703835 adapter's forced conversion of the same frame, 16-bit and 8-bit.
export async function runSilverCoreCacheSmoke({ evaluate, fail }) {
  const result = await evaluate(`(async () => {
    const oracle = await import('/src/pipeline/oracle/silverAdapter.oracle.js');
    const W = 640, H = 480;
    const frame = (seed) => {
      const data = new Uint16Array(W * H * 4);
      for (let p = 0; p < W * H; p++) {
        const x = p % W, y = (p / W) | 0, t = (x / W + y / H) / 2;
        data[p * 4] = 46000 - 22000 * t + ((x * 37 + y * 11 * seed) % 3000);
        data[p * 4 + 1] = 32000 - 16000 * t + ((x * 13 + y * 29) % 2500);
        data[p * 4 + 2] = 21000 - 10000 * t + ((x * 7 + y * 41) % 1800);
        data[p * 4 + 3] = (x < 8 && y < 8) ? 0 : 65535;
      }
      return { width: W, height: H, data };
    };
    const slide = () => {
      const data = new Uint16Array(W * H * 4);
      for (let p = 0; p < W * H; p++) {
        const x = p % W, y = (p / W) | 0, v = 0.25 + 0.75 * (x / W + y / H) / 2;
        const c = (x * 7 + y * 3) % 11 === 0 ? [v * 0.9, v * 0.5, v * 0.2] : [v, v, v];
        data.set([Math.min(65535, Math.round(c[0] * 1.1 * 65535)), Math.round(c[1] * 65535), Math.round(c[2] * 0.9 * 65535), 65535], p * 4);
      }
      return { width: W, height: H, data };
    };
    const crop = (image) => {
      const w = 320, h = 240, data = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++) data.set(image.data.subarray(((y + 120) * W + 160) * 4, ((y + 120) * W + 160 + w) * 4), y * w * 4);
      return { width: w, height: h, data };
    };
    const strokes = {
      localExposure: { strokes: [{ stops: 0.8, size: 0.3, feather: 0.5, points: [{ x: 0.3, y: 0.4, p: 1 }, { x: 0.6, y: 0.6, p: 0.8 }] }] },
      localExposureGeometry: { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false },
    };
    const worker = new Worker('/src/workers/conversionWorker.js', { type: 'module' });
    let nextId = 0;
    const ask = (message) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const onMessage = (event) => {
        if (event.data?.id !== id) return;
        worker.removeEventListener('message', onMessage);
        if (event.data.type === 'result') resolve(event.data); else reject(new Error(event.data.message));
      };
      worker.addEventListener('message', onMessage);
      worker.postMessage({ ...message, id });
    });
    const firstDiff = (a, b) => {
      if (a.length !== b.length) return 'length ' + a.length + ' vs ' + b.length;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
      return -1;
    };
    const CONVERT = { color: 'convertColorWithSilverCore', bw: 'convertBwWithSilverCore', positive: 'convertPositiveWithSilverCore' };
    const report = [];
    try {
      for (const mode of ['bw', 'positive', 'color']) {
        const source = mode === 'positive' ? slide() : frame(3);
        const reference = crop(source);
        const base = { filmType: mode, colorModel: 'standard', positiveMode: 'correct', preSaturation: 120, saturation: 100, ...strokes,
          ...(mode === 'color' ? { filmBase: { r: 210, g: 140, b: 90 } } : {}) };
        const times = [];
        for (let k = 0; k < 8; k++) {
          const settings = { ...base, brightness: k * 6 - 20 };
          const first = k === 0;
          const message = { type: 'convert', cacheInput: true, reuseSource: !first, reuseAnalysis: !first, width: W, height: H, settings,
            options: { preview: true, includeAnalysisPreview: false, ...(first ? { analysisImageData: reference } : {}) } };
          if (first) message.image16 = source.data.slice().buffer;
          const started = performance.now();
          const reply = await ask(message);
          times.push(performance.now() - started);
          const expected = await oracle[CONVERT[mode]](source, settings, { forceFullProcess: true, analysisImageData: reference, includeAnalysisPreview: false });
          const diff16 = firstDiff(new Uint16Array(reply.image16), expected.__image16.data);
          const diff8 = firstDiff(new Uint8Array(reply.rgba), new Uint8Array(expected.data.buffer));
          if (diff16 !== -1 || diff8 !== -1) return { ok: false, mode, tick: k, diff16, diff8 };
        }
        times.sort((a, b) => a - b);
        report.push({ mode, ticks: times.length, medianMs: Math.round(times[times.length >> 1] * 10) / 10 });
      }
    } finally {
      worker.terminate();
      oracle.invalidateSilverCoreCache();
    }
    return { ok: true, report };
  })()`);
  if (!result?.ok) fail('SilverCore worker ticks differ from the 1703835 adapter: ' + JSON.stringify(result));
  console.log('ok: SilverCore worker drag (prepared planes, grey table) identical to 1703835 ' + JSON.stringify(result.report));
}
