// Embedded RAW previews (#235), end to end in the real Studio:
// - the scan-decode worker reports its image capability and serves tile and
//   viewer jobs from Blob slices within the read budget;
// - the HE NEF fallback decodes identical 8/16-bit planes in the worker and on
//   the main thread (synthetic JPEG; the repo NEFs too when AUTOFRAME_RAW_DIR
//   or NEF_PARITY_DIR points at them);
// - a RAW import shows a provisional, inverted frame in the viewer-local veil
//   while its container read is still held, never under the full overlay;
// - every tile gets an embedded preview at import, stays pending, and then only
//   moves forward (embedded -> analysis -> processed);
// - a cold switch shows the tile's thumbnail in the click's task, then the
//   embedded frame, and the exact render removes both.
// The ".dng" files are synthetic TIFF containers built in the page: IFD0 is a
// small RGB image the app decodes exactly through its iPhone-DNG route, and the
// SubIFDs hold real baseline JPEG previews encoded by the browser.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const READY = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runEmbeddedPreviewSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message, detail) => { if (!condition) fail(message + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); };
  // debugCounters=1 exposes window.__ncDebug.forgetPhotoCaches for the cold switch.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debugCounters=1` });
  await waitFor('embedded preview boot', `!!document.getElementById('autoRollOnImport') && !!document.getElementById('studioPhotoSwitchFeedback')`);
  await installDialogAutoAccept();
  await wait(1000);

  await evaluate(`(async () => {
    const { buildRgbDngWithPreviews } = await import('/src/app/rawEmbeddedPreview.fixtures.mjs');
    const jpeg = async (width, height, seed) => {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      // An orange-masked negative: dense highlights are bright, thin shadows dark.
      const gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, 'rgb(236,182,132)'); gradient.addColorStop(1, 'rgb(118,68,40)');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = 'rgb(' + (96 + seed * 24) + ',56,34)';
      ctx.fillRect(width * 0.3, height * 0.3, width * 0.25, height * 0.25);
      return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    };
    const files = [];
    for (let i = 1; i <= 3; i++) {
      const width = 240, height = 160, rgb = new Uint8Array(width * height * 3);
      for (let p = 0; p < width * height; p++) {
        const t = (p % width) / width;
        rgb[p * 3] = 230 - 110 * t; rgb[p * 3 + 1] = 172 - 100 * t; rgb[p * 3 + 2] = 124 - 84 * t;
      }
      const previews = [
        { width: 160, height: 120, bytes: await jpeg(160, 120, i) },
        { width: 720, height: 480, bytes: await jpeg(720, 480, i) },
        { width: 1600, height: 1066, bytes: await jpeg(1600, 1066, i) },
      ];
      const built = buildRgbDngWithPreviews({ width, height, rgb, previews });
      files.push(new File([built.bytes], 'embedded-' + i + '.dng', { lastModified: 1000 + i }));
      window.__embeddedPreviewLengths = built.previews.map(p => p.length);
    }
    window.__embeddedFiles = files;
  })()`);

  // --- Worker capability, read budget and preview choice -------------------
  const jobs = await evaluate(`(async () => {
    const { createEmbeddedPreviewPool } = await import('/src/app/scanDecodeClient.js');
    const pool = createEmbeddedPreviewPool();
    const file = window.__embeddedFiles[0];
    const tile = await pool.request({ file, purpose: 'tile', output: 'dataUrl' });
    const viewer = await pool.request({ file, purpose: 'viewer', output: 'bitmap', longSidePx: 2000 });
    const summary = {
      capability: pool.capability,
      tile: tile && { width: tile.width, height: tile.height, bytesRead: tile.bytesRead, preview: tile.preview,
        url: String(tile.dataUrl || '').slice(0, 23) },
      viewer: viewer && { width: viewer.width, height: viewer.height, bitmap: viewer.bitmap instanceof ImageBitmap,
        bytesRead: viewer.bytesRead, preview: viewer.preview },
    };
    viewer?.bitmap?.close?.();
    pool.clear();
    return summary;
  })()`);
  console.log('embedded preview jobs:', JSON.stringify(jobs));
  expect(jobs.capability === true, 'Chrome workers must report the image-decoding capability', jobs);
  expect(jobs.tile?.preview?.width === 720 && Math.max(jobs.tile.width, jobs.tile.height) <= 320
    && jobs.tile.url.startsWith('data:image/jpeg') && jobs.tile.bytesRead <= 200 * 1024, 'tile job picks the 720 px preview within 200 KB', jobs.tile);
  expect(jobs.viewer?.preview?.width === 1600 && jobs.viewer.bitmap && jobs.viewer.width === 1600
    && jobs.viewer.bytesRead <= jobs.viewer.preview.length + 32 * 1024, 'viewer job reads only its preview plus IFD data', jobs.viewer);

  // --- HE NEF fallback parity: worker planes equal the main-thread planes --
  const parityScript = source => `(async () => {
    const { decodeNefPreviewJpeg, extractNefPreviewJpeg } = await import('/src/app/nefJpegPreview.js');
    const { fromImageData8 } = await import('/src/silvercore/util/image16.js');
    const hash = async view => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength))), b => b.toString(16).padStart(2, '0')).join('');
    const bytes = await (${source});
    const main = await decodeNefPreviewJpeg({ jpegBytes: bytes.slice() }, { decodeInWorker: null });
    main.__image16 ||= fromImageData8(main);
    const stash = { jpegBytes: bytes.slice() };
    const worker = await decodeNefPreviewJpeg(stash);
    const fromWorker = Boolean(worker?.__image16);
    return { fromWorker, main: [main.width, main.height, await hash(main.data), await hash(main.__image16.data)],
      worker: worker && [worker.width, worker.height, await hash(worker.data), await hash(worker.__image16.data)] };
  })()`;
  const synthetic = await evaluate(parityScript(`(async () => {
    const canvas = new OffscreenCanvas(1200, 800), ctx = canvas.getContext('2d');
    for (let y = 0; y < 800; y += 8) for (let x = 0; x < 1200; x += 8) {
      ctx.fillStyle = 'rgb(' + ((x * 7 + y) % 256) + ',' + ((y * 3) % 256) + ',' + ((x ^ y) % 256) + ')';
      ctx.fillRect(x, y, 8, 8);
    }
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })).arrayBuffer());
  })()`));
  console.log('HE NEF fallback parity (synthetic):', JSON.stringify(synthetic));
  expect(synthetic.fromWorker && JSON.stringify(synthetic.main) === JSON.stringify(synthetic.worker),
    'worker HE NEF decode must match the main-thread planes', synthetic);
  const nefDir = process.env.NEF_PARITY_DIR || process.env.AUTOFRAME_RAW_DIR;
  if (nefDir) {
    for (const name of ['DSC_8800.NEF', 'DSC_8798.NEF', 'DSC_8806.NEF', 'DSC_4127.NEF']) {
      const path = resolve(nefDir, name);
      if (!existsSync(path)) { console.log('HE NEF parity: missing', name); continue; }
      await evaluate(`(() => { let input = document.getElementById('nefParityInput'); if (!input) { input = document.createElement('input'); input.type = 'file'; input.id = 'nefParityInput'; input.hidden = true; document.body.append(input); } })()`);
      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#nefParityInput' });
      await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [path] });
      const row = await evaluate(parityScript(`(async () => {
        const file = document.getElementById('nefParityInput').files[0];
        const found = extractNefPreviewJpeg(await file.arrayBuffer());
        return found.jpegBytes.slice();
      })()`));
      console.log('HE NEF fallback parity', name, JSON.stringify(row));
      expect(row.fromWorker && JSON.stringify(row.main) === JSON.stringify(row.worker), `worker HE NEF planes differ for ${name}`, row);
    }
  }

  // --- RAW import: provisional frame in the veil while the read is held ----
  await evaluate(`(() => {
    const autoCrop = document.getElementById('studioImportAutoCrop'); if (autoCrop?.checked) autoCrop.click();
    const autoRoll = document.getElementById('autoRollOnImport'); if (autoRoll && !autoRoll.checked) autoRoll.click();
    const p = window.__embeddedProbe = { holdName: 'embedded-1.dng', release: null, heldReads: 0, transitions: [], longTasks: [], start: 0 };
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function (...args) {
      if (this.name === p.holdName) {
        p.holdName = null; p.heldReads++;
        await new Promise(resolve => { p.release = () => { p.release = null; resolve(); }; setTimeout(() => p.release?.(), 30000); });
      }
      return read.apply(this, args);
    };
    const kinds = new Map();
    const record = () => {
      for (const button of document.querySelectorAll('#fileListItems .file-list-name')) {
        const name = button.querySelector('.file-list-filename')?.textContent;
        const kind = button.dataset.thumbnailKind || '';
        if (name && kinds.get(name) !== kind) {
          p.transitions.push([name, kinds.get(name) || '', kind, Math.round(performance.now() - p.start)]);
          kinds.set(name, kind);
        }
      }
    };
    const observer = new MutationObserver(record);
    observer.observe(document.getElementById('fileListItems'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-thumbnail-kind'] });
    let longTasks = null;
    try {
      longTasks = new PerformanceObserver(list => p.longTasks.push(...list.getEntries().map(entry => Math.round(entry.duration))));
      longTasks.observe({ type: 'longtask' });
    } catch { /* not every engine exposes long tasks */ }
    p.restore = () => { File.prototype.arrayBuffer = read; observer.disconnect(); longTasks?.disconnect(); p.release?.(); };
    const transfer = new DataTransfer();
    for (const file of window.__embeddedFiles) transfer.items.add(file);
    const input = document.getElementById('fileInput');
    input.files = transfer.files;
    p.start = performance.now();
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const veilMeasure = `(() => {
    const veil = document.getElementById('studioPhotoSwitchFeedback');
    const surface = veil.querySelector('[data-surface="bitmap"]');
    let means = null;
    if (surface.width && surface.height) {
      const probe = document.createElement('canvas'); probe.width = surface.width; probe.height = surface.height;
      const ctx = probe.getContext('2d'); ctx.drawImage(surface, 0, 0);
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      means = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) means[c] += data[i + c];
      means = means.map(value => Math.round(value / (data.length / 4)));
    }
    const box = document.getElementById('canvasContainer').getBoundingClientRect();
    const overlay = [...document.querySelectorAll('.loading-overlay')].some(element => {
      const style = getComputedStyle(element); return style.display !== 'none' && Number(style.opacity) > 0.05;
    });
    return { ms: Math.round(performance.now() - window.__embeddedProbe.start), hidden: veil.hidden,
      provisional: veil.dataset.provisional || null, role: veil.getAttribute('role'), live: veil.getAttribute('aria-live'),
      atomic: veil.getAttribute('aria-atomic'), message: document.getElementById('studioPhotoSwitchMessage').textContent,
      chip: veil.querySelector('.studio-photo-switch-provisional')?.textContent || '',
      chipVisible: getComputedStyle(veil.querySelector('.studio-photo-switch-card')).display !== 'none',
      surface: [surface.width, surface.height, !surface.hidden], means, overlay,
      busy: document.getElementById('canvasContainer').getAttribute('aria-busy'),
      exportDisabled: document.getElementById('exportBtn').disabled,
      historyInert: document.getElementById('studioHistory').inert,
      viewer: [Math.round(box.width), Math.round(box.height)],
      // pickForViewer: the smallest preview reaching 0.8 x the device-pixel long side.
      expectedWidth: Math.max(box.width, box.height) * devicePixelRatio * 0.8 <= 720 ? 720 : 1600,
      placeholder: getComputedStyle(document.getElementById('uploadPlaceholder')).display,
      readHeld: Boolean(window.__embeddedProbe.release) };
  })()`;
  await waitFor('provisional import frame', `document.getElementById('studioPhotoSwitchFeedback').dataset.provisional === 'embedded'`, 15000);
  const importFrame = await evaluate(veilMeasure);
  console.log('provisional import frame:', JSON.stringify(importFrame));
  expect(!importFrame.hidden && importFrame.role === 'status' && importFrame.live === 'polite' && importFrame.atomic === 'true'
    && importFrame.message.includes('embedded-1.dng') && importFrame.chip.includes('preview') && importFrame.chipVisible,
  'provisional frame keeps the announced, localized opening feedback and shows the chip', importFrame);
  expect(importFrame.readHeld, 'provisional pixels must appear before the container read completes', importFrame);
  expect(!importFrame.overlay && importFrame.placeholder === 'none' && importFrame.viewer[0] > 300 && importFrame.viewer[1] > 200,
    'RAW import opens in the visible viewer, not under the full-screen overlay', importFrame);
  expect(importFrame.surface[0] === importFrame.expectedWidth && importFrame.surface[2] && importFrame.busy === 'true'
    && importFrame.exportDisabled && importFrame.historyInert, 'the viewer-sized preview is shown while editing and export stay locked', importFrame);
  expect(importFrame.means && Math.max(...importFrame.means) > 40 && Math.abs(importFrame.means[0] - importFrame.means[2]) < 70,
    'the provisional frame is an inverted positive, not the orange negative', importFrame);

  await waitFor('embedded tiles at import', `(() => {
    const tiles = [...document.querySelectorAll('#fileListItems .file-list-name')];
    return tiles.length === 3 && tiles.every(tile => tile.querySelector('img.file-list-thumbnail'))
      && !document.querySelector('#fileListItems .file-list-placeholder');
  })()`, 5000);
  const importTiles = await evaluate(`[...document.querySelectorAll('#fileListItems .file-list-name')].map(tile => ({
    name: tile.querySelector('.file-list-filename').textContent, kind: tile.dataset.thumbnailKind, state: tile.dataset.previewState }))`);
  console.log('embedded tiles:', JSON.stringify({ importTiles, transitions: await evaluate('window.__embeddedProbe.transitions') }));
  expect(importTiles.every(tile => tile.kind === 'embedded' && tile.state === 'pending'),
    'every tile shows an embedded preview while the first read is still held, and stays pending', importTiles);

  await evaluate('window.__embeddedProbe.release?.()');
  await waitFor('RAW import settles', `${READY} && document.getElementById('studioFilename').textContent === 'embedded-1.dng'
    && document.getElementById('studioPhotoSwitchFeedback').hidden`, 120000);
  const settled = await evaluate(`(() => {
    const veil = document.getElementById('studioPhotoSwitchFeedback');
    return { provisional: veil.dataset.provisional || null, surfaces: [...veil.querySelectorAll('[data-surface]')].map(node => node.hidden),
      opening: document.body.classList.contains('studio-opening'), loaded: document.body.classList.contains('studio-loaded') };
  })()`);
  expect(!settled.provisional && settled.surfaces.every(Boolean) && !settled.opening && settled.loaded,
    'the exact render releases every presentation surface', settled);

  await waitFor('tiles move forward to canonical previews', `[...document.querySelectorAll('#fileListItems .file-list-name')]
    .every(tile => tile.dataset.previewState === 'ready' && tile.dataset.thumbnailKind === 'processed')`, 180000);
  const transitions = await evaluate('window.__embeddedProbe.transitions');
  const backwards = transitions.filter(([, from, to]) => (from === 'analysis' || from === 'processed') && to === 'embedded');
  console.log('tile transitions:', JSON.stringify(transitions));
  expect(!backwards.length, 'a tile never moves back from analysis/processed to embedded', backwards);

  // --- Cold switch: thumbnail in the click's task, then the embedded frame --
  // The roll's background lanes decoded every photo and keep their bases as
  // sessions (#243), so the target is made cold first.
  const click = await evaluate(`(() => {
    window.__ncDebug.forgetPhotoCaches();
    window.__embeddedProbe.holdName = 'embedded-3.dng';
    const button = [...document.querySelectorAll('#fileListItems .file-list-name')]
      .find(tile => tile.querySelector('.file-list-filename')?.textContent === 'embedded-3.dng');
    window.__embeddedProbe.start = performance.now();
    button.click();
    const veil = document.getElementById('studioPhotoSwitchFeedback');
    return { hidden: veil.hidden, provisional: veil.dataset.provisional || null,
      thumbnail: !veil.querySelector('[data-surface="thumbnail"]').hidden,
      message: document.getElementById('studioPhotoSwitchMessage').textContent };
  })()`);
  console.log('cold switch, same task:', JSON.stringify(click));
  expect(!click.hidden && click.provisional === 'thumbnail' && click.thumbnail && click.message.includes('embedded-3.dng'),
    'a cold switch shows the tile thumbnail in the veil in the same task', click);
  await waitFor('embedded frame on a cold switch', `document.getElementById('studioPhotoSwitchFeedback').dataset.provisional === 'embedded'`, 15000);
  const coldFrame = await evaluate(veilMeasure);
  console.log('cold switch provisional frame:', JSON.stringify(coldFrame));
  expect(coldFrame.readHeld && coldFrame.surface[2] && coldFrame.exportDisabled && coldFrame.busy === 'true',
    'the embedded frame replaces the thumbnail before the read completes, with locks kept', coldFrame);
  await evaluate('window.__embeddedProbe.release?.()');
  await waitFor('cold switch settles', `${READY} && document.getElementById('studioFilename').textContent === 'embedded-3.dng'
    && document.getElementById('studioPhotoSwitchFeedback').hidden && !document.getElementById('studioPhotoSwitchFeedback').dataset.provisional`, 120000);

  const longTasks = await evaluate('window.__embeddedProbe.longTasks');
  console.log('main-thread long tasks during the embedded-preview smoke (ms):', JSON.stringify(longTasks));
  await evaluate('window.__embeddedProbe.restore(); delete window.__embeddedFiles;');
  console.log('ok: embedded previews fill the veil and every tile before the exact decode, without touching editor state');
}
