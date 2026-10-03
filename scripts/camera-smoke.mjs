// Camera-scanning smoke: a blank light-pad frame becomes the roll's flat
// field and flattens a negative shot on the same pad; a lab scan is matched;
// several shots of one frame merge into a quieter 16-bit file in a disposable
// worker (a forced out-of-memory failure alerts, Cancel releases at once);
// the live loupe converts Chrome's fake camera and captures a frame.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

export async function runCameraSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['lightpad-blank.png', 'negative-vignetted.png'].map((name) => join(root, 'negative2positive', 'test-fixtures', name));
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('camera workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('flatFieldUseCurrentBtn'))`);
  await installDialogAutoAccept();
  await wait(300);
  // Flat-field regression measures negative inversion on known synthetic input.
  // Automatic mixed-film import behavior has its own browser scenario.
  await evaluate(`document.getElementById('importFilmTypeAuto').checked && document.getElementById('importFilmTypeAuto').click()`);
  await evaluate(`(() => {
    window.__cameraToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__cameraToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  if (!input.result?.nodeId) fail('#fileInput not found');
  await send('DOM.setFileInputFiles', { files: fixtures, nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('blank frame opened', `${ready} && document.getElementById('studioFilename').textContent === 'lightpad-blank.png'`, 150_000);
  await wait(600);

  const luminance = async (region) => {
    const rect = await evaluate(`(() => {
      const gl = document.getElementById('glCanvas');
      const el = gl && getComputedStyle(gl).display !== 'none' ? gl : document.getElementById('canvas');
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()`);
    const clip = { x: rect.x + rect.width * region.x, y: rect.y + rect.height * region.y, width: Math.max(2, rect.width * region.w), height: Math.max(2, rect.height * region.h), scale: 1 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    const d = new Uint8Array(UPNG.toRGBA8(png)[0]);
    let sum = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += Math.pow((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, 2.2); n++; }
    return sum / n;
  };
  // Corner patches versus a patch at the top edge centre: the same negative
  // density everywhere, so the only difference is the pad's falloff.
  const deviation = async () => {
    const reference = await luminance({ x: 0.45, y: 0.03, w: 0.1, h: 0.08 });
    const corners = [];
    for (const [x, y] of [[0.02, 0.02], [0.88, 0.02], [0.02, 0.88], [0.88, 0.88]]) corners.push(await luminance({ x, y, w: 0.1, h: 0.1 }));
    return Math.max(...corners.map((c) => Math.abs(c / reference - 1)));
  };

  await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('studioFlatField').open = true;`);
  const initial = await evaluate(`(() => ({
    status: document.getElementById('flatFieldStatus').textContent,
    useEnabled: !document.getElementById('flatFieldUseCurrentBtn').disabled,
    checkboxDisabled: document.getElementById('flatFieldEnabled').disabled
  }))()`);
  if (!/No flat field yet/.test(initial.status) || !initial.useEnabled || !initial.checkboxDisabled) fail('flat field initial state wrong: ' + JSON.stringify(initial));
  await evaluate(`document.getElementById('flatFieldUseCurrentBtn').click()`);
  await waitFor('flat field built', `/corner falloff \\d+ %/.test(document.getElementById('flatFieldStatus').textContent)`, 20_000);
  const built = await evaluate(`document.getElementById('flatFieldStatus').textContent`);
  console.log('camera flat field:', built);
  const falloff = Number((built.match(/corner falloff (\d+) %/) || [])[1]);
  if (!(falloff >= 20 && falloff <= 40)) fail('measured falloff is not the 30 % of the fixture: ' + built);
  if (!(await evaluate(`window.__cameraToasts.some((t) => /Flat field applied to 1 photo/.test(t))`))) fail('flat field apply toast missing');

  await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
  await waitFor('vignetted negative opened', `${ready} && document.getElementById('studioFilename').textContent === 'negative-vignetted.png'`, 150_000);
  await wait(1500);
  const applied = await evaluate(`document.getElementById('flatFieldEnabled').checked`);
  if (!applied) fail('the negative did not receive the flat field');
  const corrected = await deviation();
  await evaluate(`(() => { const el = document.getElementById('flatFieldEnabled'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(2500);
  const raw = await deviation();
  console.log('camera flat field deviation:', JSON.stringify({ raw, corrected }));
  if (!(raw > 0.12)) fail(`fixture without correction should show corner falloff: ${raw}`);
  if (!(corrected < raw * 0.5 && corrected < 0.08)) fail(`flat field did not flatten the corners: raw ${raw} corrected ${corrected}`);
  await evaluate(`(() => { const el = document.getElementById('flatFieldEnabled'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(2500);
  const again = await deviation();
  if (!(again < 0.08)) fail(`re-enabling the flat field did not restore the correction: ${again}`);

  await evaluate(`document.getElementById('flatFieldClearBtn').click()`);
  await waitFor('flat field cleared', `/No flat field yet/.test(document.getElementById('flatFieldStatus').textContent) && document.getElementById('flatFieldEnabled').disabled`, 10_000);
  await wait(2500);
  const cleared = await deviation();
  if (!(cleared > 0.12)) fail(`clearing the flat field did not bring the falloff back: ${cleared}`);

  console.log('ok: a blank light-pad frame becomes the flat field, flattens the vignetted negative when applied, and clears cleanly');

  await runLabMatchScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root });
  await runMultiShotScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root });
  await runLoupeScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port });
}

// Match a lab scan: a "lab JPEG" is made from the preview itself (warmer
// matrix, 5 % crop, downscale) so the alignment has to work and the fitted
// look must pull the preview towards it.
async function runLabMatchScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-textured.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('lab match workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('labMatchRunBtn'))`);
  await installDialogAutoAccept();
  await wait(300);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('lab match fixture converted', `${ready} && document.getElementById('studioFilename').textContent === 'negative-textured.png'`, 150_000);
  await wait(1200);

  const canvasRect = async () => evaluate(`(() => {
    const gl = document.getElementById('glCanvas');
    const el = gl && getComputedStyle(gl).display !== 'none' ? gl : document.getElementById('canvas');
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  })()`);
  const screenshotRgba = async () => {
    const rect = await canvasRect();
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    return { width: png.width, height: png.height, data: new Uint8Array(UPNG.toRGBA8(png)[0]) };
  };
  const meanRgb = (img) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) { r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    return [r / n, g / n, b / n];
  };

  const before = await screenshotRgba();
  const beforeMean = meanRgb(before);
  // The "lab scan": warmer matrix, 5 % crop on every side, 80 % size.
  const cropX = Math.floor(before.width * 0.05), cropY = Math.floor(before.height * 0.05);
  const cw = before.width - 2 * cropX, ch = before.height - 2 * cropY;
  const lw = Math.floor(cw * 0.8), lh = Math.floor(ch * 0.8);
  const lab = new Uint8Array(lw * lh * 4);
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const sx = cropX + Math.floor(x / 0.8), sy = cropY + Math.floor(y / 0.8);
    const si = (sy * before.width + sx) * 4, di = (y * lw + x) * 4;
    const r = before.data[si], g = before.data[si + 1], b = before.data[si + 2];
    lab[di] = Math.min(255, 1.12 * r + 0.03 * g + 6);
    lab[di + 1] = Math.min(255, 0.02 * r + 1.0 * g + 2);
    lab[di + 2] = Math.max(0, Math.min(255, 0.9 * b - 8));
    lab[di + 3] = 255;
  }
  const dir = mkdtempSync(join(tmpdir(), 'nc-labmatch-'));
  const labPath = join(dir, 'lab-scan.png');
  writeFileSync(labPath, Buffer.from(UPNG.encode([lab.buffer], lw, lh, 0)));
  writeFileSync(join(dir, 'preview.png'), Buffer.from(UPNG.encode([before.data.buffer], before.width, before.height, 0)));
  const surfaces = await evaluate(`(() => {
    const gl = document.getElementById('glCanvas'); const c = document.getElementById('canvas');
    return { glShown: !!gl && getComputedStyle(gl).display !== 'none', glSize: gl ? [gl.width, gl.height] : null, canvasSize: c ? [c.width, c.height] : null, webgl2: !!document.createElement('canvas').getContext('webgl2'), dpr: devicePixelRatio, viewport: [innerWidth, innerHeight] };
  })()`);
  console.log('camera lab match input:', JSON.stringify({ canvas: await canvasRect(), screenshot: [before.width, before.height], lab: [lw, lh], labPath, ...surfaces }));

  await evaluate(`(() => {
    window.__labLog = [];
    for (const level of ['warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => { window.__labLog.push(level + ': ' + args.map((a) => (a && a.stack) || String(a)).join(' ')); original(...args); };
    }
    window.addEventListener('unhandledrejection', (e) => window.__labLog.push('rejection: ' + ((e.reason && e.reason.stack) || String(e.reason))));
    document.getElementById('studioTab-edit').click(); document.getElementById('studioLabMatch').open = true;
  })()`);
  const pick = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#labMatchInput' });
  await send('DOM.setFileInputFiles', { files: [labPath], nodeId: pick.result.nodeId });
  await waitFor('lab scan chosen', `/lab-scan\.png chosen/.test(document.getElementById('labMatchStatus').textContent) && !document.getElementById('labMatchRunBtn').disabled`, 10_000);
  await evaluate(`document.getElementById('labMatchRunBtn').click()`);
  const finished = await waitFor('lab match finished', `/difference [\\d.]+ → [\\d.]+/.test(document.getElementById('labMatchStatus').textContent)`, 120_000, { soft: true });
  if (!finished) {
    const log = await evaluate(`JSON.stringify({ status: document.getElementById('labMatchStatus').textContent, log: (window.__labLog || []).slice(-8) })`);
    fail('lab match did not finish: ' + log);
  }
  const status = await evaluate(`document.getElementById('labMatchStatus').textContent`);
  console.log('camera lab match:', status);
  // Alignment and warp ran in the auto-frame worker (#245).
  const labRealm = await evaluate(`({ cv: typeof window.cv, script: !!document.querySelector('script[data-opencv-loader]'), tasks: { ...window.__ncAnalysis.tasks } })`);
  if (labRealm.cv !== 'undefined' || labRealm.script || labRealm.tasks.fallback || labRealm.tasks.worker < 1) fail('lab match loaded OpenCV in the page: ' + JSON.stringify(labRealm));
  console.log('camera lab match log:', await evaluate(`JSON.stringify({ cv: typeof window.cv, cvMat: !!(window.cv && window.cv.Mat), log: (window.__labLog || []).slice(-6) })`));
  const inliers = Number((status.match(/aligned \((\d+) inliers\)/) || [])[1]);
  if (!(inliers >= 12)) fail('lab scan was not aligned: ' + status);
  const [, deltaBefore, deltaAfter] = status.match(/difference ([\d.]+) → ([\d.]+)/).map(Number);
  if (!(deltaAfter < deltaBefore * 0.7)) fail('fitted look did not reduce the difference: ' + status);
  await wait(2500);
  const after = await screenshotRgba();
  const afterMean = meanRgb(after);
  const warmBefore = beforeMean[0] / Math.max(1, beforeMean[2]);
  const warmAfter = afterMean[0] / Math.max(1, afterMean[2]);
  console.log('camera lab match warmth:', JSON.stringify({ beforeMean: beforeMean.map(Math.round), afterMean: afterMean.map(Math.round), warmBefore, warmAfter }));
  if (!(warmAfter > warmBefore * 1.05)) fail(`the look did not pull the preview towards the warmer lab scan: ${warmBefore} -> ${warmAfter}`);
  await evaluate(`document.getElementById('labMatchClearBtn').click()`);
  // The picked file stays available for another match; only the look is gone.
  await waitFor('look cleared', `/chosen; press Match|No lab scan matched yet/.test(document.getElementById('labMatchStatus').textContent) && document.getElementById('labMatchClearBtn').disabled`, 10_000);
  await wait(2500);
  const cleared = meanRgb(await screenshotRgba());
  if (Math.abs(cleared[0] / Math.max(1, cleared[2]) - warmBefore) > 0.03) fail('clearing the look did not restore the preview');
  console.log('ok: a lab scan of the same frame aligns with ORB, the fitted look reduces the difference and pulls the preview towards the lab, and clears cleanly');
}

// Multi-shot merge: three noisy, shifted and slightly rotated shots of the
// same negative merge into one 16-bit file with less grain; the first shot
// plus a one-stop darker bracket merge as HDR.
async function runMultiShotScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = (name) => join(root, 'negative2positive', 'test-fixtures', name);
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('multi-shot workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('studioMergeAverage'))`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`document.getElementById('importFilmTypeAuto').checked && document.getElementById('importFilmTypeAuto').click()`);
  // These are repeated/bracketed exposures of ONE frame. Keep the noise
  // comparison independent of the new automatic whole-roll histogram pass;
  // default-on roll import and atomic undo have their own smoke scenario.
  await evaluate(`document.getElementById('autoRollOnImport').checked && document.getElementById('autoRollOnImport').click()`);
  await evaluate(`(() => {
    window.__cameraToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__cameraToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  // #260: the merge runs in its own worker. Record each merge worker and its
  // termination, the page's OpenCV state when it ends, the stage labels, app
  // dialogs and unhandled rejections; a test hook injects a fault into the
  // worker's start message.
  await evaluate(`(() => {
    const probe = window.__multiShot = { workers: [], labels: [], dialogs: [], rejections: [], fault: null };
    const heap = () => { if (!window.cv?.Mat) return null; const m = new cv.Mat(1, 1, cv.CV_8UC1); const bytes = m.data.buffer.byteLength; m.delete(); return bytes; };
    probe.pageState = () => ({ cv: typeof window.cv, heap: heap(), loader: !!document.querySelector('script[data-opencv-loader]') });
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(url, options) {
        super(url, options);
        if (!/multiShotWorker/.test(String(url))) return;
        const record = { terminated: false, before: probe.pageState() };
        probe.workers.push(record);
        const terminate = this.terminate.bind(this);
        this.terminate = () => {
          record.terminated = true;
          terminate();
        };
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transfer) => post(message?.type === 'start' && probe.fault ? { ...message, fault: probe.fault } : message, transfer);
      }
    };
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) probe.labels.push(node.textContent);
    }).observe(document.getElementById('batchProgressText'), { childList: true });
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        const text = node.nodeType === 1 && node.querySelector('[data-app-dialog-message]');
        if (text) probe.dialogs.push(text.textContent);
      }
    }).observe(document.body, { childList: true });
    window.addEventListener('unhandledrejection', (event) => probe.rejections.push(String(event.reason?.stack || event.reason)));
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  // All four shots go in at once (the add-files picker is a transient input
  // CDP cannot reach); the bracket is deselected for the average merge.
  await send('DOM.setFileInputFiles', { files: ['shot-a.png', 'shot-b.png', 'shot-c.png', 'shot-dark.png'].map(fixture), nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('first shot converted', `${ready} && document.getElementById('studioFilename').textContent === 'shot-a.png'`, 150_000);
  await wait(1200);
  const select = async (wanted) => {
    await evaluate(`(() => {
      const wanted = ${JSON.stringify(wanted)};
      for (const box of document.querySelectorAll('.file-list-checkbox')) {
        if (box.checked !== wanted.includes(Number(box.dataset.index))) box.click();
      }
    })()`);
    await waitFor(`${wanted.length} shots selected`, `document.getElementById('studioSelection').textContent.startsWith('${wanted.length} ')`, 10_000);
  };
  await select([0, 1, 2]);

  // Grain: the median absolute difference between horizontal neighbours over
  // the frame interior. Robust to the fixture's edges, sensitive to noise.
  const grain = async () => {
    const rect = await evaluate(`(() => {
      const gl = document.getElementById('glCanvas');
      const el = gl && getComputedStyle(gl).display !== 'none' ? gl : document.getElementById('canvas');
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    const d = new Uint8Array(UPNG.toRGBA8(png)[0]);
    const diffs = [];
    for (let y = Math.floor(png.height * 0.1); y < png.height * 0.9; y += 3) {
      for (let x = Math.floor(png.width * 0.1); x < png.width * 0.9 - 1; x += 2) {
        const i = (y * png.width + x) * 4; const j = i + 4;
        diffs.push(Math.abs((d[i] + d[i + 1] + d[i + 2]) - (d[j] + d[j + 1] + d[j + 2])));
      }
    }
    diffs.sort((a, b) => a - b);
    return diffs[diffs.length >> 1];
  };
  const single = await grain();
  const enabled = await evaluate(`!document.getElementById('studioMergeAverage').disabled && !document.getElementById('studioMergeHdr').disabled`);
  if (!enabled) fail('merge buttons should be enabled with three selected shots');
  await evaluate(`document.getElementById('studioMergeAverage').click()`);
  await waitFor('average merge finished', `${ready} && /^merged-average-/.test(document.getElementById('studioFilename').textContent)`, 180_000);
  await wait(1500);
  const toast = await evaluate(`(window.__cameraToasts || []).find((t) => /Merged \\d+ shots/.test(t)) || ''`);
  console.log('camera multi-shot:', toast);
  if (!/^Merged 3 shots into merged-average-/.test(toast)) fail('average merge toast wrong: ' + toast);
  const boxes = await evaluate(`[...document.querySelectorAll('.file-list-checkbox')].sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index)).map(el => el.checked)`);
  if (boxes.length !== 5 || boxes.filter(Boolean).length !== 1 || !boxes[4]) fail('the merged file should be the only selected item: ' + JSON.stringify(boxes));
  const merged = await grain();
  console.log('camera multi-shot grain:', JSON.stringify({ single, merged }));
  if (!(merged < single * 0.8)) fail(`averaging three shots did not reduce grain: ${single} -> ${merged}`);
  const averageRun = await evaluate(`JSON.stringify({ workers: window.__multiShot.workers, labels: window.__multiShot.labels, after: window.__multiShot.pageState() })`).then(JSON.parse);
  console.log('camera multi-shot worker:', JSON.stringify(averageRun.workers), 'labels:', JSON.stringify([...new Set(averageRun.labels)]));
  if (averageRun.workers.length !== 1 || !averageRun.workers[0].terminated) fail('the average merge should run in one worker, terminated afterwards: ' + JSON.stringify(averageRun.workers));
  const pageOpenCvUnchanged = (before, after) => before.cv === after.cv && before.heap === after.heap && before.loader === after.loader;
  if (!pageOpenCvUnchanged(averageRun.workers[0].before, averageRun.after)) fail('the merge changed the page OpenCV state: ' + JSON.stringify(averageRun));
  for (const label of [/^Decoding \d \/ 3$/, /^Aligning \d \/ 3$/, /^Merging \d+ %$/, /^Encoding…$/]) {
    if (!averageRun.labels.some((text) => label.test(text))) fail(`progress label ${label} never shown: ${JSON.stringify(averageRun.labels)}`);
  }

  await select([0, 3]);
  if (await evaluate(`document.getElementById('studioMergeHdr').disabled`)) fail('HDR merge should be enabled for the bracket pair');
  await evaluate(`document.getElementById('studioMergeHdr').click()`);
  await waitFor('hdr merge finished', `${ready} && /^merged-hdr-/.test(document.getElementById('studioFilename').textContent)`, 180_000);
  const hdrToast = await evaluate(`(window.__cameraToasts || []).filter((t) => /Merged \\d+ shots/.test(t)).pop() || ''`);
  if (!/^Merged 2 shots into merged-hdr-/.test(hdrToast)) fail('hdr merge toast wrong: ' + hdrToast);
  const hdrRun = await evaluate(`JSON.stringify({ worker: window.__multiShot.workers[1], after: window.__multiShot.pageState() })`).then(JSON.parse);
  if (!hdrRun.worker?.terminated || !pageOpenCvUnchanged(hdrRun.worker.before, hdrRun.after)) fail('the hdr merge changed page OpenCV or did not terminate: ' + JSON.stringify(hdrRun));

  // A forced OpenCV allocation failure in the warp (the 60 MP failure mode)
  // shows the memory alert, releases the UI and terminates the worker.
  const queued = await evaluate(`document.querySelectorAll('.file-list-checkbox').length`);
  await select([0, 1, 2]);
  await evaluate(`window.__multiShot.fault = 'warp-memory'; document.getElementById('studioMergeAverage').click()`);
  await waitFor('memory failure alert', `window.__multiShot.dialogs.some((t) => /too large to merge/.test(t)) && ${ready} && document.getElementById('batchProgressOverlay').style.display === 'none'`, 60_000);
  const failedRun = await evaluate(`JSON.stringify({ worker: window.__multiShot.workers[2] || null, count: document.querySelectorAll('.file-list-checkbox').length, cancelHidden: document.getElementById('batchProgressCancel').hidden })`).then(JSON.parse);
  if (!failedRun.worker?.terminated) fail('the failed merge left its worker running');
  if (failedRun.count !== queued) fail('a failed merge must not add a file');
  if (!failedRun.cancelHidden) fail('the Cancel button stayed visible after the failure');

  // Cancel: the modal, the busy state and the worker go at once, and nothing
  // is added later.
  const dialogsBeforeCancel = await evaluate(`window.__multiShot.dialogs.length`);
  await evaluate(`window.__multiShot.fault = null; document.getElementById('studioMergeAverage').click()`);
  await waitFor('merge worker started', `window.__multiShot.workers.length === 4 && !document.getElementById('batchProgressCancel').hidden`, 30_000);
  const cancelled = await evaluate(`(() => {
    const started = performance.now();
    document.getElementById('batchProgressCancel').click();
    return {
      ms: performance.now() - started,
      overlayHidden: document.getElementById('batchProgressOverlay').style.display === 'none',
      busy: !!document.body.dataset.studioBusy,
      terminated: window.__multiShot.workers[3].terminated
    };
  })()`);
  console.log('camera multi-shot cancel:', JSON.stringify(cancelled));
  if (!(cancelled.ms < 200) || !cancelled.overlayHidden || cancelled.busy || !cancelled.terminated) fail('Cancel did not release the merge at once: ' + JSON.stringify(cancelled));
  await wait(3000);
  const afterCancel = await evaluate(`JSON.stringify({ count: document.querySelectorAll('.file-list-checkbox').length, dialogs: window.__multiShot.dialogs, rejections: window.__multiShot.rejections })`).then(JSON.parse);
  if (afterCancel.count !== queued) fail('a cancelled merge added a file');
  if (afterCancel.dialogs.length !== dialogsBeforeCancel) fail('Cancel must not raise an alert: ' + JSON.stringify(afterCancel.dialogs));
  if (afterCancel.rejections.length) fail('unhandled rejections during the merges: ' + JSON.stringify(afterCancel.rejections));
  console.log('ok: three shifted noisy shots align and average into a quieter 16-bit merge; a bracket pair merges as HDR and opens as the selected file; both run in a terminated worker without touching the page OpenCV; a forced memory failure alerts and Cancel releases at once');
}

// Live loupe: Chrome's fake camera (launch flags in smoke-test.mjs) is
// converted live through the automatic recipe; a capture lands in the photo
// list and opens when the loupe closes.
async function runLoupeScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const previousDocument = await evaluate('performance.timeOrigin');
  // debugCounters: the loupe's grab/conversion/recipe counts (#261).
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debugCounters=1` });
  // The previous multi-shot page exposes the same controls. Do not install the
  // permission probe in that document while navigation is still committing.
  await waitFor('loupe workspace boot', `performance.timeOrigin !== ${previousDocument} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('studioLoupe') && !!document.getElementById('loupeOverlay'))`);
  await installDialogAutoAccept();
  await wait(300);
  // Chrome's fake camera is a finished positive test chart. Explicitly select
  // negative polarity here to verify the live inversion path.
  await evaluate(`document.getElementById('importFilmTypeAuto').checked && document.getElementById('importFilmTypeAuto').click()`);
  await evaluate(`(() => {
    window.__cameraToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__cameraToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const offered = await evaluate(`!document.getElementById('studioLoupe').hidden && !document.getElementById('studioLoupe').disabled`);
  if (!offered) fail('the loupe button should be offered when getUserMedia exists');
  await evaluate(`(() => {
    const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__loupePermissionProbe = { phase: 'installed', timeOrigin: performance.timeOrigin,
      buttonDisabled: document.getElementById('studioLoupe').disabled };
    navigator.mediaDevices.getUserMedia = async (...args) => {
      window.__loupePermissionProbe.phase = 'requested';
      let stream;
      try { stream = await open(...args); }
      catch (error) {
        window.__loupePermissionProbe.error = error.name + ': ' + error.message;
        throw error;
      }
      window.__loupePermissionProbe.phase = 'acquired';
      window.__delayedLoupeStream = stream;
      await new Promise(resolve => { window.__finishLoupePermission = resolve; });
      return stream;
    };
    window.__restoreLoupeCamera = () => { navigator.mediaDevices.getUserMedia = open; };
    document.getElementById('studioLoupe').click();
  })()`);
  await waitFor('camera permission pending', `!!window.__finishLoupePermission || !!window.__loupePermissionProbe?.error`, 30_000);
  const cameraError = await evaluate(`window.__loupePermissionProbe?.error`);
  if (cameraError) fail('fake camera acquisition failed: ' + cameraError);
  await evaluate(`document.getElementById('loupeCloseBtn').click(); window.__finishLoupePermission(); window.__restoreLoupeCamera();`);
  await waitFor('late camera stream released after close', `window.__delayedLoupeStream.getTracks().every(track => track.readyState === 'ended') && document.getElementById('loupeVideo').srcObject === null`, 10_000);
  // The loupe's own conversion workers (created from its conversion path);
  // each must be gone once the loupe closes.
  await evaluate(`(() => {
    const NativeWorker = window.Worker;
    const probe = window.__loupeWorkers = { workers: [] };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (/conversionWorker/.test(String(url)) && /convertLoupeFrame/.test(new Error().stack || '')) probe.workers.push(this);
      }
      terminate() { this.__terminated = true; return super.terminate(); }
    };
    probe.alive = () => probe.workers.filter(worker => !worker.__terminated).length;
    probe.restore = () => { window.Worker = NativeWorker; };
  })()`);
  await evaluate(`document.getElementById('studioLoupe').click()`);
  await waitFor('loupe converting frames', `Number(document.getElementById('loupeOverlay').dataset.frames) >= 5`, 30_000);
  // Paced by the camera, converted in the loupe's worker: no more conversions
  // than presented camera frames, none of them twice, and the automatic
  // recipe re-detected at most once a second.
  const pacing = await evaluate(`new Promise(resolve => {
    const video = document.getElementById('loupeVideo');
    const start = window.__ncDebug.counters().loupe, startTime = performance.now();
    let presented = 0;
    const count = () => { presented++; if (performance.now() - startTime < 2000) video.requestVideoFrameCallback(count); };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(count);
    setTimeout(() => {
      const end = window.__ncDebug.counters().loupe;
      resolve({ pacing: end.pacing, presented, conversions: end.conversions - start.conversions,
        worker: end.workerConversions - start.workerConversions, main: end.mainConversions - start.mainConversions,
        defaults: end.defaultSettings - start.defaultSettings, repeated: end.repeatedFrames, workers: window.__loupeWorkers.workers.length });
    }, 2000);
  })`);
  console.log('camera loupe pacing:', JSON.stringify(pacing));
  if (!(pacing.conversions >= 2 && pacing.worker === pacing.conversions && pacing.main === 0 && pacing.workers === 1))
    fail('the loupe should convert in its own worker: ' + JSON.stringify(pacing));
  if (!(pacing.repeated === 0 && pacing.defaults <= 3 && (pacing.pacing !== 'video-frame' || pacing.conversions <= pacing.presented + 1)))
    fail('the loupe converted more often than the camera presented frames, or rebuilt its automatic recipe per frame: ' + JSON.stringify(pacing));
  // Show raw: no grab, no conversion, the frame counter stops; back to the
  // converted view resumes at once.
  const raw = await evaluate(`(async () => {
    const overlay = document.getElementById('loupeOverlay'), toggle = document.getElementById('loupeRaw');
    toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
    const before = { frames: overlay.dataset.frames, ...window.__ncDebug.counters().loupe };
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = { frames: overlay.dataset.frames, ...window.__ncDebug.counters().loupe };
    toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    const resumedAt = performance.now();
    while (overlay.dataset.frames === after.frames && performance.now() - resumedAt < 2000) await new Promise(resolve => setTimeout(resolve, 10));
    return { stopped: before.frames === after.frames && before.grabs === after.grabs && before.conversions === after.conversions,
      resumedMs: Math.round(performance.now() - resumedAt), resumed: overlay.dataset.frames !== after.frames, view: overlay.dataset.view };
  })()`);
  console.log('camera loupe raw view:', JSON.stringify(raw));
  if (!raw.stopped || !raw.resumed || raw.view !== 'converted') fail('Show raw must stop grabbing and converting, and the converted view must resume: ' + JSON.stringify(raw));
  const status = await evaluate(`document.getElementById('loupeStatus').textContent`);
  console.log('camera loupe:', status);
  if (!/Live · \d+×\d+ · recipe: automatic/.test(status)) fail('loupe status wrong: ' + status);
  const first = await evaluate(`Number(document.getElementById('loupeOverlay').dataset.frames)`);
  await wait(1000);
  const later = await evaluate(`Number(document.getElementById('loupeOverlay').dataset.frames)`);
  if (!(later > first)) fail(`loupe stopped converting: ${first} -> ${later}`);
  // The converted view is a conversion of the camera frame, not a copy: the
  // tonal order is reversed, so luminance correlates negatively.
  const compare = await evaluate(`(() => {
    const video = document.getElementById('loupeVideo');
    const canvas = document.querySelector('#loupeOverlay .loupe-stage canvas');
    const rect = canvas.getBoundingClientRect();
    if (canvas.id !== 'liveLoupeCanvas' || rect.width < 100 || rect.height < 100 || getComputedStyle(canvas).visibility !== 'visible') throw new Error('Converted camera canvas must be visible in the live loupe');
    if (document.getElementById('loupeCanvas').width !== 155) throw new Error('Camera rendering altered the sampling loupe');
    const raw = document.createElement('canvas'); raw.width = canvas.width; raw.height = canvas.height;
    raw.getContext('2d').drawImage(video, 0, 0, raw.width, raw.height);
    const lum = (ctx, w, h) => { const d = ctx.getImageData(0, 0, w, h).data; const out = []; for (let i = 0; i < d.length; i += 16) out.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); return out; };
    const a = lum(raw.getContext('2d'), raw.width, raw.height); const b = lum(canvas.getContext('2d'), canvas.width, canvas.height);
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length; const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return { width: canvas.width, height: canvas.height, rawMean: ma, convertedMean: mb, correlation: num / Math.sqrt(da * db || 1) };
  })()`);
  console.log('camera loupe frame:', JSON.stringify(compare));
  if (!(compare.width > 0 && compare.correlation < -0.1)) fail('the loupe should show an inverted conversion of the camera frame: ' + JSON.stringify(compare));
  await evaluate(`document.getElementById('loupeCaptureBtn').click()`);
  await waitFor('loupe capture queued', `(window.__cameraToasts || []).some((t) => /^Captured loupe-/.test(t)) && document.querySelectorAll('.file-list-checkbox').length === 1`, 30_000);
  const stream = await evaluate(`(() => {
    window.__loupeStream = document.getElementById('loupeVideo').srcObject;
    document.getElementById('loupeCloseBtn').click();
    return { alive: window.__loupeWorkers.alive(), tracks: window.__loupeStream.getTracks().map(track => track.readyState) };
  })()`);
  if (stream.alive !== 0 || !stream.tracks.every(state => state === 'ended')) fail('the closed loupe left a worker or a camera track running: ' + JSON.stringify(stream));
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('capture opened', `document.getElementById('loupeOverlay').hidden && document.getElementById('loupeVideo').srcObject === null && ${ready} && /^loupe-/.test(document.getElementById('studioFilename').textContent)`, 150_000);
  console.log('ok: the live loupe converts the camera feed through the automatic recipe, keeps converting, captures a frame into the photo list and opens it on close');

  // Over a converted photo the loupe follows the photo's edits: the C console
  // key and Cmd/Ctrl+Z each rebuild its recipe within two camera frames.
  await evaluate(`(() => { window.__loupeWorkers.workers = []; document.getElementById('studioLoupe').click(); })()`);
  await waitFor('loupe over the converted photo', `Number(document.getElementById('loupeOverlay').dataset.frames) >= 3 && /recipe: loupe-/.test(document.getElementById('loupeStatus').textContent)`, 30_000);
  const photoStart = await evaluate(`window.__ncDebug.counters().loupe`);
  await evaluate(`window.__ncDebug.pauseLoupeRecipeRefresh(true)`);
  const edits = [];
  for (const [label, init] of [['C', { key: 'c' }], ['undo', { key: 'z', ctrlKey: true }]]) {
    edits.push(await evaluate(`new Promise(resolve => {
      const overlay = document.getElementById('loupeOverlay');
      const frames = Number(overlay.dataset.frames), recipes = Number(overlay.dataset.recipes);
      const watch = new MutationObserver(() => {
        if (Number(overlay.dataset.recipes) === recipes) return;
        watch.disconnect(); clearTimeout(timer);
        resolve({ label: '${label}', framesUntilRebuild: Number(overlay.dataset.frames) - frames });
      });
      const timer = setTimeout(() => { watch.disconnect(); resolve({ label: '${label}', framesUntilRebuild: null }); }, 3000);
      watch.observe(overlay, { attributes: true, attributeFilter: ['data-recipes'] });
      document.getElementById('loupeCloseBtn').dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...${JSON.stringify(init)} }));
    })`));
  }
  console.log('camera loupe edits:', JSON.stringify(edits));
  if (!edits.every(edit => edit.framesUntilRebuild !== null && edit.framesUntilRebuild <= 2)) fail('the loupe did not follow the photo\'s edits within two frames: ' + JSON.stringify(edits));
  await evaluate(`window.__ncDebug.pauseLoupeRecipeRefresh(false)`);
  const photoEnd = await evaluate(`window.__ncDebug.counters().loupe`);
  if (photoEnd.mainConversions !== 0 || photoEnd.workerConversions <= photoStart.workerConversions) fail('photo loupe must convert in its worker: ' + JSON.stringify({ photoStart, photoEnd }));
  const closed = await evaluate(`(() => {
    const tracks = document.getElementById('loupeVideo').srcObject.getTracks();
    document.getElementById('loupeCloseBtn').click();
    const result = { alive: window.__loupeWorkers.alive(), workers: window.__loupeWorkers.workers.length, tracks: tracks.map(track => track.readyState) };
    window.__loupeWorkers.restore();
    return result;
  })()`);
  if (closed.alive !== 0 || closed.workers !== 1 || !closed.tracks.every(state => state === 'ended')) fail('the loupe over a photo left a worker or track running: ' + JSON.stringify(closed));
  console.log('ok: the loupe converts off the main thread, paced by the camera, idles in the raw view, follows edits and releases its worker and tracks on close');
}
