// The OpenCV build's speed in the auto-frame worker (#292): the import
// detection of real RAW files, in Chrome, on the build the page chose
// (NC_OPENCV_SIMD=0 for the scalar build). Opt-in, real files (never in the
// repo), numbers only:
//   OPENCV_BENCH_RAW=/abs/a.dng:/abs/b.dng [OPENCV_BENCH_RUNS=3] \
//     npm run test:smoke -- --opencv-bench-only
// Each file is decoded once (the 8-bit preview decode of the RAW regression
// step), then handed to the shared auto-frame worker as an owned import
// request `OPENCV_BENCH_RUNS` times after a warm-up; the medians of the round
// trip and of the worker's stageMs (window, previewCandidates, anglePasses,
// preview) are printed as one JSON row per file.
export async function runOpenCvAutoFrameBenchSmoke({ send, evaluate, waitFor, fail, port }) {
  const files = (process.env.OPENCV_BENCH_RAW || '').split(':').filter(Boolean);
  if (!files.length) fail('OPENCV_BENCH_RAW=/abs/a.dng:/abs/b.nef names the RAW files to time');
  const runs = Math.max(1, Number(process.env.OPENCV_BENCH_RUNS) || 3);
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('opencv bench boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncIsolation?.opencv`);
  const build = await evaluate(`window.__ncIsolation.opencv()`);
  console.log('opencv bench build:', JSON.stringify(build));
  await evaluate(`(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'opencvBenchInput'; input.hidden = true; document.body.append(input);
  })()`);
  const rows = [];
  for (const path of files) {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#opencvBenchInput' });
    await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [path] });
    const row = await evaluate(`(async () => {
      const { loadRawFile } = await import('/src/app/rawFileLoader.js');
      const { analyzeFrameInWorker } = await import('/src/app/autoFrameWorkerClient.js');
      const file = document.getElementById('opencvBenchInput').files[0];
      const decodeStart = performance.now();
      let raw = await loadRawFile(await file.arrayBuffer(), file.name, { preview: true, outputBps: 8 });
      const decodeMs = performance.now() - decodeStart;
      const frame = { settings: { marginRatio: .02, formatPreference: 'auto', filmType: 'color', neutralLineSearch: true, minConfidence: .55, highConfidence: .72 }, maxSide: 1600, rotatedOutput: 'none' };
      const samples = [];
      for (let i = 0; i <= ${runs}; i++) {
        const start = performance.now();
        const outcome = await analyzeFrameInWorker.analyzeImport(raw, { owned: true, frame });
        const ms = performance.now() - start;
        if (outcome.frameError) throw outcome.frameError;
        if (outcome.imageLost) throw new Error('the transferred planes did not come back');
        raw = outcome.image;
        if (i > 0) samples.push({ ms, stageMs: outcome.frame?.stageMs || {}, result: outcome.frame });
      }
      const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
      const stage = (key) => Math.round(median(samples.map(s => Number(s.stageMs[key]) || 0)));
      const last = samples.at(-1).result;
      return {
        file: file.name, size: [raw.width, raw.height], decodeMs: Math.round(decodeMs), runs: samples.length,
        roundTripMs: Math.round(median(samples.map(s => s.ms))),
        window: stage('window'), previewCandidates: stage('previewCandidates'), anglePasses: stage('anglePasses'), preview: stage('preview'),
        helpers: samples.at(-1).stageMs.helpers ?? null,
        method: last?.diagnostics?.method ?? null, angle: last?.angle ?? null, confidenceLevel: last?.confidenceLevel ?? null,
        crop: last?.cropRegion ?? null, requiresReview: last?.requiresReview ?? null
      };
    })()`);
    rows.push(row);
    console.log('opencv bench:', JSON.stringify(row));
  }
  console.log('opencv bench summary:', JSON.stringify({ variant: build.variant, simdSupported: build.simdSupported, forced: build.forced, runs, rows }));
}
