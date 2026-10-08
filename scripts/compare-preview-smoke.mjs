// #242 through the real Studio handlers: the settled CPU display is exact and
// display-size (renderSettledDisplay, the export worker above 1 MP), #canvas
// holds the drawn buffer and never the full frame, an import writes the
// full-resolution negative once, and before/after is its own cached,
// display-size element over the image. The three comparison assertions of
// the earlier version stay: exit restores fresh pixels, edits made during a
// comparison apply, and a closed session releases the canvases.
// #279 follow-up: the comparison keeps #canvas's box (with the border a
// transform lays it over the photo) and draws a patch's sides within 1 CSS px
// of where #canvas under it draws them, and #canvas within 1 CSS px of where
// its box puts them (it fills the box), at 100 % and about 400 % zoom, with
// and without the border (DPR 2).
import { createScreenEdges } from './screen-edges.mjs';

const PREVIEW_CAP = 4_000_000;
// A uniform patch of the first fixture (3600 x 2400), clear of the pattern's
// wrap, in view at about 400 %: its sides are the edges the alignment check
// measures.
const PATCH = { left: 1560, top: 1080, right: 1680, bottom: 1160 };
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// Timing budgets hold on a real Mac; shared CI runners (software GL, noisy
// CPUs) check the behaviour and log the time, which the benchmark measures.
const TIMING_BUDGETS = !process.env.CI;

export async function runComparePreviewSmoke({ send, evaluate, waitFor, wait, fail, port }) {
  // DPR 2, as the audit measured: the display preview of the 8.6 MP fixture
  // is then above 1 MP, so the settle takes the worker.
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('compare preview boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncDisplay`);
  await wait(1500);
  await evaluate(`(() => {
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const input = document.getElementById(id); if (input?.checked) input.click();
    }
    // Every write into a canvas: which one, how many pixels, and the calls
    // that went into #canvas above the display preview cap.
    const probe = window.__comparePreviewProbe = { writes: [], largeMainWrites: [], recording: false, mainTimes: [] };
    const originalPut = CanvasRenderingContext2D.prototype.putImageData;
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    const note = (context, kind, pixels, ms) => {
      const id = context.canvas.id || 'offscreen';
      if (probe.recording) probe.writes.push({ id, kind, pixels });
      if (id === 'canvas') {
        probe.mainTimes.push(ms);
        if (pixels > ${PREVIEW_CAP}) probe.largeMainWrites.push({ kind, pixels });
      }
    };
    CanvasRenderingContext2D.prototype.putImageData = function(image, ...args) {
      const start = performance.now();
      const result = originalPut.call(this, image, ...args);
      note(this, 'put', args.length >= 6 ? args[4] * args[5] : image.width * image.height, performance.now() - start);
      return result;
    };
    CanvasRenderingContext2D.prototype.drawImage = function(source, ...args) {
      const start = performance.now();
      const result = originalDraw.call(this, source, ...args);
      const pixels = args.length >= 8 ? args[6] * args[7] : args.length >= 4 ? args[2] * args[3] : (source.width || 0) * (source.height || 0);
      note(this, 'draw', pixels, performance.now() - start);
      return result;
    };
    window.__restoreComparePreviewProbe = () => {
      CanvasRenderingContext2D.prototype.putImageData = originalPut;
      CanvasRenderingContext2D.prototype.drawImage = originalDraw;
      delete window.__comparePreviewProbe;
      delete window.__comparePreviewFiles;
      delete window.__comparePreviewHash;
      delete window.__restoreComparePreviewProbe;
    };
    // Five interior patches of a canvas, enough to tell adjustment states apart.
    window.__comparePreviewHash = (id = 'canvas') => {
      const canvas = document.getElementById(id), ctx = canvas.getContext('2d');
      let hash = 2166136261;
      for (const [x, y] of [[.25,.25],[.75,.25],[.5,.5],[.25,.75],[.75,.75]]) {
        const w = Math.min(96, canvas.width), h = Math.min(64, canvas.height);
        const pixels = ctx.getImageData(Math.max(0, Math.floor(canvas.width*x)-(w>>1)), Math.max(0, Math.floor(canvas.height*y)-(h>>1)), w, h).data;
        for (let i=0; i<pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
      }
      return [canvas.width, canvas.height, hash >>> 0].join(':');
    };
  })()`);
  const frame = () => evaluate(`window.__ncDisplay.frame()`);
  const counters = () => evaluate(`window.__ncDisplay.counters()`);
  const withinCap = size => Boolean(size) && size[0] * size[1] <= PREVIEW_CAP;
  // #279 follow-up: the patch's left side (along a row) and top side (along a
  // column), drawn by the comparison and, with it hidden, by #canvas under it,
  // at 100 % and about 400 % zoom.
  const edges = createScreenEdges({ send, evaluate });
  const zoomOf = () => evaluate(`Number(/matrix\\(([\\d.]+)/.exec(document.getElementById('canvasTransformWrapper').style.transform)?.[1] || 1)`);
  const settleFrames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))');
  const comparisonAlignment = async (label) => {
    const results = [];
    for (const level of [1, 4]) {
      await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))`);
      for (let i = 0; i < 12 && level > 1 && await zoomOf() < level * 0.95; i++) {
        await evaluate(`document.getElementById('zoomInBtn').click()`);
        await wait(80);
      }
      await waitFor(`${label} zoom ${level} idle`, ready, 60000);
      await settleFrames();
      const shown = await frame();
      const geometry = await evaluate(`(() => { const r = window.__ncBrush.state().photoRect, c = document.getElementById('canvasContainer').getBoundingClientRect();
        return { photo: r, view: { left: c.left, top: c.top, right: c.right, bottom: c.bottom } }; })()`);
      const W = shown.width, H = shown.height;
      const toClient = (x, y) => ({ x: geometry.photo.left + x / W * geometry.photo.width, y: geometry.photo.top + y / H * geometry.photo.height });
      const texel = geometry.photo.width / shown.display[0];
      const reach = Math.max(10, 6 * texel);
      const sides = [
        { axis: 'x', point: toClient(PATCH.left, (PATCH.top + PATCH.bottom) / 2), band: Math.min(60, 0.5 * (PATCH.bottom - PATCH.top) / H * geometry.photo.height) },
        { axis: 'y', point: toClient((PATCH.left + PATCH.right) / 2, PATCH.top), band: Math.min(60, 0.5 * (PATCH.right - PATCH.left) / W * geometry.photo.width) },
      ];
      for (const side of sides) {
        if (!(side.point.x - reach > geometry.view.left && side.point.x + reach < geometry.view.right
          && side.point.y - reach > geometry.view.top && side.point.y + reach < geometry.view.bottom)) {
          fail(`${label} zoom ${level}: the patch side is out of view: ` + JSON.stringify({ side, geometry }));
        }
      }
      await evaluate(`document.getElementById('beforeAfterBtn').click()`);
      await waitFor(`${label} zoom ${level} comparison shown`, `window.__ncDisplay.frame().comparison.shown`, 30000);
      await settleFrames();
      const measured = [];
      for (const side of sides) {
        measured.push(await edges.layerEdges('beforeAfterCanvas', { axis: side.axis, reach, band: side.band,
          at: side.axis === 'x' ? side.point.x : side.point.y, across: side.axis === 'x' ? side.point.y : side.point.x }));
      }
      await evaluate(`document.getElementById('beforeAfterBtn').click()`);
      await waitFor(`${label} zoom ${level} comparison closed`, `!window.__ncDisplay.frame().comparison.shown`, 30000);
      const [x, y] = measured;
      if (![x.shown, x.under, y.shown, y.under].every(edge => !edge.error && edge.contrast >= 8)) {
        fail(`${label} zoom ${level}: the patch side was not found on screen: ` + JSON.stringify(measured));
      }
      // #canvas fills its box (object-fit): it draws the sides where the box
      // puts them, as the comparison laid on the box does.
      const cx = x.under.position - sides[0].point.x, cy = y.under.position - sides[1].point.y;
      if (!(Math.abs(cx) <= 1 && Math.abs(cy) <= 1)) {
        fail(`${label} zoom ${level}: #canvas draws the photo more than 1 CSS px off its box: ` + JSON.stringify({ cx, cy, measured, sides }));
      }
      const dx = x.shown.position - x.under.position, dy = y.shown.position - y.under.position;
      if (!(Math.abs(dx) <= 1 && Math.abs(dy) <= 1)) {
        fail(`${label} zoom ${level}: the comparison draws the patch more than 1 CSS px off #canvas: ` + JSON.stringify({ dx, dy, measured, sides, shown }));
      }
      const round = value => Math.round(value * 100) / 100;
      results.push({ level, zoom: round(await zoomOf()), dx: round(dx), dy: round(dy), canvas: [round(cx), round(cy)] });
    }
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))`);
    await waitFor(`${label} back at fit`, ready, 60000);
    return results;
  };
  try {
    // Two synthetic 35 mm frames: 3600x2400 (8.6 MP, above the cap) and 3000x2000.
    await evaluate(`(async () => {
      const make = async (width, height, name, phase, patch = null) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d'), image = ctx.createImageData(width, height);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4, t = (x / 37 + y / 29 + phase) % 100;
          image.data[i] = 100 + t; image.data[i + 1] = 45 + t * .6; image.data[i + 2] = 20 + t * .3; image.data[i + 3] = 255;
        }
        ctx.putImageData(image, 0, 0);
        if (patch) { ctx.fillStyle = 'rgb(60,35,20)'; ctx.fillRect(patch.left, patch.top, patch.right - patch.left, patch.bottom - patch.top); }
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .95));
        canvas.width = canvas.height = 1;
        return new File([blob], name, { type: 'image/jpeg' });
      };
      window.__comparePreviewFiles = [await make(3600, 2400, 'compare-preview-a.jpg', 0, ${JSON.stringify(PATCH)}), await make(3000, 2000, 'compare-preview-b.jpg', 40)];
      const probe = window.__comparePreviewProbe;
      probe.writes.length = 0; probe.largeMainWrites.length = 0;
      window.__ncDisplay.resetCounters();
      const transfer = new DataTransfer();
      for (const file of window.__comparePreviewFiles) transfer.items.add(file);
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('compare preview import', `${ready} && document.getElementById('studioFilename').textContent === 'compare-preview-a.jpg'`, 120000);

    // ---- B1: one full-resolution write to #canvas per import ----
    const imported = await evaluate(`({ large: window.__comparePreviewProbe.largeMainWrites, frame: window.__ncDisplay.frame() })`);
    console.log('compare import:', JSON.stringify(imported));
    if (imported.frame.width !== 3600 || imported.frame.height !== 2400) fail('compare fixture did not open: ' + JSON.stringify(imported.frame));
    if (imported.large.length > 1) fail('import wrote the full-resolution negative to #canvas more than once: ' + JSON.stringify(imported.large));

    // ---- A + B3 in a CPU mode (WebGL off, border on), after the frame went full resolution ----
    await evaluate(`(() => {
      const gl = document.getElementById('coreUseWebGL'); if (gl.checked) gl.click();
      const border = document.getElementById('sprocketPreviewBtn');
      if (border.getAttribute('aria-pressed') !== 'true') border.click();
    })()`);
    // The <= 16 MP idle render promotes the frame to full resolution: the
    // state in which #canvas used to grow to the whole image.
    await waitFor('full-resolution frame in a CPU mode', `(() => { const f = window.__ncDisplay.frame(); return f.exact && f.surface === 'cpu'; })()`, 120000);
    await waitFor('settled display frame presented', `window.__ncDisplay.counters().settlePresented > 0 && !!window.__ncDisplay.frame().handle`, 60000);
    // The frame on screen is the exact 'full' pass of the display preview
    // (a later preview-quality frame is followed by its own settle).
    await waitFor('settled frame equals the main-thread full pass', `window.__ncDisplay.settledParity().equal`, 30000);
    const settled = await evaluate(`({ frame: window.__ncDisplay.frame(), counters: window.__ncDisplay.counters(), parity: window.__ncDisplay.settledParity() })`);
    console.log('compare settled CPU frame:', JSON.stringify(settled));
    if (!withinCap(settled.frame.display) || settled.frame.display[0] >= 3600) fail('the display preview is not display-size: ' + JSON.stringify(settled.frame));
    if (JSON.stringify(settled.frame.handle) !== JSON.stringify(settled.frame.display)) fail('state.displayImageData is not the display-size frame: ' + JSON.stringify(settled.frame));
    if (!settled.parity.equal) fail('the settled frame differs from applyPreparedAdjustmentsToBuffer(preview, full): ' + JSON.stringify(settled.parity));
    if (settled.counters.settleWorker < 1 || settled.counters.settleSync !== 0) fail('a display preview above 1 MP did not settle in the export worker: ' + JSON.stringify(settled.counters));
    const [mainW, mainH] = settled.frame.canvases.main, [shownW, shownH] = settled.frame.display;
    if (mainW < shownW || mainH <= shownH || mainW > shownW * 1.25 || mainH > shownH * 2) fail('#canvas is not the display-size bordered frame: ' + JSON.stringify(settled.frame.canvases));

    await waitFor('comparison reference prepared', `window.__ncDisplay.frame().comparison.ready`);
    const result = await evaluate(`(async () => {
      const slider = document.getElementById('wbR'), compare = document.getElementById('beforeAfterBtn');
      const probe = window.__comparePreviewProbe, hash = window.__comparePreviewHash;
      const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const input = value => { slider.value = String(value); slider.dispatchEvent(new Event('input', { bubbles: true })); };
      const writesDuring = action => {
        probe.writes.length = 0; probe.recording = true;
        const start = performance.now(); action(); const ms = performance.now() - start;
        probe.recording = false;
        return { start, ms, writes: probe.writes.splice(0).filter(w => w.id !== 'histogramCanvas') };
      };
      // Input, not change: this isolates synchronous adjustment freshness from
      // asynchronous SilverCore conversion and does not schedule a full pass.
      input(1.05); await nextFrame();
      const baseline = hash();
      input(1.35); await nextFrame();
      const recent = hash();
      const firstPress = writesDuring(() => compare.click());
      firstPress.paintMs = await new Promise(resolve => requestAnimationFrame(() => resolve(performance.now())));
      const reference = hash('beforeAfterCanvas'), underComparison = hash();
      const comparisonFrame = window.__ncDisplay.frame();
      const firstExit = writesDuring(() => compare.click());
      const restored = hash();
      input(1.35); await nextFrame();
      const fresh = hash();
      // While compare is active, the normal preview callback intentionally does
      // nothing. Exit must still read the current settings, not a cached render.
      const secondPress = writesDuring(() => compare.click());
      input(.75); await nextFrame();
      const secondExit = writesDuring(() => compare.click());
      const changedWhileComparing = hash();
      input(.75); await nextFrame();
      const freshChanged = hash();
      return { baseline, recent, reference, underComparison, restored, fresh, changedWhileComparing, freshChanged,
        firstPress, secondPress, firstExit, secondExit, comparisonFrame,
        cpuVisible: getComputedStyle(document.getElementById('canvas')).display !== 'none',
        glVisible: getComputedStyle(document.getElementById('glCanvas')).display !== 'none',
        border: document.getElementById('sprocketPreviewBtn').getAttribute('aria-pressed') };
    })()`);
    console.log('compare preview:', JSON.stringify({ ...result, firstPress: { ms: result.firstPress.ms, writes: result.firstPress.writes },
      secondPress: { ms: result.secondPress.ms, writes: result.secondPress.writes } }));
    if (TIMING_BUDGETS && (result.firstPress.ms > 16 || result.firstPress.paintMs - result.firstPress.start > 50)) fail('first comparison press exceeded entry/paint budget: ' + JSON.stringify(result.firstPress));
    if (!result.cpuVisible || result.glVisible || result.border !== 'true') fail('compare scenario did not use the CPU border display');
    if (result.baseline === result.recent || result.reference === result.recent) fail('compare fixture did not distinguish changed settings/reference');
    if (result.underComparison !== result.recent) fail('entering the comparison drew over #canvas: ' + JSON.stringify(result));
    if (result.restored !== result.recent || result.restored !== result.fresh) fail('compare exit restored stale pixels after recent slider input: ' + JSON.stringify(result));
    if (result.changedWhileComparing !== result.freshChanged || result.freshChanged === result.fresh) fail('compare exit ignored settings changed while comparison was active: ' + JSON.stringify(result));
    // C: one <= 4 MP put into the comparison element on the first press, a
    // style flip on the next; never a write into #canvas or a large one.
    const firstPut = result.firstPress.writes.filter(w => w.id === 'beforeAfterCanvas');
    if (firstPut.length !== 1 || firstPut[0].pixels > PREVIEW_CAP || result.firstPress.writes.some(w => w.id === 'canvas' || w.pixels > PREVIEW_CAP)) {
      fail('the first comparison press did not draw one display-size reference: ' + JSON.stringify(result.firstPress));
    }
    if (result.secondPress.writes.length) fail('a later comparison press on the same photo wrote pixels: ' + JSON.stringify(result.secondPress));
    const comparison = result.comparisonFrame;
    if (!comparison.comparison.shown || !withinCap(comparison.canvases.comparison) || comparison.canvases.comparison[0] >= 3600) fail('the comparison element is not a display-size canvas: ' + JSON.stringify(comparison));
    // With the border, over the photo rectangle, not stretched over the
    // border: #canvas's box, carried onto the photo by a transform (#279
    // follow-up: a box of its own was rounded off the photo's grid).
    const placed = comparison.comparison;
    const scale = /scale\(([\d.e-]+), ([\d.e-]+)\)/.exec(placed.transform || '');
    if (placed.box.some(value => value !== '') || !placed.photo || !scale
      || Math.abs(Number(scale[1]) - placed.photo.width / placed.photo.frameWidth) > 1e-9 || Math.abs(Number(scale[2]) - placed.photo.height / placed.photo.frameHeight) > 1e-9
      || !(placed.photo.x > 0 && placed.photo.y > 0)) {
      fail('the comparison is not placed over the photo inside the border: ' + JSON.stringify(placed));
    }
    const bordered = await comparisonAlignment('CPU border');
    console.log('ok: with the border, the comparison draws the image within 1 CSS px of #canvas under it ' + JSON.stringify(bordered));
    for (const exit of [result.firstExit, result.secondExit]) {
      if (exit.writes.some(w => w.pixels > PREVIEW_CAP)) fail('compare exit wrote a full-resolution frame: ' + JSON.stringify(exit));
    }

    // ---- CPU mode without the border: #canvas is exactly the display frame ----
    await evaluate(`document.getElementById('sprocketPreviewBtn').click()`);
    await waitFor('unbordered CPU frame', `(() => { const f = window.__ncDisplay.frame(); return f.surface === 'cpu' && JSON.stringify(f.canvases.main) === JSON.stringify(f.display); })()`, 30000);
    const plain = await evaluate(`(() => {
      const compare = document.getElementById('beforeAfterBtn');
      compare.click(); const frame = window.__ncDisplay.frame(); compare.click();
      return frame;
    })()`);
    if (plain.comparison.box.some(value => value !== '') || plain.comparison.transform !== '' || plain.comparison.photo) {
      fail('without the border the comparison must cover the image box: ' + JSON.stringify(plain.comparison));
    }
    const unbordered = await comparisonAlignment('CPU no border');
    console.log('ok: without the border, the comparison draws the image within 1 CSS px of #canvas under it ' + JSON.stringify(unbordered));

    // ---- GPU mode: the hidden #canvas holds no frame; the comparison lies over the GL canvas ----
    await evaluate(`(async () => {
      const {Histogram} = await import('/src/silvercore/ui/Histogram.js');
      const originalDraw = Histogram.prototype.draw, probe = window.__comparePreviewProbe;
      probe.histogramDraws = 0; probe.gpuFulls = 0; probe.histogramLastDrawAt = 0;
      Histogram.prototype.draw = function(...args) {
        probe.histogramDraws++; probe.histogramLastDrawAt = performance.now();
        const stack = new Error().stack || '';
        if (stack.includes('updateFull')) probe.gpuFulls++;
        const result = originalDraw.apply(this, args), source = args[0], data = source.__image16?.data || source.data;
        let hash = 2166136261;
        for (let i = 0; i < data.length; i += Math.max(1, Math.floor(data.length / 4096))) hash = Math.imul(hash ^ data[i], 16777619);
        probe.lastHistogramSource = { width: source.width, height: source.height, hash: hash >>> 0,
          path: stack.includes('renderHistogramForWebGL') ? 'gpu' : stack.includes('enterBeforeAfter') ? 'reference' : 'other' };
        return result;
      };
      probe.histogramSnapshot = () => {
        const canvas = document.getElementById('histogramCanvas');
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let hash = 2166136261; for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619);
        return { hash: hash >>> 0, width: canvas.width, height: canvas.height, source: probe.lastHistogramSource };
      };
      window.__restoreCompareHistogramProbe = () => { Histogram.prototype.draw = originalDraw; delete window.__restoreCompareHistogramProbe; };
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
    })()`);
    await waitFor('settled GPU source for compare histogram', `window.__comparePreviewProbe.gpuFulls > 0 && getComputedStyle(document.getElementById('glCanvas')).display !== 'none'`, 120000);
    await waitFor('GPU histogram throttle elapsed', `performance.now() - window.__comparePreviewProbe.histogramLastDrawAt > 270`);
    const gpu = await evaluate(`(async () => {
      const probe = window.__comparePreviewProbe, slider = document.getElementById('wbR');
      slider.value = '.9'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const adjusted = probe.histogramSnapshot(), beforeDraws = probe.histogramDraws, start = performance.now();
      const compare = document.getElementById('beforeAfterBtn');
      probe.writes.length = 0; probe.recording = true;
      compare.click();
      probe.recording = false;
      const pressWrites = probe.writes.splice(0);
      const during = { frame: window.__ncDisplay.frame(), glShown: getComputedStyle(document.getElementById('glCanvas')).display !== 'none' };
      const reference = probe.histogramSnapshot(), referenceDraws = probe.histogramDraws;
      compare.click();
      return { adjusted, reference, restored: probe.histogramSnapshot(), beforeDraws, referenceDraws,
        restoredDraws: probe.histogramDraws, elapsedMs: performance.now() - start, pressWrites, during,
        gpuVisible: getComputedStyle(document.getElementById('glCanvas')).display !== 'none' };
    })()`);
    await waitFor('fresh same-settings GPU histogram', `performance.now() - window.__comparePreviewProbe.histogramLastDrawAt > 270`);
    gpu.fresh = await evaluate(`(async () => {
      const slider = document.getElementById('wbR'); slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return window.__comparePreviewProbe.histogramSnapshot();
    })()`);
    console.log('compare GPU histogram:', JSON.stringify(gpu));
    if (!gpu.gpuVisible || gpu.fresh.hash === gpu.reference.hash || gpu.referenceDraws <= gpu.beforeDraws
      || gpu.fresh.source.path !== 'gpu' || gpu.reference.source?.path !== 'reference') fail('GPU comparison histogram fixture did not exercise the reference');
    if (JSON.stringify(gpu.fresh) !== JSON.stringify(gpu.restored) || gpu.restoredDraws <= gpu.referenceDraws) fail('GPU compare exit did not restore a fresh same-settings histogram: ' + JSON.stringify(gpu));
    if (!gpu.during.glShown || !gpu.during.frame.comparison.shown) fail('in GPU mode the comparison must lie over the GL canvas: ' + JSON.stringify(gpu.during));
    if (gpu.pressWrites.some(w => w.id === 'canvas' || w.pixels > PREVIEW_CAP)) fail('the GPU-mode comparison wrote into #canvas or a large canvas: ' + JSON.stringify(gpu.pressWrites));
    if (gpu.during.frame.canvases.main[0] * gpu.during.frame.canvases.main[1] > 1) fail('the hidden #canvas kept a frame while WebGL presents: ' + JSON.stringify(gpu.during.frame.canvases));
    await evaluate(`window.__restoreCompareHistogramProbe()`);

    // ---- No Step-3 pass above the display preview on the main thread ----
    const mainPasses = await counters();
    console.log('compare main-thread Step-3 passes:', JSON.stringify(mainPasses));
    if (mainPasses.mainAdjustMaxPixels > PREVIEW_CAP || mainPasses.mainAdjustOverPreviewCap || mainPasses.exportFallbackAdjustments) {
      fail('a Step-3 pass above the display preview ran on the main thread: ' + JSON.stringify(mainPasses));
    }
    const mainTimes = await evaluate(`window.__comparePreviewProbe.mainTimes.slice().sort((a, b) => a - b)`);
    console.log(`compare #canvas put/draw: n=${mainTimes.length} p95=${(mainTimes[Math.floor(mainTimes.length * 0.95)] || 0).toFixed(2)} ms max=${(mainTimes.at(-1) || 0).toFixed(2)} ms`);
    const largeWrites = await evaluate(`window.__comparePreviewProbe.largeMainWrites`);
    if (largeWrites.length > 1) fail('#canvas received a frame above the display preview after the import: ' + JSON.stringify(largeWrites));

    // ---- A photo switch releases the comparison canvas ----
    await evaluate(`(() => { const compare = document.getElementById('beforeAfterBtn'); compare.click(); compare.click(); })()`);
    const cached = await frame();
    if (!cached.comparison.cached || cached.canvases.comparison[0] * cached.canvases.comparison[1] <= 1) fail('the comparison reference was not cached: ' + JSON.stringify(cached.comparison));
    await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
    await waitFor('switched to the second photo', `${ready} && document.getElementById('studioFilename').textContent === 'compare-preview-b.jpg'`, 120000);
    const switched = await frame();
    if (switched.comparison.cached || switched.canvases.comparison.join('x') !== '1x1') fail('a photo switch kept the comparison canvas: ' + JSON.stringify(switched));
    await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
    await waitFor('back on the first photo', `${ready} && document.getElementById('studioFilename').textContent === 'compare-preview-a.jpg'`, 120000);

    // ---- Close releases the canvases; a new session builds them again ----
    await evaluate(`(() => {
      const gl = document.getElementById('coreUseWebGL'); if (gl.checked) gl.click();
      const border = document.getElementById('sprocketPreviewBtn'); if (border.getAttribute('aria-pressed') !== 'true') border.click();
    })()`);
    await waitFor('CPU border restored before close', `(() => { const f = window.__ncDisplay.frame(); return f.surface === 'cpu' && f.canvases.borderFrame[0] > 1 && f.canvases.main[1] > f.display[1]; })()`, 120000);
    await evaluate(`document.getElementById('beforeAfterBtn').click(); document.getElementById('studioNewSession').click()`);
    await waitFor('new-session confirmation', `!!document.querySelector('[data-app-dialog-confirm]')`);
    await evaluate(`document.querySelector('[data-app-dialog-confirm]').click()`);
    await waitFor('compare session closed', `!document.body.classList.contains('studio-ready') && document.getElementById('beforeAfterBtn').disabled`);
    const released = await frame();
    const area = size => (size ? size[0] * size[1] : 0);
    // The GL border underlay's texture (#253) goes with the session too.
    if (released.canvases.comparison.join('x') !== '1x1' || released.canvases.borderFrame.join('x') !== '1x1' || released.comparison.cached
      || area(released.canvases.glBorder) > 1) {
      fail('session close retained compare/border canvas backing stores: ' + JSON.stringify(released));
    }
    await evaluate(`(() => {
      const transfer = new DataTransfer(); transfer.items.add(window.__comparePreviewFiles[0]);
      const input = document.getElementById('fileInput'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('compare session reopened', ready, 120000);
    await waitFor('reopened comparison reference prepared', `window.__ncDisplay.frame().comparison.ready`);
    const regenerated = await evaluate(`(async () => {
      const border = document.getElementById('sprocketPreviewBtn'); if (border.getAttribute('aria-pressed') !== 'true') border.click();
      const slider = document.getElementById('wbR'); slider.value = '1.2'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const hashShown = () => {
        const shown = window.__ncDisplay.shownFrame();
        let hash = 2166136261;
        for (let i = 0; i < shown.data.length; i++) hash = Math.imul(hash ^ shown.data[i], 16777619);
        return [shown.width, shown.height, hash >>> 0].join(':');
      };
      const before = hashShown();
      const compare = document.getElementById('beforeAfterBtn'); compare.click();
      const during = window.__ncDisplay.frame();
      compare.click();
      return { before, after: hashShown(), during, frame: window.__ncDisplay.frame() };
    })()`);
    // The new session shows the photo on the GPU again (coreUseWebGL is a
    // recipe setting), where the border is a GL underlay (#253), not the 2D
    // border canvas: the border regenerates on whichever surface shows it.
    const shownBorder = regenerated.frame.surface === 'gl' ? regenerated.frame.canvases.glBorder : regenerated.frame.canvases.borderFrame;
    if (regenerated.frame.comparison.shown !== false || regenerated.before !== regenerated.after || area(regenerated.during.canvases.comparison) <= 1 || area(shownBorder) <= 1) {
      fail('border/compare canvases did not regenerate after reopen: ' + JSON.stringify(regenerated));
    }
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&largeImagePixels=1000000` });
    await waitFor('large-route compare boot', `!!window.__ncDisplay?.frame && !!document.getElementById('studioImportAutoCrop')`);
    await evaluate(`(async () => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      const transfer = new DataTransfer();
      for (let n = 0; n < 2; n++) {
        const c = document.createElement('canvas'); c.width = 2400; c.height = 1600;
        const ctx = c.getContext('2d'); ctx.fillStyle = n ? '#b07040' : '#a06030'; ctx.fillRect(0, 0, c.width, c.height);
        const blob = await new Promise(resolve => c.toBlob(resolve));
        transfer.items.add(new File([blob], 'compare-large-' + n + '.png', { type: 'image/png' }));
      }
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor('large-route compare import', `${ready} && window.__ncDisplay.frame().comparison.ready`, 120000);
    const press = async label => {
      await waitFor(label + ': ready', `${ready} && window.__ncDisplay.frame().comparison.ready`, 120000);
      const target = await evaluate('window.__ncDisplay.state().target');
      if (!target.displayTarget) fail(label + ': fixture did not use a pixel-less display target');
      const timing = await evaluate(`(async () => {
        const button = document.getElementById('beforeAfterBtn');
        const start = performance.now(); button.click(); const ms = performance.now() - start;
        const shown = window.__ncDisplay.frame().comparison.shown;
        const paintMs = await new Promise(resolve => requestAnimationFrame(() => resolve(performance.now() - start)));
        button.click();
        return { ms, paintMs, shown, exited: !window.__ncDisplay.frame().comparison.shown };
      })()`);
      if (!timing.shown || !timing.exited || (TIMING_BUDGETS && (timing.ms > 16 || timing.paintMs > 50))) fail(label + ': first press failed ' + JSON.stringify(timing));
      console.log('ok: first compare after ' + label + ' ' + JSON.stringify(timing));
    };
    await evaluate(`document.getElementById('rotateRightBtn').click()`);
    await wait(500);
    await press('rotate');
    await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
    await waitFor('large-route second photo', `document.getElementById('studioFilename').textContent === 'compare-large-1.png'`, 120000);
    await press('switch');
    const targetBefore = await evaluate(`JSON.stringify(window.__ncDisplay.state().target)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 650, deviceScaleFactor: 1, mobile: false });
    await waitFor('comparison target resized', `JSON.stringify(window.__ncDisplay.state().target) !== ${JSON.stringify(targetBefore)}`);
    await press('resize');
    console.log('ok: settled CPU frames are exact, display-size and worker-made; #canvas holds the drawn buffer; one negative write per import; the comparison is a cached display-size element released on switch and close');
  } finally {
    await evaluate(`window.__restoreCompareHistogramProbe?.()`);
    await evaluate(`window.__restoreComparePreviewProbe?.()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
}
