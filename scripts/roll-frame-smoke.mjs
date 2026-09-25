// #252 in a real browser (always on, synthetic, about a second):
//
// 1. OpenCV compiled once (part 5): the app's auto-frame worker instantiated
//    the page's compiled WebAssembly.Module; a fresh worker realm reports its
//    time to cv.Mat from its script's first statement; the page fetched the
//    split wasm at most once and never the 13 MB package script itself.
// 2. The roll-frame worker (part 2) against the lane sequence it replaces,
//    on a synthetic LibRaw result: the #232 post-decode steps on the page,
//    then one #251 import request on a copy of the 8-bit plane in an
//    auto-frame worker (both previews come from a worker's OffscreenCanvas),
//    then the roll sample from the base. Statistics, detection, film edge and
//    the sample's planes must be identical, and the LibRaw buffer is moved.
// 3. The parallel foreground detector (part 4): the app's shared worker with
//    its two helpers against a plain worker without them, on a window frame
//    and on one that takes the fallback: identical results, with the helpers
//    having run units or passes.
export async function runRollFrameSmoke({ evaluate, fail }) {
  const result = await evaluate(`(async () => {
    const { createAutoFrameWorkerClient, analyzeFrameInWorker, warmUpAutoFrameWorker } = await import('/src/app/autoFrameWorkerClient.js');
    const { createRollFramePool, imageFromRollPlanes } = await import('/src/app/rollFrameWorkerClient.js');
    const { runRawPostDecode } = await import('/src/app/rawPostDecode.js');
    const { buildRollSample, rollSampleSettings } = await import('/src/app/rollSample.js');
    const hex = async view => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(view.buffer, view.byteOffset, view.byteLength)))].map(b => b.toString(16).padStart(2, '0')).join('');
    const strip = detection => { if (!detection) return detection; const { stageMs, rotatedImageData, ...rest } = detection; return JSON.stringify(rest); };
    const out = {};

    // 1. OpenCV realms.
    const fresh = createAutoFrameWorkerClient();
    const warmed = await fresh({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, {}, 'warm-up');
    fresh.dispose();
    const shared = await analyzeFrameInWorker({ width: 1, height: 1, data: new Uint8ClampedArray(4) }, {}, 'warm-up');
    const resources = performance.getEntriesByType('resource').map(entry => entry.name);
    out.opencv = {
      fresh: warmed.opencv, shared: shared.opencv,
      wasmFetches: resources.filter(name => /\\/@opencv-assets\\/opencv-[0-9a-f]+\\.wasm/.test(name)).length,
      // The app's own requests: the smoke's comparison realm loads the package via /@fs/.
      packageScript: resources.filter(name => /opencv\\.js(\\?|$)/.test(name) && !name.includes('/@fs/')).length
    };

    // 2. A synthetic LibRaw result: a tilted dark 3:2 frame on an orange base.
    const width = 1500, height = 1000, degrees = 2.5, rad = degrees * Math.PI / 180;
    const data = new Uint16Array(width * height * 3);
    let s = 11;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = x - width / 2, dy = y - height / 2;
      const u = dx * Math.cos(rad) + dy * Math.sin(rad), v = -dx * Math.sin(rad) + dy * Math.cos(rad);
      const rgb = Math.abs(u) < width * 0.3 && Math.abs(v) < width * 0.2 ? [95, 55, 30] : [238, 160, 100];
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = Math.min(65535, rgb[c] * 257 + Math.floor(rnd() * 400));
    }
    const result = { width, height, bits: 16, colors: 3, data };
    const frameOptions = { settings: { highConfidence: 0.72, minConfidence: 0.55, marginRatio: 0.02, filmType: 'color', formatPreference: 'auto' }, maxSide: 1600, rotatedOutput: 'none' };
    const postOptions = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };
    const choice = { automatic: true };

    const outcome = runRawPostDecode({ ...result, data: data.slice() }, postOptions);
    const base = imageFromRollPlanes({ width, height, rgba8: outcome.rgba8, rgba16: outcome.rgba16, filmStats: outcome.filmStats });
    const lane = createAutoFrameWorkerClient();
    const frameFilmType = outcome.filmStats.filmType.filmType;
    const analysed = await lane.analyzeImport(base, { frame: { ...frameOptions, frameFilmType }, filmEdge: {}, owned: false });
    lane.dispose();
    const recipe = detection => detection?.cropRegion ? { rotationAngle: detection.angle, mirrored: false, cropRegion: detection.cropRegion,
      autoFrameMeta: { imageArea: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }] } } : { mirrored: true };
    const settings = recipe(analysed.frame);
    const headSample = buildRollSample(base, settings, { tileMax: 288 });

    const pool = createRollFramePool({ size: 1 });
    pool.warm(1);
    const adapter = pool.frame({ options: { frame: frameOptions, filmTypeChoice: choice, filmEdge: true } });
    const input = { ...result, data: data.slice() };
    const started = performance.now();
    const held = await adapter.run(input, postOptions);
    const workerMs = Math.round(performance.now() - started);
    const moved = input.data.buffer.byteLength === 0;
    const { sample } = await adapter.held.sample(rollSampleSettings(settings), { tileMax: 288 });
    pool.dispose();
    const planes = async value => [await hex(value.data), value.__image16 ? await hex(value.__image16.data) : null];
    out.roll = {
      held: held.held === true, moved, workerMs, found: Boolean(analysed.frame?.cropRegion), angle: analysed.frame?.angle ?? null,
      filmStats: JSON.stringify(adapter.analysis.filmStats) === JSON.stringify(outcome.filmStats),
      detection: strip(adapter.analysis.detection) === strip(analysed.frame),
      edge: JSON.stringify(adapter.analysis.edge) === JSON.stringify(analysed.filmEdge),
      sample: JSON.stringify(await planes(sample)) === JSON.stringify(await planes(headSample)),
      tile: JSON.stringify(await planes(sample.__tileWorking)) === JSON.stringify(await planes(headSample.__tileWorking)),
      reference: (sample.__analysisReference && await hex(sample.__analysisReference.data)) === (headSample.__analysisReference && await hex(headSample.__analysisReference.data))
    };

    // 3. The parallel detector: the shared worker with helpers vs a plain one.
    const plain = createAutoFrameWorkerClient();
    const frames = {
      window: base,
      outline: (() => {
        const w = 1200, h = 820, image = new ImageData(w, h);
        const r = 2 * Math.PI / 180, fw = w * 0.55, fh = fw / 1.5;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const dx = x - w / 2, dy = y - h / 2, u = dx * Math.cos(r) + dy * Math.sin(r), v = -dx * Math.sin(r) + dy * Math.cos(r);
          const edge = Math.min(fw / 2 - Math.abs(u), fh / 2 - Math.abs(v));
          const rgb = Math.abs(edge) < 2.5 ? [60, 40, 30] : [238, 160, 100];
          image.data.set([...rgb, 255], (y * w + x) * 4);
        }
        return image;
      })()
    };
    out.parallel = {};
    await warmUpAutoFrameWorker({ helpers: true });
    for (const [name, image] of Object.entries(frames)) {
      analyzeFrameInWorker.warmHelpers();
      // A 400 px preview makes the outline miss the window search and take
      // the fallback over several angles, as in autoFrameParallel.test.
      const options = { ...frameOptions, rotatedOutput: 'full', ...(name === 'outline' ? { maxSide: 400 } : {}) };
      const withHelpers = await analyzeFrameInWorker(image, options, 'analyze-frame');
      const serial = await plain(image, options, 'analyze-frame');
      const stage = withHelpers?.stageMs || {};
      out.parallel[name] = {
        equal: strip(withHelpers) === strip(serial), helpers: stage.helpers === true,
        remote: Object.values(stage.units || {}).filter(unit => unit.where !== 'a').length + (stage.passes || []).filter(pass => pass.where !== 'a').length,
        method: serial?.diagnostics?.method || null, angleCount: stage.angleCount || 0, units: stage.units, passes: (stage.passes || []).length
      };
    }
    plain.dispose();
    out.parallel.helpersAlive = analyzeFrameInWorker.helpersAlive;
    return out;
  })()`);
  console.log('roll frame / OpenCV:', JSON.stringify(result));
  const { opencv, roll, parallel } = result;
  if (!opencv.shared?.sharedModule || !opencv.fresh?.sharedModule) fail('an OpenCV worker compiled the wasm itself instead of instantiating the page\'s module: ' + JSON.stringify(opencv));
  if (opencv.wasmFetches > 1) fail('the page fetched the OpenCV wasm more than once: ' + JSON.stringify(opencv));
  if (opencv.packageScript) fail('the app requested the 13 MB opencv.js: ' + JSON.stringify(opencv));
  if (!roll.found) fail('the roll-frame smoke frame has no window: ' + JSON.stringify(roll));
  if (!(roll.held && roll.moved && roll.filmStats && roll.detection && roll.edge && roll.sample && roll.tile && roll.reference)) {
    fail('roll-frame worker differs from the lane sequence: ' + JSON.stringify(roll));
  }
  for (const name of ['window', 'outline']) {
    const row = parallel[name];
    if (!row?.equal || !row.helpers) fail(`parallel detection differs from the serial one (${name}): ` + JSON.stringify(row));
  }
  if (parallel.outline.angleCount >= 2 && !parallel.outline.remote) fail('the helpers took no work on the fallback frame: ' + JSON.stringify(parallel.outline));
  if (parallel.outline.angleCount < 2) console.log('note: the outline frame did not take the multi-angle fallback in this browser: ' + JSON.stringify(parallel.outline));
  console.log('ok: OpenCV shared module, roll-frame worker equals the lane sequence, parallel detection equals serial');
}
