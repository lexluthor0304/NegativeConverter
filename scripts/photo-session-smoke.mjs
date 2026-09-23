// Real Studio regression: warm photo sessions must restore pixels/settings
// without another decode or conversion, and every light-table tile must show
// the edited positive rather than an embedded/original negative.
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const UPNG = createRequire(import.meta.url)('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

function installPhotoSessionProbe() {
  const original = {
    post: Worker.prototype.postMessage,
    terminate: Worker.prototype.terminate,
    read: File.prototype.arrayBuffer,
    bitmap: window.createImageBitmap,
    click: HTMLAnchorElement.prototype.click,
    revoke: URL.revokeObjectURL,
    picker: window.showSaveFilePicker,
    draw: WebGLRenderingContext.prototype.drawArrays,
  };
  const workers = new Map(), heldUrls = new Set();
  const probe = window.__photoSessionProbe = {
    requests: [], reads: [], bitmaps: [], exports: [], rawImages: [], inFlight: 0,
    lastActivity: performance.now(), gpuFrames: 0, lastGpu: null,
    holdFile: null, heldFile: null, releaseFile: null, holdTimedOut: false,
  };
  let holdTimer;
  const changed = () => { probe.lastActivity = performance.now(); };
  Worker.prototype.postMessage = function(message, ...args) {
    const kind = message?.type === 'convert' ? 'convert'
      : message?.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format) ? 'decode'
        : /^(open|metadata|imageData|rawImageData|thumbnailData)$/.test(message?.fn) && Array.isArray(message.args) ? 'raw' : null;
    if (kind) {
      let record = workers.get(this);
      if (!record) {
        record = { pending: new Set() };
        record.receive = event => {
          if (event.data?.ready) return;
          const key = event.data?.id ?? 'decode';
          if (kind === 'raw' && event.data?.out?.data && event.data.out.width > 0 && event.data.out.height > 0) {
            const { width, height, bits, colors } = event.data.out;
            probe.rawImages.push({ width, height, bits, colors });
          }
          if (record.pending.delete(key)) { probe.inFlight--; changed(); }
        };
        this.addEventListener('message', record.receive);
        workers.set(this, record);
      }
      const key = message.id ?? 'decode';
      record.pending.add(key); probe.inFlight++; changed();
      probe.requests.push({ kind, fn: message.fn, id: message.id, width: message.width, height: message.height,
        preview: message.options?.preview, file: document.getElementById('studioFilename')?.textContent });
    }
    return original.post.call(this, message, ...args);
  };
  Worker.prototype.terminate = function(...args) {
    const record = workers.get(this);
    if (record) { probe.inFlight -= record.pending.size; record.pending.clear(); changed(); }
    return original.terminate.apply(this, args);
  };
  File.prototype.arrayBuffer = async function(...args) {
    probe.reads.push(this.name); changed();
    if (probe.holdFile === this.name) {
      probe.holdFile = null; probe.heldFile = this.name;
      await new Promise(resolve => {
        probe.releaseFile = () => { clearTimeout(holdTimer); probe.releaseFile = null; resolve(); };
        holdTimer = setTimeout(() => { probe.holdTimedOut = true; probe.releaseFile?.(); }, 15000);
      });
    }
    try { return await original.read.apply(this, args); } finally { changed(); }
  };
  window.createImageBitmap = function(source, ...args) {
    if (source instanceof File) { probe.bitmaps.push(source.name); changed(); }
    return original.bitmap.call(this, source, ...args);
  };
  // Read a few patches immediately after the real draw, while WebGL's
  // non-preserved drawing buffer still exists. No product debug hook required.
  WebGLRenderingContext.prototype.drawArrays = function(...args) {
    const result = original.draw.apply(this, args);
    if (this.canvas.id === 'glCanvas') {
      const width = this.drawingBufferWidth, height = this.drawingBufferHeight;
      const pixels = new Uint8Array(8 * 8 * 4);
      let hash = 2166136261;
      for (const [x, y] of [[.25, .25], [.75, .25], [.5, .5], [.25, .75], [.75, .75]]) {
        this.readPixels(Math.max(0, Math.floor(width * x) - 4), Math.max(0, Math.floor(height * y) - 4),
          8, 8, this.RGBA, this.UNSIGNED_BYTE, pixels);
        for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
      }
      probe.gpuFrames++;
      probe.lastGpu = { width, height, hash: hash >>> 0 };
      // Zoom/layout handlers schedule a repaint and a later preview resize.
      // Worker silence alone does not mean the displayed pixels have settled.
      changed();
    }
    return result;
  };
  window.showSaveFilePicker = undefined;
  URL.revokeObjectURL = function(url) { if (!heldUrls.has(url)) original.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function(...args) {
    if (!this.download?.endsWith('.png') || !this.href.startsWith('blob:')) return original.click.apply(this, args);
    const href = this.href, capture = { name: this.download };
    heldUrls.add(href); probe.exports.push(capture);
    fetch(href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).then(data => { capture.data = data; }, error => { capture.error = String(error); })
      .finally(() => { heldUrls.delete(href); original.revoke.call(URL, href); });
  };
  probe.thumbnail = async index => {
    const img = document.querySelector(`.file-list-name[data-index="${index}"] img.file-list-thumbnail`);
    if (!img) return null;
    const bitmap = await original.bitmap.call(window, await (await fetch(img.src)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const means = [0, 0, 0]; let chroma = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) means[c] += pixels[i + c];
      chroma += Math.max(...pixels.subarray(i, i + 3)) - Math.min(...pixels.subarray(i, i + 3));
    }
    return { src: img.src, width: canvas.width, height: canvas.height,
      means: means.map(value => value / (pixels.length / 4)), chroma: chroma / (pixels.length / 4) };
  };
  probe.snapshot = () => ({ requests: probe.requests.length, reads: probe.reads.length,
    bitmaps: probe.bitmaps.length, inFlight: probe.inFlight, gpu: probe.lastGpu, gpuFrames: probe.gpuFrames,
    backing: [document.getElementById('glCanvas').width, document.getElementById('glCanvas').height],
    viewport: [document.getElementById('canvasContainer').clientWidth, document.getElementById('canvasContainer').clientHeight],
    cyan: Number(document.getElementById('cyan').value),
    zoom: document.getElementById('zoomIndicator').textContent,
    transform: document.getElementById('canvasTransformWrapper').style.transform,
    filename: document.getElementById('studioFilename').textContent,
    active: document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index,
    gpuVisible: getComputedStyle(document.getElementById('glCanvas')).display !== 'none' });
  window.__restorePhotoSessionProbe = () => {
    probe.releaseFile?.(); clearTimeout(holdTimer);
    Worker.prototype.postMessage = original.post; Worker.prototype.terminate = original.terminate;
    File.prototype.arrayBuffer = original.read; window.createImageBitmap = original.bitmap;
    WebGLRenderingContext.prototype.drawArrays = original.draw;
    HTMLAnchorElement.prototype.click = original.click; URL.revokeObjectURL = original.revoke;
    window.showSaveFilePicker = original.picker;
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    delete window.__photoSessionProbe; delete window.__restorePhotoSessionProbe;
  };
}

function decodePng(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  // UPNG.toRGBA8 intentionally discards the low byte. Compare raw unfiltered
  // 16-bit samples for precision regressions, not only their 8-bit appearance.
  const pixels = png.depth === 16 ? Buffer.from(png.data) : Buffer.from(UPNG.toRGBA8(png)[0]);
  const levels = [new Set(), new Set(), new Set()];
  if (png.depth === 16 && [2, 6].includes(png.ctype)) {
    const channels = png.ctype === 6 ? 4 : 3;
    for (let i = 0; i < pixels.length; i += channels * 2) {
      for (let c = 0; c < 3; c++) levels[c].add(pixels.readUInt16BE(i + c * 2));
    }
  }
  return { width: png.width, height: png.height, depth: png.depth, ctype: png.ctype,
    sha256: createHash('sha256').update(pixels).digest('hex'), levels: levels.map(values => values.size) };
}

async function bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port }) {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await until('fresh photo-session workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('applyFilmTypeToRollBtn')`);
    await installDialogAutoAccept();
    await evaluate(`(${installPhotoSessionProbe.toString()})()`);
    await until('learned-default reset control mounted', `!!document.getElementById('resetLearnedDefaults')`);
    await evaluate(`(() => {
      // Exports intentionally teach defaults. Isolate each fixture through the
      // same confirmed UI reset a user has, without disabling that feature.
      window.__photoSessionLearnedReset = false;
      const label = document.getElementById('learnedDefaultsCount');
      const observer = new MutationObserver(() => {
        if (label.textContent.trim() === 'Learned defaults: 0 stocks'
          && !document.querySelector('[data-app-dialog-confirm]')) {
          window.__photoSessionLearnedReset = true; observer.disconnect();
        }
      });
      observer.observe(label, { childList: true, subtree: true, characterData: true });
      document.getElementById('resetLearnedDefaults').click();
    })()`);
    await until('confirmed learned-default reset completed', `window.__photoSessionLearnedReset && document.getElementById('learnedDefaultsCount').textContent.trim() === 'Learned defaults: 0 stocks'`);
    await evaluate(`(() => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="color"]').click();
    })()`);
}

export async function runPhotoSessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 60000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const boot = () => bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port });
  const idle = async () => until('photo-session worker/render idle', `${ready} && window.__photoSessionProbe.inFlight === 0 && performance.now() - window.__photoSessionProbe.lastActivity > 1800`);
  const importFiles = async fixtures => {
    await evaluate(`(async () => {
      const transfer = new DataTransfer();
      for (const [fixture, name] of ${JSON.stringify(fixtures)}) {
        const blob = await (await fetch('/test-fixtures/' + fixture)).blob();
        transfer.items.add(new File([blob], name, { type: 'image/png' }));
      }
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('photo-session fixtures imported', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(fixtures[0][1])}`, 120000);
  };
  const open = async (index, name) => {
    const start = performance.now();
    await evaluate(`document.querySelector('.file-list-name[data-index="${index}"]').click()`);
    await until(`photo ${name} restored`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)} && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '${index}'`, 120000);
    // Observed through CDP, not a timing threshold; exclude stabilization wait.
    const activationMs = Math.round(performance.now() - start);
    await idle();
    return activationMs;
  };
  const exportPixels = async depth => {
    const index = await evaluate('window.__photoSessionProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${depth}-bit session PNG captured`, `!!window.__photoSessionProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    return decodePng(await evaluate(`window.__photoSessionProbe.exports[${index}].data`));
  };
  const samePixels = (a, b) => a.width === b.width && a.height === b.height && a.depth === b.depth
    && a.ctype === b.ctype && a.sha256 === b.sha256;
  let failure;
  try {
    await boot();
    await importFiles([['negative-gradient-16.png', 'session-a-16.png'], ['negative-plain.png', 'session-b.png']]);
    await until('both processed session thumbnails', `document.querySelectorAll('.file-list-name[data-preview-state="ready"] img.file-list-thumbnail').length === 2`);
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      document.getElementById('studioMore').open = true;
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
      document.getElementById('studioToggleLightTable').click();
    })()`);
    const before8 = await exportPixels(8);
    await idle();
    const thumbnailBefore = await evaluate('window.__photoSessionProbe.thumbnail(0)');
    const gpuBefore = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(gpuBefore.gpuVisible && gpuBefore.gpu, 'session regression did not exercise the real GPU preview');
    await evaluate(`(() => {
      const input = document.getElementById('cyan'); input.value = '20';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('CMY edit updates active thumbnail without switching', `document.querySelector('.file-list-name[data-index="0"]')?.dataset.previewState === 'ready' && document.querySelector('.file-list-name[data-index="0"] img')?.src !== ${JSON.stringify(thumbnailBefore.src)}`);
    const edited8 = await exportPixels(8), edited16 = await exportPixels(16);
    await idle();
    const thumbnailEdited = await evaluate('window.__photoSessionProbe.thumbnail(0)');
    expect(before8.sha256 !== edited8.sha256, 'CMY fixture did not change exported pixels');
    expect(thumbnailBefore.means[0] - thumbnailEdited.means[0] > 10
      && Math.abs(thumbnailBefore.means[1] - thumbnailEdited.means[1]) < 4
      && Math.abs(thumbnailBefore.means[2] - thumbnailEdited.means[2]) < 4,
    'GPU light-table thumbnail ignored or misapplied cyan: ' + JSON.stringify({ before: thumbnailBefore.means, after: thumbnailEdited.means }));
    expect(edited16.depth === 16 && edited16.levels.every(count => count > 320),
      'session precision fixture is not genuine 16-bit: ' + JSON.stringify(edited16));
    const beforeZoomDraws = await evaluate(`(() => {
      const draws = window.__photoSessionProbe.gpuFrames;
      document.getElementById('zoomInBtn').click(); document.getElementById('zoomInBtn').click();
      return draws;
    })()`);
    await until('actual GPU repaint after zoom', `window.__photoSessionProbe.gpuFrames > ${beforeZoomDraws}`);
    await idle();
    // The app also has a 2.5-second idle full-render timer. Its public export
    // barrier drains scheduled/full work; a short quiet window alone cannot.
    const zoomed8 = await exportPixels(8);
    expect(samePixels(edited8, zoomed8), 'zoom changed full-resolution export pixels: ' + JSON.stringify({ edited8, zoomed8 }));
    await idle();
    const saved = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(saved.cyan === 20 && saved.transform && saved.zoom !== '100%', 'edited zoom state was not established');
    expect(saved.gpu.width === saved.backing[0] && saved.gpu.height === saved.backing[1],
      'saved GPU sample predates the canvas resize: ' + JSON.stringify(saved));
    await open(1, 'session-b.png');
    await exportPixels(8); await idle();
    const warm = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(await evaluate(`window.__photoSessionProbe.requests.some(r => r.kind === 'decode') && window.__photoSessionProbe.requests.some(r => r.kind === 'convert')`),
      'decode/conversion request instrumentation was not exercised');
    const firstWarmActivationMs = await open(0, 'session-a-16.png');
    const restored = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(restored.requests === warm.requests && restored.reads === warm.reads && restored.bitmaps === warm.bitmaps,
      'warm A return decoded or converted again: ' + JSON.stringify({ warm, restored }));
    expect(JSON.stringify(restored.viewport) === JSON.stringify(saved.viewport)
      && JSON.stringify(restored.backing) === JSON.stringify(saved.backing)
      && restored.gpu.width === saved.gpu.width && restored.gpu.height === saved.gpu.height,
    'warm return changed settled preview dimensions: ' + JSON.stringify({ saved, restored }));
    expect(restored.cyan === saved.cyan && restored.zoom === saved.zoom && restored.transform === saved.transform
      && restored.gpu.hash === saved.gpu.hash && restored.gpuVisible,
    'warm return lost exact edited GPU pixels or per-photo zoom: ' + JSON.stringify({ saved, restored }));
    const restored8 = await exportPixels(8), restored16 = await exportPixels(16);
    expect(samePixels(edited8, restored8) && samePixels(edited16, restored16),
      'warm return changed 8/16-bit export pixels: ' + JSON.stringify({ edited8, restored8, edited16, restored16 }));
    const secondWarmActivationMs = [await open(1, 'session-b.png'), await open(0, 'session-a-16.png')];
    const twice = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(twice.requests === restored.requests && twice.reads === restored.reads && twice.bitmaps === restored.bitmaps,
      'second warm A/B/A cycle rebuilt pixels: ' + JSON.stringify({ restored, twice }));
    console.log('photo sessions warm restore:', JSON.stringify({ observedWarmActivationMs: [firstWarmActivationMs, ...secondWarmActivationMs], saved, restored, twice, edited8, edited16 }));
    await evaluate('window.__restorePhotoSessionProbe()');

    // Three equal negatives make an unconverted orange preview unmistakable.
    // Disable auto roll so the test exercises the ordinary thumbnail lifecycle.
    await boot();
    await importFiles([1, 2, 3].map(index => ['negative-plain.png', `session-roll-${index}.png`]));
    await until('all three initial light-table previews', `document.querySelectorAll('.file-list-name[data-preview-state="ready"] img.file-list-thumbnail').length === 3`);
    await exportPixels(8); await idle();
    expect(await evaluate(`['cyan', 'magenta', 'yellow'].every(id => Number(document.getElementById(id).value) === 0)`),
      'neutral B&W fixture inherited color adjustments despite learned-default reset');
    const initialRoll = await evaluate(`Promise.all([0, 1, 2].map(index => window.__photoSessionProbe.thumbnail(index)))`);
    expect(initialRoll.slice(1).every(thumbnail => thumbnail.means.every((value, channel) => Math.abs(value - initialRoll[0].means[channel]) < 12)),
      'identical unopened negatives do not share the active positive-preview pipeline: ' + JSON.stringify(initialRoll.map(thumbnail => thumbnail.means)));
    await evaluate(`document.getElementById('studioToggleLightTable').click(); document.querySelector('.film-type-btn[data-type="bw"]').click()`);
    await exportPixels(8); await idle();
    const pending = await evaluate(`(() => {
      document.getElementById('applyFilmTypeToRollBtn').click();
      return [...document.querySelectorAll('.file-list-name')].map(button => ({
        state: button.dataset.previewState, busy: button.getAttribute('aria-busy'),
        thumbnail: !!button.querySelector('img.file-list-thumbnail'), placeholder: !!button.querySelector('.file-list-placeholder')
      }));
    })()`);
    expect(pending.length === 3 && pending.every(row => row.thumbnail && !row.placeholder)
      && pending.slice(1).every(row => row.state === 'pending' && row.busy === 'true'),
    'whole-roll invalidation must retain previews and mark unopened tiles pending: ' + JSON.stringify(pending));
    await until('roll apply refreshes active and unopened previews', `${ready} && document.querySelectorAll('.file-list-name[data-preview-state="ready"] img.file-list-thumbnail').length === 3 && document.querySelectorAll('.file-list-placeholder').length === 0 && document.querySelectorAll('.file-list-name[aria-busy="true"]').length === 0`, 120000);
    await exportPixels(8);
    await idle();
    const roll = await evaluate(`Promise.all([0, 1, 2].map(index => window.__photoSessionProbe.thumbnail(index)))`);
    expect(roll.every(thumbnail => thumbnail && thumbnail.chroma < 3),
      'roll B&W thumbnails contain original orange negatives: ' + JSON.stringify(roll.map(thumbnail => thumbnail && ({ means: thumbnail.means, chroma: thumbnail.chroma }))));
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    expect(screenshot.result?.data, 'light-table screenshot was not captured');
    const screenshotPath = fileURLToPath(new URL('../output/playwright/photo-session-lighttable.png', import.meta.url));
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, Buffer.from(screenshot.result.data, 'base64'));
    console.log('photo-session light-table screenshot:', screenshotPath);

    // Add a genuinely new File through the existing "add photos" picker, then
    // open it before idle thumbnail work can populate any decoded-source cache.
    // Holding this actual read makes the late-result race deterministic.
    await evaluate(`(async () => {
      const blob = await (await fetch('/test-fixtures/negative-gradient-16.png')).blob();
      const transfer = new DataTransfer(); transfer.items.add(new File([blob], 'session-cold.png', { type: 'image/png' }));
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function(...args) {
        if (this.type !== 'file' || this.id) return originalClick.apply(this, args);
        this.files = transfer.files; this.dispatchEvent(new Event('change', { bubbles: true }));
      };
      try { document.getElementById('addFilesToolbarBtn').click(); }
      finally { HTMLInputElement.prototype.click = originalClick; }
      window.__photoSessionProbe.holdFile = 'session-cold.png';
      document.querySelector('.file-list-name[data-index="3"]').click();
    })()`);
    await until('cold switch read held', `!!window.__photoSessionProbe.releaseFile`, 10000);
    await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
    await until('newer warm click wins while older decode waits', `${ready} && document.getElementById('studioFilename').textContent === 'session-roll-1.png'`, 10000);
    await evaluate('window.__photoSessionProbe.releaseFile()');
    await idle();
    const latest = await evaluate('window.__photoSessionProbe.snapshot()');
    expect(latest.filename === 'session-roll-1.png' && latest.active === '0'
      && !await evaluate('window.__photoSessionProbe.holdTimedOut'), 'late cold decode replaced the newer clicked photo: ' + JSON.stringify(latest));
    console.log('photo sessions roll thumbnails:', JSON.stringify({ initial: initialRoll.map(({ means }) => means), pending,
      final: roll.map(({ means, chroma }) => ({ means, chroma })) }));
    console.log('ok: warm photo sessions preserve edited GPU pixels, zoom and exact 8/16-bit exports without decoding/converting; roll thumbnails refresh and latest click wins');
  } catch (error) {
    failure = error;
    try {
      console.error('photo-session diagnostics:', JSON.stringify(await evaluate(`(() => {
        const probe = window.__photoSessionProbe;
        return probe ? { ...probe.snapshot(), requests: probe.requests, reads: probe.reads, bitmaps: probe.bitmaps,
          heldFile: probe.heldFile, holdTimedOut: probe.holdTimedOut,
          rows: [...document.querySelectorAll('.file-list-item')].map(row => ({ text: row.textContent,
            placeholder: !!row.querySelector('.file-list-placeholder'), classes: row.className })) } : null;
      })()`)));
    } catch { /* Keep the original assertion if the document itself failed. */ }
  } finally {
    await evaluate('window.__restorePhotoSessionProbe?.()');
  }
  if (failure) fail(failure.message);
}

// Optional local evidence with actual camera files. The environment contains
// their private paths; neither the files nor their paths belong in the repo.
// PHOTO_SESSION_RAW_FILES='["/absolute/photo-a.dng","/absolute/photo-b.nef"]'
// npm run test:smoke -- --photo-session-raw-only
export async function runPhotoSessionRawSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 300000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const snapshot = () => evaluate('window.__photoSessionProbe.snapshot()');
  const settlePreview = () => until('actual RAW preview and worker work settled', `${ready}
    && window.__photoSessionProbe.inFlight === 0
    && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === 2
    && performance.now() - window.__photoSessionProbe.lastActivity > 3200`);
  const open = async (index, name) => {
    const start = performance.now();
    await evaluate(`document.querySelector('.file-list-name[data-index="${index}"]').click()`);
    await until(`actual RAW ${name} active`, `${ready}
      && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}
      && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '${index}'`);
    const activationMs = Math.round(performance.now() - start);
    await settlePreview();
    return activationMs;
  };
  const noRebuild = (before, after) => before.requests === after.requests
    && before.reads === after.reads && before.bitmaps === after.bitmaps;
  let failure;
  try {
    let paths;
    try { paths = JSON.parse(process.env.PHOTO_SESSION_RAW_FILES || 'null'); }
    catch { throw new Error('PHOTO_SESSION_RAW_FILES must be a JSON array of two absolute RAW file paths'); }
    expect(Array.isArray(paths) && paths.length === 2 && paths.every(path => typeof path === 'string' && isAbsolute(path))
      && paths[0] !== paths[1], 'PHOTO_SESSION_RAW_FILES must specify two different absolute RAW file paths');
    const files = await Promise.all(paths.map(async path => {
      const metadata = await stat(path);
      expect(metadata.isFile() && metadata.size > 0, 'RAW fixture is not a nonempty file: ' + basename(path));
      expect(/\.(dng|nef|arw|cr2|cr3|crw|raf|rw2|pef|orf|raw|iiq)$/i.test(path), 'RAW fixture extension is not supported: ' + basename(path));
      return { name: basename(path), bytes: metadata.size };
    }));
    await bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port });
    await evaluate(`(() => {
      for (const id of ['dustRemovalEnabled', 'dustAiEnabled']) {
        const input = document.getElementById(id); if (input.checked) input.click();
      }
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
    })()`);
    const document = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: document.result.root.nodeId, selector: '#fileInput' });
    expect(input.result?.nodeId, '#fileInput not found for actual RAW files');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    await until('first actual RAW imported', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(files[0].name)}`);
    await settlePreview();
    const draws = await evaluate(`(() => {
      const count = window.__photoSessionProbe.gpuFrames;
      document.getElementById('zoomInBtn').click(); document.getElementById('zoomInBtn').click();
      return count;
    })()`);
    await until('actual RAW zoom repainted', `window.__photoSessionProbe.gpuFrames > ${draws}`);
    // Observe normal preview/full-idle activity for longer than its 2.5-second
    // timer, without requesting an export or forcing full-resolution work.
    await settlePreview();
    const saved = await snapshot();
    expect(saved.gpuVisible && saved.gpu && saved.gpu.width === saved.backing[0]
      && saved.gpu.height === saved.backing[1] && saved.transform && saved.zoom !== '100%',
    'actual RAW GPU/zoom precondition missing: ' + JSON.stringify(saved));
    const coldBActivationMs = await open(1, files[1].name);
    const warm = await snapshot();
    expect(await evaluate(`window.__photoSessionProbe.requests.some(request => request.kind === 'raw' && request.fn === 'imageData')
      && window.__photoSessionProbe.requests.some(request => request.kind === 'convert')
      && window.__photoSessionProbe.rawImages.some(image => image.width * image.height > 1000000)`),
    'actual RAW demosaic, large decoded dimensions and conversion were not observed');
    const firstWarmActivationMs = await open(0, files[0].name);
    const restored = await snapshot();
    expect(noRebuild(warm, restored), 'actual RAW warm A return reread/decoded/converted: ' + JSON.stringify({ warm, restored }));
    expect(restored.gpuVisible && JSON.stringify(restored.viewport) === JSON.stringify(saved.viewport)
      && JSON.stringify(restored.backing) === JSON.stringify(saved.backing)
      && JSON.stringify(restored.gpu) === JSON.stringify(saved.gpu)
      && restored.zoom === saved.zoom && restored.transform === saved.transform,
    'actual RAW warm return changed exact GPU pixels, viewport or zoom: ' + JSON.stringify({ saved, restored }));
    const repeatWarmActivationMs = [await open(1, files[1].name), await open(0, files[0].name)];
    const repeated = await snapshot();
    expect(noRebuild(restored, repeated) && JSON.stringify(repeated.gpu) === JSON.stringify(saved.gpu)
      && repeated.zoom === saved.zoom && repeated.transform === saved.transform,
    'actual RAW repeated warm navigation rebuilt or changed the preview: ' + JSON.stringify({ restored, repeated }));
    const evidence = await evaluate(`({ decodedImages: window.__photoSessionProbe.rawImages,
      conversionInputs: window.__photoSessionProbe.requests.filter(request => request.kind === 'convert').map(({ width, height, preview }) => ({ width, height, preview })),
      rawCalls: window.__photoSessionProbe.requests.filter(request => request.kind === 'raw').map(request => request.fn),
      exports: window.__photoSessionProbe.exports.length })`);
    expect(evidence.exports === 0, 'actual RAW cache test must not force an export/full-resolution render');
    console.log('actual RAW warm photo sessions:', JSON.stringify({ files, coldBActivationMs,
      observedWarmActivationMs: [firstWarmActivationMs, ...repeatWarmActivationMs], saved, restored, repeated, ...evidence }));
    console.log('ok: actual RAW warm A/B/A preserves exact GPU preview and zoom with zero new file reads, RAW decode or conversion; no forced export');
  } catch (error) {
    failure = error;
    try {
      console.error('actual RAW session diagnostics:', JSON.stringify(await evaluate(`(() => {
        const probe = window.__photoSessionProbe;
        return probe ? { ...probe.snapshot(), rawImages: probe.rawImages, requests: probe.requests, reads: probe.reads,
          bitmaps: probe.bitmaps, rows: [...document.querySelectorAll('.file-list-name')].map(button => ({
            name: button.textContent, previewState: button.dataset.previewState, busy: button.getAttribute('aria-busy')
          })) } : null;
      })()`)));
    } catch { /* Keep the original failure if Chrome is no longer available. */ }
  } finally {
    await evaluate('window.__restorePhotoSessionProbe?.()');
  }
  if (failure) fail(failure.message);
}
