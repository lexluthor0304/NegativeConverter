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
// 4. The overlay layer: a dodge stroke lands on the same image point whether GL or
//    #canvas shows the photo, and is drawn within 1 CSS px of that point at 100 %
//    and about 400 % zoom, with and without the border; the layer's backing is the
//    display photo's size and its box is the photo's rectangle.
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
    displayParity, buildPreviewCase, parityFrame,
  } = await import('/src/render/gpuPreviewSelfTest.js');
  const { filmPresets } = await import('/src/silvercore/engine/FilmPresets.js');
  const renderer = createGpuPreviewRenderer(gl);
  renderer.startModesCompile();
  renderer.startApplyCompile();
  for (let i = 0; i < 600 && (renderer.modesStatus() === 'pending' || renderer.applyStatus() === 'pending'); i++) {
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  if (renderer.modesStatus() !== 'linked') return { failed: 'mode programs did not link: ' + renderer.modesError() };
  const report = { selfTest: renderer.modesSelfTest(buildDisplayModesCases()), cases: [] };
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
    const drawn = renderer.drawApply(frame, { ...testCase.step3, stages: testCase.stages }, 96, 64);
    report.cases.push({ name: 'apply + modes', program: 'apply-modes', ...(drawn ? displayParity(testCase.expected, read(96, 64)) : { ok: false, error: 'not drawn' }) });
  }
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
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&previewTier=normal${query}` });
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

  // ---- 4. The overlay layer ----
  const probe = () => evaluate('window.__ncDisplay.overlayProbe()');
  const surfaceId = () => evaluate(`document.getElementById('glCanvas').style.display === 'block' ? 'glCanvas' : 'canvas'`);
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
  // The photo point a stroke at `fraction` of the photo rectangle stores.
  const strokeAt = async (fx, fy) => {
    const before = await probe();
    const x = before.photo.left + before.photo.width * fx, y = before.photo.top + before.photo.height * fy;
    await clickAt(x, y);
    await settle('stroke settled', 1500);
    const after = await probe();
    const points = after.strokes.at(-1);
    expect(points && points.length >= 1, 'the dodge stroke was not recorded: ' + JSON.stringify(after));
    return { client: { x, y }, point: points[0], probe: after };
  };
  // Where the overlay draws a point, from a screenshot with and without the saved
  // strokes shown: the centroid of what changed, in CSS pixels.
  const drawnCentroid = async (probeState) => {
    const clip = { x: probeState.photo.left, y: probeState.photo.top, width: probeState.photo.width, height: probeState.photo.height };
    const container = await evaluate(`(() => { const r = document.getElementById('canvasContainer').getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; })()`);
    clip.x = Math.max(clip.x, container.left); clip.y = Math.max(clip.y, container.top);
    clip.width = Math.min(probeState.photo.left + probeState.photo.width, container.right) - clip.x;
    clip.height = Math.min(probeState.photo.top + probeState.photo.height, container.bottom) - clip.y;
    const shot = async () => decodePng((await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })).result.data);
    const withStroke = await shot();
    await evaluate(`document.getElementById('dodgeBurnShowOverlay').click()`);
    await sleep(300);
    const without = await shot();
    await evaluate(`document.getElementById('dodgeBurnShowOverlay').click()`);
    await sleep(300);
    const sx = withStroke.width / clip.width, sy = withStroke.height / clip.height;
    let sumX = 0, sumY = 0, n = 0;
    for (let y = 0; y < withStroke.height; y++) {
      for (let x = 0; x < withStroke.width; x++) {
        const i = (y * withStroke.width + x) * 4;
        const d = Math.max(Math.abs(withStroke.data[i] - without.data[i]), Math.abs(withStroke.data[i + 1] - without.data[i + 1]), Math.abs(withStroke.data[i + 2] - without.data[i + 2]));
        if (d > 8) { sumX += x + 0.5; sumY += y + 0.5; n++; }
      }
    }
    return n ? { x: clip.x + sumX / n / sx, y: clip.y + sumY / n / sy, pixels: n } : null;
  };
  const expectedClient = (state, point) => ({
    x: state.photo.left + point.x / state.working.width * state.photo.width,
    y: state.photo.top + point.y / state.working.height * state.photo.height,
  });
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
  const overlayAlignment = async (label) => {
    await clearStrokes();
    await settle(`${label} strokes cleared`, 800);
    const { point } = await strokeAt(0.45, 0.47);
    const results = [];
    for (const level of [1, 4]) {
      await zoomTo(level);
      const state = await probe();
      expect(state.overlay && Math.abs(state.overlay.left - state.photo.left) <= 1 && Math.abs(state.overlay.top - state.photo.top) <= 1
        && Math.abs(state.overlay.width - state.photo.width) <= 1 && Math.abs(state.overlay.height - state.photo.height) <= 1,
      `${label} zoom ${level}: the overlay is not over the photo: ` + JSON.stringify(state));
      const drawn = await drawnCentroid(state);
      const want = expectedClient(state, point);
      expect(drawn && Math.abs(drawn.x - want.x) <= 1 && Math.abs(drawn.y - want.y) <= 1,
        `${label} zoom ${level}: the stroke is drawn off its image point: ` + JSON.stringify({ drawn, want, state }));
      results.push({ level, dx: Math.round((drawn.x - want.x) * 100) / 100, dy: Math.round((drawn.y - want.y) * 100) / 100 });
    }
    await zoomTo(1);
    const state = await probe();
    expect(JSON.stringify(state.overlayBacking) === JSON.stringify((await frame()).display),
      `${label}: the overlay backing is not the display photo's size: ` + JSON.stringify({ backing: state.overlayBacking, display: (await frame()).display }));
    return results;
  };
  // GL vs CPU: the same click stores the same image point (HEAD's ratio mapping).
  const pointerMapping = async (label) => {
    await clearStrokes();
    await settle(`${label} cleared`, 800);
    const gl = await strokeAt(0.3, 0.6);
    expect(gl.probe.surface === 'gl', `${label}: the dodge tool left the GL display: ` + JSON.stringify(gl.probe));
    await clearStrokes();
    await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (input.checked) input.click(); })()`);
    await settle(`${label} WebGL off`, 2000);
    expect(await surfaceId() === 'canvas', `${label}: WebGL off did not show #canvas`);
    await clickAt(gl.client.x, gl.client.y);
    await settle(`${label} CPU stroke`, 1500);
    const cpu = (await probe()).strokes.at(-1)?.[0];
    await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (!input.checked) input.click(); })()`);
    await settle(`${label} WebGL on`, 2000);
    const displayWidth = (await frame()).display[0];
    const tolerance = gl.probe.working.width / displayWidth + 0.5;
    expect(cpu && Math.abs(cpu.x - gl.point.x) <= tolerance && Math.abs(cpu.y - gl.point.y) <= tolerance,
      `${label}: GL and CPU store different points for the same click: ` + JSON.stringify({ gl: gl.point, cpu, tolerance }));
    return { gl: gl.point, cpu };
  };

  await setDodge(true);
  await settle('dodge tool on', 1000);
  expect((await frame()).surface === 'gl', 'the dodge tool took the display off the GPU');
  const borderedAlignment = await overlayAlignment('border');
  const borderedMapping = await pointerMapping('border');
  await evaluate(`document.getElementById('sprocketPreviewBtn').click()`);
  await settle('border off', 1500);
  const plainAlignment = await overlayAlignment('no border');
  const plainMapping = await pointerMapping('no border');
  await clearStrokes();
  await setDodge(false);
  await settle('dodge tool off', 1000);
  console.log('ok: dodge strokes land on the same image points on GL and #canvas and the overlay draws them within 1 CSS px '
    + JSON.stringify({ borderedAlignment, plainAlignment, borderedMapping, plainMapping }));

  // ---- 3b. Portrait border ----
  await open('', [['display-modes-portrait.png', 1000, 1500]]);
  await until('mode programs ready (portrait)', `window.__ncDisplay.modes().ready`, 60_000);
  const portrait = await borderCheck('portrait');
  expect(portrait.layout.frameHeight > portrait.layout.height && portrait.layout.y > 0 && portrait.layout.frameWidth < portrait.layout.frameHeight,
    'portrait layout: ' + JSON.stringify(portrait.layout));
  console.log('ok: portrait border is a GL underlay equal to composeSprocketFrame ' + JSON.stringify({ layout: portrait.layout, photo: [portrait.mean, portrait.p999] }));

  // ---- 2b. Mode programs failing their self-test: a look keeps the CPU display ----
  await open('&gpuPreview=modes-fail', [['display-modes-fail.png', 1500, 1000]]);
  await until('mode self-test failed', `window.__ncDisplay.modes().status === 'failed'`, 60_000);
  await applyLook();
  const failed = await frame();
  expect(failed.surface === 'cpu' && !(await evaluate('window.__ncDisplay.glActive()')), 'a look drew on the GPU after the mode self-test failed: ' + JSON.stringify(failed));
  await evaluate(`(() => { const b = document.getElementById('sprocketPreviewBtn'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); })()`);
  await settle('border with a failed mode self-test', 1500);
  expect((await frame()).surface === 'cpu', 'the look must keep the CPU display with the border too');
  console.log('ok: with the mode self-test failed a look keeps the CPU display');
}
