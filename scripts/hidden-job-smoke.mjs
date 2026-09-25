// Hidden-window jobs (#241), on the real app with small fixtures:
//
// 1. A desktop batch (Tauri IPC stubbed) that includes a never-analysed frame
//    completes with requestAnimationFrame never firing and the page hidden,
//    and the blocking loading overlay never shows. Hiding the window while
//    the batch waits for its first frame sheds the photo caches, idle workers
//    and the MI-GAN session at once (the macOS WebKit limits are forced), and
//    leaves aiRepair.revision alone.
// 2. A 3-frame contact sheet completes in a hidden browser page without rAF.
// 1a. With parking turned on, parking the open photo in a hidden window and
//    showing the window again rebuilds it from the kept base without a
//    decode, and its export is byte-identical to the export before parking.
//    Parking is off by default until #241's footprint measurement; this step
//    reports a WARN line instead of failing, and that line means: keep it off.
// 3. A desktop batch "killed" after its first frame (its job marker restored,
//    the page reloaded) names the job at boot; after the originals are added
//    again and the recovery copy restored, Resume writes only the missing
//    frames, under the original names, with the pixels of the uninterrupted run.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const FIXTURES = ['negative-textured.png', 'negative-vignetted.png', 'negative-plain.png'];
const MARKER_KEY = 'nc_job_marker_export_v1';

// Runs in the page: a desktop IPC stub whose folder lives in sessionStorage,
// so it survives the reload of scenario 3.
function installDesktopStub() {
  const saved = JSON.parse(sessionStorage.getItem('__hjFolder') || '{}');
  const p = window.__hjDesktop = { calls: [], begins: [], files: saved, streams: new Map(), exists: [], next: 1,
    markerAtSecondBegin: null, original: window.__TAURI__ };
  const fnv = bytes => { let h = 2166136261; for (const b of bytes) h = Math.imul(h ^ b, 16777619); return (h >>> 0).toString(16); };
  window.__TAURI__ = { core: { invoke: async function (command, args = {}, options = {}) {
    p.calls.push(command);
    if (command === 'pick_export_directory') return '/virtual/Scans';
    if (command === 'take_web_content_termination') return null;
    // A new import stops any folder watch first.
    if (command === 'stop_watch_import_folder') return null;
    if (command === 'begin_export_write') {
      if (!args.directory || !args.suggestedName) throw new Error('unexpected export destination');
      p.begins.push(args.suggestedName);
      if (p.begins.length === 2) p.markerAtSecondBegin = localStorage.getItem('nc_job_marker_export_v1');
      const id = String(p.next++);
      p.streams.set(id, { name: args.suggestedName, directory: args.directory, chunks: [], expected: args.expectedBytes });
      return id;
    }
    if (command === 'append_export_chunk') {
      // Called as invoke(command, bytes, { headers }): the chunk is the payload.
      const id = options?.headers?.['x-export-id'];
      p.streams.get(id).chunks.push(new Uint8Array(args).slice());
      return;
    }
    if (command === 'finish_export_write') {
      const stream = p.streams.get(args.id);
      p.streams.delete(args.id);
      const bytes = new Uint8Array(await new Blob(stream.chunks).arrayBuffer());
      if (bytes.length !== stream.expected) throw new Error('incomplete export');
      const path = stream.directory + '/' + stream.name;
      p.files[path] = fnv(bytes);
      sessionStorage.setItem('__hjFolder', JSON.stringify(p.files));
      return { saved: true, path };
    }
    if (command === 'abort_export_write') { p.streams.delete(args.id); return; }
    if (command === 'exported_files_exist') {
      p.exists.push(args.paths);
      return args.paths.map(path => Object.prototype.hasOwnProperty.call(p.files, path));
    }
    throw new Error('Unexpected desktop command: ' + command);
  } } };
}

// Captures single exports as FNV hashes of their bytes; counts file reads.
function installExportCapture() {
  const p = window.__hjExports = { hashes: [], reads: 0, watch: null, anchor: HTMLAnchorElement.prototype.click, read: File.prototype.arrayBuffer };
  const fnv = bytes => { let h = 2166136261; for (const b of bytes) h = Math.imul(h ^ b, 16777619); return (h >>> 0).toString(16); };
  HTMLAnchorElement.prototype.click = function (...args) {
    if (!this.download || !this.href.startsWith('blob:')) return p.anchor.apply(this, args);
    const name = this.download;
    fetch(this.href).then(response => response.arrayBuffer())
      .then(buffer => { p.hashes.push({ name, hash: fnv(new Uint8Array(buffer)) }); });
  };
  File.prototype.arrayBuffer = function (...args) { if (this.name === p.watch) p.reads += 1; return p.read.apply(this, args); };
  p.stop = () => { HTMLAnchorElement.prototype.click = p.anchor; File.prototype.arrayBuffer = p.read; };
}

function removeDesktopStub() {
  const p = window.__hjDesktop;
  if (!p) return;
  if (p.original === undefined) delete window.__TAURI__; else window.__TAURI__ = p.original;
}

// rAF never fires and the page reads as hidden, as in a minimised window.
function installHiddenPage() {
  const h = window.__hjHidden = { raf: window.requestAnimationFrame, overlaySeen: false };
  window.requestAnimationFrame = () => 0;
  h.observer = new MutationObserver(() => {
    if (document.querySelector('.loading-overlay.visible')) h.overlaySeen = true;
  });
  h.observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
  h.hide = () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  h.restore = () => {
    h.observer.disconnect();
    window.requestAnimationFrame = h.raf;
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  };
}

export async function runHiddenJobSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const paths = FIXTURES.map(name => join(root, 'negative2positive', 'test-fixtures', name));
  const boot = async ({ autoAccept = true } = {}) => {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
    await waitFor('hidden-job workspace boot', `performance.timeOrigin !== ${origin} && document.readyState === 'complete'
      && !!document.getElementById('studioImportAutoCrop') && !!window.__ncHiddenJobs?.forgetFrameSettings`);
    if (autoAccept) await installDialogAutoAccept();
  };
  const importFixtures = async () => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    await waitFor('three negatives converted with previews', `${ready} && document.querySelectorAll('.file-list-name').length === 3
      && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === 3`, 180_000);
  };

  await boot();
  await evaluate(`(() => {
    localStorage.setItem('nc_auto_roll_import_v1', 'off');
    localStorage.setItem('nc_batch_lanes_v1', '1');
    localStorage.setItem('nc_hidden_job_limits_v1', 'force');
    localStorage.removeItem('${MARKER_KEY}');
    sessionStorage.removeItem('__hjFolder');
    const crop = document.getElementById('studioImportAutoCrop');
    if (crop && !crop.checked) crop.click();
  })()`);
  try {
    await importFixtures();

    // ---- 1a. Park and rebuild the open photo (opt-in part 2e) ----
    await evaluate(`(() => { localStorage.setItem('nc_hidden_park_v1', 'on'); (${installExportCapture.toString()})();
      document.getElementById('exportSingleBtn').click(); })()`);
    await waitFor('export before parking', `window.__hjExports.hashes.length === 1 && !document.getElementById('exportSingleBtn').disabled`, 120_000);
    const parked = await evaluate(`(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      const parked = window.__ncHiddenJobs.parkOpenPhoto();
      const residentBytes = window.__ncHiddenJobs.status().residentBytes;
      window.__hjExports.watch = '${FIXTURES[0]}';
      delete document.visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
      return { parked, residentBytes };
    })()`);
    const parkWarnings = [];
    if (!parked.parked) parkWarnings.push('the settled open photo could not be parked');
    await waitFor('parked photo rebuilt', `${ready} && document.getElementById('studioFilename').textContent === '${FIXTURES[0]}'`, 60_000);
    await wait(1500);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await waitFor('export after parking', `window.__hjExports.hashes.length === 2 && !document.getElementById('exportSingleBtn').disabled`, 120_000);
    const park = await evaluate(`(() => { const p = window.__hjExports; p.stop(); localStorage.removeItem('nc_hidden_park_v1'); return { hashes: p.hashes, reads: p.reads }; })()`);
    console.log('hidden-job park:', JSON.stringify({ ...park, residentBytes: parked.residentBytes }));
    if (park.hashes[0]?.name !== park.hashes[1]?.name || park.hashes[0]?.hash !== park.hashes[1]?.hash) parkWarnings.push('the rebuilt photo does not export byte-identically: ' + JSON.stringify(park.hashes));
    if (park.reads !== 0) parkWarnings.push('rebuilding decoded the file again: ' + park.reads + ' read(s)');
    if (parkWarnings.length) console.log('WARN hidden-job park (opt-in part 2e, keep nc_hidden_park_v1 off): ' + parkWarnings.join('; '));
    else console.log('ok: parking the open photo keeps only its base, and the rebuilt photo exports byte-identically without a decode');

    // ---- 1. Hidden desktop batch with a never-analysed frame ----
    // A photo switch fills the session and preview caches first.
    await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
    await waitFor('second photo open', `${ready} && document.getElementById('studioFilename').textContent === '${FIXTURES[1]}'`, 60_000);
    await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
    await waitFor('first photo open again', `${ready} && document.getElementById('studioFilename').textContent === '${FIXTURES[0]}'`, 60_000);
    await waitFor('photo caches filled', `window.__ncHiddenJobs.status().photoSessionBytes > 0`, 30_000);
    // An eager MI-GAN load (or its failure) must have settled first.
    await waitFor('MI-GAN load settled', `window.__ncHiddenJobs.status().aiRepairStatus !== 'loading'`, 120_000);
    const before = await evaluate(`window.__ncHiddenJobs.status()`);
    const forgot = await evaluate(`window.__ncHiddenJobs.forgetFrameSettings(2)`);
    if (!forgot) fail('could not make frame 3 never-analysed');
    await evaluate(`(${installDesktopStub.toString()})(); (${installHiddenPage.toString()})();`);
    // Visible, with rAF stubbed: the batch starts and waits for a frame that never comes.
    await evaluate(`document.getElementById('exportAllBtn').click()`);
    await waitFor('desktop batch started', `document.getElementById('headerExportProgress').classList.contains('visible')`, 10_000);
    await wait(300);
    const stalled = await evaluate(`window.__hjDesktop.begins.length`);
    if (stalled !== 0) fail('the visible batch should still wait for its first paint: ' + stalled);
    // Hiding the window releases that wait and sheds memory synchronously.
    const shed = await evaluate(`(() => { window.__hjHidden.hide(); return window.__ncHiddenJobs.status(); })()`);
    console.log('hidden-job shed:', JSON.stringify({ before: { sessions: before.photoSessionBytes, previews: before.photoPreviewBytes, revision: before.aiRepairRevision }, after: shed }));
    if (shed.photoSessionBytes !== 0 || shed.photoPreviewBytes !== 0) fail('hiding during a job must clear the photo caches: ' + JSON.stringify(shed));
    if (shed.sensorDefectsWorkerAlive || shed.aiRepairSession) fail('hiding during a job must release idle workers and MI-GAN: ' + JSON.stringify(shed));
    if (shed.aiRepairRevision !== before.aiRepairRevision) fail('shedding MI-GAN must keep aiRepair.revision');
    if (!shed.hidden || !shed.limited) fail('the forced WebKit limits did not apply: ' + JSON.stringify(shed));
    await waitFor('hidden desktop batch finished', `window.__hjDesktop.begins.length === 3 && !window.__hjDesktop.streams.size
      && !document.getElementById('headerExportProgress').classList.contains('visible')`, 180_000);
    // The job's last release sheds its idle export worker; the thumbnail lane
    // may run one more gated item first.
    await waitFor('hidden window idle', `(() => { const s = window.__ncHiddenJobs.status();
      return !s.inFlight && !s.waiting && !s.exportWorkerAlive && !s.sensorDefectsWorkerAlive && !s.aiRepairSession; })()`, 60_000);
    const batch = await evaluate(`({ begins: window.__hjDesktop.begins, files: Object.keys(window.__hjDesktop.files),
      overlaySeen: window.__hjHidden.overlaySeen, status: window.__ncHiddenJobs.status(),
      marker: localStorage.getItem('${MARKER_KEY}') })`);
    console.log('hidden-job batch:', JSON.stringify(batch));
    if (batch.overlaySeen) fail('the blocking loading overlay appeared during the desktop batch');
    if (batch.files.length !== 3 || batch.files.some(path => /_1\.png$/.test(path))) fail('hidden batch did not write three distinct frames: ' + JSON.stringify(batch.files));
    if (batch.status.aiRepairRevision !== before.aiRepairRevision) fail('a hidden batch changed aiRepair.revision');
    if (batch.marker !== null) fail('a finished batch must delete its job marker');
    console.log('ok: a hidden desktop batch with a never-analysed frame completes without rAF or the blocking overlay, and hiding sheds caches and idle workers');

    // ---- 2. Hidden 3-frame contact sheet (browser path) ----
    await evaluate(`(() => {
      ${removeDesktopStub.toString()}; removeDesktopStub();
      window.__ncHiddenJobs.forgetFrameSettings(2);
      const p = window.__hjSheet = { names: [], anchor: HTMLAnchorElement.prototype.click };
      HTMLAnchorElement.prototype.click = function (...args) {
        if (this.download && this.href.startsWith('blob:')) { p.names.push(this.download); return; }
        return p.anchor.apply(this, args);
      };
      document.getElementById('exportContactSheetBtn').click();
    })()`);
    await waitFor('hidden contact sheet saved', `window.__hjSheet.names.length === 1`, 180_000);
    const sheet = await evaluate(`(() => { const p = window.__hjSheet; HTMLAnchorElement.prototype.click = p.anchor; return p.names; })()`);
    if (!/^contact-sheet-.*\.png$/.test(sheet[0])) fail('contact sheet name wrong: ' + sheet[0]);
    console.log('ok: a 3-frame contact sheet completes in a hidden page without rAF');
  } finally {
    await evaluate(`(() => { window.__hjHidden?.restore(); ${removeDesktopStub.toString()}; removeDesktopStub(); })()`);
  }

  // ---- 3. Kill after the first frame, reload, restore, resume ----
  await evaluate(`localStorage.removeItem('nc_hidden_job_limits_v1')`);
  await waitFor('studio settled before the resume scenario', ready, 60_000);
  await evaluate(`(() => { sessionStorage.removeItem('__hjFolder'); (${installDesktopStub.toString()})(); document.getElementById('exportAllBtn').click(); })()`);
  await waitFor('uninterrupted desktop batch finished', `window.__hjDesktop.begins.length === 3 && !window.__hjDesktop.streams.size
    && !document.getElementById('headerExportProgress').classList.contains('visible')`, 180_000);
  const original = await evaluate(`({ begins: window.__hjDesktop.begins, files: window.__hjDesktop.files, marker: window.__hjDesktop.markerAtSecondBegin })`);
  const killedMarker = JSON.parse(original.marker || 'null');
  if (!killedMarker || killedMarker.written?.length !== 1 || killedMarker.files?.length !== 3) fail('the job marker did not record the first frame before the second began: ' + original.marker);
  // The recovery copy is debounced by 2.5 s after the last sink.
  await wait(3500);
  // The page dies after frame 1: only its file is in the folder, the marker stays.
  const firstPath = Object.keys(original.files).find(path => path.endsWith('/' + original.begins[0]));
  await evaluate(`(() => {
    localStorage.setItem('${MARKER_KEY}', ${JSON.stringify(original.marker)});
    sessionStorage.setItem('__hjFolder', JSON.stringify({ ${JSON.stringify(firstPath)}: ${JSON.stringify(original.files[firstPath])} }));
  })()`);
  await boot({ autoAccept: false });
  await waitFor('boot message names the interrupted job', `/Export of 3 photos to Scans stopped after 1\\./.test(document.querySelector('[data-app-dialog-message]')?.textContent || '')`, 15_000);
  console.log('hidden-job boot message:', await evaluate(`document.querySelector('[data-app-dialog-message]').textContent`));
  await evaluate(`document.querySelector('[data-app-dialog-confirm]').click()`);
  await installDialogAutoAccept();
  await evaluate(`(${installDesktopStub.toString()})()`);
  await importFixtures();
  await waitFor('recovery copy offered', `!document.getElementById('studioRestoreProject').hidden`, 30_000);
  await evaluate(`document.getElementById('studioRestoreProject').click()`);
  await waitFor('resumed batch finished', `window.__hjDesktop.begins.length === 2 && !window.__hjDesktop.streams.size
    && !document.getElementById('headerExportProgress').classList.contains('visible')
    && localStorage.getItem('${MARKER_KEY}') === null`, 180_000);
  const resumed = await evaluate(`({ begins: window.__hjDesktop.begins, files: window.__hjDesktop.files, exists: window.__hjDesktop.exists })`);
  console.log('hidden-job resume:', JSON.stringify({ original: original.begins, resumed: resumed.begins, exists: resumed.exists }));
  if (JSON.stringify(resumed.exists) !== JSON.stringify([[firstPath]])) fail('resume must check exactly the recorded frame: ' + JSON.stringify(resumed.exists));
  if (JSON.stringify(resumed.begins) !== JSON.stringify(original.begins.slice(1))) fail('resume must write only the missing frames, under their original names: ' + JSON.stringify(resumed.begins));
  for (const name of original.begins.slice(1)) {
    const path = Object.keys(original.files).find(entry => entry.endsWith('/' + name));
    if (resumed.files[path] !== original.files[path]) fail(`resumed ${name} differs from the uninterrupted run (${resumed.files[path]} vs ${original.files[path]})`);
  }
  await evaluate(`(() => {
    ${removeDesktopStub.toString()}; removeDesktopStub();
    sessionStorage.removeItem('__hjFolder');
    localStorage.removeItem('nc_auto_roll_import_v1');
    localStorage.removeItem('nc_batch_lanes_v1');
  })()`);
  console.log('ok: a killed desktop batch is named at boot and resumes only its missing frames, same names, same pixels');
}
