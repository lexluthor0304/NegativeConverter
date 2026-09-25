// #257: the PNG16 band encoder with real browser Workers. The Node tests run
// the worker handler in process; this proves the same bytes with real
// Workers, structured clone and Blob hand-off, and that a cancel terminates
// the band workers. Part 2 checks that a Studio 16-bit PNG export goes
// through the band pool and releases its workers when it ends.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runPng16BandSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('png16 smoke boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(300);

  // ---- 1. same bytes with 1, 2 and 6 workers, one worker and the main thread ----
  const parity = await evaluate(`(async () => {
    const { createPng16BandPool, createExportWorkerBridge, isAbortError } = await import('/src/workers/workerBridge.js');
    const { encodePng16Blob } = await import('/src/app/exportImageEncoders.js');
    const { planPng16Bands } = await import('/src/workers/png16Bands.js');
    const { loadPngFile } = await import('/src/app/pngFileLoader.js');
    const W = 613, H = 401, bandBytes = 60000; // 3679-byte rows: 16 rows per band, 26 bands
    let seed = 7;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const plane = new Uint16Array(W * H * 4);
    for (let i = 0; i < plane.length; i++) plane[i] = i % 4 === 3 ? 65535 : (Math.round((i % (W * 4)) / (W * 4) * 50000) + (random() >>> 22)) & 0xFFFF;
    const image16 = new ImageData(Uint8ClampedArray.from(plane, v => v >>> 8), W, H);
    image16.__image16 = { width: W, height: H, data: plane };
    const image8 = new ImageData(Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => i % 4 === 3 ? random() >>> 24 : random() >>> 24), W, H);
    const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
    const same = (a, b) => Boolean(a && b) && a.length === b.length && a.every((v, i) => v === b[i]);
    // The IDAT data through the browser's zlib, which verifies the Adler-32.
    const inflateIdat = async (bytes) => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const parts = [];
      const types = [];
      for (let at = 8; at < bytes.length;) {
        const length = view.getUint32(at);
        const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
        types.push(type);
        if (type === 'IDAT') parts.push(bytes.slice(at + 8, at + 8 + length));
        at += 12 + length;
      }
      const stream = new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'));
      return { types, filtered: (await new Response(stream).arrayBuffer()).byteLength };
    };
    const out = { cases: [] };
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => { warnings.push(String(args[0])); warn.apply(console, args); };
    try {
      for (const [label, image] of [['16-bit', image16], ['8-bit alpha', image8]]) {
        const channels = label === '16-bit' ? 3 : 4;
        const bands = planPng16Bands(W, H, channels, { bandBytes }).bands.length;
        const reference = await bytesOf(encodePng16Blob(image, { bandBytes }));
        const pools = {};
        for (const size of [1, 2, 6]) {
          const pool = createPng16BandPool({ size });
          try {
            pools[size] = same(await bytesOf(await pool.encode(image, { bandBytes })), reference);
          } finally {
            pool.dispose();
          }
        }
        const bridge = createExportWorkerBridge();
        const oneWorker = same(await bytesOf(await bridge.workerEncodePng16(image, { bandBytes })), reference);
        bridge.terminateWorker();
        const decoded = loadPngFile(reference.slice().buffer);
        const expected = image.__image16 ? plane : Uint16Array.from(image.data, v => v * 257);
        const zlib = await inflateIdat(reference);
        out.cases.push({
          label, bands, pools, oneWorker,
          samples: same(decoded.__image16?.data, Uint16Array.from(expected, (v, i) => i % 4 === 3 && channels === 3 ? 65535 : v)),
          idats: zlib.types.filter(t => t === 'IDAT').length,
          adlerVerified: zlib.filtered === (W * channels * 2 + 1) * H
        });
      }

      // ---- cancel mid-encode: every band worker terminated within 1 s ----
      const terminate = Worker.prototype.terminate;
      const post = Worker.prototype.postMessage;
      let terminated = 0;
      let bandPosts = 0;
      Worker.prototype.terminate = function () { terminated += 1; return terminate.call(this); };
      Worker.prototype.postMessage = function (message, ...rest) {
        if (message && message.type === 'encodePng16Band') bandPosts += 1;
        return post.call(this, message, ...rest);
      };
      try {
        const big = new ImageData(new Uint8ClampedArray(2400 * 1600 * 4), 2400, 1600);
        big.__image16 = { width: 2400, height: 1600, data: Uint16Array.from({ length: 2400 * 1600 * 4 }, (_, i) => (i * 7919) & 0xFFFF) };
        const pool = createPng16BandPool({ size: 3 });
        const controller = new AbortController();
        const pending = pool.encode(big, { signal: controller.signal, bandBytes: 1 << 20 });
        while (bandPosts < 3) await new Promise(r => setTimeout(r, 5));
        const postsAtCancel = bandPosts;
        const started = performance.now();
        controller.abort();
        let aborted = false;
        try { await pending; } catch (err) { aborted = isAbortError(err); }
        out.cancel = { aborted, ms: Math.round(performance.now() - started), terminated, postsAtCancel };
        await new Promise(r => setTimeout(r, 50));
        out.cancel.postsAfter = bandPosts - postsAtCancel;
        pool.dispose();
      } finally {
        Worker.prototype.terminate = terminate;
        Worker.prototype.postMessage = post;
      }
    } finally {
      console.warn = warn;
    }
    out.warnings = warnings;
    return out;
  })()`);
  console.log('png16 band pool:', JSON.stringify(parity));
  for (const c of parity.cases) {
    if (!c.pools[1] || !c.pools[2] || !c.pools[6] || !c.oneWorker) fail(`PNG16 bytes depend on the worker count (${c.label}): ` + JSON.stringify(c));
    if (!c.samples) fail(`PNG16 samples changed (${c.label}): ` + JSON.stringify(c));
    if (c.idats !== c.bands + 1 || !c.adlerVerified) fail(`PNG16 IDAT layout or Adler-32 wrong (${c.label}): ` + JSON.stringify(c));
  }
  if (!parity.cancel.aborted || parity.cancel.ms > 1000 || parity.cancel.terminated < 3 || parity.cancel.postsAfter !== 0) {
    fail('cancelling a PNG16 encode must terminate every band worker within 1 s: ' + JSON.stringify(parity.cancel));
  }
  if (parity.warnings.some(w => /falling back/.test(w))) fail('the band pool fell back: ' + JSON.stringify(parity.warnings));

  // ---- 2. a Studio 16-bit PNG export uses the band pool and releases it ----
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [join(root, 'negative2positive', 'test-fixtures', 'negative-gradient-16.png')], nodeId: input.result.nodeId });
  await waitFor('png16 fixture ready', ready, 120_000);
  const studio = await evaluate(`(async () => {
    const probe = { types: [], downloads: [], created: 0, terminated: 0 };
    try { delete window.showSaveFilePicker; } catch {}
    window.showSaveFilePicker = undefined;
    const post = Worker.prototype.postMessage;
    const terminate = Worker.prototype.terminate;
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message && typeof message.type === 'string') probe.types.push(message.type);
      return post.call(this, message, ...rest);
    };
    Worker.prototype.terminate = function () { probe.terminated += 1; return terminate.call(this); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      probe.downloads.push(fetch(this.href).then(r => r.blob()));
    };
    try {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click();
      document.getElementById('exportSingleBtn').click();
      const started = performance.now();
      while (probe.downloads.length === 0 && performance.now() - started < 120000) await new Promise(r => setTimeout(r, 50));
      while (document.getElementById('exportSingleBtn').disabled && performance.now() - started < 120000) await new Promise(r => setTimeout(r, 50));
      const blob = await probe.downloads[0];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        depth: bytes[24],
        bandRequests: probe.types.filter(t => t === 'encodePng16Band').length,
        wholeFrameRequests: probe.types.filter(t => t === 'encodePng16').length,
        terminated: probe.terminated,
        overlayVisible: document.querySelector('.loading-overlay')?.classList.contains('visible') || false
      };
    } finally {
      Worker.prototype.postMessage = post;
      Worker.prototype.terminate = terminate;
      HTMLAnchorElement.prototype.click = click;
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]')?.click();
    }
  })()`);
  console.log('Studio PNG16 export:', JSON.stringify(studio));
  if (studio.depth !== 16) fail('the Studio export is not a 16-bit PNG: ' + JSON.stringify(studio));
  if (studio.bandRequests < 1 || studio.wholeFrameRequests !== 0) fail('a single PNG16 export must go through the band pool: ' + JSON.stringify(studio));
  if (studio.terminated < 1) fail('the band pool must be disposed when the export ends: ' + JSON.stringify(studio));
  if (studio.overlayVisible) fail('the export overlay stayed up after the download: ' + JSON.stringify(studio));
}
