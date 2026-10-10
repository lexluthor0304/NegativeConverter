// #250: export planes stay with the export worker, in a real browser. Node
// stubs cannot prove what Chrome's OffscreenCanvas encoder writes, that a Blob
// outlives the worker that made it, or that a transferred plane really leaves
// the page. Part 1 runs the real bridge and worker; part 2 exports through the
// Studio on a generated 3.8 MP 16-bit frame (above the 1 MP worker
// threshold, and large enough for a separate display preview); part 3 exports
// a tilted frame that the import straightens and crops, whose whole rotated
// frame no export and no plane-release probe may build (#244, #250).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// A 16-bit RGB PNG (filter 0 rows) from a per-pixel function.
function writePng16(path, width, height, pixel) {
  const raw = Buffer.alloc((width * 6 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 6 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = row + 1 + x * 6;
      raw.writeUInt16BE(r, o);
      raw.writeUInt16BE(g, o + 2);
      raw.writeUInt16BE(b, o + 4);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 2; // RGB
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
  return path;
}

// A 16-bit RGB PNG, so the frame carries a genuine 16-bit plane (8-bit
// sources are never handed to the conversion lane).
function writeNegativeFixture(dir) {
  const width = 2400;
  const height = 1600;
  const clamp = value => Math.max(0, Math.min(65535, Math.round(value)));
  return writePng16(join(dir, 'ownership-negative-16.png'), width, height, (x, y) => {
    const t = x / (width - 1) * 0.65 + y / (height - 1) * 0.35;
    // An orange-masked negative with a soft vignette and some texture.
    const v = 1 - 0.18 * (((x - width / 2) / width) ** 2 + ((y - height / 2) / height) ** 2);
    const grain = ((x * 7919 + y * 104729) % 97) - 48;
    return [clamp((60000 - t * 30000) * v + grain), clamp((43000 - t * 24000) * v + grain), clamp((30000 - t * 17000) * v + grain)];
  });
}

// The geometry smoke's scan: an orange rebate around a dark, textured frame
// turned by 4 degrees, which the import straightens and crops.
function writeTiltedFixture(dir) {
  const W = 2400, H = 1700, frameW = 1800, frameH = 1200, angle = 4 * Math.PI / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return writePng16(join(dir, 'ownership-tilted-16.png'), W, H, (x, y) => {
    const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    if (Math.abs(u) < frameW / 2 && Math.abs(v) < frameH / 2) {
      const n = ((Math.floor(u / 6) * 17 + Math.floor(v / 6) * 23) % 90 + 90) % 90;
      return [(40 + n) * 257 + (x % 97), Math.round((22 + n / 2) * 257) + (y % 89), Math.round((18 + n / 3) * 257) + ((x + y) % 83)];
    }
    return [232 * 257 + (y % 61), 155 * 257 + (x % 53), 91 * 257 + 7];
  });
}

// Records the export requests, the downloads and the export workers the
// page creates (window.__ownershipProbe); `restore()` takes it out again.
const INSTALL_OWNERSHIP_PROBE = `(() => {
  const probe = window.__ownershipProbe = { requests: [], downloads: [], exportWorkers: [] };
  try { delete window.showSaveFilePicker; } catch {}
  window.showSaveFilePicker = undefined;
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes('exportWorker')) probe.exportWorkers.push(this);
    }
  };
  const post = OriginalWorker.prototype.postMessage;
  OriginalWorker.prototype.postMessage = function (message, transfers) {
    if (message && typeof message.type === 'string') {
      const list = Array.isArray(transfers) ? transfers : (transfers && transfers.transfer) || [];
      probe.requests.push({ type: message.type, gain: Boolean(message.gainMap), transfers: list.length,
        handoff: message.returnSource ? 'lend' : message.options && message.options.ownedSource ? 'consume' : null,
        releaseAfter: Boolean(message.releaseAfter) });
    }
    return post.apply(this, arguments);
  };
  const terminate = OriginalWorker.prototype.terminate;
  OriginalWorker.prototype.terminate = function () { this.__terminated = true; return terminate.call(this); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
    probe.downloads.push(fetch(this.href).then(r => r.blob()));
  };
  probe.restore = () => {
    window.Worker = OriginalWorker;
    OriginalWorker.prototype.postMessage = post;
    OriginalWorker.prototype.terminate = terminate;
    HTMLAnchorElement.prototype.click = click;
  };
  try { localStorage.setItem('nc_hdr_gain_map_v1', 'on'); } catch {}
})()`;

export async function runExportOwnershipSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('ownership smoke boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(300);

  // ---- 1. real Worker, real OffscreenCanvas ----
  const worker = await evaluate(`(async () => {
    const { createExportWorkerBridge, encodeImageSupported } = await import('/src/workers/workerBridge.js');
    const { markOwnedPlanes, releaseOwnedPlanes, detectReleaseEngine } = await import('/src/app/planeRelease.js');
    const { createImageDataCanvasBlobEncoder } = await import('/src/app/canvasBlobEncoder.js');
    const { applyPreparedAdjustmentsToBuffer, applyPreparedAdjustmentsToPlane16 } = await import('/src/app/adjustmentPipeline.js');
    const { computeGainMap } = await import('/src/app/gainMapJpeg.js');
    const { attachMetadataToBlob, listJpegSegments } = await import('/src/app/exportMetadata.js');
    const encoders = await import('/src/app/exportImageEncoders.js');
    const { buildLinearPositive, encodeLinearDngBlob } = await import('/src/app/linearDng.js');
    const W = 331, H = 197;
    const makeProcessed = () => {
      const plane = new Uint16Array(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4, t = x / (W - 1) * 0.8 + y / (H - 1) * 0.2;
        plane[o] = Math.round(t * 65535); plane[o + 1] = Math.round(t * 0.85 * 65535 + ((x * 31) & 1023));
        plane[o + 2] = Math.round(t * 0.7 * 65535 + ((y * 17) & 511)); plane[o + 3] = 65535;
      }
      const image = new ImageData(Uint8ClampedArray.from(plane, v => v >>> 8), W, H);
      image.__image16 = { width: W, height: H, data: plane };
      return image;
    };
    const s = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
    const settings = { curves: { r: s, g: new Uint8Array(s), b: new Uint8Array(s) }, exposure: 0.2, contrast: 8,
      highlights: -15, shadows: 10, saturation: 12, vibrance: 20, wbR: 1.05, wbG: 1, wbB: 0.95,
      temperature: 5, tint: 0, cyan: 2, magenta: 0, yellow: -1, look: null };
    const processed = makeProcessed();
    const sdr = new ImageData(new Uint8ClampedArray(W * H * 4), W, H);
    applyPreparedAdjustmentsToBuffer(processed, settings, sdr, { quality: 'full' });
    const decode = async (blob) => {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const bytesOf = async (blob) => new Uint8Array(await blob.arrayBuffer());
    const pngChunks = (bytes) => {
      const out = [];
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let p = 8; p + 8 <= bytes.length;) {
        const length = view.getUint32(p);
        const type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
        if (type === 'IDAT') break;
        out.push(type);
        p += length + 12;
      }
      return out;
    };
    const jpegApps = (bytes) => listJpegSegments(bytes).filter(seg => seg.marker >= 0xE0 && seg.marker <= 0xEF)
      .map(seg => seg.marker.toString(16) + ':' + new TextDecoder('latin1').decode(seg.data.subarray(0, 4)));
    const metadata = { exif: { Make: 'NeoAnalogLab', Model: 'smoke', DateTimeOriginal: '2026:09:25 12:00:00' }, xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' };
    const canvasEncode = createImageDataCanvasBlobEncoder();
    const bridge = createExportWorkerBridge();
    const result = { engine: detectReleaseEngine() };
    try {
      // PNG8: decoded pixels and metadata chunks equal the canvas path.
      const png = await bridge.workerEncodeImage(new ImageData(sdr.data.slice(), W, H), { mimeType: 'image/png' });
      const pngMain = await canvasEncode(new ImageData(sdr.data.slice(), W, H), 'image/png');
      result.pngWorker = Boolean(png && png.blob);
      result.pngPixels = sameArray(await decode(png.blob), await decode(pngMain));
      result.pngBytesEqual = sameArray(await bytesOf(png.blob), await bytesOf(pngMain));
      const pngMeta = pngChunks(await bytesOf(await attachMetadataToBlob(png.blob, 'png', metadata)));
      const pngMainMeta = pngChunks(await bytesOf(await attachMetadataToBlob(pngMain, 'png', metadata)));
      result.pngChunks = pngMeta.join(',');
      result.pngChunksEqual = pngMeta.join() === pngMainMeta.join() && pngMeta.filter(t => t === 'iCCP').length === 1;

      // JPEG with the gain map in the same request.
      const jpeg = await bridge.workerEncodeImage(new ImageData(sdr.data.slice(), W, H), { mimeType: 'image/jpeg', quality: 0.92, gainMap: { source: processed, settings } });
      const jpegMain = await canvasEncode(new ImageData(sdr.data.slice(), W, H), 'image/jpeg', 0.92);
      const mapMain = computeGainMap(sdr, applyPreparedAdjustmentsToPlane16(processed, settings));
      const gainMain = await canvasEncode(new ImageData(mapMain.data, mapMain.width, mapMain.height), 'image/jpeg', 0.85);
      result.jpegWorker = Boolean(jpeg && jpeg.blob && jpeg.gain);
      result.jpegPixels = sameArray(await decode(jpeg.blob), await decode(jpegMain));
      result.jpegBytesEqual = sameArray(await bytesOf(jpeg.blob), await bytesOf(jpegMain));
      result.gainPixels = sameArray(await decode(jpeg.gain.blob), await decode(gainMain));
      result.gainMax = Object.is(jpeg.gain.gainMax, mapMain.gainMax);
      const jpegMeta = jpegApps(await bytesOf(await attachMetadataToBlob(jpeg.blob, 'jpeg', metadata)));
      const jpegMainMeta = jpegApps(await bytesOf(await attachMetadataToBlob(jpegMain, 'jpeg', metadata)));
      result.jpegSegments = jpegMeta.join(',');
      // Worker parity: the worker adds no segment the canvas path lacks. Chrome's
      // canvas JPEG already carries an ICC profile and attachMetadataToBlob adds
      // its own on both paths (docs/audit-backlog.md), so the count is reported.
      result.jpegSegmentsEqual = jpegMeta.join() === jpegMainMeta.join();
      result.jpegIccProfiles = jpegMeta.filter(t => t.startsWith('e2:ICC_')).length;
      result.planeIntact = processed.__image16.data.length === W * H * 4;

      // A non-opaque frame goes back to the canvas path with its pixels.
      const translucent = markOwnedPlanes(new ImageData(sdr.data.slice(), W, H));
      translucent.data[7] = 128;
      let restored = null;
      result.alphaFallback = (await bridge.workerEncodeImage(translucent, { mimeType: 'image/png', transferPlane: true, onRestore: (frame) => { restored = frame; } })) === null
        && restored instanceof ImageData && restored.data[7] === 128;
      result.support = encodeImageSupported();

      // The linear DNG in the worker (#293): the same bytes as the main-thread
      // build, with a copied plane (intact here) and with a transferred one.
      const dngMeta = { exif: { make: 'NeoAnalogLab', model: 'smoke', dateTime: '2026:10:10 09:00:00' }, xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' };
      const filmBase = { r: 212, g: 131, b: 77 };
      const dngMain = await bytesOf(encodeLinearDngBlob(buildLinearPositive(makeProcessed().__image16, filmBase, { positive: false }), { metadata: dngMeta }));
      const dngCopied = await bridge.workerEncodeLinearDng(processed, { filmBase, positive: false, metadata: dngMeta });
      result.dngWorker = Boolean(dngCopied && dngCopied.blob) && Number.isFinite(dngCopied.buildMs) && Number.isFinite(dngCopied.blobMs);
      result.dngBytesEqual = Boolean(dngCopied) && sameArray(await bytesOf(dngCopied.blob), dngMain);
      result.dngPlaneIntact = processed.__image16.data.byteLength === W * H * 8;
      const dngOwned = markOwnedPlanes(makeProcessed());
      const dngMoved = await bridge.workerEncodeLinearDng(dngOwned, { filmBase, positive: false, metadata: dngMeta, transferPlane: true });
      result.dngTransferred = dngOwned.__image16.data.byteLength === 0 && Boolean(dngMoved) && sameArray(await bytesOf(dngMoved.blob), dngMain);
    } finally {
      bridge.terminateWorker();
    }

    // Blobs stay readable after their worker is gone.
    const late = createExportWorkerBridge();
    const owned = markOwnedPlanes(makeProcessed());
    const fused = await late.workerAdjust16AndEncode(owned, settings, { format: 'tiff', transferPlane: true });
    const encoded = await late.workerEncodeImage(new ImageData(sdr.data.slice(), W, H), { mimeType: 'image/jpeg', quality: 0.9 });
    late.terminateWorker();
    await new Promise(r => setTimeout(r, 100));
    const expectedTiff = encoders.encodeTiffBlob({ width: W, height: H, __image16: applyPreparedAdjustmentsToPlane16(makeProcessed(), settings) }, 16);
    result.fusedTransferred = owned.__image16.data.byteLength === 0;
    result.fusedBytes = sameArray(await bytesOf(fused), await bytesOf(expectedTiff));
    result.blobAfterTerminate = (await bytesOf(encoded.blob)).length === encoded.blob.size && encoded.blob.size > 0;

    // Release through the throwaway worker (Chromium) detaches the buffers.
    const planes = markOwnedPlanes({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4), __image16: { width: W, height: H, data: new Uint16Array(W * H * 4) } });
    const summary = releaseOwnedPlanes(planes);
    result.release = summary.method;
    result.released = summary.released === 2 && planes.data.byteLength === 0 && planes.__image16.data.byteLength === 0;
    return result;
  })()`);
  console.log('export ownership (worker):', JSON.stringify(worker));
  if (!worker.pngWorker || !worker.jpegWorker || worker.support !== true) fail('PNG8/JPEG were not encoded in the worker: ' + JSON.stringify(worker));
  if (!worker.pngPixels || !worker.jpegPixels || !worker.gainPixels || !worker.gainMax) fail('worker encodes differ from the canvas path in decoded pixels: ' + JSON.stringify(worker));
  if (!worker.pngChunksEqual || !worker.jpegSegmentsEqual) fail('metadata chunks differ after attachMetadataToBlob: ' + JSON.stringify(worker));
  if (!worker.planeIntact || !worker.alphaFallback) fail('encodeImage plane/alpha handling regressed: ' + JSON.stringify(worker));
  if (!worker.fusedTransferred || !worker.fusedBytes || !worker.blobAfterTerminate) fail('fused TIFF16 / Blob after terminate regressed: ' + JSON.stringify(worker));
  if (!worker.dngWorker || !worker.dngBytesEqual || !worker.dngPlaneIntact || !worker.dngTransferred) fail('the worker linear DNG differs from the main-thread build or mishandled its plane: ' + JSON.stringify(worker));
  if (worker.engine === 'chromium' && (worker.release !== 'worker' || !worker.released)) fail('plane release did not go through the throwaway worker: ' + JSON.stringify(worker));
  if (!worker.pngBytesEqual || !worker.jpegBytesEqual) console.log('note: Chrome worker encodes differ in file bytes only (decoded pixels equal)');
  if (worker.jpegIccProfiles > 1) console.log(`note: JPEG carries ${worker.jpegIccProfiles} ICC profiles on the worker and canvas paths alike (pre-existing, audit backlog)`);

  // The page's accessibility bridge mirrors the bit-depth buttons' `disabled`
  // class into the `disabled` property on the next animation frame, so after
  // a JPEG the 16-bit button stays disabled for a frame: a click before that
  // would be ignored.
  const setFormat = (format, depth) => evaluate(`(async () => {
    document.querySelector('.format-btn[data-format="${format}"]').click();
    const depth = document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]');
    for (let i = 0; i < 50 && depth && depth.disabled && !depth.classList.contains('disabled'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (depth && !depth.classList.contains('disabled')) depth.click();
    return document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth;
  })()`);
  const exportOnce = async (label, button = 'exportSingleBtn') => {
    const index = await evaluate(`(() => { const p = window.__ownershipProbe; p.requests = []; p.workersBefore = p.exportWorkers.length; document.getElementById('${button}').click(); return p.downloads.length; })()`);
    await waitFor(label, `window.__ownershipProbe.downloads.length > ${index} && !document.getElementById('exportSingleBtn').disabled && !document.body.dataset.studioBusy`, 180_000);
    await wait(1200);
    return evaluate(`(async () => {
      const p = window.__ownershipProbe;
      const blob = await p.downloads[${index}];
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let hash = 0;
      for (let i = 0; i < bytes.length; i++) hash = (Math.imul(hash, 31) + bytes[i]) | 0;
      const created = p.exportWorkers.slice(p.workersBefore);
      const geometry = window.__ncGeometry?.diagnostics;
      return {
        type: blob.type, size: bytes.length, hash,
        requests: p.requests.map(r => r.type + (r.gain ? '+gain' : '')),
        conversions: p.requests.filter(r => r.type === 'convert').map(r => ({ transfers: r.transfers, handoff: r.handoff, releaseAfter: r.releaseAfter })),
        encodeTransfers: p.requests.filter(r => r.type === 'encodeImage').map(r => r.transfers),
        workersCreated: created.length,
        workersAlive: created.filter(w => !w.__terminated).length,
        frameSyncReads: geometry ? geometry.frameSyncReads : null,
        mainRotations: geometry ? geometry.mainRotations : null
      };
    })()`);
  };

  // ---- 2. Studio exports ----
  const dir = mkdtempSync(join(tmpdir(), 'nc-ownership-'));
  try {
    const fixture = writeNegativeFixture(dir);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
    await waitFor('ownership fixture ready', ready, 180_000);
    await evaluate(INSTALL_OWNERSHIP_PROBE);
    const exportTypes = (result) => result.requests.filter(t => !['convert', 'detectDust', 'progress'].includes(t));
    const evictable = () => evaluate(`(async () => {
      const { listEvictablePlanes } = await import('/src/app/evictablePlanes.js');
      return listEvictablePlanes().find(p => p.name === 'processedImageData') || null;
    })()`);

    await setFormat('png', 8);
    const png = await exportOnce('ownership PNG8 export');
    console.log('studio PNG8 export:', JSON.stringify(png));
    if (!/png/.test(png.type)) fail('PNG8 export failed: ' + JSON.stringify(png));
    if (!png.requests.includes('encodeImage') || png.requests.includes('encodeTiff')) fail('PNG8 was not encoded in the export worker: ' + JSON.stringify(png));
    if (png.workersCreated < 1 || png.workersAlive !== 0) fail('the single export left its export worker alive: ' + JSON.stringify(png));

    // Demote the full-resolution plane the export left, then export again:
    // the next export converts again and writes the same file.
    const before = await evictable();
    if (before && before.evictable && before.bytes > 0) {
      const freed = await evaluate(`(async () => (await import('/src/app/evictablePlanes.js')).evictPlane('processedImageData'))()`);
      const after = await evictable();
      const again = await exportOnce('PNG8 export after demotion');
      const restored = await evictable();
      console.log('demotion:', JSON.stringify({ before, freed, after, restoredBytes: restored?.bytes }));
      if (!(freed > 0) || after.bytes !== 0) fail('the full-resolution plane was not demoted: ' + JSON.stringify({ before, freed, after }));
      if (again.hash !== png.hash || again.size !== png.size) fail('an export after demotion differs from the export before it: ' + JSON.stringify({ png, again }));
      if (!(restored?.bytes > 0)) fail('the export did not rebuild the full-resolution plane');
    } else {
      console.log('WARN: demotion not exercised (no separate display preview for this frame): ' + JSON.stringify(before));
    }

    await setFormat('jpeg', 8);
    const jpeg = await exportOnce('ownership JPEG export');
    console.log('studio JPEG export:', JSON.stringify(jpeg));
    if (!exportTypes(jpeg).includes('encodeImage+gain') || jpeg.requests.includes('gainMap16')) fail('the JPEG gain map did not travel with the encode: ' + JSON.stringify(jpeg));
    if (jpeg.workersAlive !== 0) fail('the JPEG export left its worker alive: ' + JSON.stringify(jpeg));

    if (await setFormat('tiff', 16) !== '16') fail('could not select a 16-bit TIFF export');
    const tiff = await exportOnce('ownership TIFF16 export');
    console.log('studio TIFF16 export:', JSON.stringify(tiff));
    const tiffTypes = exportTypes(tiff);
    if (tiff.size > 0 && tiffTypes.includes('adjust16AndEncode')) {
      if (tiffTypes.some(t => t === 'applyAdjustments16' || t === 'encodeTiff')) fail('a 16-bit TIFF still adjusted and encoded separately: ' + JSON.stringify(tiff));
    } else {
      fail('a 16-bit TIFF did not use the fused request: ' + JSON.stringify(tiff));
    }
    if (tiff.workersAlive !== 0) fail('the TIFF export left its worker alive: ' + JSON.stringify(tiff));

    // The linear DNG (#293): the single export sends the editor's plane to
    // its worker as a copy; a one-file batch hands the frame's own plane
    // over (one transfer); neither builds the DNG on the main thread, and
    // both workers are gone afterwards.
    await evaluate(`document.querySelector('.format-btn[data-format="dng"]').click()`);
    const dng = await exportOnce('ownership DNG export');
    console.log('studio DNG export:', JSON.stringify(dng));
    if (!/dng|octet|tiff/.test(dng.type) && !(dng.size > 0)) fail('DNG export failed: ' + JSON.stringify(dng));
    if (!exportTypes(dng).includes('encodeLinearDng')) fail('the single DNG export was not built in the export worker: ' + JSON.stringify(dng));
    if (dng.workersCreated < 1 || dng.workersAlive !== 0) fail('the DNG export left its worker alive: ' + JSON.stringify(dng));
    const dngWorker = await evaluate(`window.__ncBatchPipeline?.diagnostics?.singleExport?.linearDngWorker`);
    if (dngWorker !== true) fail('the single DNG export fell back to the main thread: ' + JSON.stringify(dngWorker));
    const dngBatch = await exportOnce('ownership DNG batch export', 'exportAllBtn');
    console.log('studio DNG batch export:', JSON.stringify(dngBatch));
    if (!exportTypes(dngBatch).includes('encodeLinearDng')) fail('the batch DNG was not built in the export worker: ' + JSON.stringify(dngBatch));
    if (dngBatch.workersAlive !== 0) fail('the DNG batch left an export worker alive: ' + JSON.stringify(dngBatch));
    if (dngBatch.size !== dng.size) console.log('note: batch and single DNG differ in size (per-file settings); not a failure');

    // A one-file batch: a pool of one, the source lent to the conversion
    // lane, the lane released after the frame, every export worker gone.
    await setFormat('png', 8);
    const batch = await exportOnce('ownership batch export', 'exportAllBtn');
    console.log('studio batch export:', JSON.stringify(batch));
    if (!/png/.test(batch.type)) fail('batch export failed: ' + JSON.stringify(batch));
    if (!batch.conversions.length || !batch.conversions.every(c => c.releaseAfter)) fail('batch conversions must release the lane after each frame: ' + JSON.stringify(batch));
    if (!batch.conversions.some(c => c.handoff && c.transfers === 1)) fail('the batch did not hand its source to the conversion lane: ' + JSON.stringify(batch));
    if (!batch.encodeTransfers.length || batch.encodeTransfers[0] < 1) fail('the batch did not transfer its frame to the encoder: ' + JSON.stringify(batch));
    if (batch.workersCreated < 1 || batch.workersAlive !== 0) fail('the batch left an export worker alive: ' + JSON.stringify(batch));
    if (batch.hash !== png.hash) console.log('note: batch and single PNG8 differ (per-file settings); not a failure');
  } finally {
    await evaluate(`(() => { window.__ownershipProbe?.restore(); document.querySelector('.format-btn[data-format="png"]').click(); })()`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('ok: PNG8/JPEG encode in the worker with canvas parity; fused TIFF16; per-export workers end with the export; planes are handed over and released');

  // ---- 3. A tilted photo, straightened and cropped on import ----
  // Beside the crop state.originalImageData is a frame descriptor (#244):
  // reading its pixels builds the whole rotated frame on the main thread
  // (renderGeometryFrame, seconds at 60 MP) and keeps it. Every export ends
  // by releasing its planes and every transferPlane hand-off asks the
  // plane-release probe (#250) what the editor holds; neither may build the
  // frame. frameSyncReads and mainRotations stay where the import left them,
  // so renderGeometryFrame never runs (no long task from it), and no plane
  // of the rotated frame's size is kept. The files are listed by hash: a
  // build whose probe built the frame writes the same bytes.
  const tiltedDir = mkdtempSync(join(tmpdir(), 'nc-ownership-tilted-'));
  try {
    const fixture = writeTiltedFixture(tiltedDir);
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('tilted ownership boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`(() => { const crop = document.getElementById('studioImportAutoCrop'); if (!crop.checked) crop.click(); })()`);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
    await waitFor('tilted fixture straightened and converted', `${ready} && !window.__ncGeometry.pending() && document.getElementById('studioFilename').textContent === 'ownership-tilted-16.png'`, 180_000);
    await wait(500);
    const inspectTilted = `({ geometry: window.__ncGeometry.inspect(), diagnostics: { ...window.__ncGeometry.diagnostics },
      status: document.getElementById('studioFrameNotice').dataset.status })`;
    const imported = await evaluate(inspectTilted);
    if (imported.status !== 'crop' || !imported.geometry.descriptor || Math.abs(Math.abs(imported.geometry.rotationAngle) - 4) > 0.5) {
      fail('the tilted fixture was not straightened and cropped on import: ' + JSON.stringify(imported));
    }
    await evaluate(INSTALL_OWNERSHIP_PROBE);
    const exports = {};
    await setFormat('png', 8);
    exports.png8 = await exportOnce('tilted PNG8 export');
    await setFormat('jpeg', 8);
    exports.jpeg = await exportOnce('tilted JPEG export');
    if (await setFormat('tiff', 16) !== '16') fail('could not select a 16-bit TIFF export');
    exports.tiff16 = await exportOnce('tilted TIFF16 export');
    await setFormat('png', 8);
    exports.batch = await exportOnce('tilted batch export', 'exportAllBtn');
    exports.contactSheet = await exportOnce('tilted contact sheet', 'exportContactSheetBtn');
    const after = await evaluate(inspectTilted);
    // Everything is printed before it is checked, so a failing build still
    // lists its file hashes for comparison.
    const files = Object.fromEntries(Object.entries(exports).map(([name, r]) => [name, { type: r.type, size: r.size, hash: r.hash }]));
    console.log('tilted exports:', JSON.stringify(files));
    const counts = Object.fromEntries(Object.entries(exports).map(([name, r]) => [name, [r.frameSyncReads, r.mainRotations]]));
    console.log('tilted geometry (frameSyncReads, mainRotations after each export):', JSON.stringify({
      imported: [imported.diagnostics.frameSyncReads, imported.diagnostics.mainRotations], ...counts,
      frameSized: after.geometry.frameSized, descriptor: after.geometry.descriptor
    }));
    const kinds = { png8: /png/, jpeg: /jpeg/, tiff16: /tiff/, batch: /png/, contactSheet: /png/ };
    for (const [name, r] of Object.entries(exports)) {
      if (!kinds[name].test(r.type) || !(r.size > 0)) fail(`the tilted ${name} export failed: ` + JSON.stringify(r));
    }
    if (!exports.jpeg.requests.includes('encodeImage+gain')) fail('the tilted JPEG did not carry its gain map: ' + JSON.stringify(exports.jpeg));
    if (!exports.tiff16.requests.includes('adjust16AndEncode')) fail('the tilted TIFF16 did not use the fused request: ' + JSON.stringify(exports.tiff16));
    for (const [name, r] of Object.entries(exports)) {
      if (r.frameSyncReads !== imported.diagnostics.frameSyncReads || r.mainRotations !== imported.diagnostics.mainRotations) {
        fail(`the tilted ${name} export built the rotated frame on the main thread: ` + JSON.stringify({ imported: imported.diagnostics, after: after.diagnostics }));
      }
    }
    if (after.diagnostics.pendingReads !== imported.diagnostics.pendingReads) fail('an export read geometry planes while a build was pending: ' + JSON.stringify(after.diagnostics));
    if (!after.geometry.descriptor || after.geometry.frameSized !== 0) fail('a plane of the rotated frame stayed reachable after the exports: ' + JSON.stringify(after.geometry));
  } finally {
    await evaluate(`(() => { window.__ownershipProbe?.restore(); document.querySelector('.format-btn[data-format="png"]').click(); })()`).catch(() => {});
    rmSync(tiltedDir, { recursive: true, force: true });
  }
  console.log('ok: a straightened, cropped photo exports PNG8, JPEG, TIFF16, Export All and a contact sheet without building its rotated frame');
}
