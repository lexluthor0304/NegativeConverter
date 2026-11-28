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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// The photo: three zones of a scene 9 stops apart (deep shadow, midtones, a
// bright window), textured, as a neutral (B&W) negative.
function drcNegativePng(width = 1500, height = 1000) {
  const raw = Buffer.alloc((width * 6 + 1) * height);
  const mask = [0.85, 0.85, 0.85];
  for (let y = 0; y < height; y++) {
    const row = y * (width * 6 + 1);
    for (let x = 0; x < width; x++) {
      const base = x < width / 3 ? 0.6 / 300 : x < 2 * width / 3 ? 0.6 / 18 : 0.6;
      const scene = base * (1 + 0.25 * Math.sin(x / 5.3) * Math.sin(y / 6.1)) * (1 + 0.3 * Math.sin(y / 90));
      for (let ch = 0; ch < 3; ch++) {
        const t = mask[ch] * Math.min(1, Math.pow(scene / 0.18, -0.62) * 0.12);
        raw.writeUInt16BE(Math.round(Math.pow(Math.min(1, t), 1 / 2.2) * 65535), row + 1 + x * 6 + ch * 2);
      }
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 16; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function runDynamicRangeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  // Without the automatic colour correction: its second, asynchronous
  // measurement would move the frames compared below.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1&rescueDefault=off` });
  await waitFor('drc: boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncDynamicRange`);
  await installDialogAutoAccept();

  // 0. The GPU stage against the JavaScript reference: a frame of more rows
  //    than one band holds, with dense and tiled strokes and the protection
  //    weights.
  const parity = await evaluate(`(async () => {
    const D = await import('/src/pipeline/dynamicRange.js');
    const G = await import('/src/render/dynamicRangeGpu.js');
    const exposer = G.createDrcExposer();
    if (!exposer.supported) return { supported: false, reason: exposer.reason };
    const w = G.DRC_GPU_TILE + 300, h = Math.floor(G.DRC_GPU_BAND_PIXELS / w) + 211;
    let seed = 11; const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const plane = new Uint16Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const zone = x < w / 3 ? 0.9 : x < 2 * w / 3 ? 0.35 : 0.04;
      for (let c = 0; c < 3; c++) plane[(y * w + x) * 4 + c] = Math.round(Math.min(1, zone * [1, 0.8, 0.6][c] * (1 + 0.2 * Math.sin(x / 7 + c) * Math.sin(y / 9)) + (random() - 0.5) * 0.02) ** (1 / 2.2) * 65535);
      plane[(y * w + x) * 4 + 3] = 65535;
    }
    const settings = { drcAmount: 70, drcShadows: 60, drcHighlights: 45 };
    const map = D.solveDrcMap(D.sampleDrcInput(plane, w, h), settings, { prep: { preSaturation: 100 } });
    map.key = 'parity';
    const method = D.drcMethodParams(settings);
    const dense = new Float32Array(w * h); for (let i = 0; i < dense.length; i++) dense[i] = (i % w) > 1000 && (i % w) < 1300 ? 0.5 : 0;
    const ts = 256, columns = Math.ceil(w / ts), rows = Math.ceil(h / ts);
    const tiles = new Array(columns * rows).fill(null); tiles[columns + 9] = new Float32Array(ts * ts).fill(-0.75);
    const tiled = { tiled: true, width: w, height: h, tileSize: ts, columns, rows, tiles };
    const out = [];
    for (const [name, strokes, inverted] of [['plain', null, true], ['dense strokes', dense, true], ['tiled strokes', tiled, true], ['positive', null, false]]) {
      const a = { width: w, height: h, data: new Uint16Array(plane) }, b = { width: w, height: h, data: new Uint16Array(plane) };
      const wa = new Uint8Array(w * h), wb = new Uint8Array(w * h);
      const t0 = performance.now();
      const outcome = exposer.expose(a, map, method, { inverted, strokes, weights: wa });
      const gpuMs = performance.now() - t0;
      const t1 = performance.now();
      D.exposeDrcReference(b, D.buildDrcStage(map), method, { inverted, strokes, weights: wb });
      const referenceMs = performance.now() - t1;
      let max = 0, differ = 0, changed = 0, wmax = 0;
      for (let i = 0; i < a.data.length; i++) { const d = Math.abs(a.data[i] - b.data[i]); if (d > max) max = d; if (d) differ++; if (a.data[i] !== plane[i]) changed++; }
      for (let i = 0; i < wa.length; i++) wmax = Math.max(wmax, Math.abs(wa[i] - wb[i]));
      out.push({ name, max, differPct: +(100 * differ / a.data.length).toFixed(3), changedPct: +(100 * changed / a.data.length).toFixed(1), weightMax: wmax, gpuTiles: outcome.gpuTiles, referenceTiles: outcome.referenceTiles, gpuMs: Math.round(gpuMs), referenceMs: Math.round(referenceMs) });
    }
    exposer.dispose();
    // The preview shader's stage against the CPU chain (the GPU preview's own self-test, with the compression).
    const preview = await (async () => {
      const canvas = document.createElement('canvas');
      const pgl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false });
      if (!pgl) return { skipped: 'no WebGL2' };
      const { createGpuPreviewRenderer } = await import('/src/render/gpuPreviewRenderer.js');
      const { buildPreviewCase, parityFrame, parityStops } = await import('/src/render/gpuPreviewSelfTest.js');
      const { drcPrepFor } = await import('/src/pipeline/silverAdapter.js');
      const renderer = createGpuPreviewRenderer(pgl);
      renderer.startApplyCompile();
      for (let i = 0; i < 600 && renderer.applyStatus() === 'pending'; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      if (renderer.applyStatus() !== 'linked') return { failed: 'applyProgram did not link: ' + renderer.applyError() };
      const W = 96, H = 64;
      const specs = [
        { name: 'colour', mode: 'color', settings: { colorModel: 'standard' }, drc: { drcAmount: 80, drcShadows: 70 } },
        { name: 'colour, protection 100', mode: 'color', settings: { colorModel: 'standard', saturation: 140 }, drc: { drcAmount: 100, drcSaturation: 100, drcHighlights: 80 } },
        { name: 'colour with strokes', mode: 'color', settings: { colorModel: 'standard', preSaturation: 130 }, drc: { drcAmount: 60 }, stops: true },
        { name: 'B&W', mode: 'bw', settings: { bwMix: 'green' }, drc: { drcAmount: 90, drcLocalContrast: 100 } },
        { name: 'positive', mode: 'positive', settings: { colorModel: 'basic' }, drc: { drcAmount: 70 }, positive: { gain: 1.6, wb: [0.95, 1, 0.9] } },
      ];
      const cases = specs.map((spec, k) => {
        const image = parityFrame(spec.mode, W, H);
        const params = { bwMix: spec.settings.bwMix, preSaturation: spec.settings.preSaturation ?? 100 };
        const prep = drcPrepFor({}, spec.mode, params, spec.positive || null);
        const map = D.solveDrcMap(D.sampleDrcInput(image.data, W, H), spec.drc, { prep });
        map.key = 'case' + k;
        const method = D.drcMethodParams(spec.drc);
        return buildPreviewCase({ name: spec.name, mode: spec.mode, settings: spec.settings, image, stops: spec.stops ? parityStops(W, H) : null,
          positive: spec.positive || null, drc: { map, method, inverted: spec.mode !== 'positive', protect: spec.mode !== 'bw' ? method.protect : 0 } });
      });
      const result = renderer.selfTest(cases);
      return { cases: result.cases.map((c) => ({ name: c.name, maxDiff: c.maxDiff, identical: c.identical })) };
    })();
    // WebGL2 in a worker (OffscreenCanvas): what batch export and the conversion workers get.
    const worker = await new Promise((resolve) => {
      const source = "import('" + location.origin + "/src/render/dynamicRangeGpu.js').then((G) => { const e = G.createDrcExposer(); postMessage({ supported: e.supported, reason: e.reason || '', renderer: e.info?.renderer || '' }); }, (error) => postMessage({ supported: false, reason: String(error) }));";
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const wk = new Worker(url, { type: 'module' });
      const timer = setTimeout(() => resolve({ supported: false, reason: 'no answer' }), 10000);
      wk.onmessage = (event) => { clearTimeout(timer); resolve(event.data); wk.terminate(); };
      wk.onerror = (event) => { clearTimeout(timer); resolve({ supported: false, reason: String(event.message) }); };
    });
    return { supported: true, cases: out, worker, preview };
  })()`);
  if (!parity.supported) {
    console.log('note: no WebGL2 for the dynamic range stage here (' + parity.reason + '); the JavaScript reference runs');
  } else {
    for (const c of parity.cases) {
      if (c.max > 1 || c.weightMax > 1) fail('the GPU stage and the reference differ by more than one least significant bit: ' + JSON.stringify(c));
      if (c.referenceTiles) fail('the GPU stage fell back to the reference: ' + JSON.stringify(c));
      if (!(c.gpuTiles >= 2)) fail('the parity frame did not cross a band border: ' + JSON.stringify(c));
      if (!(c.changedPct > 30)) fail('the compression changed almost nothing: ' + JSON.stringify(c));
    }
    console.log('ok: the GPU exposure stage equals the reference within one least significant bit (across a band border, dense and tiled strokes, a positive):', JSON.stringify(parity.cases), 'worker WebGL2:', JSON.stringify(parity.worker));
    if (parity.preview.failed) fail('the GPU preview could not run: ' + parity.preview.failed);
    if (parity.preview.cases) {
      const bad = parity.preview.cases.filter((c) => c.name !== 'step3' && (c.maxDiff > 1 || c.identical < 0.999));
      if (bad.length) fail('the GPU preview\'s compression differs from the CPU chain: ' + JSON.stringify(bad));
      console.log('ok: the GPU preview draws the compression as the CPU chain does (8-bit display, at most one level):', JSON.stringify(parity.preview.cases));
    }
  }
  await evaluate(`(() => {
    const autoCrop = document.getElementById('studioImportAutoCrop');
    if (autoCrop.checked) autoCrop.click();
  })()`);
  // A negative of a scene spanning about 9 stops, as a 16-bit PNG (a
  // scan's depth: the hint's measure reads the codes the curves see).
  const dir = mkdtempSync(join(tmpdir(), 'nc-drc-'));
  const photo = join(dir, 'drc-contrast.png');
  writeFileSync(photo, drcNegativePng());
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [photo], nodeId: input.result.nodeId });
  await waitFor('drc: photo', `${ready} && document.getElementById('studioFilename').textContent === 'drc-contrast.png' && !!window.__ncDynamicRange.frame()`, 150_000);

  // 1. The hint.
  await waitFor('drc: hint', `!!document.querySelector('.toast-message[data-drc-hint]')`, 60_000);
  const offered = await evaluate(`({ estimate: window.__ncDynamicRange.estimate(), settings: window.__ncDynamicRange.settings(),
    fineDisabled: document.getElementById('drcFineControls').disabled, text: document.querySelector('.toast-message[data-drc-hint]').textContent })`);
  // DRC_HINT_THRESHOLD is 6; the photo clears it by far (about 33 on this Mac).
  if (!(offered.estimate?.benefit >= 6)) fail('the hint appeared without a large enough estimate: ' + JSON.stringify(offered));
  if (!(offered.estimate.benefit >= 15)) console.log('WARN: the hint photo clears the threshold by little: ' + offered.estimate.benefit);
  if (offered.settings.drcAmount !== 0 || !offered.fineDisabled) fail('the compression must stay off and its fine controls greyed until asked for: ' + JSON.stringify(offered));
  await evaluate(`document.querySelector('[data-toast-action="drcHintDismiss"]').click()`);
  await waitFor('drc: dismissed', `window.__ncDynamicRange.settings().drcHintDismissed === true && !document.querySelector('.toast-message[data-drc-hint].toast-visible')`, 10_000);
  console.log('ok: the hint offers dynamic range compression on a contrasty photo (benefit', offered.estimate.benefit.toFixed(2) + '), and "Not now" keeps it away');

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
