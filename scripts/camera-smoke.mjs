// Camera-scanning smoke: a blank light-pad frame becomes the roll's flat
// field and flattens a negative shot on the same pad.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

export async function runCameraSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['lightpad-blank.png', 'negative-vignetted.png'].map((name) => join(root, 'negative2positive', 'test-fixtures', name));
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('camera workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('flatFieldUseCurrentBtn')`);
  await installDialogAutoAccept();
  await wait(300);
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
}

// Match a lab scan: a "lab JPEG" is made from the preview itself (warmer
// matrix, 5 % crop, downscale) so the alignment has to work and the fitted
// look must pull the preview towards it.
async function runLabMatchScenario({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-textured.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('lab match workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('labMatchRunBtn')`);
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
