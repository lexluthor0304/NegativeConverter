// Resumed browser exports (#241, R1-125), on the real app. A TIFF 16-bit
// export with dust removal on (AI repair off), the sprocket border and custom
// edge markings is "killed" after its first frame (its job marker restored,
// the page reloaded); the originals are added again and the roll restored.
// The ZIP is written again whole and 'Download individually' writes the
// missing frames: same names, TIFF at the same bit depth, and decoded pixels
// equal to the uninterrupted run's. After the reload every control is back at
// its default (PNG 8-bit, no border, AI repair on, the restored open photo
// without dust removal and with the default markings): only the options the
// job recorded can reproduce it, and the controls stay as they are.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const UPNG = require('upng-js');
const UTIF = require('utif');

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const MARKER_KEY = 'nc_job_marker_export_v1';
const EDGE_TEXT = 'SMOKE 400';

// The small fixtures with dust: dark and bright specks a few pixels wide at
// fixed places, so the export's dust removal has work to do.
function writeDustyFixtures(root, dir) {
  return ['negative-textured.png', 'negative-vignetted.png', 'negative-plain.png'].map((name, n) => {
    const bytes = readFileSync(join(root, 'negative2positive', 'test-fixtures', name));
    const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
    const { width, height } = png;
    let seed = 1234 + n;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let k = 0; k < 24; k++) {
      const cx = Math.round(80 + random() * (width - 160));
      const cy = Math.round(80 + random() * (height - 160));
      const r = 1 + Math.round(random() * 2);
      const value = k % 2 ? 250 : 6;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue;
        const o = ((cy + y) * width + cx + x) * 4;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = value;
      }
    }
    const path = join(dir, name.replace('negative-', 'dusty-'));
    writeFileSync(path, Buffer.from(UPNG.encode([rgba.buffer], width, height, 0)));
    return path;
  });
}

// Runs in the page: ZIP saves and single downloads are kept in memory, and
// the export marker is copied the moment it records its first frame.
function installSaveCapture() {
  const p = window.__hjSaves = { zips: [], downloads: [], marker: null, original: {
    picker: window.showSaveFilePicker, anchor: HTMLAnchorElement.prototype.click,
    revoke: URL.revokeObjectURL, setItem: Storage.prototype.setItem
  } };
  const held = new Set();
  window.showSaveFilePicker = async (options) => {
    const capture = { name: options.suggestedName, chunks: [], bytes: null };
    p.zips.push(capture);
    return { name: capture.name, createWritable: async () => ({
      async write(bytes) { capture.chunks.push(new Uint8Array(bytes).slice()); },
      async close() { capture.bytes = new Uint8Array(await new Blob(capture.chunks).arrayBuffer()); capture.chunks = []; },
      async abort() { capture.aborted = true; }
    }) };
  };
  URL.revokeObjectURL = function (url) { if (!held.has(url)) p.original.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function (...args) {
    if (!this.download || !this.href.startsWith('blob:')) return p.original.anchor.apply(this, args);
    const href = this.href;
    const capture = { name: this.download, bytes: null };
    held.add(href);
    p.downloads.push(capture);
    fetch(href).then(response => response.arrayBuffer())
      .then(buffer => { capture.bytes = new Uint8Array(buffer); }, error => { capture.error = String(error); })
      .finally(() => { held.delete(href); p.original.revoke.call(URL, href); });
  };
  Storage.prototype.setItem = function (key, value) {
    if (key === 'nc_job_marker_export_v1' && !p.marker) {
      try { if (JSON.parse(value).written?.length === 1) p.marker = String(value); } catch { /* not a marker */ }
    }
    return p.original.setItem.call(this, key, value);
  };
  p.stop = () => {
    window.showSaveFilePicker = p.original.picker;
    HTMLAnchorElement.prototype.click = p.original.anchor;
    URL.revokeObjectURL = p.original.revoke;
    Storage.prototype.setItem = p.original.setItem;
  };
}

// Pulls a Uint8Array out of the page in base64 slices.
async function pullBytes(evaluate, expression) {
  const length = await evaluate(`${expression}.length`);
  const parts = [];
  const slice = 1 << 21;
  for (let at = 0; at < length; at += slice) {
    parts.push(Buffer.from(await evaluate(`(() => { const b = ${expression}.subarray(${at}, ${at + slice}); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return btoa(s); })()`), 'base64'));
  }
  return Buffer.concat(parts);
}

// A TIFF's format, size, bit depth and a hash of its decoded samples.
function decodeTiff(name, bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic !== '49492a00' && magic !== '4d4d002a') return { name, format: 'not a TIFF: ' + magic };
  const [ifd] = UTIF.decode(buffer);
  UTIF.decodeImage(buffer, ifd);
  const samples = Buffer.from(ifd.data.buffer, ifd.data.byteOffset, ifd.data.byteLength);
  return { name, format: 'tiff', width: ifd.width, height: ifd.height, bits: Array.from(ifd.t258 || []),
    pixels: createHash('sha256').update(samples).digest('hex').slice(0, 16) };
}

async function zipEntries(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  const entries = [];
  for (const name of names) entries.push(decodeTiff(name, await zip.files[name].async('nodebuffer')));
  return entries;
}

export async function runHiddenJobResumeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-hidden-resume-'));
  const paths = writeDustyFixtures(root, dir);
  const names = paths.map(path => path.split('/').pop());
  const boot = async ({ autoAccept = true } = {}) => {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
    await waitFor('resume smoke boot', `performance.timeOrigin !== ${origin} && document.readyState === 'complete'
      && !!document.getElementById('studioImportAutoCrop') && !!window.__ncHiddenJobs`);
    if (autoAccept) await installDialogAutoAccept();
  };
  const importFiles = async () => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    await waitFor('three dusty negatives converted with previews', `${ready} && document.querySelectorAll('.file-list-name').length === 3
      && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === 3`, 180_000);
  };
  // The job's settings, made on the second photo: frame 1 keeps its own
  // recipe (no dust removal, default markings) and is the photo a restore opens.
  const configureJob = async () => {
    await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
    await waitFor('second photo open for the job', `${ready} && document.getElementById('studioFilename').textContent === '${names[1]}'`, 60_000);
    await evaluate(`(() => {
      document.getElementById('studioTab-repair')?.click();
      const ai = document.getElementById('dustAiEnabled');
      if (ai.checked) ai.click();
      const dust = document.getElementById('dustRemovalEnabled');
      if (!dust.checked) dust.click();
    })()`);
    await waitFor('dust detected on the open photo', `/^(Detected [0-9]+ dust particles|No dust detected|Error:)/.test(document.getElementById('dustStatus').textContent)`, 90_000);
    const status = await evaluate(`document.getElementById('dustStatus').textContent`);
    if (!/^Detected [1-9][0-9]* dust particles/.test(status)) fail('the dusty fixture must have dust to remove: ' + status);
    await evaluate(`(() => {
      const check = id => { const el = document.getElementById(id); if (!el.checked) el.click(); };
      check('sprocketTextEnabledInput');
      check('sprocketDxEnabledInput');
      const text = document.getElementById('sprocketTextInput');
      text.value = '${EDGE_TEXT}';
      text.dispatchEvent(new Event('input', { bubbles: true }));
      if (!document.getElementById('exportSprocketBtn').classList.contains('active')) document.getElementById('exportSprocketBtn').click();
      document.getElementById('exportDropdownMenu')?.classList.remove('show');
      document.querySelector('.format-btn[data-format="tiff"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click();
    })()`);
    await waitFor('job settings in place', `${ready} && document.querySelector('.format-btn.active')?.dataset.format === 'tiff'
      && document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth === '16'
      && document.getElementById('exportSprocketBtn').classList.contains('active')
      && document.getElementById('dustRemovalEnabled').checked && !document.getElementById('dustAiEnabled').checked
      && document.getElementById('sprocketTextInput').value === '${EDGE_TEXT}'`, 60_000);
  };
  // The controls a reload leaves, which a resume must not change.
  const controls = () => evaluate(`({ format: document.querySelector('.format-btn.active')?.dataset.format,
    bitDepth: document.querySelector('.bitdepth-btn.active')?.dataset.bitdepth,
    sprocket: document.getElementById('exportSprocketBtn').classList.contains('active'),
    ai: document.getElementById('dustAiEnabled').checked })`);
  const checkJobMarker = (text, kind) => {
    const marker = JSON.parse(text || 'null');
    if (!marker || marker.v !== 2 || marker.kind !== kind || marker.written?.length !== 1 || marker.files?.length !== 3) fail(`the ${kind} marker did not record its first frame: ${text}`);
    const options = marker.options || {};
    if (options.dustRemoval?.enabled !== true || options.dustRemoval?.ai !== false || options.sprocket !== true
      || options.sprocketEdge?.text !== EDGE_TEXT || marker.exportInfo?.format !== 'tiff' || marker.exportInfo?.bitDepth !== 16) {
      fail(`the ${kind} marker lacks the job's options: ` + JSON.stringify({ exportInfo: marker.exportInfo, options }));
    }
    return marker;
  };
  // The page dies after the first frame: its marker stays, its lock goes
  // with it. The next page names the job; the originals come back and the
  // roll is restored, which offers the resume (accepted).
  const killAndRestore = async (marker, message) => {
    // The recovery copy is debounced by 2.5 s after the last sink.
    await wait(3500);
    await evaluate(`localStorage.setItem('${MARKER_KEY}', ${JSON.stringify(marker)})`);
    await boot({ autoAccept: false });
    await waitFor('boot message names the interrupted job', `${message}.test(document.querySelector('[data-app-dialog-message]')?.textContent || '')`, 15_000);
    console.log('hidden-job resume boot message:', await evaluate(`document.querySelector('[data-app-dialog-message]').textContent`));
    await evaluate(`document.querySelector('[data-app-dialog-confirm]').click()`);
    await installDialogAutoAccept();
    await evaluate(`(${installSaveCapture.toString()})()`);
    const reloaded = await controls();
    if (reloaded.format !== 'png' || reloaded.bitDepth !== '8' || reloaded.sprocket || !reloaded.ai) fail('the reload must reset the controls: ' + JSON.stringify(reloaded));
    await importFiles();
    await waitFor('recovery copy offered', `!document.getElementById('studioRestoreProject').hidden`, 30_000);
    await evaluate(`document.getElementById('studioRestoreProject').click()`);
    return reloaded;
  };
  const sameFrames = (label, resumed, original) => {
    for (const entry of resumed) {
      if (entry.format !== 'tiff') fail(`${label}: ${entry.name} is ${entry.format}`);
      const twin = original.find(candidate => candidate.name === entry.name);
      if (!twin) fail(`${label}: ${entry.name} is not a name of the uninterrupted run: ${JSON.stringify(original.map(o => o.name))}`);
      if (/_16bit\.tiff$/.test(entry.name) && entry.bits.some(bits => bits !== 16)) fail(`${label}: ${entry.name} is not 16-bit: ${entry.bits}`);
      if (JSON.stringify(entry) !== JSON.stringify(twin)) fail(`${label}: ${entry.name} differs from the uninterrupted run: ${JSON.stringify(entry)} vs ${JSON.stringify(twin)}`);
    }
  };

  try {
    await boot();
    await evaluate(`(() => {
      localStorage.setItem('nc_auto_roll_import_v1', 'off');
      localStorage.setItem('nc_batch_lanes_v1', '1');
      localStorage.removeItem('${MARKER_KEY}');
      const crop = document.getElementById('studioImportAutoCrop');
      if (crop && !crop.checked) crop.click();
    })()`);
    await importFiles();

    // ---- 4a. ZIP: killed after frame 1, written again whole ----
    await configureJob();
    await evaluate(`(${installSaveCapture.toString()})(); document.getElementById('exportZipBtn').click()`);
    await waitFor('uninterrupted ZIP written', `window.__hjSaves.zips[0]?.bytes && localStorage.getItem('${MARKER_KEY}') === null
      && !document.querySelector('.loading-overlay.visible')`, 240_000);
    const zipMarker = checkJobMarker(await evaluate(`window.__hjSaves.marker`), 'export-zip');
    const originalZip = await zipEntries(await pullBytes(evaluate, 'window.__hjSaves.zips[0].bytes'));
    console.log('hidden-job resume ZIP, uninterrupted:', JSON.stringify(originalZip));
    if (originalZip.length !== 3 || originalZip.some(entry => entry.format !== 'tiff' || !/_sprocket_16bit\.tiff$/.test(entry.name))) {
      fail('the uninterrupted ZIP must hold three 16-bit sprocket TIFFs: ' + JSON.stringify(originalZip));
    }
    const zipControls = await killAndRestore(JSON.stringify(zipMarker), '/^ZIP export of 3 photos stopped after 1\\. A partial ZIP cannot be resumed\\./');
    await waitFor('resumed ZIP written', `window.__hjSaves.zips[0]?.bytes && localStorage.getItem('${MARKER_KEY}') === null
      && !document.querySelector('.loading-overlay.visible')`, 240_000);
    const resumedZip = await zipEntries(await pullBytes(evaluate, 'window.__hjSaves.zips[0].bytes'));
    console.log('hidden-job resume ZIP, resumed:', JSON.stringify(resumedZip));
    if (JSON.stringify(resumedZip.map(entry => entry.name)) !== JSON.stringify(originalZip.map(entry => entry.name))) {
      fail('the resumed ZIP must hold every frame under its original name: ' + JSON.stringify(resumedZip.map(entry => entry.name)));
    }
    sameFrames('resumed ZIP', resumedZip, originalZip);
    const afterZip = await controls();
    if (JSON.stringify(afterZip) !== JSON.stringify(zipControls)) fail('the resume changed the controls: ' + JSON.stringify(afterZip));
    console.log('ok: a ZIP killed after frame 1 is written again with its format, bit depth, dust removal (AI off) and edge markings: same names, same pixels');

    // ---- 4b. Download individually: killed after frame 1, the rest resumed ----
    await evaluate(`window.__hjSaves.stop()`);
    await configureJob();
    await evaluate(`(${installSaveCapture.toString()})(); document.getElementById('exportAllBtn').click()`);
    await waitFor('uninterrupted downloads written', `window.__hjSaves.downloads.length === 3 && window.__hjSaves.downloads.every(d => d.bytes)
      && localStorage.getItem('${MARKER_KEY}') === null && !document.querySelector('.loading-overlay.visible')`, 240_000);
    const downloadMarker = checkJobMarker(await evaluate(`window.__hjSaves.marker`), 'export-downloads');
    const originalDownloads = [];
    for (let i = 0; i < 3; i++) {
      originalDownloads.push(decodeTiff(await evaluate(`window.__hjSaves.downloads[${i}].name`), await pullBytes(evaluate, `window.__hjSaves.downloads[${i}].bytes`)));
    }
    console.log('hidden-job resume downloads, uninterrupted:', JSON.stringify(originalDownloads));
    if (JSON.stringify(originalDownloads.map(entry => entry.name)) !== JSON.stringify(originalZip.map(entry => entry.name))) {
      fail('downloads and ZIP name the frames alike: ' + JSON.stringify(originalDownloads.map(entry => entry.name)));
    }
    const downloadControls = await killAndRestore(JSON.stringify(downloadMarker), '/^Export of 3 photos stopped after 1\\./');
    await waitFor('resumed downloads written', `window.__hjSaves.downloads.length === 2 && window.__hjSaves.downloads.every(d => d.bytes)
      && localStorage.getItem('${MARKER_KEY}') === null && !document.querySelector('.loading-overlay.visible')`, 240_000);
    const resumedDownloads = [];
    for (let i = 0; i < 2; i++) {
      resumedDownloads.push(decodeTiff(await evaluate(`window.__hjSaves.downloads[${i}].name`), await pullBytes(evaluate, `window.__hjSaves.downloads[${i}].bytes`)));
    }
    console.log('hidden-job resume downloads, resumed:', JSON.stringify(resumedDownloads));
    const firstWritten = downloadMarker.files[downloadMarker.written[0][0]].output;
    const missing = originalDownloads.filter(entry => entry.name !== firstWritten).map(entry => entry.name);
    if (JSON.stringify(resumedDownloads.map(entry => entry.name)) !== JSON.stringify(missing)) {
      fail('the resumed downloads must be the missing frames, under their names: ' + JSON.stringify(resumedDownloads.map(entry => entry.name)));
    }
    sameFrames('resumed downloads', resumedDownloads, originalDownloads);
    const afterDownloads = await controls();
    if (JSON.stringify(afterDownloads) !== JSON.stringify(downloadControls)) fail('the resume changed the controls: ' + JSON.stringify(afterDownloads));
    console.log('ok: downloads killed after frame 1 resume the missing frames with the job\'s format, dust removal and edge markings: same names, same pixels');
  } finally {
    await evaluate(`(() => {
      window.__hjSaves?.stop();
      localStorage.removeItem('nc_auto_roll_import_v1');
      localStorage.removeItem('nc_batch_lanes_v1');
    })()`);
    rmSync(dir, { recursive: true, force: true });
  }
}
