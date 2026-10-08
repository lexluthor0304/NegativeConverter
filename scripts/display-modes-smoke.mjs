// #253 in Chrome: the look, the expired-film rescue, the film border, the
// dodge-and-burn tool and the dust mask on the GPU display.
//
// 1. Offscreen, independent of the app: the mode programs' self-test, then every
//    parity recipe of the issue drawn one by one with the Step-3 mode program and
//    read back against pixelAdjustments.js ('full'): rescue with offsets, with the
//    fog surface (strongest top-left: the orientation fixture), with local
//    contrast 30 and 100, the look (matrix + curves, curves only), rescue + look +
//    vibrance, hold-to-compare, and the apply mode program on a SilverCore frame.
//    Budget: mean <= 1 level, p99.9 <= 3.
// 2. In the app: a look applied through a recipe draws on #glCanvas with the mode
//    program within the budget, and a core-slider drag with it stays on
//    applyProgram; ?gpuPreview=modes-fail keeps a look on the CPU display.
// 3. The film border as a GL underlay, landscape and portrait: the border pixels
//    equal composeSprocketFrame at display size, the photo rectangle meets the
//    budget.
// 4. The overlay layer (#279): it shares the photo canvas's box and backing
//    (the framed display size with the border, the photo at its offset, the
//    same pixels as a backing of the photo's size). A dodge stroke lands on the
//    same image point whether GL or #canvas shows the photo; the overlay draws
//    it within 0.5 backing pixels of that point and on screen within 1 CSS px,
//    on both canvases. A direct dust stroke: #brushFeedback draws its live dab
//    within 1 CSS px of the recorded point, and the tint of the committed disc
//    lies around it in the backing and on screen within 1 CSS px of where the
//    backing puts it. All at 100 % and about 400 % zoom, with and without the
//    border.
// The rescue in the app (fog from OpenCV, local contrast, drags, hold-to-compare)
// is checked by expired-film-smoke.mjs on its aged positive.
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// ---- page side ----

async function offscreenModes() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
  if (!gl) return { skipped: 'no WebGL2' };
  const { createGpuPreviewRenderer } = await import('/src/render/gpuPreviewRenderer.js');
  const {
    buildDisplayModesCases, buildDisplayModesCase, displayModesSpecs, agedPositiveFixture, expiredAnalysisOf,
    displayParity, buildPreviewCase, parityFrame, syntheticLook,
  } = await import('/src/render/gpuPreviewSelfTest.js');
  const { filmPresets } = await import('/src/silvercore/engine/FilmPresets.js');
  const { applyPreparedAdjustmentsToBuffer } = await import('/src/app/adjustmentPipeline.js');
  const renderer = createGpuPreviewRenderer(gl);
  renderer.startModesCompile();
  renderer.startApplyCompile();
  for (let i = 0; i < 600 && (renderer.modesStatus() === 'pending' || renderer.applyStatus() === 'pending'); i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  if (renderer.modesStatus() !== 'linked') return { failed: 'mode programs did not link: ' + renderer.modesError() };
  const selfTestCases = buildDisplayModesCases();
  const report = { selfTest: renderer.modesSelfTest(selfTestCases), corruptApply: renderer.modesSelfTest(selfTestCases, { corruptApply: true }), cases: [] };
  if (!report.selfTest.ok) return { ...report, failed: 'self-test' };
  const read = (width, height) => {
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const rows = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < height; y++) rows.set(pixels.subarray((height - 1 - y) * width * 4, (height - y) * width * 4), y * width * 4);
    return rows;
  };
  // Each recipe at an odd size, drawn and read back in the same task.
  const W = 211, H = 137;
  canvas.width = W; canvas.height = H;
  for (const testCase of buildDisplayModesCases(W, H)) {
    renderer.uploadExact(testCase.image, true);
    renderer.uploadCurves(testCase.step3.curves);
    const drawn = renderer.drawStep3({ ...testCase.step3, stages: testCase.stages }, W, H);
    const result = drawn ? displayParity(testCase.expected, read(W, H)) : { ok: false, error: 'not drawn' };
    report.cases.push({ name: testCase.name, program: testCase.stages.active ? 'modes' : 'plain', ...result });
  }
  // The apply mode program: a SilverCore frame, then the rescue and the look.
  let applyFrame = null;
  if (renderer.applyStatus() === 'linked') {
    const image = agedPositiveFixture(96, 64);
    const spec = displayModesSpecs(expiredAnalysisOf(image)).find(item => item.name === 'rescue + look + vibrance');
    const preview = buildPreviewCase({
      name: 'apply', mode: 'color', settings: { filmType: 'color', colorModel: 'standard', temperature: 8, contrast: 12 },
      image: parityFrame('color', 96, 64), filmPresets,
    });
    const converted = { width: 96, height: 64, data: new Uint8ClampedArray(preview.expected) };
    const testCase = buildDisplayModesCase({ name: 'apply + modes', image: converted, settings: spec.settings, curves: 'tone' });
    canvas.width = 96; canvas.height = 64;
    renderer.uploadPrepared({ width: 96, height: 64, data16: preview.prepared.data });
    renderer.uploadCurves(testCase.step3.curves);
    const frame = { mode: preview.mode, params: preview.params, plan: preview.plan, engine: preview.engine };
    applyFrame = frame;
    const drawn = renderer.drawApply(frame, { ...testCase.step3, stages: testCase.stages }, 96, 64);
    report.cases.push({ name: 'apply + modes', program: 'apply-modes', ...(drawn ? displayParity(testCase.expected, read(96, 64)) : { ok: false, error: 'not drawn' }) });
  }
  // R2-020: the unchanged original 211x137 identity-WB fixture. Both public
  // GPU callers reject this recipe; the actual CPU display keeps every pixel.
  const original = buildDisplayModesCase({ name: 'original identity WB + vibrance', image: agedPositiveFixture(W, H),
    settings: { look: syntheticLook({ matrix: false }), wbR: 1, wbG: 1, wbB: 1, vibrance: 35, cyan: 6, magenta: -4, yellow: 3 } });
  canvas.width = W; canvas.height = H;
  renderer.uploadExact(original.image, true);
  renderer.uploadCurves(original.step3.curves);
  const values = { ...original.step3, stages: original.stages };
  const step3Gated = !renderer.drawStep3(values, W, H);
  const applyGated = applyFrame ? !renderer.drawApply(applyFrame, values, W, H) : false;
  const cpu = new ImageData(W, H);
  applyPreparedAdjustmentsToBuffer(original.image, original.recipe, cpu, { quality: 'full' });
  const fallback = document.createElement('canvas'); fallback.width = W; fallback.height = H;
  const ctx = fallback.getContext('2d'); ctx.putImageData(cpu, 0, 0);
  report.identityWb = { step3Gated, applyGated, ...displayParity(original.expected, ctx.getImageData(0, 0, W, H).data) };
  report.failedCases = report.cases.filter(item => !item.ok);
  return report;
}

// A synthetic colour negative (optionally portrait) with a film-base rebate.
async function importNegative(name, width, height) {
  for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
    const input = document.getElementById(id); if (input?.checked) input.click();
  }
  document.querySelector('.film-type-btn[data-type="color"]').click();
  const surface = document.createElement('canvas');
  surface.width = width; surface.height = height;
  const context = surface.getContext('2d');
  context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, width, height);
  const inset = Math.round(Math.min(width, height) * 0.06);
  const gradient = context.createLinearGradient(inset, inset, width - inset, height - inset);
  gradient.addColorStop(0, 'rgb(190,125,80)'); gradient.addColorStop(0.5, 'rgb(150,95,70)'); gradient.addColorStop(1, 'rgb(95,70,55)');
  context.fillStyle = gradient; context.fillRect(inset, inset, width - 2 * inset, height - 2 * inset);
  const colors = ['rgb(120,110,60)', 'rgb(180,80,70)', 'rgb(90,120,95)', 'rgb(160,140,110)', 'rgb(70,60,40)', 'rgb(200,160,120)'];
  colors.forEach((color, i) => {
    context.fillStyle = color;
    context.fillRect(width * (0.55 + (i % 3) * 0.12), height * (0.55 + Math.floor(i / 3) * 0.15), width * 0.1, height * 0.12);
  });
  const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], name, { type: 'image/png' }));
  const input = document.getElementById('fileInput'); input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

// Counts the GL canvas's draws by program (applyProgram has u_prepared) and the
// preview worker's conversions.
function installModesProbe() {
  const probe = window.__modesProbe = { applyDraws: 0, glDraws: 0, converts: 0 };
  const isApply = new WeakMap();
  for (const proto of [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    const draw = proto.drawArrays;
    proto.drawArrays = function (...args) {
      if (this.canvas?.id === 'glCanvas' && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
        probe.glDraws++;
        const program = this.getParameter(this.CURRENT_PROGRAM);
        let apply = program ? isApply.get(program) : false;
        if (program && apply === undefined) { apply = this.getUniformLocation(program, 'u_prepared') !== null; isApply.set(program, apply); }
        if (apply) probe.applyDraws++;
      }
      return draw.apply(this, args);
    };
  }
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message?.type === 'convert') probe.converts++;
    return post.call(this, message, ...args);
  };
}

// ---- node side ----

function decodePng(base64) {
  const png = UPNG.decode(Buffer.from(base64, 'base64'));
  return { width: png.width, height: png.height, data: new Uint8Array(UPNG.toRGBA8(png)[0]) };
}

export async function runDisplayModesSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) fail(message); };
  const until = async (description, expression, timeout = 60_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const settle = async (label, ms = 1200) => { await until(label, ready, 120_000); await sleep(ms); };
  const open = async (query, files) => {
    const origin = await evaluate('performance.timeOrigin');
    // The normal tier (the GL frame is the display source's size) and no detail
    // layer (a region landing between two screenshots would read as overlay).
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&previewTier=normal&detailLayer=0${query || '&gpuPreview=force'}` });
    await until('fresh display-modes workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await evaluate(`(${installModesProbe.toString()})()`);
    for (const [name, width, height] of files) {
      await evaluate(`(${importNegative.toString()})(${JSON.stringify(name)}, ${width}, ${height})`);
      await until(`${name} converted`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`, 120_000);
    }
    await evaluate(`document.getElementById('studioTab-edit').click()`);
    await settle('workspace idle');
  };
  const frame = () => evaluate('window.__ncDisplay.frame()');
  const parity = async (label) => {
    const result = await evaluate('window.__ncDisplay.glParity()');
    expect(!result.error && result.mean <= 1 && result.p999 <= 3, `GL display parity (${label}): ${JSON.stringify(result).slice(0, 2000)}`);
    return result;
  };

  // ---- 1. Offscreen ----
  await open('', [['display-modes.png', 1500, 1000]]);
  const offscreen = await evaluate(`(${offscreenModes.toString()})()`);
  if (offscreen.skipped) {
    console.log(`SKIP display-modes: ${offscreen.skipped}`);
    return;
  }
  expect(!offscreen.corruptApply.ok, 'corrupted apply-modes shader was accepted');
  expect(offscreen.identityWb.step3Gated && offscreen.identityWb.applyGated && offscreen.identityWb.p999 === 0 && offscreen.identityWb.max === 0,
    'original identity-WB fixture missed its strict CPU display target: ' + JSON.stringify(offscreen.identityWb));
  expect(!offscreen.failed && !offscreen.failedCases.length && offscreen.cases.length >= 9,
    'display-mode parity failed offscreen: ' + JSON.stringify(offscreen).slice(0, 4000));
  console.log('ok: mode programs self-test and ' + offscreen.cases.length + ' parity recipes within the budget '
    + JSON.stringify(offscreen.cases.map(item => [item.name, Math.round(item.mean * 1000) / 1000, item.p999])));

  // ---- 2. A look in the app ----
  await until('mode programs ready', `window.__ncDisplay.modes().ready`, 60_000);
  const applyLook = async () => {
    await evaluate(`(async () => {
      const { encodeRecipe } = await import('/src/app/recipes.js');
      const curve = gamma => Array.from({ length: 256 }, (_, v) => Math.round(255 * Math.pow(v / 255, gamma)));
      const code = encodeRecipe({ look: { matrix: [0.92, 0.14, -0.03, 0.05, 0.86, 0.12, -0.08, 0.21, 0.95], offset: [6, -4, 9],
        curves: { r: curve(0.85), g: curve(1), b: curve(1.15) } } });
      const box = document.getElementById('recipeCode');
      box.value = code; box.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('recipeDecodeBtn').click();
      await new Promise(resolve => setTimeout(resolve, 100));
      document.getElementById('recipeApplyBtn').click();
    })()`);
    await settle('look applied', 2000);
  };
  await applyLook();
  const lookFrame = await frame();
  expect(lookFrame.surface === 'gl' && await evaluate('window.__ncDisplay.modes().needed'), 'a look did not stay on the GL display: ' + JSON.stringify(lookFrame));
  const lookParity = await parity('look');
  expect(lookParity.program === 'modes' && lookParity.stages?.lookMatrix && lookParity.stages?.lookCurves, 'the look did not draw with the mode program: ' + JSON.stringify(lookParity));
  // A core-slider drag with the look draws applyProgram frames (mode variant).
  const drag = await evaluate(`(async () => {
    const probe = window.__modesProbe, el = document.getElementById('coreExposure');
    for (let i = 0; i < 40 && probe.applyDraws === 0; i++) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    const start = { apply: probe.applyDraws, converts: probe.converts };
    for (const value of [5, 10, 15, 20, 25, 30]) {
      el.value = String(value); el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 4)));
    }
    const during = { apply: probe.applyDraws - start.apply, converts: probe.converts - start.converts };
    el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return during;
  })()`);
  expect(drag.apply >= 3 && drag.converts === 0, 'a core-slider drag with a look left applyProgram: ' + JSON.stringify(drag));
  await settle('look drag settled', 2000);
  console.log('ok: a look draws on #glCanvas within the budget and core drags stay on applyProgram ' + JSON.stringify({ parity: [lookParity.mean, lookParity.p999], drag }));

  await evaluate(`(async () => {
    const { encodeRecipe } = await import('/src/app/recipes.js');
    const box = document.getElementById('recipeCode');
    box.value = encodeRecipe({ vibrance: 35, wbR: 1, wbG: 1, wbB: 1, cyan: 6, magenta: -4, yellow: 3 });
    box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('recipeDecodeBtn').click();
    await new Promise(resolve => setTimeout(resolve, 100)); document.getElementById('recipeApplyBtn').click();
  })()`);
  await settle('identity WB + vibrance on CPU', 2000);
  const fallbackFrame = await frame();
  expect(fallbackFrame.surface === 'cpu', 'the unsupported recipe escaped the app CPU gate: ' + JSON.stringify(fallbackFrame));
  console.log('ok: original identity-WB fixture strict parity and app CPU fallback ' + JSON.stringify({ fixture: offscreen.identityWb, surface: fallbackFrame.surface }));
  await evaluate(`(async () => {
    const { encodeRecipe } = await import('/src/app/recipes.js');
    const box = document.getElementById('recipeCode'); box.value = encodeRecipe({ vibrance: 0, cyan: 0, magenta: 0, yellow: 0 });
    box.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('recipeDecodeBtn').click();
    await new Promise(resolve => setTimeout(resolve, 100)); document.getElementById('recipeApplyBtn').click();
  })()`);
  await settle('supported look back on GL', 2000);
  expect((await frame()).surface === 'gl', 'the supported recipe did not return to GL');

  // ---- 3. The border as a GL underlay ----
  const borderCheck = async (label) => {
    await evaluate(`(() => { const b = document.getElementById('sprocketPreviewBtn'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
    await until(`${label} border on the GL display`, `(() => { const f = window.__ncDisplay.frame(); return f.surface === 'gl' && !!f.glPhoto; })()`, 30_000);
    await settle(`${label} border idle`, 1500);
    const result = await parity(`${label} border`);
    expect(result.border && result.border.pixels > 0 && result.border.differing === 0,
      `${label}: the GL border differs from composeSprocketFrame at display size: ` + JSON.stringify(result.border));
    const shown = await frame();
    expect(JSON.stringify(shown.canvases.gl) === JSON.stringify([result.layout.frameWidth, result.layout.frameHeight]),
      `${label}: the GL canvas is not the framed display size: ` + JSON.stringify({ gl: shown.canvases.gl, layout: result.layout }));
    return result;
  };
  const landscape = await borderCheck('landscape');
  expect(landscape.layout.frameWidth > landscape.layout.width && landscape.layout.x > 0, 'landscape layout: ' + JSON.stringify(landscape.layout));
  console.log('ok: landscape border is a GL underlay equal to composeSprocketFrame ' + JSON.stringify({ layout: landscape.layout, photo: [landscape.mean, landscape.p999] }));

  // ---- 4. The overlay layer (#253 C, #279) ----
  const probe = () => evaluate('window.__ncDisplay.overlayProbe()');
  const surfaceId = () => evaluate(`document.getElementById('glCanvas').style.display === 'block' ? 'glCanvas' : 'canvas'`);
  const nextFrames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const round = (value, digits = 100) => Math.round(value * digits) / digits;
  const offBy = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const setDodge = (on) => evaluate(`(() => {
    document.getElementById('studioTab-repair')?.click();
    const drawer = document.getElementById('studioDodgeBurn'); if (drawer) drawer.open = true;
    const el = document.getElementById('dodgeBurnEnabled'); if (el.checked !== ${on}) { el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true })); }
    const size = document.getElementById('dodgeBurnSize'); size.value = '3'; size.dispatchEvent(new Event('input', { bubbles: true }));
    const overlay = document.getElementById('dodgeBurnShowOverlay'); if (!overlay.checked) overlay.click();
  })()`);
  const clearStrokes = () => evaluate(`(() => { const b = document.getElementById('dodgeBurnClearBtn'); if (b && !b.disabled) b.click(); })()`);
  // The photo point a stroke at `fraction` of the photo rectangle stores. The
  // brushes map through the photo inside the border (#254 A.2): the stored
  // point is the clicked one, within a display pixel.
  const strokeAt = async (fx, fy) => {
    const before = await probe();
    const x = before.photo.left + before.photo.width * fx, y = before.photo.top + before.photo.height * fy;
    await clickAt(x, y);
    await settle('stroke settled', 1500);
    const after = await probe();
    const points = after.strokes.at(-1);
    expect(points && points.length >= 1, 'the dodge stroke was not recorded: ' + JSON.stringify(after));
    const tolerance = after.working.width / (await frame()).display[0] + 0.5;
    const want = { x: fx * after.working.width, y: fy * after.working.height };
    expect(Math.abs(points[0].x - want.x) <= tolerance && Math.abs(points[0].y - want.y) <= tolerance,
      'the stroke is not stored at the clicked photo point: ' + JSON.stringify({ stored: points[0], want, tolerance, photo: after.photo }));
    return { client: { x, y }, point: points[0], probe: after };
  };
  const zoomTo = async (level) => {
    await evaluate(`document.getElementById('zoomResetBtn') && (${level} === 1) && document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))`);
    for (let i = 0; i < 12 && level > 1; i++) {
      const zoom = await evaluate(`Number(/matrix\\(([\\d.]+)/.exec(document.getElementById('canvasTransformWrapper').style.transform)?.[1] || 1)`);
      if (zoom >= level * 0.95) break;
      await evaluate(`document.getElementById('zoomInBtn').click()`);
      await sleep(80);
    }
    await settle(`zoom ${level}`, 1000);
  };
  const zoomOf = () => evaluate(`Number(/matrix\\(([\\d.]+)/.exec(document.getElementById('canvasTransformWrapper').style.transform)?.[1] || 1)`);
  // Where a layer (an element id) draws in `region` (client px): the centroid
  // of what changes on screen when it is hidden. The clip is whole device
  // pixels: Chrome rounds a fractional clip's origin and truncates its size,
  // which moved every point measured in the photo's own rectangle by up to
  // half a pixel. Pixels that change by at least half the largest change
  // count, which puts an antialiased or magnified edge where it is half
  // covered.
  const layerCentroid = async (region, id) => {
    const view = await evaluate(`(() => { const r = document.getElementById('canvasContainer').getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, dpr: window.devicePixelRatio || 1 }; })()`);
    const dpr = view.dpr;
    const left = Math.floor(Math.max(region.left, view.left) * dpr) / dpr, top = Math.floor(Math.max(region.top, view.top) * dpr) / dpr;
    const right = Math.ceil(Math.min(region.left + region.width, view.right) * dpr) / dpr;
    const bottom = Math.ceil(Math.min(region.top + region.height, view.bottom) * dpr) / dpr;
    const clip = { x: left, y: top, width: right - left, height: bottom - top, scale: 1 };
    if (!(clip.width > 0 && clip.height > 0)) return null;
    const shot = async () => decodePng((await send('Page.captureScreenshot', { format: 'png', clip })).result.data);
    const shown = await shot();
    await evaluate(`document.getElementById(${JSON.stringify(id)}).style.visibility = 'hidden'`);
    await nextFrames();
    await sleep(100);
    const hidden = await shot();
    await evaluate(`document.getElementById(${JSON.stringify(id)}).style.visibility = ''`);
    await nextFrames();
    expect(shown.width === Math.round(clip.width * dpr) && shown.height === Math.round(clip.height * dpr) && hidden.width === shown.width,
      `screenshot of ${id} is not the clip's device pixels: ` + JSON.stringify({ clip, dpr, shot: [shown.width, shown.height] }));
    const change = new Float32Array(shown.width * shown.height);
    let largest = 0;
    for (let i = 0; i < change.length; i++) {
      const o = i * 4;
      const d = Math.max(Math.abs(shown.data[o] - hidden.data[o]), Math.abs(shown.data[o + 1] - hidden.data[o + 1]), Math.abs(shown.data[o + 2] - hidden.data[o + 2]));
      change[i] = d;
      if (d > largest) largest = d;
    }
    if (largest < 8) return null;
    let sumX = 0, sumY = 0, n = 0;
    for (let y = 0; y < shown.height; y++) {
      for (let x = 0; x < shown.width; x++) {
        if (change[y * shown.width + x] * 2 < largest) continue;
        sumX += x + 0.5; sumY += y + 0.5; n++;
      }
    }
    return { x: clip.x + sumX / n / dpr, y: clip.y + sumY / n / dpr, pixels: n };
  };
  const around = (point, radius) => ({ left: point.x - radius, top: point.y - radius, width: 2 * radius, height: 2 * radius });
  // An overlay backing point on screen: the overlay has the photo canvas's
  // client rect, so its backing maps onto that rect.
  const backingToClient = (state, point) => ({
    x: state.surfaceRect.left + point.x / state.overlayBacking[0] * state.surfaceRect.width,
    y: state.surfaceRect.top + point.y / state.overlayBacking[1] * state.surfaceRect.height,
  });
  // An image point (working-frame pixels) in the overlay's backing.
  const imageToBacking = (state, point) => ({
    x: state.overlayPhoto.x + point.x / state.working.width * state.overlayPhoto.width,
    y: state.overlayPhoto.y + point.y / state.working.height * state.overlayPhoto.height,
  });
  // #279: the overlay shares the photo canvas's box and backing, so the
  // compositor puts both on one pixel grid: the same client rect, the same
  // backing size (the framed display size with the border), the photo at its
  // offset in it, and the same pixels in the photo's rectangle as a backing
  // of the photo's size.
  const expectSharedBox = async (label, state) => {
    const box = (r) => [r.left, r.top, r.width, r.height];
    expect(state.overlay && box(state.overlay).every((value, i) => Math.abs(value - box(state.surfaceRect)[i]) <= 0.01),
      `${label}: the overlay is not in the photo canvas's box: ` + JSON.stringify({ overlay: state.overlay, surface: state.surfaceRect }));
    expect(JSON.stringify(state.overlayBacking) === JSON.stringify(state.surfaceBacking),
      `${label}: the overlay's backing is not the photo canvas's: ` + JSON.stringify({ overlay: state.overlayBacking, surface: state.surfaceBacking }));
    const shown = await frame();
    const layout = state.surface === 'gl' ? shown.glPhoto : null;
    const photo = state.overlayPhoto;
    expect(photo && photo.width === shown.display[0] && photo.height === shown.display[1]
      && (!layout || (photo.x === layout.x && photo.y === layout.y && state.overlayBacking[0] === layout.frameWidth && state.overlayBacking[1] === layout.frameHeight)),
    `${label}: the photo is not at its place in the overlay's backing: ` + JSON.stringify({ photo, layout, display: shown.display }));
    const parity = await evaluate('window.__ncDisplay.overlayParity()');
    expect(!parity.error && parity.drawn > 0 && parity.differing === 0 && parity.margin === 0,
      `${label}: the overlay's photo pixels differ from a backing of the photo's size: ` + JSON.stringify(parity));
    return parity;
  };
  // Where the overlay drew in its own backing pixels, around `center` when
  // given: the alpha-weighted centroid, content- and compositor-independent.
  const backingCentroid = (center = null, radius = 0) => evaluate(`(() => {
    const c = document.getElementById('displayOverlay');
    const center = ${JSON.stringify(center)}, radius = ${radius};
    const x0 = center ? Math.max(0, Math.floor(center.x - radius)) : 0, y0 = center ? Math.max(0, Math.floor(center.y - radius)) : 0;
    const x1 = center ? Math.min(c.width, Math.ceil(center.x + radius)) : c.width, y1 = center ? Math.min(c.height, Math.ceil(center.y + radius)) : c.height;
    if (!(x1 > x0 && y1 > y0)) return null;
    const d = c.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let sx = 0, sy = 0, sw = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const a = d[((y - y0) * (x1 - x0) + x - x0) * 4 + 3];
      if (a) { sx += (x + 0.5) * a; sy += (y + 0.5) * a; sw += a; }
    }
    return sw ? { x: sx / sw, y: sy / sw, width: c.width, height: c.height } : null;
  })()`);
  // A saved dodge stroke at a known image point, on the GL display (or #canvas):
  // drawn exactly there in the overlay's backing (0.5 backing px) and on
  // screen within 1 CSS px, at 100 % and about 400 % zoom.
  const strokeAlignment = async (label, point) => {
    const results = [];
    for (const level of [1, 4]) {
      await zoomTo(level);
      const state = await probe();
      await expectSharedBox(`${label} zoom ${level}`, state);
      const backing = await backingCentroid();
      const wantBacking = imageToBacking(state, point);
      expect(backing && offBy(backing, wantBacking) <= 0.5,
        `${label} zoom ${level}: the overlay draws the stroke off its image point: ` + JSON.stringify({ backing, wantBacking }));
      const want = backingToClient(state, wantBacking);
      const drawn = await layerCentroid({ left: state.photo.left, top: state.photo.top, width: state.photo.width, height: state.photo.height }, 'displayOverlay');
      expect(drawn && offBy(drawn, want) <= 1,
        `${label} zoom ${level}: the stroke is drawn more than 1 CSS px off its image point: ` + JSON.stringify({ drawn, want, backing, state }));
      results.push({ level, zoom: round(await zoomOf()), dx: round(drawn.x - want.x), dy: round(drawn.y - want.y),
        backing: [round(backing.x - wantBacking.x, 1000), round(backing.y - wantBacking.y, 1000)] });
    }
    await zoomTo(1);
    return results;
  };
  const overlayAlignment = async (label) => {
    await clearStrokes();
    await settle(`${label} strokes cleared`, 800);
    const { point } = await strokeAt(0.45, 0.47);
    return strokeAlignment(label, point);
  };
  // GL vs CPU: the same click stores the same image point, through the photo
  // rectangle inside the border on both canvases (#254 A.2), and #canvas
  // shares its box with the overlay as #glCanvas does.
  const pointerMapping = async (label) => {
    await clearStrokes();
    await settle(`${label} cleared`, 800);
    // Inside the view at about 400 %, where the #canvas stroke is checked too.
    const gl = await strokeAt(0.42, 0.56);
    expect(gl.probe.surface === 'gl', `${label}: the dodge tool left the GL display: ` + JSON.stringify(gl.probe));
    await clearStrokes();
    await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (input.checked) input.click(); })()`);
    await settle(`${label} WebGL off`, 2000);
    expect(await surfaceId() === 'canvas', `${label}: WebGL off did not show #canvas`);
    await clickAt(gl.client.x, gl.client.y);
    await settle(`${label} CPU stroke`, 1500);
    const cpu = (await probe()).strokes.at(-1)?.[0];
    const cpuAlignment = cpu ? await strokeAlignment(`${label} #canvas`, cpu) : null;
    await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (!input.checked) input.click(); })()`);
    await settle(`${label} WebGL on`, 2000);
    const displayWidth = (await frame()).display[0];
    const tolerance = gl.probe.working.width / displayWidth + 0.5;
    expect(cpu && Math.abs(cpu.x - gl.point.x) <= tolerance && Math.abs(cpu.y - gl.point.y) <= tolerance,
      `${label}: GL and CPU store different points for the same click: ` + JSON.stringify({ gl: gl.point, cpu, tolerance }));
    return { gl: gl.point, cpu, cpuAlignment };
  };
  // The dust mask shown with TELEA repairs (no model download), a direct
  // brush of radius 8.
  const setDust = async (on) => {
    await evaluate(`(() => {
      document.getElementById('studioTab-repair')?.click();
      const ai = document.getElementById('dustAiEnabled'); if (ai?.checked) ai.click();
      const show = document.getElementById('dustShowMask'), enabled = document.getElementById('dustRemovalEnabled');
      if (!${on} && show.checked) show.click();
      if (enabled.checked !== ${on}) enabled.click();
      if (${on} && !show.checked) show.click();
      const size = document.getElementById('dustBrushSize'); size.value = '8'; size.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    if (on) {
      await until('dust mask shown', `${ready} && /^(Detected [0-9]+ dust particles|No dust detected)/.test(document.getElementById('dustStatus').textContent)
        && window.__ncBrush.state().tint?.current && window.__ncBrush.state().layer.visible`, 120_000);
    }
    await settle(on ? 'dust mask idle' : 'dust removal off', 1500);
  };
  const dustPointer = (type, x, y) => evaluate(`(() => {
    const gl = document.getElementById('glCanvas');
    const surface = gl.style.display === 'block' ? gl : document.getElementById('canvas');
    surface.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, pointerId: 31, pointerType: 'mouse',
      isPrimary: true, button: 0, buttons: ${type === 'pointerup' ? 0 : 1}, clientX: ${x}, clientY: ${y}, altKey: true }));
  })()`);
  // The dust tint and the live brush (#279): a direct dust stroke (Alt) at a
  // known image point, at 100 % and about 400 % zoom. While the pointer is
  // down #brushFeedback draws the dab at the point the brush records (the
  // pointer, rounded to an image pixel); within 1 CSS px of it on screen. The
  // committed disc is stamped around that pixel (its centre is the pixel's
  // centre) and max-pooled into the tint: its cells lie around that point in
  // the overlay's backing (within a cell), and on screen within 1 CSS px of
  // where the backing puts them.
  const dustAlignment = async (label, points) => {
    const results = [];
    for (const [level, fx, fy] of points) {
      await zoomTo(level);
      const state = await probe();
      const W = state.working.width, H = state.working.height;
      const brush = Number(await evaluate(`document.getElementById('dustBrushSize').value`));
      const x = state.photo.left + state.photo.width * fx, y = state.photo.top + state.photo.height * fy;
      const point = { x: Math.round((x - state.photo.left) * W / state.photo.width), y: Math.round((y - state.photo.top) * H / state.photo.height) };
      const cellsPerPixel = state.overlayPhoto.width / W;
      const span = (brush + 6) * Math.max(1, cellsPerPixel);
      const wantTint = imageToBacking(state, { x: point.x + 0.5, y: point.y + 0.5 });
      expect(!(await backingCentroid(wantTint, span)), `${label} zoom ${level}: the tint is set at the test point before the stroke`);
      await dustPointer('pointerdown', x, y);
      await until(`${label} zoom ${level} live dab`, `window.__ncBrush.state().feedback.drawing && window.__ncBrush.state().feedback.drawn > 0`, 10_000);
      await nextFrames();
      const wantDab = { x: state.photo.left + point.x * state.photo.width / W, y: state.photo.top + point.y * state.photo.height / H };
      const screenSpan = (brush + 6) * state.photo.width / W;
      const dab = await layerCentroid(around(wantDab, screenSpan), 'brushFeedback');
      await dustPointer('pointerup', x, y);
      expect(dab && offBy(dab, wantDab) <= 1,
        `${label} zoom ${level}: #brushFeedback draws the dab more than 1 CSS px off its image point: ` + JSON.stringify({ dab, wantDab, state }));
      await until(`${label} zoom ${level} tint of the stroke`, `(() => {
        const c = document.getElementById('displayOverlay'), x = ${Math.round(wantTint.x)}, y = ${Math.round(wantTint.y)};
        return c.width > x && c.height > y && c.getContext('2d').getImageData(x - 1, y - 1, 3, 3).data.some((v, i) => i % 4 === 3 && v > 0);
      })()`, 60_000);
      await settle(`${label} zoom ${level} dust stroke`, 1000);
      const after = await probe();
      await expectSharedBox(`${label} dust zoom ${level}`, after);
      const tint = await backingCentroid(wantTint, span);
      expect(tint && offBy(tint, wantTint) <= 1,
        `${label} zoom ${level}: the tint of the stroke is off its image point in the overlay's backing: ` + JSON.stringify({ tint, wantTint }));
      const want = backingToClient(after, tint);
      const drawn = await layerCentroid(around(want, screenSpan), 'displayOverlay');
      expect(drawn && offBy(drawn, want) <= 1,
        `${label} zoom ${level}: the tint is drawn more than 1 CSS px off its place: ` + JSON.stringify({ drawn, want, tint, after }));
      results.push({ level, zoom: round(await zoomOf()), dab: [round(dab.x - wantDab.x), round(dab.y - wantDab.y)],
        tint: [round(drawn.x - want.x), round(drawn.y - want.y)], tintBacking: [round(tint.x - wantTint.x), round(tint.y - wantTint.y)] });
    }
    await zoomTo(1);
    return results;
  };

  await setDodge(true);
  await settle('dodge tool on', 1000);
  expect((await frame()).surface === 'gl', 'the dodge tool took the display off the GPU');
  const borderedAlignment = await overlayAlignment('border');
  const borderedMapping = await pointerMapping('border');
  console.log('ok: with the border, dodge strokes land on the same image points on GL and #canvas and the overlay draws them within 1 CSS px '
    + JSON.stringify({ borderedAlignment, borderedMapping }));
  await clearStrokes();
  await setDodge(false);
  await setDust(true);
  expect((await frame()).surface === 'gl', 'the dust mask took the display off the GPU');
  // Each stroke at its own image point (the tint of every earlier one stays),
  // inside the view at about 400 %.
  const borderedDust = await dustAlignment('border', [[1, 0.42, 0.44], [4, 0.46, 0.41]]);
  console.log('ok: with the border, the dust tint and the live dab on #brushFeedback within 1 CSS px ' + JSON.stringify(borderedDust));
  await evaluate(`document.getElementById('sprocketPreviewBtn').click()`);
  await settle('border off', 1500);
  const plainDust = await dustAlignment('no border', [[1, 0.38, 0.52], [4, 0.53, 0.43]]);
  console.log('ok: without the border, the dust tint and the live dab on #brushFeedback within 1 CSS px ' + JSON.stringify(plainDust));
  await setDust(false);
  await setDodge(true);
  await settle('dodge tool on without the border', 1000);
  const plainAlignment = await overlayAlignment('no border');
  const plainMapping = await pointerMapping('no border');
  await clearStrokes();
  await setDodge(false);
  await settle('dodge tool off', 1000);
  console.log('ok: without the border, dodge strokes land on the same image points on GL and #canvas and the overlay draws them within 1 CSS px '
    + JSON.stringify({ plainAlignment, plainMapping }));

  // ---- 3b. Portrait border ----
  await open('', [['display-modes-portrait.png', 1000, 1500]]);
  await until('mode programs ready (portrait)', `window.__ncDisplay.modes().ready`, 60_000);
  const portrait = await borderCheck('portrait');
  expect(portrait.layout.frameHeight > portrait.layout.height && portrait.layout.y > 0 && portrait.layout.frameWidth < portrait.layout.frameHeight,
    'portrait layout: ' + JSON.stringify(portrait.layout));
  console.log('ok: portrait border is a GL underlay equal to composeSprocketFrame ' + JSON.stringify({ layout: portrait.layout, photo: [portrait.mean, portrait.p999] }));

  // ---- 2b. Mode programs failing their self-test: a look keeps the CPU display ----
  await open('&gpuPreview=force&displayModesFail=1', [['display-modes-fail.png', 1500, 1000]]);
  await until('mode self-test failed', `window.__ncDisplay.modes().status === 'failed'`, 60_000);
  await applyLook();
  const failed = await frame();
  expect(failed.surface === 'cpu' && !(await evaluate('window.__ncDisplay.glActive()')), 'a look drew on the GPU after the mode self-test failed: ' + JSON.stringify(failed));
  await evaluate(`(() => { const b = document.getElementById('sprocketPreviewBtn'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
  await settle('border with a failed mode self-test', 1500);
  expect((await frame()).surface === 'cpu', 'the look must keep the CPU display with the border too');
  console.log('ok: with the mode self-test failed a look keeps the CPU display');
}
