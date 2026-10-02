// Apply Crop and the crop view (#245), on a synthetic negative imported
// without auto crop (so no image area is stored and every changed frame is
// detected again):
// - crop mode draws on its own canvas at display resolution, fitted like the
//   develop view; the area-filtered proxy replaces the stand-in; turning the
//   draft by 90 degrees redraws without a histogram or a pixel rotation;
// - the first frame after the Apply click shows the overlay fully opaque,
//   before the geometry build or the crop-area detection starts;
// - the detection runs in the auto-frame worker, a miss converts once and a
//   hit at most twice, and the page never boots its own OpenCV;
// - one-click colour correction measures the fog surface in the worker too;
//   with the worker forced to fail it falls back to the page's OpenCV with
//   the same analysis and one warning;
// - an edit made while the detection runs leaves the exports, and those after
//   undoing it, as waiting for a hit would (runEditWhileDetecting).

// Imports the synthetic negative without auto crop, in a page expression: an
// orange rebate around a dark, textured frame.
const IMPORT_FIXTURE = `
    const autoCrop = document.getElementById('studioImportAutoCrop');
    if (autoCrop.checked) autoCrop.click();
    const c = document.createElement('canvas'); c.width = 1500; c.height = 1000;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'rgb(232,158,92)'; ctx.fillRect(0, 0, 1500, 1000);
    ctx.fillStyle = 'rgb(34,22,12)'; ctx.fillRect(150, 120, 1200, 760);
    for (let y = 124; y < 876; y += 6) for (let x = 154; x < 1346; x += 6) {
      const n = (x * 13 + y * 29) % 90; ctx.fillStyle = 'rgb(' + (40 + n) + ',' + (22 + n / 2) + ',' + (14 + n / 3) + ')'; ctx.fillRect(x, y, 6, 6);
    }
    const blob = await new Promise(r => c.toBlob(r)); const dt = new DataTransfer();
    dt.items.add(new File([blob], 'crop-apply.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput'); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));`;
const READY = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !window.__ncGeometry.pending()`;

export async function runCropApplySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('crop apply boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncAnalysis && !!window.__ncGeometry`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(async () => {
    window.__analysisWarnings = [];
    const warn = console.warn.bind(console);
    console.warn = (...args) => { window.__analysisWarnings.push(args.map(a => (a && a.message) || String(a)).join(' ')); warn(...args); };
    ${IMPORT_FIXTURE}
  })()`);
  const ready = READY;
  await waitFor('crop apply fixture converted', `${ready} && document.getElementById('studioFilename').textContent === 'crop-apply.png'`, 150_000);
  await wait(1200);
  const realm = `({ cv: typeof window.cv, script: !!document.querySelector('script[data-opencv-loader]'), tasks: { ...window.__ncAnalysis.tasks } })`;
  const imported = await evaluate(realm);
  if (imported.cv !== 'undefined' || imported.script) fail('the page loaded OpenCV during import: ' + JSON.stringify(imported));

  // ---- The crop view ----
  const containerSize = `(() => { const c = document.getElementById('canvasContainer'); return { width: c.clientWidth, height: c.clientHeight }; })()`;
  const developBox = await evaluate(`(() => { const r = document.getElementById('canvasTransformWrapper').getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);
  const developContainer = await evaluate(containerSize);
  const histogramsBefore = await evaluate(`window.__ncAnalysis.cropView.histograms`);
  await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click()`);
  await waitFor('crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
  await wait(200);
  const view = await evaluate(`(() => {
    const crop = document.getElementById('cropCanvas');
    const box = crop.getBoundingClientRect();
    return { shown: getComputedStyle(crop).display !== 'none',
      mainHidden: getComputedStyle(document.getElementById('canvas')).display === 'none',
      glHidden: getComputedStyle(document.getElementById('glCanvas')).display === 'none',
      box: { width: box.width, height: box.height }, pixels: [crop.width, crop.height], dpr: devicePixelRatio,
      draft: window.__ncAnalysis.draftView(), histograms: window.__ncAnalysis.cropView.histograms, renderMs: window.__ncAnalysis.cropView.lastRenderMs };
  })()`);
  if (!view.shown || !view.mainHidden || !view.glHidden) fail('crop mode is not on its own canvas: ' + JSON.stringify(view));
  // The crop toolbar can change the container's size by a few pixels. Both
  // views are fitted by the same rule, the full-size frame into the container
  // less 20 px and never above 100 % (adjustCanvasDisplay), each in the
  // container it has.
  const cropContainer = await evaluate(containerSize);
  const fitted = (frame, container) => {
    const scale = Math.min((container.width - 20) / frame.width, (container.height - 20) / frame.height, 1);
    return { width: frame.width * scale, height: frame.height * scale };
  };
  const expectCrop = fitted(view.draft.frame, cropContainer), expectDevelop = fitted(view.draft.frame, developContainer);
  if (Math.abs(view.box.width - expectCrop.width) > 1 || Math.abs(view.box.height - expectCrop.height) > 1
    || Math.abs(developBox.width - expectDevelop.width) > 1 || Math.abs(developBox.height - expectDevelop.height) > 1) {
    fail('the crop view is not fitted like the develop view: ' + JSON.stringify({ view, developBox, cropContainer, developContainer }));
  }
  const wanted = Math.min(Math.round(view.box.width * view.dpr), view.draft.frame.width);
  if (view.pixels[0] < wanted - 2) fail('the crop canvas is below display resolution: ' + JSON.stringify({ view, wanted }));
  if (view.histograms - histogramsBefore !== 1) fail('the crop histogram was not drawn once on entry: ' + JSON.stringify(view));
  await waitFor('crop view proxy', `window.__ncAnalysis.proxyReady() && !window.__ncAnalysis.draftView().standIn`, 30_000);
  const turn = async (button) => evaluate(`(async () => {
    const before = { histograms: window.__ncAnalysis.cropView.histograms, rotations: window.__ncGeometry.main.rotations, draws: window.__ncAnalysis.cropView.draws };
    document.getElementById('${button}').click();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const crop = document.getElementById('cropCanvas');
    return { pixels: [crop.width, crop.height], draft: window.__ncAnalysis.draftView(),
      histograms: window.__ncAnalysis.cropView.histograms - before.histograms,
      rotations: window.__ncGeometry.main.rotations - before.rotations,
      draws: window.__ncAnalysis.cropView.draws - before.draws, renderMs: window.__ncAnalysis.cropView.lastRenderMs };
  })()`);
  const turned = await turn('rotateRightBtn');
  if (turned.draws < 1 || turned.histograms || turned.rotations || !(turned.pixels[1] > turned.pixels[0]) || turned.renderMs > 30) fail('turning the draft did pixel work or did not redraw: ' + JSON.stringify(turned));
  const back = await turn('rotateLeftBtn');
  if (back.histograms || back.rotations || !(back.pixels[0] > back.pixels[1])) fail('turning the draft back: ' + JSON.stringify(back));
  console.log(`ok: crop view ${view.pixels.join('x')} px in a ${Math.round(view.box.width)}x${Math.round(view.box.height)} box (develop view's), proxy swapped in, a 90-degree turn redraws in ${turned.renderMs.toFixed(1)} ms without a histogram or pixel rotation`);

  // ---- Apply: paint first ----
  // The new frame straddles the image window's corner: a crop inside or
  // around the window the import already stored is the same analysis frame,
  // which Apply keeps without a detection.
  const corner = await evaluate(`(() => { const r = document.getElementById('cropOverlay').getBoundingClientRect(); return { x: r.x + 2, y: r.y + 2, toX: r.x + r.width * 0.6, toY: r.y + r.height * 0.6 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.toX, y: corner.toY, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.toX, y: corner.toY, button: 'left', clickCount: 1 });
  const firstFrame = await evaluate(`(async () => {
    const before = { started: window.__ncAnalysis.detection.started, jobs: window.__ncGeometry.pool.jobs, conversions: window.__ncAnalysis.detection.conversions };
    window.__cropApplyBefore = before;
    const clicked = performance.now();
    document.getElementById('applyCropBtn').click();
    // rAF callbacks run in the first frame after the click, before its paint.
    await new Promise(r => requestAnimationFrame(r));
    const overlay = document.querySelector('.loading-overlay');
    const style = overlay && getComputedStyle(overlay);
    return { ms: performance.now() - clicked, visible: !!overlay && overlay.classList.contains('visible'),
      immediate: !!overlay && overlay.classList.contains('loading-overlay-immediate'), opacity: style && style.opacity,
      detectionStarted: window.__ncAnalysis.detection.started - before.started, geometryJobs: window.__ncGeometry.pool.jobs - before.jobs };
  })()`);
  if (!firstFrame.visible || !firstFrame.immediate || firstFrame.opacity !== '1' || firstFrame.detectionStarted || firstFrame.geometryJobs || firstFrame.ms > 100) {
    fail('the Apply overlay was not opaque in the first frame, before any work: ' + JSON.stringify(firstFrame));
  }
  await waitFor('crop applied and converted', `${ready} && !document.getElementById('canvasContainer').classList.contains('crop-mode') && !document.querySelector('.loading-overlay.visible')`, 120_000);
  const applied = await evaluate(`window.__ncAnalysis.settle().then(() => {
    const before = window.__cropApplyBefore, d = window.__ncAnalysis.detection;
    return { started: d.started - before.started, conversions: d.conversions - before.conversions, hits: d.hits, misses: d.misses, reconversions: d.reconversions,
      diagnostics: window.__ncAnalysis.diagnostics(), cv: typeof window.cv, script: !!document.querySelector('script[data-opencv-loader]'), tasks: { ...window.__ncAnalysis.tasks } };
  })`);
  if (applied.started !== 1 || applied.hits + applied.misses !== 1) fail('Apply did not detect the new frame once: ' + JSON.stringify(applied));
  if (applied.misses && applied.conversions !== 1) fail('a miss must convert exactly once: ' + JSON.stringify(applied));
  if (applied.hits && (applied.conversions > 2 || applied.diagnostics?.method !== 'manual-image-window' || applied.diagnostics?.analysisNeedsReview)) fail('a hit must complete the diagnostics in at most two conversions: ' + JSON.stringify(applied));
  if (applied.misses && !applied.diagnostics?.analysisNeedsReview) fail('a miss must keep analysisNeedsReview: ' + JSON.stringify(applied));
  if (applied.cv !== 'undefined' || applied.script || applied.tasks.fallback) fail('Apply Crop booted OpenCV in the page: ' + JSON.stringify(applied));
  console.log(`ok: Apply overlay opaque in the first frame (${firstFrame.ms.toFixed(0)} ms), detection in the worker (${applied.hits ? 'hit' : 'miss'}, ${applied.conversions} conversion(s)), no OpenCV in the page`);

  // ---- One-click colour correction in the worker, then the page fallback ----
  const correct = async (label) => {
    // Both measurements read the same settled full-resolution positive.
    await waitFor(label + ': full resolution settled', `${ready} && window.__ncAnalysis.fullResolution()`, 120_000);
    const count = await evaluate(`window.__ncAnalysis.tasks.worker + window.__ncAnalysis.tasks.fallback`);
    await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioColorCorrect').click()`);
    await waitFor(label, `window.__ncAnalysis.tasks.worker + window.__ncAnalysis.tasks.fallback > ${count} && !!(window.__ncAnalysis.expiredAnalysis() || {}).spatial`, 120_000);
    await wait(500);
    return evaluate(`JSON.stringify(window.__ncAnalysis.expiredAnalysis())`);
  };
  await waitFor('colour correct enabled', `!document.getElementById('studioColorCorrect').disabled`, 30_000);
  const inWorker = await correct('colour correct in the worker');
  const afterWorker = await evaluate(realm);
  if (afterWorker.cv !== 'undefined' || afterWorker.script || afterWorker.tasks.fallback) fail('colour correct booted OpenCV in the page: ' + JSON.stringify(afterWorker));
  await evaluate(`window.__ncAnalysis.failWorker(true)`);
  const onPage = await correct('colour correct on the page');
  await evaluate(`window.__ncAnalysis.failWorker(false)`);
  const fallback = await evaluate(`({ ...${realm}, warnings: window.__analysisWarnings.filter(w => /OpenCV worker unavailable/.test(w)) })`);
  if (onPage !== inWorker) fail('the page fallback measured a different expired analysis');
  if (fallback.cv === 'undefined' || fallback.tasks.fallback !== 1 || fallback.warnings.length !== 1 || !/expired-spatial-maps/.test(fallback.warnings[0])) fail('the worker failure did not fall back once with one warning: ' + JSON.stringify(fallback));
  console.log('ok: colour correct measured in the worker; a forced worker failure falls back to the page with the same analysis and one warning');

  await runEditWhileDetecting({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port });
}

// An edit made while the crop-area detection runs (R1-070, R1-072, R1-134).
// The import stores the window as the image area, so first confirm a smaller
// image area off its centre; then Apply the default draft (5 % inside the
// frame, around the window), which detects again and hits. Press the
// magenta slider while the worker request is held, let the hit land
// mid-drag and release the slider after it. Export PNG8 and TIFF16, undo the
// drag, export again: every file equals the one of the same steps when the
// drag waits for the hit. Magenta is a Step-3 control, outside the
// conversion the hit's auto white balance is measured on, and not a learned
// default, so the first run's exports teach the second run nothing.
async function runEditWhileDetecting({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const cropMode = `document.getElementById('canvasContainer').classList.contains('crop-mode')`;
  const exportOnce = async (label, format, depth) => {
    const index = await evaluate(`(async () => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      const depth = document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]');
      for (let i = 0; i < 50 && depth && depth.disabled && !depth.classList.contains('disabled'); i++) await new Promise(r => setTimeout(r, 20));
      if (depth && !depth.classList.contains('disabled')) depth.click();
      if (document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth !== '${depth}') return null;
      const index = window.__cropEditProbe.downloads.length;
      document.getElementById('exportSingleBtn').click();
      return index;
    })()`);
    if (index === null) fail(`${label}: could not select ${format} ${depth}-bit`);
    await waitFor(label, `window.__cropEditProbe.downloads.length > ${index} && !document.getElementById('exportSingleBtn').disabled && !document.body.dataset.studioBusy`, 180_000);
    return evaluate(`(async () => {
      const blob = await window.__cropEditProbe.downloads[${index}];
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      return { type: blob.type, size: blob.size, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') };
    })()`);
  };
  const exportBoth = async label => ({ png8: await exportOnce(label + ' PNG8', 'png', 8), tiff16: await exportOnce(label + ' TIFF16', 'tiff', 16) });
  const slider = (events, value = null) => evaluate(`(() => {
    const el = document.getElementById('magenta');
    for (const type of ${JSON.stringify(events)}) {
      if (type === 'input') el.value = '${value}';
      el.dispatchEvent(type === 'pointerdown' ? new PointerEvent(type, { bubbles: true }) : new Event(type, { bubbles: true }));
    }
    return el.value;
  })()`);
  const view = `({ diagnostics: window.__ncAnalysis.diagnostics(), whiteBalance: window.__ncAnalysis.whiteBalance(), magenta: document.getElementById('magenta').value })`;
  const state = `({ ready: ${READY}, cropMode: ${cropMode}, converting: window.__ncAnalysis.converting(), pending: window.__ncAnalysis.pendingDetection(),
    held: window.__cropEditProbe.held.length, detection: { ...window.__ncAnalysis.detection }, diagnostics: window.__ncAnalysis.diagnostics() })`;
  const run = async (atOnce) => {
    const label = atOnce ? 'edit at once' : 'edit after the hit';
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor(label + ': boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncAnalysis && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`(async () => {
      // Holds the detection request until the test lets it go, and keeps the
      // exported files instead of downloading them.
      const probe = window.__cropEditProbe = { hold: false, held: [], downloads: [] };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if (probe.hold && message && message.type === 'detect-crop-area') { probe.held.push(() => post.call(this, message, transfer)); return; }
        return post.apply(this, arguments);
      };
      probe.release = () => { probe.hold = false; for (const deliver of probe.held.splice(0)) deliver(); };
      try { delete window.showSaveFilePicker; } catch {}
      window.showSaveFilePicker = undefined;
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
        probe.downloads.push(fetch(this.href).then(r => r.blob()));
      };
      ${IMPORT_FIXTURE}
    })()`);
    await waitFor(label + ': fixture converted', `${READY} && document.getElementById('studioFilename').textContent === 'crop-apply.png'`, 150_000);
    await wait(1200);
    // Confirm the top-left part of the stored window as the image area.
    await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('studioConfirmAnalysis').click()`);
    await waitFor(label + ': image area mode', cropMode, 30_000);
    await wait(200);
    const corner = await evaluate(`(() => { const r = document.getElementById('cropOverlay').getBoundingClientRect(); return { x: r.x + r.width - 2, y: r.y + r.height - 2, toX: r.x + r.width * 0.4, toY: r.y + r.height * 0.4 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.toX, y: corner.toY, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.toX, y: corner.toY, button: 'left', clickCount: 1 });
    await evaluate(`document.getElementById('applyCropBtn').click()`);
    await waitFor(label + ': image area confirmed', `${READY} && !${cropMode} && !window.__ncAnalysis.converting() && window.__ncAnalysis.diagnostics()?.method === 'manual-analysis-area'`, 60_000);
    await wait(500);
    await evaluate(`document.getElementById('cropBtn').click()`);
    await waitFor(label + ': crop mode', cropMode, 30_000);
    await wait(200);
    await evaluate(`window.__cropEditProbe.hold = ${atOnce}; document.getElementById('applyCropBtn').click()`);
    if (atOnce) {
      // The provisional positive is on screen and the detection is waiting.
      if (!await waitFor(label + ': provisional positive', `${READY} && !${cropMode} && !window.__ncAnalysis.converting() && window.__ncAnalysis.pendingDetection() && window.__cropEditProbe.held.length === 1`, 120_000, { soft: true })) {
        fail(label + ': no provisional positive with the detection held: ' + JSON.stringify(await evaluate(state)));
      }
      const provisional = await evaluate(view);
      if (!provisional.diagnostics?.analysisNeedsReview) fail(label + ': the provisional conversion did not use the miss outcome: ' + JSON.stringify(provisional));
      await slider(['pointerdown', 'input'], 12);
      await evaluate(`window.__cropEditProbe.release()`);
      await evaluate(`window.__ncAnalysis.settle()`);
      await slider(['change']);
    } else {
      await waitFor(label + ': applied', `${READY} && !${cropMode} && !window.__ncAnalysis.converting()`, 120_000);
      await evaluate(`window.__ncAnalysis.settle()`);
      await slider(['pointerdown', 'input', 'change'], 12);
    }
    const edited = await evaluate(view);
    if (edited.diagnostics?.method !== 'manual-image-window' || edited.diagnostics?.analysisNeedsReview) fail(label + ': the detection did not hit: ' + JSON.stringify(edited));
    const editedFiles = await exportBoth(label);
    const undoState = `({ magenta: document.getElementById('magenta').value, undoDisabled: document.getElementById('undoBtn').disabled,
      busy: document.body.dataset.studioBusy || null, ready: ${READY}, converting: window.__ncAnalysis.converting(),
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent) })`;
    const beforeUndo = await evaluate(undoState);
    await evaluate(`document.getElementById('undoBtn').click()`);
    if (!await waitFor(label + ': undone', `document.getElementById('magenta').value === '0' && ${READY} && !window.__ncAnalysis.converting()`, 60_000, { soft: true })) {
      fail(label + ': the undo did not settle: ' + JSON.stringify({ beforeUndo, after: await evaluate(undoState) }));
    }
    const undone = await evaluate(view);
    const undoneFiles = await exportBoth(label + ' after undo');
    return { edited, editedFiles, undone, undoneFiles, detection: await evaluate(`({ ...window.__ncAnalysis.detection })`) };
  };
  const atOnce = await run(true);
  const waited = await run(false);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (atOnce.detection.reconversions !== 1) fail('the held hit did not convert again: ' + JSON.stringify(atOnce.detection));
  if (!same(atOnce.undone, waited.undone)) fail('undoing an edit made while the detection ran lost the hit: ' + JSON.stringify({ atOnce: atOnce.undone, waited: waited.undone }));
  if (!same(atOnce.edited, waited.edited)) fail('an edit made while the detection ran changed the settings: ' + JSON.stringify({ atOnce: atOnce.edited, waited: waited.edited }));
  for (const [step, files] of [['edited', 'editedFiles'], ['undone', 'undoneFiles']]) {
    for (const format of ['png8', 'tiff16']) {
      const a = atOnce[files][format], b = waited[files][format];
      if (!a.size || a.sha256 !== b.sha256) fail(`${step} ${format}: the export of an edit made while the detection ran differs: ` + JSON.stringify({ atOnce: a, waited: b }));
    }
  }
  console.log(`ok: an edit made while the detection ran (a magenta drag across the hit) exports, and after undo exports, the same PNG8 and TIFF16 as one made after it (${atOnce.editedFiles.tiff16.sha256.slice(0, 12)}, ${atOnce.undoneFiles.tiff16.sha256.slice(0, 12)})`);
}
