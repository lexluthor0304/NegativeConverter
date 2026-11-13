// Focus recovery in a real browser (docs/focus-recovery.md).
//
// 1. The GPU against the reference arithmetic: a blurred synthetic scene, 8
//    and 16 bits, and a frame wider than a tile (a tile border runs through
//    it): at most one least significant bit apart.
// 2. The editor: the slider recovers the open photo's full-resolution frame,
//    the status says what was undone, Undo and Redo take the strength and
//    the frame along, and an export with it on succeeds.
// A browser without float render targets has no focus recovery: the smoke
// says so and checks that the control is off.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const settled = `/undone|sharp|No edges|Error/i.test(document.getElementById('focusRecoveryStatus').textContent)`;

export async function runFocusRecoverySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
  await waitFor('focus: boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();

  const parity = await evaluate(`(async () => {
    const F = await import('/src/render/focusRecovery.js');
    const recoverer = F.createFocusRecoverer();
    if (!recoverer.supported) return { supported: false };
    let seed = 7; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const scene = (w, h, sixteen) => {
      const grey = new Float32Array(w * h).fill(70);
      for (let k = 0; k < 40; k++) { const x0 = Math.floor(random() * w), y0 = Math.floor(random() * h), bw = 20 + Math.floor(random() * 90), bh = 20 + Math.floor(random() * 90), v = 40 + random() * 170;
        for (let y = y0; y < Math.min(h, y0 + bh); y++) for (let x = x0; x < Math.min(w, x0 + bw); x++) grey[y * w + x] = v; }
      const taps = F.focusKernel(2.5), r = taps.length >> 1, tmp = new Float32Array(w * h), soft = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += grey[y * w + Math.min(w - 1, Math.max(0, x + i))] * taps[i + r]; tmp[y * w + x] = s; }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * taps[i + r]; soft[y * w + x] = s; }
      const data = new Uint8ClampedArray(w * h * 4), plane = sixteen ? new Uint16Array(w * h * 4) : null;
      for (let p = 0; p < w * h; p++) { const v = soft[p] + (random() - 0.5) * 3;
        for (let c = 0; c < 3; c++) { const value = Math.max(0, Math.min(255, v * [1, 0.9, 0.8][c])); data[p * 4 + c] = Math.round(value); if (plane) plane[p * 4 + c] = Math.round(value * 257); }
        data[p * 4 + 3] = 255; if (plane) plane[p * 4 + 3] = 65535; }
      const frame = new ImageData(data, w, h); if (plane) frame.__image16 = { width: w, height: h, data: plane }; return frame; };
    const plan = { sigma: 2.2, damp: 0.03, iterations: F.FOCUS_ITERATIONS };
    const out = { supported: true, cases: [] };
    for (const [w, h, sixteen] of [[640, 420, false], [640, 420, true], [F.FOCUS_TILE + 260, 300, false]]) {
      const frame = scene(w, h, sixteen);
      const gpu = await recoverer.recover(frame, plan), reference = F.recoverFocusReference(frame, plan);
      const a = sixteen ? gpu.__image16.data : gpu.data, b = sixteen ? reference.__image16.data : reference.data, source = sixteen ? frame.__image16.data : frame.data;
      let max = 0, changed = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d; if (a[i] !== source[i]) changed++; }
      let eight = true; if (sixteen) for (let i = 0; i < gpu.data.length; i += 13) if (gpu.data[i] !== gpu.__image16.data[i] >>> 8) eight = false;
      out.cases.push({ w, h, sixteen, max, changed: changed / a.length, eight, tiles: F.focusTiles(w, h).length });
    }
    const estimate = F.estimateFocus(scene(900, 700, false));
    out.estimate = estimate && estimate.sigma;
    recoverer.dispose();
    return out;
  })()`);
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  await waitFor('focus: photo', `${ready} && document.getElementById('studioFilename').textContent === 'negative-sample.jpg'`, 150_000);
  await evaluate(`document.getElementById('studioTab-repair').click()`);

  if (!parity.supported) {
    const off = await evaluate(`({ disabled: document.getElementById('focusRecovery').disabled, status: document.getElementById('focusRecoveryStatus').textContent })`);
    if (!off.disabled || !/GPU/.test(off.status)) fail('without float render targets the focus control must be off: ' + JSON.stringify(off));
    console.log('ok: no float render targets in this browser: focus recovery is off and says why');
    return;
  }
  for (const c of parity.cases) {
    if (c.max > 1) fail('the GPU and the reference differ by more than one least significant bit: ' + JSON.stringify(c));
    if (!(c.changed > 0.05)) fail('the recovery changed almost nothing: ' + JSON.stringify(c));
    if (!c.eight) fail('the 8-bit data does not follow the 16-bit plane: ' + JSON.stringify(c));
  }
  if (!(parity.cases[2].tiles > 1)) fail('the wide frame must cross a tile border: ' + JSON.stringify(parity.cases[2]));
  if (!(Math.abs(parity.estimate - 2.5) < 0.75)) fail('a 2.5 px blur was read as ' + parity.estimate);
  console.log('ok: GPU focus recovery equals the reference within one least significant bit (8 and 16 bits, across a tile border):', JSON.stringify(parity.cases.map(c => c.max)));

  const set = async (value, label) => {
    await evaluate(`(() => { const s = document.getElementById('focusRecovery'); s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); s.value = '${value}'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    if (value > 0) await waitFor(label, `${ready} && ${settled}`, 120_000);
    else await waitFor(label, `document.getElementById('focusRecoveryStatus').textContent === 'Off'`, 60_000);
    return evaluate(`({ status: document.getElementById('focusRecoveryStatus').textContent, value: document.getElementById('focusRecovery').value })`);
  };
  const on = await set(100, 'focus: recovered');
  if (/Error/.test(on.status)) fail('focus recovery failed: ' + on.status);
  await evaluate(`document.getElementById('studioUndo').click()`);
  await waitFor('focus: undo', `document.getElementById('focusRecovery').value === '0' && document.getElementById('focusRecoveryStatus').textContent === 'Off'`, 60_000);
  await evaluate(`document.getElementById('studioRedo').click()`);
  await waitFor('focus: redo', `document.getElementById('focusRecovery').value === '100' && ${settled}`, 120_000);
  // An export with it on: the barrier ends and a file is made.
  await evaluate(`(() => { window.__focusExports = 0; const create = URL.createObjectURL.bind(URL); URL.createObjectURL = (blob) => { if (blob instanceof Blob && blob.size > 10000) window.__focusExports++; return create(blob); };
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) return; return click.call(this); };
    document.getElementById('exportSingleBtn').click(); })()`);
  await waitFor('focus: export', `window.__focusExports > 0`, 120_000);
  await wait(500);
  const off = await set(0, 'focus: off');
  console.log('ok: the focus slider recovers the open photo, follows undo and redo, exports, and turns off:', JSON.stringify({ on: on.status, off: off.status }));
}
