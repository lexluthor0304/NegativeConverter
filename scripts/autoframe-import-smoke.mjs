// Auto-frame import requests (#251) in Chrome:
// - the deterministic preview resizer hashes to the Node golden bytes;
// - an import of three tilted frames with automatic roll analysis sends one
//   'analyze-import' request per frame (frame detection and film edge on one
//   buffer), each on an 8-bit copy (returnPlanes false): the open photo's
//   planes are the editor's, and a roll lane's decode is shared with the
//   foreground and the photo caches (#243), so it is never transferred; no
//   request carries the 16-bit plane unless it is the full-resolution retry,
//   no 'analyze-frame' / 'read-film-edge' request is made, and no rotated
//   frame comes back from the worker.
export async function runAutoFrameImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('auto-frame import boot', `!!document.getElementById('autoRollOnImport') && !!document.getElementById('studioImportAutoCrop') && !!window.__ncGeometry`);
  await installDialogAutoAccept();
  await wait(1000);

  const golden = await evaluate(`(async () => {
    const { areaResizeToMaxSide } = await import('/src/app/autoFramePreview.js');
    const { GOLDEN_PREVIEW_CASES, GOLDEN_PREVIEW_SHA256, goldenPreviewSource } = await import('/test-fixtures/autoFramePreviewGolden.mjs');
    const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    const cases = [];
    for (const [index, entry] of GOLDEN_PREVIEW_CASES.entries()) {
      const preview = areaResizeToMaxSide(goldenPreviewSource(entry), entry.maxSide);
      cases.push({ actual: await hex(preview.data), expected: GOLDEN_PREVIEW_SHA256[index] });
    }
    // For the record: the resizer's speed on a 12 MP frame in this engine.
    const W = 4000, H = 3000, data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
    const started = performance.now();
    areaResizeToMaxSide({ width: W, height: H, data }, 1600);
    return { cases, msPer12MP: Math.round(performance.now() - started) };
  })()`);
  if (golden.cases.some(entry => entry.actual !== entry.expected)) fail('the preview resizer differs from the Node golden bytes: ' + JSON.stringify(golden));
  console.log(`ok: deterministic preview bytes equal the Node golden SHA-256 (resizer ${golden.msPer12MP} ms per 12 MP here)`);

  const autoRollBefore = await evaluate(`(()=>{const key='nc_auto_roll_import_v1',before=localStorage.getItem(key);localStorage.setItem(key,'on');document.getElementById('autoRollOnImport').checked=true;return before})()`);
  const before = await evaluate(`({ ...window.__ncGeometry.diagnostics })`);
  await evaluate(`(async () => {
    const crop = document.getElementById('studioImportAutoCrop'); if (!crop.checked) crop.click();
    const posts = window.__afImport = [];
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message && ['analyze-import', 'analyze-frame', 'read-film-edge'].includes(message.type)) {
        const list = Array.isArray(transfer) ? transfer : (transfer?.transfer || []);
        posts.push({ type: message.type, frame: Boolean(message.frame), filmEdge: Boolean(message.filmEdge),
          returnPlanes: Boolean(message.returnPlanes), image16: Boolean(message.image16), image16Omitted: Boolean(message.image16Omitted),
          transferred: Boolean(message.rgba) && list.includes(message.rgba.buffer), frameOutput: message.frame?.rotatedOutput || null });
      }
      return original.call(this, message, transfer);
    };
    const dt = new DataTransfer();
    for (let n = 1; n <= 3; n++) {
      const W = 900, H = 600, canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'rgb(226,150,96)'; ctx.fillRect(0, 0, W, H);
      ctx.translate(W / 2, H / 2); ctx.rotate((1.5 + n / 2) * Math.PI / 180);
      const gradient = ctx.createLinearGradient(-270, 0, 270, 0);
      gradient.addColorStop(0, 'rgb(70,45,30)'); gradient.addColorStop(1, 'rgb(140,90,60)');
      ctx.fillStyle = gradient; ctx.fillRect(-270, -180, 540, 360);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      dt.items.add(new File([blob], 'af-import-' + n + '.png', { type: 'image/png', lastModified: n }));
    }
    const input = document.getElementById('folderInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('roll lanes analysed the other frames', `${ready} && window.__afImport.filter(post => post.type === 'analyze-import' && post.frame && !post.image16).length >= 3`, 180_000);
  await wait(1500);
  const posts = await evaluate(`window.__afImport`);
  const after = await evaluate(`({ ...window.__ncGeometry.diagnostics })`);
  await evaluate(`(()=>{const key='nc_auto_roll_import_v1',before=${JSON.stringify(autoRollBefore ?? null)};if(before===null)localStorage.removeItem(key);else localStorage.setItem(key,before)})()`);

  const legacy = posts.filter(post => post.type !== 'analyze-import');
  if (legacy.length) fail('the import made separate frame / film-edge requests: ' + JSON.stringify(posts));
  // Every frame's request, the open photo's and the roll lanes', is a
  // size-only request for frame and film edge on an 8-bit copy.
  // (A full-resolution retry, with the 16-bit plane, reads the frame only.)
  const copies = posts.filter(post => !post.image16);
  if (copies.length < 3 || copies.some(post => !post.frame || !post.filmEdge || post.frameOutput !== 'none')) {
    fail('the three frames did not each make one size-only request for frame and film edge: ' + JSON.stringify(posts));
  }
  if (posts.some(post => post.returnPlanes)) {
    fail('a decode the editor or a background lane shares was transferred to the auto-frame worker: ' + JSON.stringify(posts));
  }
  if (posts.some(post => post.image16 && post.image16Omitted)) fail('a request both sent and omitted the 16-bit plane: ' + JSON.stringify(posts));
  if (posts.filter(post => post.image16).length > posts.filter(post => post.image16Omitted).length) {
    fail('16-bit planes were posted without a full-resolution retry: ' + JSON.stringify(posts));
  }
  if (after.workerRotations !== before.workerRotations) fail('the import received rotated frames from the auto-frame worker: ' + JSON.stringify({ before, after }));
  console.log(`ok: ${posts.length} import requests, one per frame on 8-bit copies, sizes only`);
}
