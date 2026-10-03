import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const UPNG = require('upng-js');

// The expired-film rescue, end to end in the real Studio: the separate entry,
// an aged positive and an aged negative synthesised from the fixture, the
// diagnosis, the hold-to-compare, undo, the single export (worker path) and
// the batch export of a frame that was never opened (its own measurement).
export async function runExpiredFilmSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root = null }) {
  const capture = async name => {
    if (!root) return;
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) fail('expired screenshot failed');
    mkdirSync(join(root, 'output', 'playwright'), { recursive: true });
    writeFileSync(join(root, 'output', 'playwright', name), Buffer.from(shot.result.data, 'base64'));
  };
  // The normal preview tier, so the GL frame is the display source's size (#253).
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&previewTier=normal&gpuPreview=force` });
  await waitFor('expired boot', `!!document.getElementById('studioImportAutoCrop') && !!document.getElementById('uploadExpiredBtn')`);
  await installDialogAutoAccept();
  await wait(500);
  await evaluate(`(() => {
    const crop = document.getElementById('studioImportAutoCrop'); if (crop.checked) crop.click();
    const auto = document.getElementById('importFilmTypeAuto'); if (!auto.checked) auto.click();
    window.__expiredExports = [];
    window.__expiredDownloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function() {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      const name = this.download;
      window.__expiredDownloads.push(fetch(this.href).then(r => r.blob()).then(blob => new Promise(resolve => {
        const reader = new FileReader(); reader.onload = () => resolve({ name, dataUrl: reader.result }); reader.readAsDataURL(blob);
      })));
    };
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      if (blob instanceof Blob && blob.type === 'image/png') window.__expiredExports.push(blob);
      return create(blob);
    };
  })()`);

  // The entry button switches the session before the picker opens; keep the
  // OS picker closed and hand the files to the input directly.
  await evaluate(`(() => {
    const label = document.getElementById('uploadExpiredBtn');
    label.addEventListener('click', event => event.preventDefault(), { once: true });
    label.click();
  })()`);
  if (!await evaluate(`document.body.classList.contains('studio-expired') && !document.getElementById('studioTab-expired').hidden`)) fail('the expired-roll entry did not switch the session');

  // Age the fixture positive the way an old roll does (fog, range loss,
  // per-layer gamma, green shadows / magenta highlights), then also present
  // the same scene as an orange-masked colour negative.
  await evaluate(`(async () => {
    const bitmap = await createImageBitmap(await (await fetch('/test-fixtures/negative-sample.jpg')).blob());
    const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
    const surface = document.createElement('canvas'); surface.width = w; surface.height = h;
    const ctx = surface.getContext('2d'); ctx.drawImage(bitmap, 0, 0, w, h); bitmap.close();
    const original = ctx.getImageData(0, 0, w, h);
    const AGE = { fog: [0.30, 0.36, 0.42], top: [0.86, 0.76, 0.90], gamma: [0.85, 1.05, 0.95] };
    const aged = ctx.createImageData(w, h);
    for (let i = 0; i < aged.data.length; i += 4) {
      // Light piping from the left edge: extra fog that fades towards the right.
      const edgeFog = 0.08 * (1 - ((i / 4) % w) / (w - 1));
      for (let c = 0; c < 3; c++) {
        const x = original.data[i + c] / 255;
        let y = AGE.fog[c] + edgeFog + (AGE.top[c] - AGE.fog[c] - edgeFog) * Math.pow(x, AGE.gamma[c]);
        if (c === 1 && x < 0.4) { const t = x / 0.4; y += 0.06 * 4 * t * (1 - t); }
        if (c !== 1 && x > 0.6) { const t = (x - 0.6) / 0.4; y += 0.05 * 4 * t * (1 - t); }
        aged.data[i + c] = Math.round(Math.max(0, Math.min(1, y)) * 255);
      }
      aged.data[i + 3] = 255;
    }
    window.__expiredOriginal = original;
    window.__expiredAged = aged;
    const files = [];
    ctx.putImageData(aged, 0, 0);
    files.push(new File([await new Promise(r => surface.toBlob(r, 'image/png'))], 'expired-positive.png', { type: 'image/png' }));
    // As a scan of a colour negative: the aged scene inverted through an
    // orange mask, with the unexposed rebate around it as a real scan shows.
    const border = Math.round(Math.min(w, h) * 0.06);
    const negativeSurface = document.createElement('canvas'); negativeSurface.width = w + border * 2; negativeSurface.height = h + border * 2;
    const negativeCtx = negativeSurface.getContext('2d');
    const negative = negativeCtx.createImageData(negativeSurface.width, negativeSurface.height); const base = [230, 185, 145];
    for (let y = 0; y < negativeSurface.height; y++) for (let x = 0; x < negativeSurface.width; x++) {
      const o = (y * negativeSurface.width + x) * 4;
      const inside = x >= border && x < w + border && y >= border && y < h + border;
      const src = inside ? ((y - border) * w + (x - border)) * 4 : -1;
      for (let c = 0; c < 3; c++) negative.data[o + c] = inside ? Math.round(base[c] * (1 - aged.data[src + c] / 255)) : base[c];
      negative.data[o + 3] = 255;
    }
    negativeCtx.putImageData(negative, 0, 0);
    files.push(new File([await new Promise(r => negativeSurface.toBlob(r, 'image/png'))], 'expired-negative.png', { type: 'image/png' }));
    const transfer = new DataTransfer(); files.forEach(f => transfer.items.add(f));
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('aged positive imported', `${ready} && document.querySelectorAll('.file-list-item').length === 2`, 150000);
  // The global measurement shows at once; OpenCV's fog map follows once it has loaded.
  await waitFor('OpenCV fog map', `[...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120000);
  // #253: once the mode programs passed their self-test, the rescued preview
  // is drawn by the preview shader on #glCanvas.
  await waitFor('rescued preview on the GPU', `window.__ncDisplay.modes().ready && window.__ncDisplay.glActive() && document.getElementById('glCanvas').style.display === 'block'`, 60000);
  await wait(1500);

  const document_disabled = state => state.spatialDisabled;
  const panel = `(() => ({
    spatialDisabled: document.getElementById('expiredUnevenFog').disabled || document.getElementById('expiredLocalContrast').disabled,
    selected: document.getElementById('studioTab-expired').getAttribute('aria-selected'),
    hidden: document.getElementById('studioTab-expired').hidden,
    enabled: document.getElementById('expiredEnabled').checked,
    state: document.getElementById('expiredDiagnosis').dataset.state,
    lines: [...document.querySelectorAll('#expiredDiagnosis li')].map(li => li.textContent),
    type: document.querySelector('.film-type-btn.active').dataset.type,
    sliders: Object.fromEntries(['expiredLevels', 'expiredNeutralize', 'expiredCrossover', 'expiredBrightness', 'expiredContrast'].map(id => [id, document.getElementById(id).value])),
    glShown: document.getElementById('glCanvas').style.display === 'block',
    controlsHidden: document.getElementById('expiredControls').hidden
  }))()`;
  const first = await evaluate(panel);
  if (first.selected !== 'true' || first.hidden || !first.enabled || first.state !== 'analysed' || first.controlsHidden) fail(`expired tab after import: ${JSON.stringify(first)}`);
  if (first.type !== 'positive') fail(`aged positive was not identified as a positive: ${JSON.stringify(first)}`);
  if (!/^Source: positive scan/.test(first.lines[0]) || !/^Fog: black point raised \d+%/.test(first.lines[1])) fail(`diagnosis lines: ${JSON.stringify(first.lines)}`);
  if (!/shadows green/.test(first.lines[3]) || !/highlights magenta/.test(first.lines[3])) fail(`diagnosis missed the synthetic crossover: ${JSON.stringify(first.lines)}`);
  const unevenLine = first.lines.find(line => /^Uneven fog:/.test(line)) || '';
  const unevenMatch = unevenLine.match(/differs by (\d+)%/);
  if (!unevenMatch || Number(unevenMatch[1]) < 4) fail(`OpenCV did not read the left-edge fog: ${JSON.stringify(first.lines)}`);
  if (document_disabled(first)) fail('spatial sliders should be live once OpenCV measured');
  if (!first.glShown) fail('the rescued preview must render on #glCanvas: ' + JSON.stringify(await evaluate('window.__ncDisplay.modes()')));
  await capture('expired-positive.png');
  console.log(`ok: expired entry, tab and diagnosis (${first.lines.join(' | ')})`);

  // What is on screen (a real screenshot of whichever canvas is displayed,
  // WebGL or CPU) against the scene before it aged, resampled to the same size.
  const decodePng = base64 => {
    const png = UPNG.decode(Buffer.from(base64, 'base64'));
    return { width: png.width, height: png.height, data: new Uint8Array(UPNG.toRGBA8(png)[0]) };
  };
  const references = new Map();
  const measure = async () => {
    const rect = await evaluate(`(() => {
      const el = document.getElementById('glCanvas').style.display !== 'none' ? document.getElementById('glCanvas') : document.getElementById('canvas');
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), id: el.id };
    })()`);
    if (rect.width < 50 || rect.height < 50) fail(`preview canvas is not visible: ${JSON.stringify(rect)}`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
    const shown = decodePng(shot.result.data);
    const key = `${shown.width}x${shown.height}`;
    if (!references.has(key)) {
      const refs = await evaluate(`(() => {
        const w = ${shown.width}, h = ${shown.height};
        const render = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); const d = document.createElement('canvas'); d.width = w; d.height = h; d.getContext('2d').drawImage(c, 0, 0, w, h); return d.toDataURL('image/png').split(',')[1]; };
        return { original: render(window.__expiredOriginal), aged: render(window.__expiredAged) };
      })()`);
      references.set(key, { original: decodePng(refs.original).data, aged: decodePng(refs.aged).data });
    }
    const { original, aged } = references.get(key);
    let errShown = 0; let errAged = 0; let n = 0; let sum = 0; const cast = [0, 0, 0];
    // Signed error per third of the width: an uneven fog leaves the left
    // third brighter than the right one, a flattened frame does not.
    const thirds = [0, 0, 0]; const thirdsAged = [0, 0, 0]; const thirdCounts = [0, 0, 0];
    for (let i = 0; i < shown.data.length; i += 4) {
      const L = 0.2126 * shown.data[i] + 0.7152 * shown.data[i + 1] + 0.0722 * shown.data[i + 2];
      const third = Math.min(2, Math.floor((((i / 4) % shown.width) / shown.width) * 3));
      for (let c = 0; c < 3; c++) {
        errShown += Math.abs(shown.data[i + c] - original[i + c]);
        errAged += Math.abs(aged[i + c] - original[i + c]);
        cast[c] += shown.data[i + c] - L;
        sum += shown.data[i + c];
        thirds[third] += shown.data[i + c] - original[i + c];
        thirdsAged[third] += aged[i + c] - original[i + c];
      }
      thirdCounts[third] += 3;
      n += 3;
    }
    const tilt = (thirds[0] / thirdCounts[0]) - (thirds[2] / thirdCounts[2]);
    const tiltAged = (thirdsAged[0] / thirdCounts[0]) - (thirdsAged[2] / thirdCounts[2]);
    return { errShown: errShown / n, errAged: errAged / n, mean: sum / n, cast: cast.map(v => Math.round(v / (n / 3) * 10) / 10), tilt, tiltAged, canvas: rect.id, width: shown.width, height: shown.height };
  };
  const rescued = await measure();
  if (rescued.canvas !== 'glCanvas') fail(`the rescued preview must render on #glCanvas (${rescued.canvas})`);
  if (!(rescued.errShown < rescued.errAged * 0.6)) fail(`rescue did not bring the aged positive back: ${JSON.stringify(rescued)}`);
  if (!(rescued.tiltAged > 8) || !(Math.abs(rescued.tilt) < rescued.tiltAged * 0.5)) fail(`OpenCV fog surface did not flatten the left-edge fog: ${JSON.stringify({ tilt: rescued.tilt, tiltAged: rescued.tiltAged })}`);
  console.log(`ok: aged positive error ${rescued.errAged.toFixed(1)} -> ${rescued.errShown.toFixed(1)} levels; left-right tilt ${rescued.tiltAged.toFixed(1)} -> ${rescued.tilt.toFixed(1)}`);
  // Turning the OpenCV stage down brings the tilt back.
  await evaluate(`(() => { const s = document.getElementById('expiredUnevenFog'); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(800);
  const unflattened = await measure();
  if (!(Math.abs(unflattened.tilt) > Math.abs(rescued.tilt) + 3)) fail(`uneven-fog slider has no effect: ${JSON.stringify({ rescued: rescued.tilt, unflattened: unflattened.tilt })}`);
  await evaluate(`(() => { const s = document.getElementById('expiredUnevenFog'); s.value = '100'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(800);
  console.log('ok: uneven-fog strength drives the OpenCV surface');

  // #253: the GL frame against pixelAdjustments.js ('full') on the same display
  // source (mean <= 1 level, p99.9 <= 3), with the fog surface, with local
  // contrast 30, and held to compare; drags of the rescue strengths and C/M/Y
  // stay on the GPU with no main-thread Step-3 pass beyond the histogram sample.
  const glParity = async (label) => {
    const result = await evaluate('window.__ncDisplay.glParity()');
    if (result.error || !(result.mean <= 1 && result.p999 <= 3)) fail(`GL rescue parity (${label}): ${JSON.stringify(result)}`);
    return result;
  };
  const touched = ['expiredLevels', 'expiredCrossover', 'expiredUnevenFog', 'expiredLocalContrast', 'cyan'];
  const original = await evaluate(`Object.fromEntries(${JSON.stringify(touched)}.map(id => [id, document.getElementById(id).value]))`);
  const withFog = await glParity('offsets + fog');
  if (withFog.program !== 'modes' || !withFog.stages?.rescue || !withFog.stages.fog) fail('the rescue did not draw with the mode program and the fog surface: ' + JSON.stringify(withFog));
  await evaluate(`(() => { const s = document.getElementById('expiredLocalContrast'); s.value = '30'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(800);
  const withLocal = await glParity('local contrast 30');
  if (!(withLocal.stages?.local > 0)) fail('local contrast did not reach the shader: ' + JSON.stringify(withLocal));
  const dragged = await evaluate(`(async () => {
    window.__ncDisplay.resetCounters();
    const protos = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean);
    let draws = 0;
    const originals = protos.map(proto => ({ proto, draw: proto.drawArrays }));
    for (const { proto, draw } of originals) proto.drawArrays = function (...args) { if (this.canvas?.id === 'glCanvas') draws++; return draw.apply(this, args); };
    const out = {};
    try {
      for (const [id, values] of [['expiredLevels', [90, 80, 70, 60, 70, 80]], ['expiredCrossover', [80, 60, 40, 60, 80, 100]],
        ['expiredUnevenFog', [80, 60, 40, 60, 80, 100]], ['cyan', [4, 8, 12, 8, 4, 0]]]) {
        const el = document.getElementById(id), start = draws, histogramBefore = window.__ncDisplay.counters().mainAdjustments;
        for (const value of values) {
          el.value = String(value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 4)));
        }
        out[id] = { draws: draws - start, glShown: document.getElementById('glCanvas').style.display === 'block',
          mainPasses: window.__ncDisplay.counters().mainAdjustments - histogramBefore };
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } finally {
      for (const { proto, draw } of originals) proto.drawArrays = draw;
    }
    return { out, counters: window.__ncDisplay.counters() };
  })()`);
  for (const [id, entry] of Object.entries(dragged.out)) {
    if (!entry.glShown || entry.draws < 6) fail(`${id} drag did not draw every value change on the GPU: ${JSON.stringify(dragged)}`);
  }
  if (dragged.counters.mainAdjustMaxPixels > 24_576) fail('a rescue drag ran a Step-3 pass beyond the histogram sample on the main thread: ' + JSON.stringify(dragged));
  await wait(800);
  await evaluate(`document.getElementById('expiredCompareBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))`);
  await wait(700);
  const heldParity = await glParity('hold to compare');
  await evaluate(`document.getElementById('expiredCompareBtn').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))`);
  await wait(700);
  if (heldParity.stages?.rescue) fail('hold-to-compare kept the rescue on screen: ' + JSON.stringify(heldParity));
  // The rest of the scenario compares against the measured strengths.
  await evaluate(`(() => {
    for (const [id, value] of Object.entries(${JSON.stringify(original)})) {
      const s = document.getElementById(id); s.value = value;
      s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await wait(800);
  console.log('ok: the rescue draws on the GPU within the parity budget ' + JSON.stringify({ fog: [withFog.mean, withFog.p999], local: [withLocal.mean, withLocal.p999], held: [heldParity.mean, heldParity.p999], drags: dragged.out }));

  // Hold to see before: the screen shows the unrescued positive while held.
  await evaluate(`document.getElementById('expiredCompareBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))`);
  await wait(700);
  const held = await measure();
  await evaluate(`document.getElementById('expiredCompareBtn').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))`);
  await wait(700);
  const released = await measure();
  if (!(held.errShown > rescued.errShown * 1.5) || !(released.errShown < rescued.errShown * 1.2)) fail(`hold-to-compare: ${JSON.stringify({ rescued, held, released })}`);
  console.log('ok: hold-to-compare shows the frame before the rescue and restores it');

  // Off, undo, on again.
  await evaluate(`document.getElementById('expiredEnabled').click()`);
  await wait(700);
  const off = await evaluate(panel);
  if (off.enabled || !off.controlsHidden || off.hidden) fail(`disabling the rescue: ${JSON.stringify(off)}`);
  const offMeasure = await measure();
  if (!(offMeasure.errShown > rescued.errShown * 1.5)) fail(`disabled rescue still corrected: ${JSON.stringify(offMeasure)}`);
  await evaluate(`document.getElementById('undoBtn').click()`);
  await wait(900);
  const undone = await evaluate(panel);
  if (!undone.enabled || undone.controlsHidden || undone.state !== 'analysed') fail(`undo did not restore the rescue: ${JSON.stringify(undone)}`);
  console.log('ok: rescue toggles off and undo restores it');

  // A slider moves the preview, the number input follows, automatic values come back.
  const before = await measure();
  await evaluate(`(() => { const s = document.getElementById('expiredBrightness'); s.value = String(Number(s.value) + 40); s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(800);
  const brighter = await measure();
  const readout = await evaluate(`({ value: document.getElementById('expiredBrightnessValue').value, slider: document.getElementById('expiredBrightness').value })`);
  if (readout.value !== readout.slider) fail(`brightness readout ${readout.value} does not follow the slider ${readout.slider}`);
  if (!(brighter.mean > before.mean + 4)) fail(`brightness slider did not lift the preview: ${JSON.stringify({ before, brighter })}`);
  await evaluate(`document.getElementById('expiredResetBtn').click()`);
  await wait(800);
  const reset = await measure();
  if (Math.abs(reset.errShown - before.errShown) > 1.5 || Math.abs(reset.mean - before.mean) > 2) fail(`automatic values did not restore the measured defaults: ${JSON.stringify({ before, reset })}`);
  console.log('ok: sliders drive the preview and automatic values come back');

  // Single export goes through the worker with the same curves.
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  await waitFor('expired single export', `window.__expiredExports.length > 0`, 120000);
  const exported = await evaluate(`(async () => {
    const bitmap = await createImageBitmap(window.__expiredExports.at(-1));
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0); const out = ctx.getImageData(0, 0, c.width, c.height).data;
    const original = window.__expiredOriginal.data, aged = window.__expiredAged.data;
    if (out.length !== original.length) return { mismatch: [c.width, c.height, window.__expiredOriginal.width, window.__expiredOriginal.height] };
    let errOut = 0, errAged = 0; for (let i = 0; i < out.length; i += 4) for (let k = 0; k < 3; k++) { errOut += Math.abs(out[i + k] - original[i + k]); errAged += Math.abs(aged[i + k] - original[i + k]); }
    return { errOut: errOut / (out.length * 0.75), errAged: errAged / (out.length * 0.75) };
  })()`);
  if (exported.mismatch || !(exported.errOut < exported.errAged * 0.6)) fail(`exported PNG is not rescued: ${JSON.stringify(exported)}`);
  console.log(`ok: single export rescued (${exported.errAged.toFixed(1)} -> ${exported.errOut.toFixed(1)} levels)`);

  // Batch export: the negative was never opened, so its rescue is measured
  // from its own conversion inside the export path.
  const downloadsBefore = await evaluate('window.__expiredDownloads.length');
  await evaluate(`document.getElementById('exportAllBtn').click()`);
  await waitFor('expired batch export', `window.__expiredDownloads.length >= ${downloadsBefore} + 2`, 180000);
  const downloads = await evaluate('Promise.all(window.__expiredDownloads.slice(-2))');
  const negativeFile = downloads.find(d => /negative/.test(d.name));
  if (!negativeFile) fail(`batch export did not include the negative: ${downloads.map(d => d.name).join(', ')}`);
  const bytes = Buffer.from(negativeFile.dataUrl.split(',')[1], 'base64');
  const decoded = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  void decoded;
  // The negative was inverted from the aged positive, so its converted and
  // rescued export (inside the rebate) must land far closer to the scene
  // before it aged than the aged frame does.
  const batchResult = await evaluate(`(async () => {
    const bitmap = await createImageBitmap(await (await fetch(${JSON.stringify(negativeFile.dataUrl)})).blob());
    const original = window.__expiredOriginal, aged = window.__expiredAged;
    const border = Math.round(Math.min(original.width, original.height) * 0.06);
    if (bitmap.width !== original.width + border * 2 || bitmap.height !== original.height + border * 2) return { mismatch: [bitmap.width, bitmap.height, original.width, original.height, border] };
    const c = document.createElement('canvas'); c.width = original.width; c.height = original.height;
    const ctx = c.getContext('2d'); ctx.drawImage(bitmap, -border, -border);
    const out = ctx.getImageData(0, 0, c.width, c.height).data;
    let errOut = 0, errAged = 0; const cast = [0, 0, 0]; let n = 0;
    for (let i = 0; i < out.length; i += 4) {
      const L = 0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2];
      for (let k = 0; k < 3; k++) { errOut += Math.abs(out[i + k] - original.data[i + k]); errAged += Math.abs(aged.data[i + k] - original.data[i + k]); cast[k] += out[i + k] - L; }
      n++;
    }
    return { errOut: errOut / (n * 3), errAged: errAged / (n * 3), spread: Math.max(...cast) / n - Math.min(...cast) / n };
  })()`);
  if (batchResult.mismatch || !(batchResult.errOut < batchResult.errAged * 0.6) || !(batchResult.spread < 20)) fail(`batch-exported negative is not rescued: ${JSON.stringify(batchResult)}`);
  console.log(`ok: never-opened negative batch-exported, converted and rescued (${batchResult.errAged.toFixed(1)} -> ${batchResult.errOut.toFixed(1)} levels, spread ${batchResult.spread.toFixed(1)})`);

  // Open the negative: identified by its rebate, converted first, then
  // rescued from the converted positive with its own diagnosis.
  await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
  await waitFor('aged negative opened', `${ready} && document.getElementById('studioFilename').textContent === 'expired-negative.png'`, 150000);
  await wait(1200);
  const second = await evaluate(panel);
  if (second.type !== 'color') fail(`aged negative with a rebate was not identified as a colour negative: ${JSON.stringify(second)}`);
  if (!second.enabled || second.state !== 'analysed' || !/^Source: Color, converted/.test(second.lines[0])) fail(`negative diagnosis: ${JSON.stringify(second)}`);
  await capture('expired-negative.png');
  const negativeShown = await measure();
  if (negativeShown.canvas !== 'glCanvas' || !(Math.max(...negativeShown.cast) - Math.min(...negativeShown.cast) < 14)) fail(`rescued negative preview carries a cast: ${JSON.stringify(negativeShown)}`);
  console.log(`ok: expired negative converted then rescued (channel spread ${(Math.max(...negativeShown.cast) - Math.min(...negativeShown.cast)).toFixed(1)})`);

  // The menu entry leaves the flow: the tab goes away and the photo is no longer rescued.
  await evaluate(`document.getElementById('studioExpiredMode').click()`);
  await wait(700);
  const left = await evaluate(`(() => ({ flow: document.body.classList.contains('studio-expired'), hidden: document.getElementById('studioTab-expired').hidden, enabled: document.getElementById('expiredEnabled').checked, active: document.querySelector('.studio-tabs [aria-selected="true"]').id }))()`);
  if (left.flow || !left.hidden || left.enabled || left.active === 'studioTab-expired') fail(`leaving the flow: ${JSON.stringify(left)}`);
  // Compare exported pixels: enabling rescue switches between WebGL and CPU
  // previews, and a hidden backing canvas can contain an older render.
  const exportColorPixels = async () => {
    const count = await evaluate('window.__expiredExports.length');
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await waitFor('color correction verification export', `window.__expiredExports.length > ${count} && !document.getElementById('exportSingleBtn').disabled`, 120000);
    return evaluate(`(async () => {
      const bitmap = await createImageBitmap(window.__expiredExports.at(-1));
      const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
      c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
      return { width: c.width, height: c.height, pixels: c.toDataURL() };
    })()`);
  };
  const ordinaryPixels = await exportColorPixels();
  // Ordinary negative workflow exposes the same algorithm above CMYD, even
  // with Advanced off. One action, one undo; geometry and manual CMYD survive.
  await evaluate(`(() => { document.getElementById('studioTab-edit').click(); const advanced = document.getElementById('studioAdvancedPanels'); if (advanced.getAttribute('aria-pressed') === 'true') advanced.click(); })()`);
  const ordinary = await evaluate(`(() => {
    const button = document.getElementById('studioColorCorrect');
    const console = document.getElementById('consoleSection');
    return { visible: button.getBoundingClientRect().height >= 44 && !button.disabled,
      above: !!(button.compareDocumentPosition(console) & Node.DOCUMENT_POSITION_FOLLOWING),
      label: button.textContent.trim(), advanced: document.getElementById('studioAdvancedPanels').getAttribute('aria-pressed') };
  })()`);
  if (!ordinary.visible || !ordinary.above || ordinary.label !== 'One-click color correction' || ordinary.advanced !== 'false') fail('ordinary color correction entry: ' + JSON.stringify(ordinary));
  await evaluate(`document.getElementById('studioColorCorrect').click()`);
  await waitFor('one-click color correction applied', `document.getElementById('expiredEnabled').checked && document.getElementById('expiredDiagnosis').dataset.state === 'analysed'`);
  await wait(1600);
  const corrected = await evaluate(`(() => {
    return {
      active: document.querySelector('.studio-tabs [aria-selected="true"]').id,
      type: document.querySelector('.film-type-btn.active').dataset.type,
      status: !document.getElementById('studioColorCorrectStatus').hidden,
      session: document.getElementById('studioExpiredMode').getAttribute('aria-pressed') };
  })()`);
  const correctedPixels = await exportColorPixels();
  if (correctedPixels.pixels === ordinaryPixels.pixels || correctedPixels.width !== ordinaryPixels.width || correctedPixels.height !== ordinaryPixels.height || corrected.active !== 'studioTab-edit' || corrected.type !== 'color' || !corrected.status || corrected.session !== 'false') fail('ordinary one-click correction: ' + JSON.stringify(corrected));
  await capture('one-click-color-correction.png');
  await evaluate(`document.getElementById('undoBtn').click()`);
  await waitFor('one-click correction undo', `!document.getElementById('expiredEnabled').checked`);
  await wait(1000);
  const undonePixels = await exportColorPixels();
  if (undonePixels.pixels !== ordinaryPixels.pixels) fail('one-click correction undo changed exported pixels');
  console.log('ok: ordinary negative one-click correction is prominent above CMYD, changes pixels, preserves geometry/type/tab, and undoes in one step');

  await evaluate(`document.getElementById('studioExpiredMode').click()`);
  await wait(700);
  const back = await evaluate(`(() => ({ flow: document.body.classList.contains('studio-expired'), enabled: document.getElementById('expiredEnabled').checked, active: document.querySelector('.studio-tabs [aria-selected="true"]').id, state: document.getElementById('expiredDiagnosis').dataset.state }))()`);
  if (!back.flow || !back.enabled || back.active !== 'studioTab-expired' || back.state !== 'analysed') fail(`re-entering the flow: ${JSON.stringify(back)}`);
  console.log('ok: menu entry leaves and re-enters the expired flow');

  // The fog surface (interactive, one-click correction and the batch export
  // of a never-opened frame) was measured in the auto-frame worker: the page
  // never booted its own OpenCV (#245).
  const realm = await evaluate(`({ cv: typeof window.cv, script: !!document.querySelector('script[data-opencv-loader]'), tasks: { ...window.__ncAnalysis.tasks } })`);
  if (realm.cv !== 'undefined' || realm.script || realm.tasks.fallback || realm.tasks.worker < 2) fail('the expired rescue loaded OpenCV in the page: ' + JSON.stringify(realm));
  console.log(`ok: fog surfaces measured in the worker (${realm.tasks.worker} requests), no OpenCV in the page`);

  await runExpiredRollRetypeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port });
}

// #229 review R1-017: an expired-roll session imports a B&W roll without
// rebates (as bw-roll-import-smoke.mjs). The leader shows a holder edge and no
// film evidence of its own (noMask): it opens as a positive and is measured as
// one, then the roll's decision (#231) flips it to B&W. Its stored rescue
// measurement, and the strengths it sets, must be of the B&W frame. The scans
// are dense (mostly dark), so the B&W reading is bright where the positive
// reading is dark: the leveled midtones sit high and the rescue darkens
// (brightness <= 0), where the positive's measurement lifts. "These are
// positives" then brings the positive reading and its measurement back.
export async function runExpiredRollRetypeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const count = 5;
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&gpuPreview=force` });
  await waitFor('expired roll boot', `!!document.getElementById('autoRollOnImport') && !!document.getElementById('uploadExpiredBtn')`);
  await installDialogAutoAccept();
  await wait(1000);
  // The roll decision needs automatic roll import (see bw-roll-import-smoke.mjs).
  const autoRollBefore = await evaluate(`(() => { const key = 'nc_auto_roll_import_v1', before = localStorage.getItem(key); localStorage.setItem(key, 'on'); document.getElementById('autoRollOnImport').checked = true; return before; })()`);
  await evaluate(`(() => {
    const crop = document.getElementById('studioImportAutoCrop'); if (crop.checked) crop.click();
    const auto = document.getElementById('importFilmTypeAuto'); if (!auto.checked) auto.click();
    const projects = window.__expiredRollProjects = [];
    const actions = window.__expiredRollActions = [];
    new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
      const action = node.querySelector?.('.toast-action');
      if (action?.dataset.toastAction === 'rollPositives') actions.push(action);
    } }).observe(document.getElementById('toastContainer'), { childList: true });
    const revoke = URL.revokeObjectURL.bind(URL), pending = new Set();
    URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download.endsWith('.ncroll.json')) return;
      const url = this.href; pending.add(url);
      projects.push(fetch(url).then(r => r.json()).finally(() => { pending.delete(url); revoke(url); }));
    };
    const label = document.getElementById('uploadExpiredBtn');
    label.addEventListener('click', event => event.preventDefault(), { once: true });
    label.click();
  })()`);
  if (!await evaluate(`document.body.classList.contains('studio-expired')`)) fail('the expired-roll entry did not switch the session');
  await evaluate(`(async () => {
    const dt = new DataTransfer();
    for (let n = 1; n <= ${count}; n++) {
      const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 150;
      const ctx = canvas.getContext('2d'), image = ctx.createImageData(200, 150);
      for (let y = 0; y < 150; y++) for (let x = 0; x < 200; x++) {
        const t = ((x + y * 2 + n * 17) % 170) / 169, v = 18 + Math.round(150 * t * t);
        image.data.set(n === 1 && x < 32 ? [34, 44, 70, 255] : [v, v, v, 255], (y * 200 + x) * 4);
      }
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      dt.items.add(new File([blob], 'expired-roll-' + n + '.png', { type: 'image/png', lastModified: n }));
    }
    const input = document.getElementById('folderInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('expired roll analysed', `${ready} && document.getElementById('rollAnalysisStatus').textContent.includes('${count}/${count}')`, 180000);
  await waitFor('expired roll leader flipped to B&W', `${ready} && document.querySelector('.film-type-btn.active')?.dataset.type === 'bw'`, 30000);
  await waitFor('expired roll leader measured', `${ready} && document.getElementById('expiredDiagnosis').dataset.state === 'analysed'
    && [...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120000);
  await wait(1500);
  const leaderMeasurement = async label => {
    await waitFor('expired roll settled', ready, 60000);
    await evaluate(`document.getElementById('studioSaveProject').click()`);
    await waitFor('expired roll project', `window.__expiredRollProjects.length > 0`);
    const project = await evaluate(`window.__expiredRollProjects.shift()`);
    const leader = project.files.find(file => file.name === 'expired-roll-1.png')?.settings;
    const measured = leader?.expiredAnalysis ? {
      filmType: leader.filmType, reason: leader.filmTypeReason, enabled: leader.expiredEnabled,
      leveledMedian: leader.expiredAnalysis.leveledMedian, lumMedian: leader.expiredAnalysis.lumMedian, spatial: Boolean(leader.expiredAnalysis.spatial),
      brightness: leader.expiredBrightness, contrast: leader.expiredContrast
    } : { filmType: leader?.filmType, enabled: leader?.expiredEnabled, analysis: null };
    console.log(`expired roll leader ${label}:`, JSON.stringify(measured));
    return measured;
  };
  try {
    const flipped = await leaderMeasurement('after the flip');
    if (flipped.filmType !== 'bw' || !flipped.enabled || !flipped.spatial) fail('the expired roll leader was not rescued as B&W: ' + JSON.stringify(flipped));
    if (!(flipped.leveledMedian > 0.55) || !(flipped.brightness <= 0)) fail('the leader kept the measurement of its positive reading after the flip: ' + JSON.stringify(flipped));
    console.log('ok: an expired roll\'s leader flipped to B&W is measured as B&W, with the strengths that measurement sets');
    // "These are positives" converts the open leader again (no processNegative):
    // the positive reading is measured once its frame has settled.
    if (!await evaluate(`window.__expiredRollActions.length > 0`)) fail('no "These are positives" action was offered');
    await evaluate(`window.__expiredRollActions[0].click()`);
    await waitFor('expired roll corrected to positive', `${ready} && document.querySelector('.film-type-btn.active')?.dataset.type === 'positive'
      && document.getElementById('expiredDiagnosis').dataset.state === 'analysed'
      && [...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120000);
    await wait(1500);
    const corrected = await leaderMeasurement('after These are positives');
    if (corrected.filmType !== 'positive' || !corrected.enabled || !corrected.spatial) fail('the corrected leader was not rescued as a positive: ' + JSON.stringify(corrected));
    if (!(corrected.leveledMedian < 0.45) || !(corrected.brightness > 0)) fail('the leader kept the B&W measurement after These are positives: ' + JSON.stringify(corrected));
    console.log('ok: These are positives measures the leader\'s positive reading again, with its strengths');
  } finally {
    await evaluate(`(() => { const key = 'nc_auto_roll_import_v1', before = ${JSON.stringify(autoRollBefore ?? null)}; if (before === null) localStorage.removeItem(key); else localStorage.setItem(key, before); })()`);
  }
}
