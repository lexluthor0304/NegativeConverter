// Auto-frame import requests (#251) in Chrome:
// - the deterministic preview resizer hashes to the Node golden bytes;
// - an import of four tilted frames (one 16-bit) with automatic roll analysis sends one
//   'analyze-import' request per frame (frame detection and film edge on one
//   buffer), each on an 8-bit copy (returnPlanes false): the open photo's
//   planes are the editor's, and a roll lane's decode is shared with the
//   foreground and the photo caches (#243), so it is never transferred; no
//   request carries the 16-bit plane unless it is the full-resolution retry,
//   no 'analyze-frame' / 'read-film-edge' request is made, and no rotated
//   frame comes back from the worker.
import { createRequire } from 'node:module';
import { encodePng16Blob } from '../negative2positive/src/workers/imageEncoders.js';

export async function runAutoFrameImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  // Exercise the non-shared copy path too (WKWebView). Shared 16-bit views
  // intentionally travel with the first request under #264.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&sharedPlanes=0` });
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
  const W16 = 904, H16 = 604, rgba16 = new Uint16Array(W16 * H16 * 4);
  const angle = 3.5 * Math.PI / 180;
  for (let y = 0; y < H16; y++) for (let x = 0; x < W16; x++) {
    const dx = x - W16 / 2, dy = y - H16 / 2;
    const u = dx * Math.cos(angle) + dy * Math.sin(angle), v = -dx * Math.sin(angle) + dy * Math.cos(angle);
    const inside = Math.abs(u) < 270 && Math.abs(v) < 180;
    const rgb = inside ? [90 + (u + 270) / 10, 55 + (u + 270) / 18, 35] : [226, 150, 96];
    const at = (y * W16 + x) * 4;
    for (let c = 0; c < 3; c++) rgba16[at + c] = Math.round(rgb[c] * 257) + ((x + y + c) % 73);
    rgba16[at + 3] = 65535;
  }
  const png16 = Buffer.from(await encodePng16Blob(rgba16, W16, H16, createRequire(import.meta.url)('pako')).arrayBuffer()).toString('base64');
  await evaluate(`(async () => {
    const crop = document.getElementById('studioImportAutoCrop'); if (!crop.checked) crop.click();
    const posts = window.__afImport = [];
    const replies = window.__afImportReplies = [];
    const watched = new WeakMap();
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      if (message && ['analyze-import', 'analyze-frame', 'read-film-edge'].includes(message.type)) {
        if (!watched.has(this)) {
          const pending = new Map(); watched.set(this, pending);
          this.addEventListener('message', ({ data }) => {
            const request = pending.get(data?.id);
            if (!request) return;
            pending.delete(data.id);
            replies.push({ ...request, rotated: Boolean(data.result?.frame?.rotatedImageData), error: data.error || null });
          });
        }
        const list = Array.isArray(transfer) ? transfer : (transfer?.transfer || []);
        const request = { type: message.type, width: message.width, height: message.height, frame: Boolean(message.frame), filmEdge: Boolean(message.filmEdge),
          returnPlanes: Boolean(message.returnPlanes), image16: Boolean(message.image16), image16Omitted: Boolean(message.image16Omitted),
          transferred: Boolean(message.rgba) && list.includes(message.rgba.buffer), frameOutput: message.frame?.rotatedOutput || null };
        posts.push(request); watched.get(this).set(message.id, request);
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
    const blob16 = await (await fetch('data:image/png;base64,${png16}')).blob();
    dt.items.add(new File([blob16], 'af-import-4-16.png', { type: 'image/png', lastModified: 4 }));
    const input = document.getElementById('folderInput'); input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('roll lanes analysed the other frames', `${ready} && window.__afImportReplies.filter(reply => reply.type === 'analyze-import' && reply.frame && reply.filmEdge).length >= 4`, 180_000);
  await wait(1500);
  const posts = await evaluate(`window.__afImport`);
  const replies = await evaluate(`window.__afImportReplies`);
  await evaluate(`(()=>{const key='nc_auto_roll_import_v1',before=${JSON.stringify(autoRollBefore ?? null)};if(before===null)localStorage.removeItem(key);else localStorage.setItem(key,before)})()`);

  const legacy = posts.filter(post => post.type !== 'analyze-import');
  if (legacy.length) fail('the import made separate frame / film-edge requests: ' + JSON.stringify(posts));
  // Every frame's request, the open photo's and the roll lanes', is a
  // size-only request for frame and film edge on an 8-bit copy.
  // (A full-resolution retry, with the 16-bit plane, reads the frame only.)
  const copies = posts.filter(post => !post.image16);
  if (copies.length < 4 || copies.some(post => !post.frame || !post.filmEdge || post.frameOutput !== 'none')) {
    fail('the four frames did not each make one size-only request for frame and film edge: ' + JSON.stringify(posts));
  }
  const sixteen = posts.find(post => post.width === W16 && post.height === H16 && post.frame && post.filmEdge);
  if (!sixteen?.image16Omitted || sixteen.image16) fail('the 16-bit fixture did not omit its plane on the initial request: ' + JSON.stringify(posts));
  if (posts.some(post => post.returnPlanes)) {
    fail('a decode the editor or a background lane shares was transferred to the auto-frame worker: ' + JSON.stringify(posts));
  }
  if (posts.some(post => post.image16 && post.image16Omitted)) fail('a request both sent and omitted the 16-bit plane: ' + JSON.stringify(posts));
  if (posts.filter(post => post.image16).length > posts.filter(post => post.image16Omitted).length) {
    fail('16-bit planes were posted without a full-resolution retry: ' + JSON.stringify(posts));
  }
  if (replies.some(reply => reply.rotated)) fail('the import received rotated frames from the auto-frame worker: ' + JSON.stringify(replies));
  console.log(`ok: ${posts.length} import requests, one per frame on 8-bit copies, 16-bit plane omitted, ${replies.length} replies without rotated frames`);
}
