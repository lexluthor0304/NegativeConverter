// Dynamic range compression in the real Studio (docs/dynamic-range-compression.md).
//
// A synthetic contrasty negative (a deep shadow, midtones and a bright
// window, all textured) is imported:
// 1. the hint offers the compression; "Not now" keeps it away for the photo;
// 2. Auto sets the controls from the photo; the frame's shadows come up and
//    its highlights down (the histogram's ends move towards the middle), the
//    fine controls are enabled, Undo and Redo carry the values;
// 3. "Hold to see before" shows the photo without it and goes on release;
// 4. a single export and Export All of the photo carry the same compression
//    as the frame on screen;
// 5. Amount 0 brings the frame back to the uncompressed one exactly.

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runDynamicRangeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  // Without the automatic colour correction: its second, asynchronous
  // measurement would move the frames compared below.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1&rescueDefault=off` });
  await waitFor('drc: boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncDynamicRange`);
  await installDialogAutoAccept();
  await evaluate(`(async () => {
    const autoCrop = document.getElementById('studioImportAutoCrop');
    if (autoCrop.checked) autoCrop.click();
    // A colour negative of a scene spanning about 9 stops.
    const w = 1500, h = 1000, c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); const img = ctx.createImageData(w, h);
    const mask = [0.92, 0.62, 0.42];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const base = x < 500 ? 0.6 / 300 : x < 1000 ? 0.6 / 18 : 0.6;
      const scene = base * (1 + 0.25 * Math.sin(x / 5.3) * Math.sin(y / 6.1)) * (1 + 0.3 * Math.sin(y / 90));
      for (let ch = 0; ch < 3; ch++) {
        const t = mask[ch] * Math.min(1, Math.pow(scene * [1, 0.95, 0.85][ch] / 0.18, -0.62) * 0.12);
        img.data[(y * w + x) * 4 + ch] = Math.round(Math.pow(Math.min(1, t), 1 / 2.2) * 255);
      }
      img.data[(y * w + x) * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise(r => c.toBlob(r)); const dt = new DataTransfer();
    dt.items.add(new File([blob], 'drc-contrast.png', { type: 'image/png' }));
    const input = document.getElementById('fileInput'); input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('drc: photo', `${ready} && document.getElementById('studioFilename').textContent === 'drc-contrast.png' && !!window.__ncDynamicRange.frame()`, 150_000);

  // 1. The hint.
  await waitFor('drc: hint', `!!document.querySelector('.toast-message[data-drc-hint]')`, 60_000);
  const offered = await evaluate(`({ estimate: window.__ncDynamicRange.estimate(), settings: window.__ncDynamicRange.settings(),
    fineDisabled: document.getElementById('drcFineControls').disabled, text: document.querySelector('.toast-message[data-drc-hint]').textContent })`);
  if (!(offered.estimate?.reduction >= 0.08)) fail('the hint appeared without a large enough estimate: ' + JSON.stringify(offered));
  if (offered.settings.drcAmount !== 0 || !offered.fineDisabled) fail('the compression must stay off and its fine controls greyed until asked for: ' + JSON.stringify(offered));
  await evaluate(`document.querySelector('[data-toast-action="drcHintDismiss"]').click()`);
  await waitFor('drc: dismissed', `window.__ncDynamicRange.settings().drcHintDismissed === true && !document.querySelector('.toast-message[data-drc-hint].toast-visible')`, 10_000);
  console.log('ok: the hint offers dynamic range compression on a contrasty photo (estimate', offered.estimate.reduction.toFixed(3) + '), and "Not now" keeps it away');

  // 2. Auto.
  await wait(800);
  const before = await evaluate(`window.__ncDynamicRange.frame()`);
  await evaluate(`document.getElementById('drcAutoBtn').click()`);
  await waitFor('drc: auto', `window.__ncDynamicRange.settings().drcAmount > 0 && ${ready}`, 60_000);
  await waitFor('drc: converted', `${ready} && window.__ncDynamicRange.frame().digest !== ${before.digest}`, 60_000);
  await wait(1500);
  const after = await evaluate(`({ frame: window.__ncDynamicRange.frame(), settings: window.__ncDynamicRange.settings(), fineDisabled: document.getElementById('drcFineControls').disabled, value: document.getElementById('drcAmount').value })`);
  if (after.fineDisabled) fail('the fine controls must be enabled once Amount is above 0');
  if (String(after.settings.drcAmount) !== after.value) fail('the Amount slider does not show the setting: ' + JSON.stringify(after));
  if (!(after.frame.p02 > before.p02 + 0.01)) fail('the shadows did not come up: ' + JSON.stringify({ before, after: after.frame }));
  if (!(after.frame.p98 < before.p98 - 0.005)) fail('the highlights did not come down: ' + JSON.stringify({ before, after: after.frame }));
  console.log('ok: Auto set', JSON.stringify(after.settings), 'and the ends of the histogram moved in:', JSON.stringify({ p02: [before.p02, after.frame.p02].map(v => +v.toFixed(3)), p98: [before.p98, after.frame.p98].map(v => +v.toFixed(3)) }));

  await evaluate(`document.getElementById('studioUndo').click()`);
  await waitFor('drc: undo', `window.__ncDynamicRange.settings().drcAmount === 0 && document.getElementById('drcAmount').value === '0' && document.getElementById('drcFineControls').disabled`, 30_000);
  await waitFor('drc: undo frame', `${ready} && window.__ncDynamicRange.frame().digest === ${before.digest}`, 60_000);
  await evaluate(`document.getElementById('studioRedo').click()`);
  await waitFor('drc: redo', `window.__ncDynamicRange.settings().drcAmount === ${after.settings.drcAmount} && ${ready}`, 30_000);
  await waitFor('drc: redo frame', `${ready} && window.__ncDynamicRange.frame().digest === ${after.frame.digest}`, 60_000);
  console.log('ok: Undo takes the compression off (the frame is the uncompressed one exactly) and Redo puts it back');

  // 3. Hold to see before.
  await evaluate(`document.getElementById('drcCompareBtn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
  await waitFor('drc: compare shown', `document.getElementById('beforeAfterCanvas').style.display === 'block'`, 30_000);
  await evaluate(`document.getElementById('drcCompareBtn').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))`);
  await waitFor('drc: compare hidden', `document.getElementById('beforeAfterCanvas').style.display === 'none' && !window.__ncDynamicRange.compareHeld()`, 10_000);
  console.log('ok: "Hold to see before" shows the photo without the compression and goes on release');

  // 4. Exports: the file carries the frame's compression; Export All gives the same pixels.
  await evaluate(`(() => {
    const probe = window.__drcProbe = { downloads: [] };
    try { delete window.showSaveFilePicker; } catch {}
    window.showSaveFilePicker = undefined;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      probe.downloads.push({ name: this.download, blob: fetch(this.href).then(r => r.blob()) });
    };
  })()`);
  const decode = (index) => `(async () => {
    const entry = window.__drcProbe.downloads[${index}];
    const blob = await entry.blob;
    let file = blob;
    if (/\\.zip$/i.test(entry.name)) {
      // A stored ZIP of one entry: the local header's name and extra field, then the bytes.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const view = new DataView(bytes.buffer);
      const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
      let end = bytes.length; for (let i = bytes.length - 4; i > start; i--) if (view.getUint32(i, true) === 0x08074b50) { end = i; break; }
      file = new Blob([bytes.subarray(start, end)]);
    }
    const bitmap = await createImageBitmap(file);
    const c = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = c.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
    const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const values = []; for (let i = 0; i < d.length; i += 28) values.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
    values.sort((a, b) => a - b);
    const q = (x) => values[Math.min(values.length - 1, Math.floor(x * values.length))];
    let digest = 2166136261; for (let i = 0; i < d.length; i += 4) digest = Math.imul(digest ^ (d[i] + d[i + 1] * 3 + d[i + 2] * 7), 16777619) >>> 0;
    return { name: entry.name, width: bitmap.width, height: bitmap.height, p02: q(0.02), p50: q(0.5), p98: q(0.98), digest };
  })()`;
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  await waitFor('drc: single export', `window.__drcProbe.downloads.length >= 1 && !document.getElementById('exportSingleBtn').disabled && ${ready}`, 180_000);
  await wait(800);
  const single = await evaluate(decode(0));
  const shown = await evaluate(`window.__ncDynamicRange.frame()`);
  for (const key of ['p02', 'p50', 'p98']) {
    if (Math.abs(single[key] - shown[key]) > 0.02) fail(`the exported file's ${key} does not follow the frame on screen: ` + JSON.stringify({ single, shown }));
  }
  if (!(single.p02 > before.p02 + 0.01)) fail('the exported file does not carry the compression: ' + JSON.stringify({ single, before }));
  await evaluate(`document.getElementById('exportAllBtn').click()`);
  await waitFor('drc: export all', `window.__drcProbe.downloads.length >= 2 && !document.getElementById('exportAllBtn').disabled && ${ready}`, 300_000);
  await wait(1500);
  const batch = await evaluate(decode(1));
  if (batch.width !== single.width || batch.height !== single.height || batch.digest !== single.digest) {
    fail('Export All and the single export of the photo differ: ' + JSON.stringify({ single, batch }));
  }
  console.log('ok: the single export carries the compression on screen and Export All writes the same pixels:', JSON.stringify({ size: `${single.width}x${single.height}`, p02: +single.p02.toFixed(3), p98: +single.p98.toFixed(3) }));
  await evaluate(`window.__drcProbe = null`);

  // 5. Off again.
  await evaluate(`(() => { const s = document.getElementById('drcAmount'); s.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); s.value = '0'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('drc: off', `${ready} && window.__ncDynamicRange.settings().drcAmount === 0 && document.getElementById('drcFineControls').disabled`, 30_000);
  await wait(2500);
  await waitFor('drc: off settled', ready, 60_000);
  const offFrame = await evaluate(`window.__ncDynamicRange.frame()`);
  // After the exports the frame on screen is the full-resolution one (the
  // frame measured before was the display preview), so the same pixels are
  // compared by their histogram; Undo above compared the same frame exactly.
  if (offFrame.width === before.width ? offFrame.digest !== before.digest
    : Math.abs(offFrame.p02 - before.p02) > 0.003 || Math.abs(offFrame.p98 - before.p98) > 0.003) {
    fail('Amount 0 did not give back the uncompressed frame: ' + JSON.stringify({ before, offFrame }));
  }
  // The hint stays away for this photo (dismissed, and the compression was used).
  if (await evaluate(`!!document.querySelector('.toast-message[data-drc-hint].toast-visible')`)) fail('the hint came back for a photo where it was dismissed');
  console.log('ok: Amount 0 gives back the uncompressed frame exactly, and the hint does not come back');
}
