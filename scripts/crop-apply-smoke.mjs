// Apply Crop and the crop view (#245), on a synthetic negative imported
// without auto crop (so no image area is stored and every changed frame is
// detected again):
// - crop mode draws on its own canvas at display resolution, in the develop
//   view's box (within 1 px); the area-filtered proxy replaces the stand-in;
//   turning the draft by 90 degrees redraws without a histogram or a pixel
//   rotation;
// - the first frame after the Apply click shows the overlay fully opaque,
//   before the geometry build or the crop-area detection starts; Apply
//   shows the indeterminate strip, and once it has settled the hidden
//   overlay runs no animation (#261);
// - the detection runs in the auto-frame worker, a miss converts once and a
//   hit at most twice, and the page never boots its own OpenCV;
// - while the detection runs, the frame notice reports it and nothing asks
//   to confirm the image area; that request comes with a miss (forced here
//   by a uniform region), not with a hit;
// - one-click colour correction measures the fog surface in the worker too;
//   with the worker forced to fail it falls back to the page's OpenCV with
//   the same analysis and one warning;
// - an edit made while the detection runs leaves the exports, and those after
//   undoing it, as waiting for a hit would (runEditWhileDetecting);
// - the gray-point click and one-click colour correction made while the
//   detection runs, or right after a slider release while the frame's 16-bit
//   plane is still in the preview worker, wait for them and export what the
//   same clicks made after waiting export (runMeasureWhileWaiting).

import { expectLoadingOverlayIdle, loadingOverlayIdle } from './loading-overlay-idle.mjs';

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
// What Studio says about the image area: the frame notice, the composition
// pane's status and whether the filmstrip flags the frame for review.
const AREA_STATE = `(async () => {
  const { studioText } = await import('/src/app/studioWorkspace.js');
  const { i18n } = await import('/src/app/i18n.js');
  const key = text => Object.keys(studioText.en).find(name => studioText.en[name] === text) || text;
  const notice = document.getElementById('studioFrameNotice');
  return { notice: notice.hidden ? null : key(notice.textContent), status: notice.dataset.status || '',
    analysis: key(document.getElementById('studioAnalysisStatus').textContent),
    flagged: [...document.querySelectorAll('.file-list-badge.needs-review')].some(badge => badge.title.includes(i18n.en.reviewFrame)) };
})()`;
// Renders the filmstrip now (a sort round trip), as an edit or a thumbnail
// would at any time.
const RENDER_FILMSTRIP = `(() => {
  const select = document.getElementById('studioPhotoSort'), original = select.value;
  for (const value of [original === 'name-asc' ? 'name-desc' : 'name-asc', original]) {
    select.value = value;
    select.dispatchEvent(new Event('change'));
  }
  return !select.disabled;
})()`;

export async function runCropApplySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('crop apply boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncAnalysis && !!window.__ncGeometry`);
  await installDialogAutoAccept();
  await wait(300);
  // Nothing has shown the loading overlay yet: the idle check fails on a
  // page without one, unless the caller expects none (R1-113).
  if (await evaluate(loadingOverlayIdle()) || !await evaluate(loadingOverlayIdle({ overlayExpected: false }))) {
    fail('the loading-overlay idle check passed where no overlay was ever shown: ' + JSON.stringify(await evaluate(`({ overlays: document.querySelectorAll('.loading-overlay').length })`)));
  }
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
  // For an uncropped frame at angle 0 the crop view's box is the develop
  // view's within 1 px (#245): both are fitted by the same rule
  // (adjustCanvasDisplay), and crop mode's ratio control is no taller than
  // the toolbar's buttons, so the container keeps its size (R1-076).
  const cropContainer = await evaluate(containerSize);
  if (Math.abs(view.box.width - developBox.width) > 1 || Math.abs(view.box.height - developBox.height) > 1) {
    fail('the crop view is not in the develop view\'s box: ' + JSON.stringify({ view, developBox, cropContainer, developContainer }));
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
  console.log(`ok: crop view ${view.pixels.join('x')} px in a ${Math.round(view.box.width)}x${Math.round(view.box.height)} box (the develop view's: ${Math.round(developBox.width)}x${Math.round(developBox.height)}), proxy swapped in, a 90-degree turn redraws in ${turned.renderMs.toFixed(1)} ms without a histogram or pixel rotation`);

  // ---- Apply: paint first ----
  // The new frame straddles the image window's corner: a crop inside or
  // around the window the import already stored is the same analysis frame,
  // which Apply keeps without a detection.
  const corner = await evaluate(`(() => { const r = document.getElementById('cropOverlay').getBoundingClientRect(); return { x: r.x + 2, y: r.y + 2, toX: r.x + r.width * 0.6, toY: r.y + r.height * 0.6 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.toX, y: corner.toY, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.toX, y: corner.toY, button: 'left', clickCount: 1 });
  // The detection request waits in the page until the provisional positive
  // has been checked, then goes out over a uniform region, which the
  // detector misses.
  await evaluate(`(() => {
    const probe = window.__cropApplyProbe = { held: [] };
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (probe.held && message && message.type === 'detect-crop-area') {
        probe.held.push(() => { message.region.data.fill(128); post.call(this, message, transfer); });
        return;
      }
      return post.apply(this, arguments);
    };
    probe.release = () => { const held = probe.held; probe.held = null; for (const deliver of held) deliver(); };
    // While the overlay is shown: whether it shows the indeterminate strip.
    window.__overlayShows = [];
    window.__overlayWatch = new MutationObserver(() => {
      const overlay = document.querySelector('.loading-overlay.visible');
      if (overlay) window.__overlayShows.push(overlay.classList.contains('indeterminate'));
    });
    window.__overlayWatch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  })()`);
  const firstFrame = await evaluate(`(async () => {
    const before = { started: window.__ncAnalysis.detection.started, jobs: window.__ncGeometry.pool.jobs, conversions: window.__ncAnalysis.detection.conversions };
    window.__cropApplyBefore = before;
    // Read in the first frame after the click once all its animation-frame
    // callbacks, and the microtasks each queues, have run, before the paint:
    // a ResizeObserver's first notification comes then. The handler asks
    // for its yield's frame only after overlay.show() resolves, so a rAF
    // asked for here would run first and miss work that a bare-rAF yield
    // starts before the paint (R1-075).
    const read = new Promise(resolve => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        const overlay = document.querySelector('.loading-overlay');
        const style = overlay && getComputedStyle(overlay);
        resolve({ ms: performance.now() - clicked, visible: !!overlay && overlay.classList.contains('visible'),
          immediate: !!overlay && overlay.classList.contains('loading-overlay-immediate'), opacity: style && style.opacity,
          detectionStarted: window.__ncAnalysis.detection.started - before.started, geometryJobs: window.__ncGeometry.pool.jobs - before.jobs });
      });
      observer.observe(document.documentElement);
    });
    const clicked = performance.now();
    document.getElementById('applyCropBtn').click();
    return read;
  })()`);
  if (!firstFrame.visible || !firstFrame.immediate || firstFrame.opacity !== '1' || firstFrame.detectionStarted || firstFrame.geometryJobs || firstFrame.ms > 100) {
    fail('the Apply overlay was not opaque in the first frame, before any work: ' + JSON.stringify(firstFrame));
  }
  await waitFor('crop applied and converted', `${ready} && !document.getElementById('canvasContainer').classList.contains('crop-mode') && !document.querySelector('.loading-overlay.visible')`, 120_000);
  // The provisional positive, converted with the miss outcome, is on screen
  // while the detection waits: the frame notice reports the detection, and
  // neither the composition pane nor a filmstrip rendered meanwhile asks to
  // confirm the image area (R1-148).
  if (!await waitFor('provisional positive, detection held', `window.__ncAnalysis.pendingDetection() && window.__cropApplyProbe.held?.length === 1`, 60_000, { soft: true })) {
    fail('Apply did not leave its detection pending behind the provisional positive: ' + JSON.stringify(await evaluate(`({ pending: window.__ncAnalysis.pendingDetection(), held: window.__cropApplyProbe.held?.length })`)));
  }
  if (!await evaluate(RENDER_FILMSTRIP)) fail('the photo sort control is disabled after Apply');
  await wait(100);
  const detecting = { ...await evaluate(AREA_STATE), provisional: await evaluate(`window.__ncAnalysis.diagnostics()`) };
  if (!detecting.provisional?.analysisNeedsReview || detecting.notice !== 'detectingFrame' || detecting.status !== 'detecting'
    || detecting.analysis !== 'analysisHint' || detecting.flagged) {
    fail('while the crop-area detection runs, Studio asks to confirm the image area: ' + JSON.stringify(detecting));
  }
  await evaluate(`window.__cropApplyProbe.release()`);
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
  const missed = await evaluate(AREA_STATE);
  if (!applied.misses || missed.notice !== 'analysisReview' || missed.status === 'detecting' || missed.analysis !== 'analysisReview' || !missed.flagged) {
    fail('the forced miss did not ask to confirm the image area: ' + JSON.stringify({ missed, applied }));
  }
  console.log(`ok: Apply overlay opaque in the first frame (${firstFrame.ms.toFixed(0)} ms), detection in the worker (${applied.hits ? 'hit' : 'miss'}, ${applied.conversions} conversion(s)), no OpenCV in the page`);
  console.log('ok: while the detection ran the frame notice read "detecting" and nothing asked to confirm the image area; the forced miss then did (notice, composition pane, filmstrip)');
  // Apply's detection showed the indeterminate strip, the conversion its
  // progress; once both are done the hidden overlay is idle (#261, R1-113).
  const overlayShows = await evaluate(`(() => { window.__overlayWatch.disconnect(); return window.__overlayShows; })()`);
  if (!overlayShows.includes(true)) fail('Apply Crop did not show the indeterminate strip: ' + JSON.stringify(overlayShows));
  await expectLoadingOverlayIdle({ evaluate, waitFor, fail }, 'Apply Crop');
  console.log(`ok: Apply showed the indeterminate strip (${overlayShows.length} overlay states, last ${overlayShows.at(-1) ? 'indeterminate' : 'progress'}); the hidden overlay is idle afterwards`);

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
  await runMeasureWhileWaiting({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port });
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
  const slider = (events, value = null, id = 'magenta') => evaluate(`(() => {
    const el = document.getElementById('${id}');
    for (const type of ${JSON.stringify(events)}) {
      if (type === 'input') el.value = '${value}';
      el.dispatchEvent(type === 'pointerdown' ? new PointerEvent(type, { bubbles: true }) : new Event(type, { bubbles: true }));
    }
    return el.value;
  })()`);
  const view = `({ diagnostics: window.__ncAnalysis.diagnostics(), whiteBalance: window.__ncAnalysis.whiteBalance(), magenta: document.getElementById('magenta').value, exposure: document.getElementById('coreExposure').value })`;
  const state = `({ ready: ${READY}, cropMode: ${cropMode}, converting: window.__ncAnalysis.converting(), pending: window.__ncAnalysis.pendingDetection(),
    held: window.__cropEditProbe.held.length, detection: { ...window.__ncAnalysis.detection }, diagnostics: window.__ncAnalysis.diagnostics() })`;
  const run = async (atOnce, manualWb = false) => {
    const label = (atOnce ? 'edit at once' : 'edit after the hit') + (manualWb ? ', exposure and manual WB' : '');
    const editedSlider = manualWb ? 'coreExposure' : 'magenta';
    const setManualWb = async () => {
      for (const [id, gain] of [['wbR', 1.3], ['wbG', 1.1], ['wbB', 0.9]]) {
        await slider(['pointerdown', 'input', 'change'], gain, id);
      }
    };
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
      const pendingArea = await evaluate(AREA_STATE);
      if (pendingArea.notice !== 'detectingFrame' || pendingArea.analysis !== 'analysisHint' || pendingArea.flagged) {
        fail(label + ': while the crop-area detection runs, Studio asks to confirm the image area: ' + JSON.stringify(pendingArea));
      }
      await slider(['pointerdown', 'input'], 12, editedSlider);
      if (manualWb) {
        await slider(['change'], null, editedSlider);
        await setManualWb();
      }
      await evaluate(`window.__cropEditProbe.release()`);
      await evaluate(`window.__ncAnalysis.settle()`);
      if (!manualWb) await slider(['change']);
    } else {
      await waitFor(label + ': applied', `${READY} && !${cropMode} && !window.__ncAnalysis.converting()`, 120_000);
      await evaluate(`window.__ncAnalysis.settle()`);
      await slider(['pointerdown', 'input', 'change'], 12, editedSlider);
      if (manualWb) await setManualWb();
    }
    const edited = await evaluate(view);
    if (edited.diagnostics?.method !== 'manual-image-window' || edited.diagnostics?.analysisNeedsReview) fail(label + ': the detection did not hit: ' + JSON.stringify(edited));
    // A hit asks for nothing (R1-148).
    const hitArea = await evaluate(AREA_STATE);
    if (['detectingFrame', 'analysisReview'].includes(hitArea.notice) || hitArea.status === 'detecting' || hitArea.analysis !== 'analysisHint' || hitArea.flagged) {
      fail(label + ': after the hit, Studio still reports the detection or asks to confirm the image area: ' + JSON.stringify(hitArea));
    }
    const editedFiles = await exportBoth(label);
    let wbUndone = null, wbUndoneFiles = null;
    if (manualWb) {
      for (let channel = 0; channel < 3; channel++) {
        await evaluate(`document.getElementById('undoBtn').click()`);
        await waitFor(label + ': manual WB channel undone', `${READY} && !window.__ncAnalysis.converting()`, 60_000);
      }
      wbUndoneFiles = await exportBoth(label + ' after undo WB');
      wbUndone = await evaluate(view);
    }
    const undoState = `({ magenta: document.getElementById('magenta').value, undoDisabled: document.getElementById('undoBtn').disabled,
      busy: document.body.dataset.studioBusy || null, ready: ${READY}, converting: window.__ncAnalysis.converting(),
      toast: [...document.querySelectorAll('.toast')].map(t => t.textContent) })`;
    const beforeUndo = await evaluate(undoState);
    await evaluate(`document.getElementById('undoBtn').click()`);
    if (!await waitFor(label + ': undone', `document.getElementById('${editedSlider}').value === '0' && ${READY} && !window.__ncAnalysis.converting()`, 60_000, { soft: true })) {
      fail(label + ': the undo did not settle: ' + JSON.stringify({ beforeUndo, after: await evaluate(undoState) }));
    }
    const undone = await evaluate(view);
    const undoneFiles = await exportBoth(label + ' after undo');
    return { edited, editedFiles, wbUndone, wbUndoneFiles, undone, undoneFiles, detection: await evaluate(`({ ...window.__ncAnalysis.detection })`) };
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const manualWb of [false, true]) {
    const atOnce = await run(true, manualWb);
    const waited = await run(false, manualWb);
    if (atOnce.detection.reconversions !== 1) fail('the held hit did not convert again: ' + JSON.stringify(atOnce.detection));
    if (!same(atOnce.undone, waited.undone)) fail('undoing an edit made while the detection ran lost the hit: ' + JSON.stringify({ atOnce: atOnce.undone, waited: waited.undone }));
    if (!same(atOnce.edited, waited.edited)) fail('an edit made while the detection ran changed the settings: ' + JSON.stringify({ atOnce: atOnce.edited, waited: waited.edited }));
    if (!same(atOnce.wbUndone, waited.wbUndone)) fail('undoing pending-window manual WB lost automatic hit gains: ' + JSON.stringify({ atOnce: atOnce.wbUndone, waited: waited.wbUndone }));
    for (const [step, files] of [['edited', 'editedFiles'], ...(manualWb ? [['WB undone', 'wbUndoneFiles']] : []), ['undone', 'undoneFiles']]) {
      for (const format of ['png8', 'tiff16']) {
        const a = atOnce[files][format], b = waited[files][format];
        if (!a.size || a.sha256 !== b.sha256) fail(`${step} ${format}: the export of an edit made while the detection ran differs: ` + JSON.stringify({ atOnce: a, waited: b }));
      }
    }
    console.log(`ok: ${manualWb ? 'exposure and manual WB edited before the hit' : 'a magenta drag across the hit'} exports, and after undo exports, the same PNG8 and TIFF16 as one made after it (${atOnce.editedFiles.tiff16.sha256.slice(0, 12)}, ${atOnce.undoneFiles.tiff16.sha256.slice(0, 12)})`);
  }
}

// Measurements made while their inputs are pending (R1-023, R1-071). Each run
// makes one of the two measurements (the gray-point click, one-click colour
// correction) while Apply's crop-area detection is held, and the other right
// after a core exposure release while the preview worker's plane commit is
// held; the fixture is "large" (?largeImagePixels), so the display preview
// stays the frame both measure, as on a 60 MP scan. The clicks wait (Studio
// busy, nothing measured) until the request is let go; the settings and the
// PNG8 and TIFF16 exports then equal those of the same clicks made after the
// hit and after the plane is back. Core exposure, the gray point and the
// rescue are not learned defaults, so no run teaches the next one.
async function runMeasureWhileWaiting({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const cropMode = `document.getElementById('canvasContainer').classList.contains('crop-mode')`;
  const view = `({ diagnostics: window.__ncAnalysis.diagnostics(), whiteBalance: window.__ncAnalysis.whiteBalance(),
    expired: window.__ncAnalysis.expiredAnalysis(), rescue: document.getElementById('expiredEnabled').checked,
    exposure: document.getElementById('coreExposure').value, sampling: document.getElementById('sampleWBBtn').classList.contains('active') })`;
  const exportOnce = async (label, format, depth) => {
    const index = await evaluate(`(async () => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      const depth = document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]');
      for (let i = 0; i < 50 && depth && depth.disabled && !depth.classList.contains('disabled'); i++) await new Promise(r => setTimeout(r, 20));
      if (depth && !depth.classList.contains('disabled')) depth.click();
      if (document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth !== '${depth}') return null;
      const index = window.__measureProbe.downloads.length;
      document.getElementById('exportSingleBtn').click();
      return index;
    })()`);
    if (index === null) fail(`${label}: could not select ${format} ${depth}-bit`);
    await waitFor(label, `window.__measureProbe.downloads.length > ${index} && !document.getElementById('exportSingleBtn').disabled && !document.body.dataset.studioBusy`, 180_000);
    return evaluate(`(async () => {
      const blob = await window.__measureProbe.downloads[${index}];
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
      return { type: blob.type, size: blob.size, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') };
    })()`);
  };
  // The gray-point click lands on the photo at the same place in every run.
  const measure = async kind => {
    if (kind === 'colourCorrect') {
      await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioColorCorrect').click()`);
      return;
    }
    const point = await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      document.getElementById('sampleWBBtn').click();
      const gl = document.getElementById('glCanvas');
      const el = gl.style.display !== 'none' && gl.getBoundingClientRect().width > 0 ? gl : document.getElementById('canvas');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width * 0.42, y: r.top + r.height * 0.47 };
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const landed = kind => (kind === 'colourCorrect'
    ? `!document.body.dataset.studioBusy && !!(window.__ncAnalysis.expiredAnalysis() || {}).spatial`
    : `!document.body.dataset.studioBusy && !document.getElementById('sampleWBBtn').classList.contains('active')`);
  // The click waits: Studio busy, and nothing measured yet.
  const expectWaiting = async (label, before) => {
    await wait(300);
    const now = await evaluate(`({ busy: document.body.dataset.studioBusy || null, view: ${view} })`);
    if (now.busy !== 'true' || JSON.stringify({ ...now.view, sampling: null }) !== JSON.stringify({ ...before, sampling: null })) {
      fail(label + ': the click did not wait: ' + JSON.stringify({ before, now }));
    }
  };
  const run = async ({ atOnce, detecting }) => {
    const released = detecting === 'grayPoint' ? 'colourCorrect' : 'grayPoint';
    const label = `${detecting} while detecting, ${released} after a release, ${atOnce ? 'at once' : 'after waiting'}`;
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&largeImagePixels=100000&previewTier=normal` });
    await waitFor(label + ': boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncAnalysis && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`(async () => {
      // Holds worker requests of the given types until the test lets them
      // go, and keeps the exported files instead of downloading them.
      const probe = window.__measureProbe = { hold: new Set(), held: [], downloads: [] };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, transfer) {
        if (message && probe.hold.has(message.type)) { probe.held.push({ type: message.type, deliver: () => post.call(this, message, transfer) }); return; }
        return post.apply(this, arguments);
      };
      probe.count = type => probe.held.filter(entry => entry.type === type).length;
      probe.release = type => {
        probe.hold.delete(type);
        for (const entry of probe.held.filter(entry => entry.type === type)) { probe.held.splice(probe.held.indexOf(entry), 1); entry.deliver(); }
      };
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
    // As in runEditWhileDetecting: an off-centre image area, then the default
    // draft around the window, which is detected again and hits.
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

    // ---- One measurement while the crop-area detection runs ----
    // Both runs hold the request until the provisional positive is on
    // screen; one clicks before letting it go, the other after the hit.
    await evaluate(`window.__measureProbe.hold.add('detect-crop-area'); document.getElementById('applyCropBtn').click()`);
    if (!await waitFor(label + ': provisional positive', `${READY} && !${cropMode} && !window.__ncAnalysis.converting() && window.__ncAnalysis.pendingDetection() && window.__measureProbe.count('detect-crop-area') === 1`, 120_000, { soft: true })) {
      fail(label + ': no provisional positive with the detection held');
    }
    const provisional = await evaluate(view);
    if (!provisional.diagnostics?.analysisNeedsReview) fail(label + ': the provisional conversion did not use the miss outcome: ' + JSON.stringify(provisional));
    if (atOnce) {
      await measure(detecting);
      await expectWaiting(label + ' (detection)', provisional);
    }
    await evaluate(`window.__measureProbe.release('detect-crop-area')`);
    await evaluate(`window.__ncAnalysis.settle()`);
    if (!atOnce) {
      await waitFor(label + ': hit converted', `${READY} && !window.__ncAnalysis.converting() && !window.__ncAnalysis.pendingDetection()`, 120_000);
      await measure(detecting);
    }
    await waitFor(label + ': ' + detecting + ' landed', landed(detecting), 120_000);
    await wait(500);
    const hit = await evaluate(`window.__ncAnalysis.diagnostics()`);
    if (hit?.method !== 'manual-image-window' || hit?.analysisNeedsReview) fail(label + ': the detection did not hit: ' + JSON.stringify(hit));

    // ---- The other right after a core exposure release ----
    // Both runs hold the plane's commit until the released frame is on
    // screen; one clicks before letting it go, the other once it is back.
    await evaluate(`window.__measureProbe.hold.add('commit')`);
    await evaluate(`(() => {
      const el = document.getElementById('coreExposure');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.value = '15';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    if (!await waitFor(label + ': plane in the worker', `window.__measureProbe.count('commit') >= 1 && window.__ncAnalysis.plane().retained && !window.__ncAnalysis.plane().attached`, 60_000, { soft: true })) {
      fail(label + ': no retained frame with its commit held: ' + JSON.stringify(await evaluate(`({ plane: window.__ncAnalysis.plane(), held: window.__measureProbe.held.map(entry => entry.type) })`)));
    }
    const retained = await evaluate(view);
    if (retained.exposure !== '15') fail(label + ': the release did not reach the frame: ' + JSON.stringify(retained));
    if (atOnce) {
      await measure(released);
      await expectWaiting(label + ' (plane)', retained);
    }
    await evaluate(`window.__measureProbe.release('commit')`);
    if (!atOnce) {
      await waitFor(label + ': plane back', `(() => { const p = window.__ncAnalysis.plane(); return !p.retained && !p.committing && p.attached && p.preview; })()`, 60_000);
      await measure(released);
    }
    await waitFor(label + ': ' + released + ' landed', landed(released), 120_000);
    await wait(800);
    const settled = await evaluate(view);
    const plane = await evaluate(`window.__ncAnalysis.plane()`);
    if (!plane.preview) fail(label + ': the display preview is no longer the frame on screen: ' + JSON.stringify(plane));
    const files = { png8: await exportOnce(label + ' PNG8', 'png', 8), tiff16: await exportOnce(label + ' TIFF16', 'tiff', 16) };
    return { settled, files };
  };
  for (const detecting of ['grayPoint', 'colourCorrect']) {
    const atOnce = await run({ atOnce: true, detecting });
    const waited = await run({ atOnce: false, detecting });
    if (JSON.stringify(atOnce.settled) !== JSON.stringify(waited.settled)) {
      fail(`${detecting} while detecting: the settings differ from the same clicks made after waiting: ` + JSON.stringify({ atOnce: atOnce.settled, waited: waited.settled }));
    }
    for (const format of ['png8', 'tiff16']) {
      const a = atOnce.files[format], b = waited.files[format];
      if (!a.size || a.sha256 !== b.sha256) fail(`${detecting} while detecting: ${format} differs from the same clicks made after waiting: ` + JSON.stringify({ atOnce: a, waited: b }));
    }
    console.log(`ok: ${detecting === 'grayPoint' ? 'the gray-point click' : 'colour correct'} while the detection runs and ${detecting === 'grayPoint' ? 'colour correct' : 'the gray-point click'} right after a release wait for the hit and the plane; PNG8 and TIFF16 equal the same clicks made after waiting (${atOnce.files.png8.sha256.slice(0, 12)}, ${atOnce.files.tiff16.sha256.slice(0, 12)})`);
  }
}
