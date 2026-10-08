import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

// #248 in Chrome, on a 3000x2000 synthetic negative (larger than the viewport,
// so the base display image is fit x DPR and the detail layer has work):
// 1. "1:1" toggles fit <-> true 100 % (the indicator reads 100 %), the zoom
//    reaches 200 % of native, and zoom-only gestures convert no whole frame.
// 2. A window resize is followed by a slider tick that resamples nothing of
//    the full frame on the main thread; a resize inside the hysteresis band
//    changes nothing.
// 3. The display level and target: preview requests carry the target and,
//    after the first, no pixels.
// 4. A 16 MP-or-less settle lands with its display preview built in the worker.
// 5. The detail layer at 100 %: native density, hidden while a SilverCore drag
//    is ahead of it and back after the settle, hidden in before/after and crop
//    mode, and exports unchanged by any of it. ?detailLayer=0 turns it off.
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const SOURCE = { width: 3000, height: 2000 };

function installZoomDetailProbe() {
  const original = { post: Worker.prototype.postMessage, terminate: Worker.prototype.terminate,
    click: HTMLAnchorElement.prototype.click, revoke: URL.revokeObjectURL, picker: window.showSaveFilePicker };
  const workers = new Map();
  const heldUrls = new Set();
  const probe = window.__zoomDetailProbe = { events: [], exports: [], inFlight: 0, lastActivity: performance.now() };
  const note = (type, detail = {}) => {
    probe.events.push({ type, time: performance.now(), ...detail });
    probe.lastActivity = performance.now();
  };
  const track = (worker, id) => {
    let record = workers.get(worker);
    if (!record) {
      record = { pending: new Set() };
      record.receive = event => {
        const data = event.data;
        if (data?.type === 'result' && data.displayPreview) note('displayPreview', { width: data.displayPreview.width, height: data.displayPreview.height });
        if (record.pending.delete(data?.id)) { probe.inFlight--; note('reply'); }
      };
      worker.addEventListener('message', record.receive);
      workers.set(worker, record);
    }
    record.pending.add(id);
    probe.inFlight++;
  };
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.type === 'convert') {
      track(this, message.id);
      const tile = message.width * message.height <= 300 * 300;
      note(message.cacheInput ? 'preview' : (tile ? 'lane' : 'full'), {
        width: message.width, height: message.height, pixels: Boolean(message.image16 || message.rgba),
        target: message.display ? message.display.target : null, displayTarget: message.options?.displayTarget || null });
    } else if (message?.type === 'roi') {
      track(this, message.id);
      note(message.warm ? 'roi-warm' : 'roi', { width: message.region?.outWidth, height: message.region?.outHeight });
    }
    return original.post.call(this, message, ...args);
  };
  Worker.prototype.terminate = function(...args) {
    const record = workers.get(this);
    if (record) { probe.inFlight -= record.pending.size; record.pending.clear(); note('terminate'); }
    return original.terminate.apply(this, args);
  };
  window.showSaveFilePicker = undefined;
  URL.revokeObjectURL = function(url) { if (!heldUrls.has(url)) original.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function(...args) {
    if (!this.download?.endsWith('.png') || !this.href.startsWith('blob:')) return original.click.apply(this, args);
    const href = this.href, capture = { name: this.download };
    heldUrls.add(href); probe.exports.push(capture);
    fetch(href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).then(data => { capture.data = data; }, error => { capture.error = String(error); })
      .finally(() => { heldUrls.delete(href); original.revoke.call(URL, href); });
  };
  probe.count = (since = 0) => {
    const out = { preview: 0, full: 0, lane: 0, roi: 0, displayPreview: 0 };
    for (const event of probe.events) if (event.time >= since && event.type in out) out[event.type]++;
    return out;
  };
  probe.after = (since, type) => probe.events.filter(event => event.time >= since && event.type === type);
  probe.restore = () => {
    Worker.prototype.postMessage = original.post; Worker.prototype.terminate = original.terminate;
    HTMLAnchorElement.prototype.click = original.click; URL.revokeObjectURL = original.revoke;
    window.showSaveFilePicker = original.picker;
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    delete window.__zoomDetailProbe;
  };
}

function decodePng(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const pixels = png.depth === 16 ? Buffer.from(png.data) : Buffer.from(UPNG.toRGBA8(png)[0]);
  return { width: png.width, height: png.height, depth: png.depth, sha256: createHash('sha256').update(pixels).digest('hex') };
}

// Small pixels, actual browser worker and GPU: the bounded exact-crop level
// uses the original filter, independent of source-conversion provenance.
async function boundedExactCropProbe() {
  const { buildDetailFrameLevel, copyRegionRows } = await import('/src/app/detailLayer.js');
  const { filterDisplayImage } = await import('/src/app/displayPreview.js');
  const { createConversionWorkerClient } = await import('/src/app/conversionWorkerClient.js');
  const { createGpuPreviewRenderer } = await import('/src/render/gpuPreviewRenderer.js');
  const { displayParity } = await import('/src/render/gpuPreviewSelfTest.js');
  const frame = new ImageData(191, 137);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    frame.data.set([(x * 17 + y * 13) % 256, (x * 5 + y * 7) % 256, (x * 23 + y * 19) % 256, 255], (y * frame.width + x) * 4);
  }
  const rect = { x: 11, y: 7, width: 173, height: 121 }, target = { width: 83, height: 57 };
  const crop = new ImageData(copyRegionRows(frame.data, frame.width, rect), rect.width, rect.height);
  const expected = filterDisplayImage(crop, target, { k: 2 });
  const level = await buildDetailFrameLevel(frame, rect, { k: 2, tilePixels: rect.width * 4 });
  const client = createConversionWorkerClient({ cacheInput: true });
  try {
    const image = await client.resample(level, target, { geometry: level.geometry, detail: true, transfer: true });
    const canvas = document.createElement('canvas'); Object.assign(canvas, target);
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) return { error: 'no WebGL2 for exact-crop probe' };
    const renderer = createGpuPreviewRenderer(gl);
    const ramp = Uint8Array.from({ length: 256 }, (_, v) => v);
    renderer.uploadExact(image, true); renderer.uploadCurves({ r: ramp, g: ramp, b: ramp });
    renderer.drawStep3({ wb: [1, 1, 1], vib: 0, cmy: [0, 0, 0] }, target.width, target.height);
    const pixels = new Uint8Array(image.data.length), rows = new Uint8ClampedArray(image.data.length);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let y = 0; y < target.height; y++) rows.set(pixels.subarray((target.height - 1 - y) * target.width * 4,
      (target.height - y) * target.width * 4), y * target.width * 4);
    return { worker: displayParity(expected.data, image.data), gpu: displayParity(expected.data, rows), transferred: level.data.byteLength === 0 };
  } finally { client.dispose(); }
}

export async function runZoomDetailSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 90_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const now = () => evaluate('performance.now()');
  const counts = since => evaluate(`window.__zoomDetailProbe.count(${since})`);
  const display = () => evaluate('window.__ncDisplay.state()');
  const detail = () => evaluate('window.__ncDetailLayer.state()');
  const quiet = async (description, ms = 1500) => {
    await evaluate('window.__zoomDetailProbe.lastActivity = Math.max(window.__zoomDetailProbe.lastActivity, performance.now())');
    await until(description, `${ready} && window.__zoomDetailProbe.inFlight === 0 && performance.now() - window.__zoomDetailProbe.lastActivity > ${ms}`);
  };
  const zoomIndicator = () => evaluate(`(() => { const el = document.getElementById('zoomIndicator'); return el.style.display === 'none' ? null : el.textContent; })()`);
  const zoomLevel = () => evaluate(`Number(/matrix\\(([\\d.]+)/.exec(document.getElementById('canvasTransformWrapper').style.transform)?.[1] || 1)`);
  const setViewport = (width, height = 900) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const setSlider = (id, value) => evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    window.dispatchEvent(new Event('pointerup'));
  })()`);
  const exportPng = async (label) => {
    const index = await evaluate('window.__zoomDetailProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${label}: PNG captured`, `!!window.__zoomDetailProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120_000);
    return decodePng(await evaluate(`window.__zoomDetailProbe.exports[${index}].data`));
  };
  const boot = async (query, fileName, { size = SOURCE, second = false, filmType = 'color', keepAutoCrop = false } = {}) => {
    await setViewport(1440);
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });
    await until('fresh zoom-detail workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await evaluate(`(${installZoomDetailProbe.toString()})()`);
    await evaluate(`(async () => {
      const autoCrop = document.getElementById('studioImportAutoCrop');
      if (autoCrop.checked !== ${keepAutoCrop}) autoCrop.click();
      for (const id of ['importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="${filmType}"]').click();
      // Rebate, a gradient image area and fine detail (1-px lines) that only
      // native pixels resolve.
      const surface = document.createElement('canvas');
      surface.width = ${size.width}; surface.height = ${size.height};
      const context = surface.getContext('2d');
      context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, surface.width, surface.height);
      const gradient = context.createLinearGradient(120, 120, surface.width - 120, surface.height - 120);
      gradient.addColorStop(0, 'rgb(190,125,80)'); gradient.addColorStop(1, 'rgb(110,70,45)');
      context.fillStyle = gradient; context.fillRect(120, 120, surface.width - 240, surface.height - 240);
      context.fillStyle = 'rgb(60,40,25)';
      for (let x = 900; x < 2100; x += 2) context.fillRect(x, 700, 1, 600);
      const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], ${JSON.stringify(fileName)}, { type: 'image/png' }));
      if (${second}) transfer.items.add(new File([blob], ${JSON.stringify(fileName + '-next.png')}, { type: 'image/png' }));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(`${fileName} converted`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(fileName)}`, 120_000);
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      const more = document.getElementById('studioMore'); if (more) more.open = true;
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
    })()`);
    await quiet(`${fileName} idle`, 3000);
  };

  let failure;
  try {
    await boot('?lang=en&gpuPreview=force&detailProbe=1', 'zoom-detail.png');

    // ---- Part 3: the level and the display target ----
    const settled = await display();
    expect(settled.level && settled.level.k === 1 && settled.level.isSource && settled.target.displayTarget && settled.separate,
      'the 6 MP source is not its own level with a display target: ' + JSON.stringify(settled));
    const previews = await evaluate('window.__zoomDetailProbe.after(0, "preview")');
    expect(previews.length >= 1 && previews[0].target && previews.slice(1).every(event => !event.pixels && event.target),
      'preview requests did not send the level once and then only the display target: ' + JSON.stringify(previews));
    console.log('ok: the display level is kept in the preview worker; preview requests carry only the target ' + JSON.stringify(settled.target));
    const bounded = await evaluate(`(${boundedExactCropProbe.toString()})()`);
    expect(!bounded.error && bounded.transferred && bounded.worker.p999 === 0 && bounded.worker.max === 0 && bounded.gpu.p999 === 0 && bounded.gpu.max === 0,
      'bounded exact-crop worker/GPU parity: ' + JSON.stringify(bounded));
    console.log('ok: bounded exact crop through the actual browser worker and GPU ' + JSON.stringify(bounded));

    // ---- Part 1: a true 1:1 ----
    expect(await zoomIndicator() === null, 'the indicator shows at fit');
    let mark = await now();
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    const zoom100 = await zoomLevel();
    expect(zoom100 > 1 && await zoomIndicator() === '100%', `1:1 did not reach true 100 %: zoom ${zoom100}, indicator ${await zoomIndicator()}`);
    await until('detail layer at 100 %', `window.__ncDetailLayer.state().visible && window.__ncDetailLayer.state().current`, 20_000);
    await quiet('1:1 settled');
    const atActual = await detail();
    const zoomOnly = await counts(mark);
    expect(atActual.sourcePxPerDevicePx >= 0.95 && atActual.region.density === 1,
      'the detail layer does not show native pixels at 100 %: ' + JSON.stringify(atActual));
    // After the import's idle settle the full-resolution frame is current, so
    // the region is cropped from it (no conversion at all).
    expect(zoomOnly.preview === 0 && zoomOnly.full === 0 && atActual.counters.requests >= 1,
      'a zoom-only gesture converted a whole frame: ' + JSON.stringify({ zoomOnly, counters: atActual.counters }));
    console.log('ok: 1:1 reaches true 100 % with native detail and no whole-frame conversion ' + JSON.stringify({ zoom100, region: atActual.region, zoomOnly }));

    // A Step-3 edit keeps the region (redrawn with the new uniforms); a
    // SilverCore drag hides it until the base settles, then it is back.
    await setSlider('cyan', 15);
    await quiet('step-3 edit at 100 %');
    expect((await detail()).visible, 'a Step-3 edit hid the detail layer');
    mark = await now();
    const drag = await evaluate(`(async () => {
      const slider = document.getElementById('coreExposure');
      slider.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      const seen = [];
      for (let value = 1; value <= 12; value++) {
        slider.value = String(value * 2);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
        seen.push(window.__ncDetailLayer.state());
      }
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      window.dispatchEvent(new Event('pointerup'));
      // A region of older settings than the base frame on screen is never drawn.
      return { staleShown: seen.filter(entry => entry.visible && entry.roiToken < entry.baseToken).length,
        hidden: seen.filter(entry => !entry.visible).length };
    })()`);
    expect(drag.staleShown === 0, 'a stale detail region was drawn during a drag: ' + JSON.stringify(drag));
    const conversionsBefore = atActual.counters.conversions;
    await until('detail layer back after the drag', `window.__ncDetailLayer.state().visible && window.__ncDetailLayer.state().current`, 20_000);
    // Until the settle render lands, the region is converted from the source
    // with the base's analysis (a 'roi' request, never a whole frame).
    const afterDrag = await detail();
    expect(afterDrag.counters.conversions > conversionsBefore && (await counts(mark)).roi >= 1,
      'the detail layer after a drag was not converted from the source: ' + JSON.stringify(afterDrag));
    console.log('ok: the detail layer never shows a stale region during a drag and returns after it ' + JSON.stringify({ drag, ready: (await detail()).counters.lastReadyMs }));
    await quiet('drag at 100 % settled', 3000);

    // Exports ignore zoom and the layer.
    const zoomedExport = await exportPng('export at 100 %');
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    expect(await zoomLevel() === 1 && await zoomIndicator() === null, '1:1 did not toggle back to fit');
    await quiet('back at fit');
    await until('detail layer hidden at fit', `!window.__ncDetailLayer.state().visible`, 10_000);
    const fitExport = await exportPng('export at fit');
    expect(zoomedExport.sha256 === fitExport.sha256 && zoomedExport.width === SOURCE.width,
      'the zoom or the detail layer changed the export: ' + JSON.stringify({ zoomedExport, fitExport }));
    console.log('ok: 1:1 toggles back to fit; exports at fit and at 100 % are byte-identical');

    // 200 % of native is reachable.
    for (let i = 0; i < 20; i++) await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }))`);
    const maxIndicator = Number(String(await zoomIndicator()).replace('%', ''));
    expect(maxIndicator >= 200, `the zoom stops below 200 % of native: ${maxIndicator} %`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))`);
    await quiet('key 0 back to fit');
    console.log(`ok: the zoom reaches ${maxIndicator} % of native; key 0 returns to fit`);

    // ---- Part 5 scope: modes that draw something else hide the layer ----
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    await until('detail layer again', `window.__ncDetailLayer.state().visible`, 20_000);
    await evaluate(`document.getElementById('beforeAfterBtn').click()`);
    const comparing = await evaluate(`document.getElementById('beforeAfterBtn').getAttribute('aria-pressed') === 'true'`);
    expect(comparing, 'before/after did not open at 100 %');
    expect(!(await detail()).visible, 'the detail layer stayed over before/after');
    await evaluate(`document.getElementById('beforeAfterBtn').click()`);
    await until('detail layer back after before/after', `window.__ncDetailLayer.state().visible`, 20_000);
    await evaluate(`document.getElementById('cropBtn').click()`);
    await until('crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
    expect(!(await detail()).visible, 'the detail layer stayed over crop mode');
    await evaluate(`document.getElementById('cancelCropBtn').click()`);
    await until('crop mode closed', `!document.getElementById('canvasContainer').classList.contains('crop-mode') && ${ready}`, 60_000);
    await quiet('crop cancelled');
    console.log('ok: before/after and crop mode hide the detail layer');

    // ---- Part 2: a resize is followed by no full-frame resample in the input path ----
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }))`);
    await quiet('fit before resize');
    const beforeResize = await display();
    await setViewport(1440 - 12);
    await quiet('resize inside the hysteresis band');
    const inBand = await display();
    expect(inBand.target.width === beforeResize.target.width, 'a resize inside the hysteresis band changed the display target: ' + JSON.stringify({ beforeResize, inBand }));
    await setViewport(1100);
    await quiet('resize outside the band');
    mark = await now();
    await setSlider('coreExposure', 8);
    await quiet('tick after resize');
    const afterResize = await display();
    const ticks = await evaluate(`window.__zoomDetailProbe.after(${mark}, 'preview')`);
    expect(afterResize.counters.mainFullResamples === beforeResize.counters.mainFullResamples,
      'a resize and the next tick resampled the full frame on the main thread: ' + JSON.stringify({ beforeResize: beforeResize.counters, afterResize: afterResize.counters }));
    expect(ticks.length >= 1 && ticks.every(event => !event.pixels && event.target && event.target.width === afterResize.target.width),
      'the tick after a resize sent pixels or another size: ' + JSON.stringify({ ticks, target: afterResize.target }));
    expect(Math.abs(afterResize.target.width - afterResize.normalTarget.width) <= afterResize.normalTarget.width * 0.15,
      'the display target did not follow the resize: ' + JSON.stringify(afterResize));
    console.log('ok: a resize moves the display target without a main-thread resample; the band keeps it ' + JSON.stringify({ before: beforeResize.target, after: afterResize.target }));
    await setViewport(1440);
    await quiet('viewport back');

    // ---- Part 4: a 16 MP-or-less settle lands with its display preview ----
    mark = await now();
    const before4 = await display();
    await setSlider('coreExposure', 14);
    await until('settle render with its display preview', `window.__zoomDetailProbe.count(${mark}).displayPreview >= 1`, 30_000);
    await quiet('settle landed', 2000);
    const full = await evaluate(`window.__zoomDetailProbe.after(${mark}, 'full')`);
    const after4 = await display();
    expect(full.length >= 1 && full.at(-1).displayTarget && after4.full && after4.shown.filter === 'area'
      && after4.counters.prebuilt > before4.counters.prebuilt && after4.counters.mainFullResamples === before4.counters.mainFullResamples,
    'the settle render did not bring its display preview, or main resampled it: ' + JSON.stringify({ full, before4, after4 }));
    console.log('ok: the settle render brings its display preview; main only uploads it ' + JSON.stringify(after4.shown));

    // At 100 % a current full-resolution frame is cropped, not converted.
    mark = await now();
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    await until('detail layer from the full frame', `window.__ncDetailLayer.state().visible && window.__ncDetailLayer.state().current`, 20_000);
    await quiet('full-frame detail settled');
    const cropped = await detail();
    expect((await counts(mark)).roi === 0 && cropped.counters.crops >= 1,
      'the detail layer converted although a current full-resolution frame exists: ' + JSON.stringify({ counts: await counts(mark), cropped }));
    console.log('ok: a current full-resolution frame is cropped for the detail layer');
    const exactParity = await evaluate('window.__ncDetailLayer.parity()');
    expect(exactParity.exact && exactParity.cropEqual && exactParity.ok,
      'settled detail is not a crop of the exact frame: ' + JSON.stringify(exactParity));
    await evaluate('window.__zoomDetailProbe.restore()');

    // Drive the large-image/export route with the same 6 MP fixture. A 60 MP
    // input is never allocated. The export render must bring its own display
    // preview, and replace the source ROI while the view remains zoomed.
    await boot('?lang=en&gpuPreview=force&detailProbe=1&largeImagePixels=2000000', 'zoom-detail-large.png');
    expect(!(await display()).full, 'the large fixture unexpectedly settled a whole frame before export');
    await evaluate(`document.getElementById('zoomResetBtn').click(); document.getElementById('zoomInBtn').click()`);
    await until('large source ROI', 'window.__ncDetailLayer.state().current && window.__ncDetailLayer.state().visible');
    const beforeExport = await display();
    await exportPng('large zoomed export');
    await until('export exact region replaces source ROI', 'window.__ncDetailLayer.state().current && window.__ncDetailLayer.state().exact');
    const afterExport = await display();
    const largeParity = await evaluate('window.__ncDetailLayer.parity()');
    expect(afterExport.counters.prebuilt > beforeExport.counters.prebuilt
      && afterExport.counters.mainFullResamples === beforeExport.counters.mainFullResamples
      && largeParity.exact && largeParity.cropEqual && largeParity.ok,
      'large export did not supply its display preview and exact crop: ' + JSON.stringify({ beforeExport, afterExport, largeParity }));
    console.log('ok: export-triggered large render supplies a prebuilt display preview and exact zoom crop ' + JSON.stringify(largeParity));
    await evaluate('window.__zoomDetailProbe.restore()');

    // A wide 10.8 MP fixture forces k=2 through the dimension cap, so a Tier B
    // session can exercise fromLevel with a pending source on a small input.
    // Complete normal frame detection before enabling rescue: expired imports
    // deliberately keep the whole frame and do not decide autoFrameMeta.
    await boot('?lang=en&gpuPreview=force&detailProbe=1&largeImagePixels=2000000', 'zoom-detail-tier-b.png',
      { size: { width: 18000, height: 600 }, second: true, keepAutoCrop: true, filmType: 'positive' });
    const tierBSource = (await display()).source;
    expect((await display()).level?.k === 2 && await evaluate(`(() => {
      const settings = window.__ncDisplaySessions.recipe().settings;
      return !!settings.autoFrameMeta && settings.filmEdge?.checked;
    })()`), 'the Tier B fixture did not complete its frame and film-edge detections');
    await evaluate(`document.getElementById('uploadExpiredBtn').click()`);
    await until('Tier B fixture fog analysis', `[...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120_000);
    await setSlider('expiredUnevenFog', 100);
    await quiet('Tier B fog recipe settled');
    await evaluate(`window.__ncDisplaySessions.force('B'); document.querySelector('.file-list-name[data-index="1"]').click()`);
    await until('second Tier B fixture open', `${ready} && document.getElementById('studioFilename').textContent === 'zoom-detail-tier-b.png-next.png'`);
    await quiet('second fixture settled');
    expect(await evaluate("window.__ncDisplaySessions.tier(0)") === 'B', 'the framed positive did not enter Tier B');
    await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
    await until('Tier B original restored', `${ready} && document.getElementById('studioFilename').textContent === 'zoom-detail-tier-b.png' && window.__ncDisplaySessions.live().sourcePending`);
    await evaluate(`document.getElementById('zoomInBtn').click(); document.getElementById('zoomInBtn').click()`);
    await until('Tier B rescued detail at about 150 percent fit zoom', 'window.__ncDetailLayer.state().current && window.__ncDetailLayer.state().visible && window.__ncDetailLayer.state().region.fromLevel');
    const tierBParity = await evaluate('window.__ncDetailLayer.parity()');
    expect(tierBParity.fromLevel && tierBParity.fog && tierBParity.ok && tierBParity.source[0] === tierBSource.width
      && await evaluate('window.__ncDisplaySessions.live().sourcePending'),
      'Tier B region fog was normalised to the crop or rebuilt the source: ' + JSON.stringify(tierBParity));
    console.log('ok: Tier B fog detail uses whole-frame coordinates without a seam ' + JSON.stringify(tierBParity));
    await evaluate('window.__ncDisplaySessions.force(null); window.__zoomDetailProbe.restore()');

    // ---- The kill switch ----
    await boot('?lang=en&gpuPreview=force&detailLayer=0', 'zoom-detail-off.png');
    await evaluate(`document.getElementById('zoomResetBtn').click()`);
    await quiet('1:1 with the layer off');
    const off = await detail();
    expect(!off.enabled && !off.visible && (await counts(0)).roi === 0, '?detailLayer=0 still showed or converted a region: ' + JSON.stringify(off));
    console.log('ok: ?detailLayer=0 turns the detail layer off');
  } catch (error) {
    failure = error;
    const diagnostics = await evaluate(`(() => {
      const probe = window.__zoomDetailProbe;
      return { display: window.__ncDisplay?.state(), detail: window.__ncDetailLayer?.state(),
        session: window.__ncDisplaySessions?.live(), tier: window.__ncDisplaySessions?.tier(0),
        counts: probe?.count(0), inFlight: probe?.inFlight, tail: probe?.events.slice(-30) };
    })()`).catch(() => null);
    console.error('zoom-detail diagnostics:', JSON.stringify(diagnostics));
  } finally {
    await evaluate('window.__zoomDetailProbe?.restore()').catch(() => {});
    await setViewport(1440).catch(() => {});
  }
  if (failure) fail(failure.stack || String(failure));
}
