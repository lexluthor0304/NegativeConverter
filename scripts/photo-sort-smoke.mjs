// Exercise sorting through real Files, DOM controls and the production export
// pipeline. Queue identity is deliberately different from every display order.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const UPNG = require('upng-js');
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const storageKey = 'nc_photo_sort_v1';
const fixtures = [
  ['frame10.png', 1000], ['frame2.png', 4000], ['frame1.png', 2000], ['frame20.png', 3000],
];
const expectedOrders = {
  'modified-desc': ['frame2.png', 'frame20.png', 'frame1.png', 'frame10.png'],
  'modified-asc': ['frame10.png', 'frame1.png', 'frame20.png', 'frame2.png'],
  'name-asc': ['frame1.png', 'frame2.png', 'frame10.png', 'frame20.png'],
  'name-desc': ['frame20.png', 'frame10.png', 'frame2.png', 'frame1.png'],
};

function installSortProbe() {
  const originals = {
    read: File.prototype.arrayBuffer,
    post: Worker.prototype.postMessage,
    terminate: Worker.prototype.terminate,
    bitmap: window.createImageBitmap,
    picker: window.showSaveFilePicker,
    anchor: HTMLAnchorElement.prototype.click,
    revoke: URL.revokeObjectURL,
  };
  const workers = new Map(), heldUrls = new Set();
  const p = window.__photoSortProbe = {
    reads: [], requests: [], bitmaps: 0, inFlight: 0, lastActivity: performance.now(),
    holdName: null, heldName: null, release: null, holdTimedOut: false,
    single: [], archives: [],
  };
  let watchdog;
  const activity = () => { p.lastActivity = performance.now(); };
  File.prototype.arrayBuffer = async function(...args) {
    p.reads.push(this.name); activity();
    if (p.holdName === this.name) {
      p.holdName = null; p.heldName = this.name;
      await new Promise(resolve => {
        p.release = () => { clearTimeout(watchdog); p.release = null; resolve(); };
        watchdog = setTimeout(() => { p.holdTimedOut = true; p.release?.(); }, 15000);
      });
    }
    try { return await originals.read.apply(this, args); }
    finally { activity(); }
  };
  Worker.prototype.postMessage = function(message, ...args) {
    const kind = message?.type === 'convert' ? 'convert'
      : message?.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format) ? 'decode' : null;
    if (kind) {
      let record = workers.get(this);
      if (!record) {
        record = { pending: new Set() };
        record.receive = event => {
          if (event.data?.ready) return;
          if (record.pending.delete(event.data?.id ?? 'decode')) { p.inFlight--; activity(); }
        };
        this.addEventListener('message', record.receive);
        workers.set(this, record);
      }
      const key = message.id ?? 'decode';
      if (!record.pending.has(key)) { record.pending.add(key); p.inFlight++; }
      p.requests.push(kind); activity();
    }
    return originals.post.call(this, message, ...args);
  };
  Worker.prototype.terminate = function(...args) {
    const record = workers.get(this);
    if (record) { p.inFlight -= record.pending.size; record.pending.clear(); activity(); }
    return originals.terminate.apply(this, args);
  };
  window.createImageBitmap = function(...args) {
    p.bitmaps++; activity();
    return originals.bitmap.apply(this, args);
  };
  const dataUrl = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  // Replace only the browser's destination. The actual conversion, PNG
  // encoding, streaming ZIP writer and in-order batch sink run unchanged.
  window.showSaveFilePicker = async options => {
    const capture = { name: options.suggestedName }, chunks = [];
    p.archives.push(capture);
    return { name: capture.name, createWritable: async () => ({
      async write(bytes) { chunks.push(new Uint8Array(bytes).slice()); },
      async close() { capture.data = await dataUrl(new Blob(chunks, { type: 'application/zip' })); },
      async abort() { capture.aborted = true; },
    }) };
  };
  URL.revokeObjectURL = function(url) { if (!heldUrls.has(url)) originals.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function(...args) {
    if (!this.download?.endsWith('.png') || !this.href.startsWith('blob:')) return originals.anchor.apply(this, args);
    const href = this.href, capture = { name: this.download };
    heldUrls.add(href); p.single.push(capture);
    fetch(href).then(response => response.blob()).then(dataUrl)
      .then(data => { capture.data = data; }, error => { capture.error = String(error); })
      .finally(() => { heldUrls.delete(href); originals.revoke.call(URL, href); });
  };
  p.snapshot = () => ({
    reads: p.reads.length, requests: p.requests.length, bitmaps: p.bitmaps,
    filename: document.getElementById('studioFilename').textContent,
    active: document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index,
    cyan: document.getElementById('cyan').value,
    undoDisabled: document.getElementById('undoBtn').disabled,
    redoDisabled: document.getElementById('redoBtn').disabled,
    selected: [...document.querySelectorAll('.file-list-checkbox:checked')].map(el => el.dataset.index).sort(),
    thumbnails: [...document.querySelectorAll('.file-list-name')].map(el => [el.dataset.index, el.querySelector('img')?.src]).sort(),
  });
  p.captureNodes = () => {
    p.nodes = [...document.querySelectorAll('.file-list-name')].map(button => ({ index: button.dataset.index,
      button, row: button.closest('.file-list-item'), thumbnail: button.querySelector('img') }));
  };
  p.sameNodes = () => p.nodes.every(({ index, button, row, thumbnail }) => {
    const next = document.querySelector('.file-list-name[data-index="' + index + '"]');
    return next === button && next.closest('.file-list-item') === row && next.querySelector('img') === thumbnail;
  });
  p.stop = () => {
    p.release?.(); clearTimeout(watchdog);
    File.prototype.arrayBuffer = originals.read;
    Worker.prototype.postMessage = originals.post;
    Worker.prototype.terminate = originals.terminate;
    window.createImageBitmap = originals.bitmap;
    window.showSaveFilePicker = originals.picker;
    HTMLAnchorElement.prototype.click = originals.anchor;
    URL.revokeObjectURL = originals.revoke;
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
  };
}

function pngHash(bytes) {
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return { width: png.width, height: png.height,
    hash: createHash('sha256').update(Buffer.from(UPNG.toRGBA8(png)[0])).digest('hex') };
}

function summarizeSnapshot(snapshot) {
  return { ...snapshot, thumbnails: snapshot.thumbnails.map(([index, src]) => [index, {
    srcLength: src?.length || 0,
    sha256: createHash('sha256').update(src || '').digest('hex'),
  }]) };
}

export async function runPhotoSortSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 60000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), 'timeout waiting for ' + description);
  };
  const names = () => evaluate(`[...document.querySelectorAll('#fileListItems .file-list-filename')].map(el => el.textContent)`);
  const setSort = mode => evaluate(`(() => {
    const select = document.getElementById('studioPhotoSort');
    select.value = ${JSON.stringify(mode)}; select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const settled = count => until('sorted photo previews and workers settled', `${ready}
    && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === ${count}
    && window.__photoSortProbe.inFlight === 0
    && performance.now() - window.__photoSortProbe.lastActivity > 3200`, 120000);
  const boot = async () => {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await until('fresh photo sorting workspace', `performance.timeOrigin !== ${origin}
      && document.readyState === 'complete' && !!document.getElementById('studioPhotoSort')
      && !!document.getElementById('resetLearnedDefaults')`);
    await installDialogAutoAccept();
  };
  let oldSort, storageCaptured = false, failure;
  try {
    await boot();
    oldSort = await evaluate(`localStorage.getItem('${storageKey}')`);
    storageCaptured = true;
    await evaluate(`localStorage.removeItem('${storageKey}')`);
    await boot();
    const options = await evaluate(`(() => {
      const select = document.getElementById('studioPhotoSort');
      return { value: select.value, options: [...select.options].map(option => option.value),
        label: select.labels?.[0]?.textContent || select.getAttribute('aria-label') };
    })()`);
    expect(options.value === 'modified-desc' && options.label?.trim()
      && JSON.stringify([...options.options].sort()) === JSON.stringify(Object.keys(expectedOrders).sort()),
    'sort must default to newest modification with four labelled choices: ' + JSON.stringify(options));
    await evaluate(`(${installSortProbe.toString()})()`);
    await evaluate(`(async () => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport', 'dustRemovalEnabled', 'dustAiEnabled']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="color"]').click();
      const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
      const context = canvas.getContext('2d'), gradient = context.createLinearGradient(0, 0, 240, 160);
      gradient.addColorStop(0, '#d09165'); gradient.addColorStop(1, '#36241c');
      context.fillStyle = gradient; context.fillRect(0, 0, 240, 160);
      window.__photoSortBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer();
      for (const [name, lastModified] of ${JSON.stringify(fixtures)}) {
        transfer.items.add(new File([window.__photoSortBlob], name, { type: 'image/png', lastModified }));
      }
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settled(4);
    expect(JSON.stringify(await names()) === JSON.stringify(expectedOrders['modified-desc']), 'default order does not use file modification time');
    expect(await evaluate(`document.getElementById('studioFilename').textContent === 'frame10.png'
      && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '0'`),
    'display sorting must preserve existing import-first activation');

    // A live unsaved adjustment is intentionally attached to queue index 0,
    // which is not the first displayed row in either natural ascending order
    // or the default newest-first order.
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      const input = document.getElementById('cyan'); input.value = '20';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
    })()`);
    await settled(4);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await until('edited reference PNG export', `!!window.__photoSortProbe.single[0]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    const edited = pngHash(Buffer.from((await evaluate('window.__photoSortProbe.single[0].data')).split(',')[1], 'base64'));
    await settled(4);
    await evaluate(`window.__photoSortProbe.captureNodes()`);
    const baseline = await evaluate('window.__photoSortProbe.snapshot()');
    for (const mode of Object.keys(expectedOrders)) {
      await setSort(mode);
      expect(JSON.stringify(await names()) === JSON.stringify(expectedOrders[mode]), mode + ' produced incorrect natural/date order');
      await wait(100);
      const actual = await evaluate('window.__photoSortProbe.snapshot()');
      expect(JSON.stringify(actual) === JSON.stringify(baseline), 'sorting changed active photo, adjustment, history, selection, pixels or processing counters: ' + JSON.stringify({ mode, baseline: summarizeSnapshot(baseline), actual: summarizeSnapshot(actual) }));
      expect(await evaluate('window.__photoSortProbe.sameNodes()'), 'sorting recreated existing tile or thumbnail nodes');
    }
    // Catch a sort-triggered delayed decode/full-render, not just its first turn.
    await wait(3400);
    expect(JSON.stringify(await evaluate('window.__photoSortProbe.snapshot()')) === JSON.stringify(baseline), 'sorting scheduled delayed image work');
    console.log('ok: all four sort orders reuse DOM and preserve edited photo, history, selection and processing counters');

    await setSort('name-asc');
    const keyboard = await evaluate(`(() => {
      const list = document.getElementById('fileListItems');
      const rows = [...list.querySelectorAll('.file-list-name')]; rows[0].focus({ preventScroll: true });
      const press = key => { list.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); return document.activeElement.dataset.index; };
      return { right: press('ArrowRight'), end: press('End'), home: press('Home') };
    })()`);
    expect(keyboard.right === '1' && keyboard.end === '3' && keyboard.home === '2', 'keyboard navigation does not follow visual order: ' + JSON.stringify(keyboard));
    const selection = await evaluate(`(() => {
      document.getElementById('selectNoneBtn').click();
      document.querySelector('.file-list-checkbox[data-index="1"]').click();
      document.querySelector('.file-list-checkbox[data-index="3"]').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      return [...document.querySelectorAll('.file-list-checkbox:checked')].map(el => el.dataset.index);
    })()`);
    expect(JSON.stringify(selection) === JSON.stringify(['1', '0', '3']), 'Shift selection used queue order instead of visible natural order: ' + JSON.stringify(selection));

    await evaluate(`document.getElementById('exportZipBtn').click()`);
    await until('sorted streaming ZIP complete', `!!window.__photoSortProbe.archives[0]?.data && !document.getElementById('exportBtn').disabled`, 120000);
    const archive = await JSZip.loadAsync(Buffer.from((await evaluate('window.__photoSortProbe.archives[0].data')).split(',')[1], 'base64'));
    const entries = Object.values(archive.files).filter(entry => !entry.dir);
    expect(JSON.stringify(entries.map(entry => entry.name)) === JSON.stringify(['frame2_converted.png', 'frame10_converted.png', 'frame20_converted.png']),
      'ZIP entry order does not match sorted selection: ' + JSON.stringify(entries.map(entry => entry.name)));
    const encoded = await Promise.all(entries.map(async entry => ({ name: entry.name, ...pngHash(await entry.async('nodebuffer')) })));
    expect(encoded[1].hash === edited.hash && encoded[1].width === edited.width && encoded[1].height === edited.height,
      'sorted batch attached the current edited settings to a different source');
    expect(encoded[0].hash === encoded[2].hash && encoded[0].hash !== edited.hash,
      'sorted batch lost independent unedited settings: ' + JSON.stringify(encoded));
    console.log('ok: Shift selection and real streaming ZIP follow visual order, retaining per-file edited PNG pixels', JSON.stringify(encoded));

    // Exercise actual add-more behavior without changing the open photo. Only
    // the native picker is supplied with a real File; app handlers run normally.
    await evaluate(`window.__appendSortFile = (name, lastModified, cold = false) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([window.__photoSortBlob], name, { type: 'image/png', lastModified }));
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function(...args) {
        if (this.type !== 'file' || this.id) return click.apply(this, args);
        this.files = transfer.files; this.dispatchEvent(new Event('change', { bubbles: true }));
      };
      try { document.getElementById('addFilesToolbarBtn').click(); }
      finally { HTMLInputElement.prototype.click = click; }
      if (cold) {
        window.__photoSortProbe.holdName = name;
        const button = [...document.querySelectorAll('.file-list-name')].find(el => el.querySelector('.file-list-filename').textContent === name);
        button.click();
      }
    }`);
    await evaluate(`window.__appendSortFile('frame3.png', 5000)`);
    await settled(5);
    expect(JSON.stringify(await names()) === JSON.stringify(['frame1.png', 'frame2.png', 'frame3.png', 'frame10.png', 'frame20.png']), 'appended file did not enter natural display order');
    expect(await evaluate(`document.getElementById('studioFilename').textContent === 'frame10.png' && document.getElementById('cyan').value === '20'`), 'appending a sorted file replaced the edited current photo');

    await evaluate(`window.__appendSortFile('frame4.png', 6000, true)`);
    await until('real cold file read held during sorting', `!!window.__photoSortProbe.release && window.__photoSortProbe.heldName === 'frame4.png'`, 10000);
    await setSort('modified-desc');
    const pending = await evaluate(`(() => {
      const target = document.querySelector('.file-list-name[data-photo-switch-target="true"]');
      return { name: target?.querySelector('.file-list-filename').textContent, index: target?.dataset.index,
        busy: target?.getAttribute('aria-busy'), current: target?.getAttribute('aria-current'),
        active: target?.closest('.file-list-item').classList.contains('active'),
        hidden: document.getElementById('studioPhotoSwitchFeedback').hidden,
        message: document.getElementById('studioPhotoSwitchMessage').textContent };
    })()`);
    expect(pending.name === 'frame4.png' && pending.index === '5' && pending.busy === 'true'
      && pending.current === 'true' && pending.active && !pending.hidden && pending.message.includes('frame4.png'),
    'sort detached cold-switch feedback from its original queue item: ' + JSON.stringify(pending));
    await evaluate('window.__photoSortProbe.release()');
    await until('sorted cold switch completes for correct source', `${ready}
      && document.getElementById('studioFilename').textContent === 'frame4.png'
      && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '5'
      && document.getElementById('studioPhotoSwitchFeedback').hidden
      && !document.querySelector('.file-list-name[data-photo-switch-target="true"]')`, 120000);
    expect(!await evaluate('window.__photoSortProbe.holdTimedOut'), 'cold read auto-released before its sorting assertions completed');
    await settled(6);
    console.log('ok: sorted appends preserve the open photo; reordering during a held cold read preserves switch ownership');

    const layouts = [];
    for (const [width, height] of [[2048, 1166], [1440, 900], [390, 844], [320, 844], [844, 390]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 700 });
      for (const grid of [false, true]) {
        await evaluate(`(() => { if (document.body.classList.contains('studio-lighttable') !== ${grid}) document.getElementById('studioToggleLightTable').click(); })()`);
        const layout = await evaluate(`(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const header = document.querySelector('.studio-strip-header'), rect = header.getBoundingClientRect();
          const select = document.getElementById('studioPhotoSort'), box = select.getBoundingClientRect();
          const controls = [...header.querySelectorAll(':scope > button, :scope > label select, :scope > details > summary, :scope > #studioSelection')]
            .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden')
            .map(el => { const r = el.getBoundingClientRect(); return { id: el.id || el.parentElement.id,
              left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; });
          return { width: innerWidth, height: innerHeight, grid: document.body.classList.contains('studio-lighttable'),
            header: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: header.clientWidth, scrollWidth: header.scrollWidth },
            select: { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height },
            controls, pageWidth: document.documentElement.scrollWidth };
        })()`);
        expect(layout.header.scrollWidth <= layout.header.width + 1 && layout.pageWidth <= width + 1
          && layout.select.width > 30 && layout.select.height > 15
          && layout.controls.every(box => box.width > 0 && box.height > 0 && box.left >= layout.header.left - 1
            && box.right <= Math.min(width, layout.header.right) + 1 && box.top >= layout.header.top - 1 && box.bottom <= layout.header.bottom + 1),
        'photo-sort header clips or overflows at ' + width + 'x' + height + ': ' + JSON.stringify(layout));
        const overlaps = layout.controls.some((box, i) => layout.controls.slice(i + 1).some(other =>
          Math.min(box.right, other.right) - Math.max(box.left, other.left) > 1
          && Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top) > 1));
        expect(!overlaps, 'photo-sort header controls overlap at ' + width + 'x' + height + ': ' + JSON.stringify(layout));
        layouts.push(layout);
        if (width === 1440 && grid) {
          const screenshot = await send('Page.captureScreenshot', { format: 'png' });
          expect(screenshot.result?.data, 'photo-sort screenshot missing');
          mkdirSync(join(root, 'output', 'playwright'), { recursive: true });
          writeFileSync(join(root, 'output', 'playwright', 'photo-sort.png'), Buffer.from(screenshot.result.data, 'base64'));
        }
      }
    }
    console.log('photo sort header layouts:', JSON.stringify(layouts));
    await setSort('name-desc');
    expect(await evaluate(`localStorage.getItem('${storageKey}') === 'name-desc'`), 'sort preference was not persisted');
    await evaluate('window.__photoSortProbe.stop()');
    await boot();
    expect(await evaluate(`document.getElementById('studioPhotoSort').value === 'name-desc'`), 'sort preference did not survive reload');
    console.log('ok: photo sorting survives reload and remains accessible without header overflow in both modes at five viewports');
  } catch (error) {
    failure = error;
    try {
      console.error('photo-sort diagnostics:', JSON.stringify(await evaluate(`({
        snapshot: (() => {
          const snapshot = window.__photoSortProbe?.snapshot();
          return snapshot ? { ...snapshot, thumbnails: snapshot.thumbnails.map(([index, src]) => [index, { srcLength: src?.length || 0 }]) } : null;
        })(), reads: window.__photoSortProbe?.reads,
        requests: window.__photoSortProbe?.requests, inFlight: window.__photoSortProbe?.inFlight,
        holdTimedOut: window.__photoSortProbe?.holdTimedOut,
        mode: document.getElementById('studioPhotoSort')?.value,
        rows: [...document.querySelectorAll('.file-list-name')].map(el => ({ index: el.dataset.index, name: el.querySelector('.file-list-filename')?.textContent }))
      })`)));
    } catch { /* Retain the original assertion when the document itself failed. */ }
  } finally {
    await evaluate(`window.__photoSortProbe?.stop(); delete window.__photoSortProbe;
      delete window.__photoSortBlob; delete window.__appendSortFile;`);
    if (storageCaptured) await evaluate(oldSort === null
      ? `localStorage.removeItem('${storageKey}')`
      : `localStorage.setItem('${storageKey}', ${JSON.stringify(oldSort)})`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }
  if (failure) fail(failure.message);
}
