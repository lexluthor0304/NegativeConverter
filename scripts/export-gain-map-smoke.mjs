// #240: the export worker's 16-bit result and the JPEG gain map, in a real
// browser. Blink's ImageData rejects a buffer of the wrong length, which is how
// the worker's 16-bit result used to be dropped without a word; a Node stub
// cannot prove that. Part 1 runs the real bridge and worker module against the
// main-thread path; part 2 checks through the Studio export that the gain-map
// request follows the export's intent (sent for a plain JPEG, not for the
// sprocket frame, which drops the map, nor for the contact sheet). Since #250
// the map travels in the JPEG's own `encodeImage` request.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runExportGainMapSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('gain-map smoke boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(300);

  // ---- 1. real Worker, real ImageData, real structured clone ----
  const worker = await evaluate(`(async () => {
    const { createExportWorkerBridge } = await import('/src/workers/workerBridge.js');
    const { markOwnedPlanes } = await import('/src/app/planeRelease.js');
    const { applyPreparedAdjustmentsToBuffer16 } = await import('/src/app/adjustmentPipeline.js');
    const { computeGainMap } = await import('/src/app/gainMapJpeg.js');
    const W = 173, H = 97; // not multiples of 4: partial map blocks
    const makeProcessed = () => {
      const plane = new Uint16Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, t = x / (W - 1) * 0.8 + y / (H - 1) * 0.2;
        plane[o] = Math.round(t * 65535); plane[o + 1] = Math.round(t * 0.85 * 65535 + 97);
        plane[o + 2] = Math.round(t * 0.7 * 65535 + 13); plane[o + 3] = 65535;
      }
      const image = new ImageData(Uint8ClampedArray.from(plane, v => v >>> 8), W, H);
      image.__image16 = { width: W, height: H, data: plane };
      return image;
    };
    const processed = makeProcessed();
    const s = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
    const settings = { curves: { r: s, g: new Uint8Array(s), b: new Uint8Array(s) }, exposure: 0.2, contrast: 8,
      highlights: -15, shadows: 10, saturation: 12, vibrance: 20, wbR: 1.05, wbG: 1, wbB: 0.95,
      temperature: 5, tint: 0, cyan: 2, magenta: 0, yellow: -1, look: null };
    const reference = new ImageData(new Uint8ClampedArray(W * H * 4), W, H);
    applyPreparedAdjustmentsToBuffer16(processed, settings, reference);
    const same = (a, b) => Boolean(a && b) && a.length === b.length && a.every((v, i) => v === b[i]);
    const bridge = createExportWorkerBridge();
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => { warnings.push(String(args[0])); warn.apply(console, args); };
    try {
      const adjusted = await bridge.workerApplyAdjustments16(processed, settings, 'full');
      const planeOnly = await bridge.workerApplyAdjustments16(processed, settings, 'full', { planeOnly: true });
      const sdr = new ImageData(Uint8ClampedArray.from(reference.data, (v, i) => i % 4 === 3 ? 255 : Math.max(0, v - (i % 3))), W, H);
      const expected = computeGainMap(sdr, reference.__image16);
      const map = await bridge.workerGainMap16(processed, sdr, settings);
      // Only an export-owned plane may be transferred (#250).
      const owned = markOwnedPlanes(makeProcessed());
      const transferred = await bridge.workerGainMap16(owned, sdr, settings, { transferPlane: true });
      return {
        adjusted: adjusted instanceof ImageData,
        plane16: adjusted?.__image16?.data instanceof Uint16Array,
        planeSame: same(adjusted?.__image16?.data, reference.__image16.data),
        mirrorSame: same(adjusted?.data, reference.data),
        planeOnly: Boolean(planeOnly) && !('data' in planeOnly) && same(planeOnly.__image16?.data, reference.__image16.data),
        sourceIntact: processed.__image16.data.length === W * H * 4,
        mapSame: Boolean(map) && same(map.data, expected.data) && Object.is(map.gainMax, expected.gainMax),
        gainMax: map?.gainMax,
        transferred: Boolean(transferred) && same(transferred.data, expected.data) && owned.__image16.data.byteLength === 0,
        warnings
      };
    } finally {
      console.warn = warn;
      bridge.terminateWorker();
    }
  })()`);
  console.log('export worker 16-bit / gain map:', JSON.stringify(worker));
  if (!worker.adjusted || !worker.plane16 || !worker.planeSame || !worker.mirrorSame) {
    fail("the worker's 16-bit result is not used, or differs from the main-thread path: " + JSON.stringify(worker));
  }
  if (!worker.planeOnly || !worker.sourceIntact) fail('planeOnly / source plane regression: ' + JSON.stringify(worker));
  if (!worker.mapSame || !worker.transferred) fail('worker gain map differs from the main-thread map: ' + JSON.stringify(worker));
  if (worker.warnings.length) fail('the worker path fell back: ' + JSON.stringify(worker.warnings));

  // ---- 2. Studio export: who asks for a gain map ----
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [join(root, 'negative2positive', 'test-fixtures', 'negative-gradient-16.png')], nodeId: input.result.nodeId });
  await waitFor('gain-map fixture ready', ready, 120_000);
  await evaluate(`(() => {
    const probe = window.__gainMapProbe = { requests: [], downloads: [] };
    try { delete window.showSaveFilePicker; } catch {}
    window.showSaveFilePicker = undefined;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message && typeof message.type === 'string') {
        probe.requests.push(message.type === 'encodeImage' && message.gainMap ? 'encodeImage+gainMap' : message.type);
      }
      return post.call(this, message, ...rest);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      probe.downloads.push(fetch(this.href).then(r => r.blob()));
    };
    probe.restore = () => { Worker.prototype.postMessage = post; HTMLAnchorElement.prototype.click = click; };
    try { localStorage.setItem('nc_hdr_gain_map_v1', 'on'); } catch {}
    const gain = document.getElementById('exportHdrGainMap');
    if (gain && !gain.checked) gain.click();
    document.querySelector('.format-btn[data-format="jpeg"]').click();
  })()`);
  const setBorder = (on) => evaluate(`(() => {
    const border = document.getElementById('studioExportBorder');
    if (border.checked !== ${on}) { border.checked = ${on}; border.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  const exportJpeg = async (label) => {
    const index = await evaluate(`(() => { const p = window.__gainMapProbe; p.requests = []; document.getElementById('exportSingleBtn').click(); return p.downloads.length; })()`);
    await waitFor(label, `window.__gainMapProbe.downloads.length > ${index} && !document.getElementById('exportSingleBtn').disabled`, 120_000);
    return evaluate(`(async () => {
      const { listJpegSegments } = await import('/src/app/exportMetadata.js');
      const p = window.__gainMapProbe;
      const blob = await p.downloads[${index}];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const text = new TextDecoder('latin1').decode(bytes);
      const segments = listJpegSegments(bytes);
      return {
        type: blob.type, size: bytes.length,
        mpf: segments.some(s => s.marker === 0xE2 && new TextDecoder().decode(s.data.subarray(0, 4)) === 'MPF\\0'),
        gainMapMax: /hdrgm:GainMapMax="([^"]+)"/.exec(text)?.[1] || null,
        gainMap16: p.requests.filter(t => t === 'gainMap16').length,
        encodeWithMap: p.requests.filter(t => t === 'encodeImage+gainMap').length,
        encodeWithoutMap: p.requests.filter(t => t === 'encodeImage').length,
        adjust16: p.requests.filter(t => t === 'applyAdjustments16').length
      };
    })()`);
  };
  try {
    await setBorder(false);
    const plain = await exportJpeg('plain JPEG with gain map');
    console.log('plain JPEG export:', JSON.stringify(plain));
    if (!plain.mpf || !plain.gainMapMax) fail('JPEG export lost its gain map: ' + JSON.stringify(plain));
    if (plain.encodeWithMap !== 1 || plain.gainMap16 !== 0 || plain.adjust16 !== 0) {
      fail('a plain JPEG must send its map in exactly one encodeImage request, with no separate gain-map pass or 16-bit adjustment: ' + JSON.stringify(plain));
    }
    // A second export (a fresh per-export worker) must describe the same map.
    const again = await exportJpeg('repeat JPEG with gain map');
    if (again.gainMapMax !== plain.gainMapMax || again.encodeWithMap !== 1) fail('repeated JPEG export differs: ' + JSON.stringify({ plain, again }));

    await setBorder(true);
    const framed = await exportJpeg('sprocket JPEG');
    console.log('sprocket JPEG export:', JSON.stringify(framed));
    if (framed.mpf || framed.gainMapMax) fail('the sprocket frame never carried a gain map: ' + JSON.stringify(framed));
    if (framed.gainMap16 !== 0 || framed.encodeWithMap !== 0 || framed.adjust16 !== 0 || framed.encodeWithoutMap !== 1) {
      fail('the sprocket frame must be encoded without a gain map or a 16-bit pass: ' + JSON.stringify(framed));
    }

    // The contact sheet renders every frame through the batch pipeline but
    // encodes no plane or map: no gain-map pass, whatever the export format.
    await setBorder(false);
    const sheet = await evaluate(`(async () => {
      const p = window.__gainMapProbe; p.requests = []; const index = p.downloads.length;
      document.getElementById('exportContactSheetBtn').click();
      const started = performance.now();
      while (p.downloads.length === index && performance.now() - started < 120000) await new Promise(r => setTimeout(r, 200));
      const blob = await p.downloads[index];
      return { type: blob?.type, gainMap16: p.requests.filter(t => t === 'gainMap16').length,
        encodeWithMap: p.requests.filter(t => t === 'encodeImage+gainMap').length,
        adjust16: p.requests.filter(t => t === 'applyAdjustments16').length };
    })()`);
    console.log('contact sheet with JPEG selected:', JSON.stringify(sheet));
    if (!/png/.test(sheet.type || '')) fail('contact sheet was not exported: ' + JSON.stringify(sheet));
    if (sheet.gainMap16 !== 0 || sheet.encodeWithMap !== 0 || sheet.adjust16 !== 0) fail('the contact sheet started a gain-map pass: ' + JSON.stringify(sheet));
  } finally {
    await setBorder(false);
    await evaluate(`(() => { window.__gainMapProbe?.restore(); document.querySelector('.format-btn[data-format="png"]').click(); })()`);
  }
  console.log('ok: the worker 16-bit result and gain map match the main thread; gain-map requests follow the export intent');
}
