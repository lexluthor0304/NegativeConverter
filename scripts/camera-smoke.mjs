// Camera-scanning smoke: a blank light-pad frame becomes the roll's flat
// field and flattens a negative shot on the same pad; a lab scan is matched;
// several shots of one frame merge into a quieter 16-bit file; the live loupe
// converts Chrome's fake camera and captures a frame.
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

  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
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
  await evaluate(`(() => {
    window.__cameraToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__cameraToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
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
      for (let i = 0; i < document.querySelectorAll('.file-list-checkbox').length; i++) {
        const box = document.querySelectorAll('.file-list-checkbox')[i];
        if (box.checked !== wanted.includes(i)) box.click();
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
  const boxes = await evaluate(`Array.from(document.querySelectorAll('.file-list-checkbox')).map((el) => el.checked)`);
  if (boxes.length !== 5 || boxes.filter(Boolean).length !== 1 || !boxes[4]) fail('the merged file should be the only selected item: ' + JSON.stringify(boxes));
  const merged = await grain();
  console.log('camera multi-shot grain:', JSON.stringify({ single, merged }));
  if (!(merged < single * 0.8)) fail(`averaging three shots did not reduce grain: ${single} -> ${merged}`);

  await select([0, 3]);
  if (await evaluate(`document.getElementById('studioMergeHdr').disabled`)) fail('HDR merge should be enabled for the bracket pair');
  await evaluate(`document.getElementById('studioMergeHdr').click()`);
  await waitFor('hdr merge finished', `${ready} && /^merged-hdr-/.test(document.getElementById('studioFilename').textContent)`, 180_000);
  const hdrToast = await evaluate(`(window.__cameraToasts || []).filter((t) => /Merged \\d+ shots/.test(t)).pop() || ''`);
  if (!/^Merged 2 shots into merged-hdr-/.test(hdrToast)) fail('hdr merge toast wrong: ' + hdrToast);
  console.log('ok: three shifted noisy shots align and average into a quieter 16-bit merge; a bracket pair merges as HDR and opens as the selected file');
}

// Live loupe: Chrome's fake camera (launch flags in smoke-test.mjs) is
// converted live through the automatic recipe; a capture lands in the photo
// list and opens when the loupe closes.
async function runLoupeScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('loupe workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('studioLoupe') && !!document.getElementById('loupeOverlay'))`);
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
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await open(...args);
      window.__delayedLoupeStream = stream;
      await new Promise(resolve => { window.__finishLoupePermission = resolve; });
      return stream;
    };
    window.__restoreLoupeCamera = () => { navigator.mediaDevices.getUserMedia = open; };
    document.getElementById('studioLoupe').click();
  })()`);
  await waitFor('camera permission pending', `!!window.__finishLoupePermission`, 30_000);
  await evaluate(`document.getElementById('loupeCloseBtn').click(); window.__finishLoupePermission(); window.__restoreLoupeCamera();`);
  await waitFor('late camera stream released after close', `window.__delayedLoupeStream.getTracks().every(track => track.readyState === 'ended') && document.getElementById('loupeVideo').srcObject === null`, 10_000);
  await evaluate(`document.getElementById('studioLoupe').click()`);
  await waitFor('loupe converting frames', `Number(document.getElementById('loupeOverlay').dataset.frames) >= 5`, 30_000);
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
  await evaluate(`document.getElementById('loupeCloseBtn').click()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('capture opened', `document.getElementById('loupeOverlay').hidden && document.getElementById('loupeVideo').srcObject === null && ${ready} && /^loupe-/.test(document.getElementById('studioFilename').textContent)`, 150_000);
  console.log('ok: the live loupe converts the camera feed through the automatic recipe, keeps converting, captures a frame into the photo list and opens it on close');
}
