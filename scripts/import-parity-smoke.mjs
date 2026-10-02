// Opt-in settings and export parity for the convert-first import (#236).
// The RAW files are not in the repository, so the reference values are
// recorded from a HEAD build and compared on this one:
//
//   # on a checkout of the reference commit, with this branch's scripts/ copied in
//   IMPORT_PARITY_FILES=/raw/_DSC3111.NEF:/raw/L1009967.dng IMPORT_PARITY_OUT=head.json \
//     node scripts/smoke-test.mjs --import-parity-only
//   # on this branch
//   IMPORT_PARITY_FILES=/raw/_DSC3111.NEF:/raw/L1009967.dng IMPORT_PARITY_BASELINE=head.json \
//     node scripts/smoke-test.mjs --import-parity-only
//
// For each file (one fresh import each) it records the settled recipe the
// app saves for the photo (a saved project's settings, i.e.
// extractCurrentSettings after settling) and the parity digests of its 8- and
// 16-bit PNG and TIFF exports and of a JPEG export (export-parity-digest.mjs:
// PNG by decoded samples, IHDR and metadata chunks, so #257's flagged PNG16
// band stream compares equal; TIFF by file; JPEG by the decoded primary, its
// metadata and the gain-map bytes), then fails on any difference from the
// baseline. A baseline recorded before R1-100 (whole-file hashes) is refused:
// record it again on the reference build. Record and compare with the same
// Chrome: the JPEG and its gain map come out of its encoder.
//
// Flagged #229 changes (issues/229.md, "Constraints for every child") that a
// 1703835 baseline cannot match are excluded per file, never by default:
// IMPORT_PARITY_FLAGGED='<file>=<flag>[+<flag>],...' names the file and the
// flag that moves it, for example the M11 frames #231 types inverted B&W
// ('L1009967.dng=#231') or a photo larger than the display, whose auto WB
// #248 estimates on another sample ('_DSC3111.NEF=#248'). FLAGGED_CHANGES
// below says what each flag leaves out and what it still checks; the run
// prints every exclusion and whether anything it left out differed. Photos
// that fit the display need none. #251 part 4b (flagged, with a kill switch) is
// switched off for every run, so the frame detector reads what 1703835 read.
// #264's decoder rebuild is not in effect while libraw-wasm is 1.6.0; once it
// ships, RAW baselines from 1703835 no longer apply.
// Large files are heavy: run one 60 MP file at a time on a 16 GB machine.
//
// IMPORT_PARITY_CROP_DURING_SEMANTIC=1 (R1-037): the semantic colour worker's
// answer is held while crop mode is opened and cancelled (several 200 ms poll
// ticks), then released, so the map lands after a crop mode the user left.
// 1703835 checked only before and after the inference and applied it.
//
// IMPORT_PARITY_EXPIRED=1 (R1-085): each file is imported into an expired-roll
// session (the rescue entry), with Auto Frame off so the frame detector (#251,
// flagged) stays out of the comparison. The settled recipe then holds the
// rescue's measurement (expiredAnalysis with its fog surface, the strengths
// it set, the semantic map). PNG16 file bytes differ by #257's stream; TIFF16
// compares the same 16-bit pixels.
//
// Recipes the light-table lane makes (#229 review, #247). Both modes compare
// the saved project's recipes of every file and the SHA-256 of each file an
// Export All writes (PNG8, TIFF8, TIFF16), so the frames nobody opened are
// exported with the recipes the lane gave them. #251 part 4b (the neutral line
// search, flagged) is switched off for the detector to read what 1703835 read.
// IMPORT_PARITY_LANE=1 (R1-081): the listed files are imported together, with
// Auto Frame on (its straighten is the point: 8-bit JPEGs tilted by a few
// tenths of a degree to a few degrees); the first opens, the others get their
// recipes from the lane and are never opened. With IMPORT_PARITY_EXPIRED=1 the
// session is an expired-roll one (Auto Frame stays on).
// IMPORT_PARITY_WATCH=1 (R1-082, R1-124): the desktop IPC is stubbed before
// the app boots, so 'Watch a folder…' exists; the first file opens with the
// picker, the folder watch starts and the other files (under 1 MiB, one read
// each) arrive through it at once. Once their tiles are ready the stub is
// removed and the recipes and exports take the browser's download path.
// Auto Frame stays on; with IMPORT_PARITY_EXPIRED=1 the session is an
// expired-roll one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PAGE_EXPORT_DIGEST } from './export-parity-digest.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioDetecting`;

const CAPTURE = `(() => {
  ${PAGE_EXPORT_DIGEST};
  window.showSaveFilePicker = undefined;
  window.__parityDownloads = [];
  const pending = new Set();
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return;
    const href = this.href, name = this.download;
    pending.add(href);
    window.__parityDownloads.push(fetch(href).then(r => r.blob()).then(async blob => {
      pending.delete(href); revoke(href);
      const bytes = await blob.arrayBuffer();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const text = /json/.test(blob.type) ? new TextDecoder().decode(bytes) : null;
      // What the parity check compares (export-parity-digest.mjs); sha256 is the file's.
      const parity = text === null ? await window.__ncExportDigest(new Uint8Array(bytes)) : null;
      return { name, size: bytes.byteLength, sha256: digest, text, parity };
    }));
  };
})()`;

// Holds the semantic worker's answers (the analyzer sets `onmessage`) until
// release(); a worker terminated meanwhile never answers.
const SEMANTIC_HOLD = `(() => {
  const hold = window.__paritySemantic = { on: true, created: 0, terminated: 0, delivered: 0, queued: [] };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (!/semanticWorker/.test(String(url))) return;
      hold.created++;
      let handler = null, ended = false;
      Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: fn => { handler = fn; } });
      this.addEventListener('message', event => {
        const deliver = () => { if (!ended && handler) { hold.delivered++; handler.call(this, event); } };
        if (hold.on) hold.queued.push(deliver); else deliver();
      });
      const terminate = this.terminate.bind(this);
      this.terminate = () => { ended = true; hold.terminated++; terminate(); };
    }
  };
  hold.release = () => { hold.on = false; for (const deliver of hold.queued.splice(0)) deliver(); };
})()`;

function differences(expected, actual, path = '') {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap(key => differences(expected[key], actual[key], path ? `${path}.${key}` : key));
  }
  return [`${path}: ${JSON.stringify(expected)?.slice(0, 120)} -> ${JSON.stringify(actual)?.slice(0, 120)}`];
}

// What a flag leaves out for the files IMPORT_PARITY_FLAGGED names (paths in
// the baseline row; a path covers what is under it), and what it still
// checks. Each key is the flag's issue in issues/229.md.
const EXPORT_PIXELS = ['png8.samples', 'png16.samples', 'tiff8.file', 'tiff16.file', 'jpeg8.pixels', 'jpeg8.gainMap', 'jpeg8.metadata']
  .map(path => 'exports.' + path);
const FLAGGED_CHANGES = {
  '#231': {
    flag: 'rebate-less monochrome frames default to inverted B&W',
    // The frame converts in another mode: its whole recipe and every export
    // move. The flagged outcome itself is still checked.
    leaves: ['settings', 'exports'],
    check: (reference, row) => (row.settings.filmType === 'bw' && reference.settings.filmType !== 'bw'
      ? null : `not the flagged retype to B&W (filmType ${reference.settings.filmType} -> ${row.settings.filmType})`)
  },
  '#248': {
    flag: 'the auto-WB sample no longer depends on the viewport',
    // A photo larger than the display: the semantic anchors and the auto-WB
    // gains are estimated on the 1024 px sample, and every export's pixels
    // follow the gains (the JPEG's container XMP names the gain map's
    // length). The rest of the recipe and every export's size, bit depth and
    // PNG chunks still compare.
    leaves: ['semanticMap', 'wbR', 'wbG', 'wbB', 'wbAutoConfidence', 'wbSemanticApplied'].map(key => 'settings.' + key).concat(EXPORT_PIXELS)
  }
};

function flaggedChanges(files, fail) {
  const flagged = new Map();
  for (const item of (process.env.IMPORT_PARITY_FLAGGED || '').split(',').map(text => text.trim()).filter(Boolean)) {
    const [file, flags = ''] = item.split('=');
    if (!files.some(path => basename(path) === file)) fail(`IMPORT_PARITY_FLAGGED names ${file}, which IMPORT_PARITY_FILES does not list`);
    for (const flag of flags.split('+')) {
      if (!FLAGGED_CHANGES[flag]) fail(`IMPORT_PARITY_FLAGGED: ${flag || 'no flag'} for ${file} is not one of ${Object.keys(FLAGGED_CHANGES).join(', ')}`);
      flagged.set(file, [...(flagged.get(file) || []), flag]);
    }
  }
  return flagged;
}

// The baseline differences of one file, without what its flags leave out.
function parityDifferences(name, reference, row, flags, fail) {
  const lines = [...differences(reference.settings, row.settings).map(line => 'settings.' + line),
    ...differences(reference.exports, row.exports).map(line => 'exports.' + line)];
  const leftOut = new Set();
  for (const key of flags) {
    const change = FLAGGED_CHANGES[key];
    const problem = change.check?.(reference, row);
    if (problem) fail(`${name}: ${key} (${change.flag}): ${problem}`);
    const covered = lines.filter(line => change.leaves.some(path => line.startsWith(path + ':') || line.startsWith(path + '.')));
    covered.forEach(line => leftOut.add(line));
    console.log(`import parity: ${name}: ${key} (${change.flag}) leaves out ${change.leaves.join(', ')}; `
      + (covered.length ? `${covered.length} of those differ, e.g. ${covered[0]}` : 'none of those differ, the exclusion is not needed'));
  }
  return lines.filter(line => !leftOut.has(line));
}

export async function runImportParitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port,
  files = (process.env.IMPORT_PARITY_FILES || '').split(':').filter(Boolean),
  baselinePath = process.env.IMPORT_PARITY_BASELINE, outPath = process.env.IMPORT_PARITY_OUT,
  cropDuringSemantic = process.env.IMPORT_PARITY_CROP_DURING_SEMANTIC === '1',
  expired = process.env.IMPORT_PARITY_EXPIRED === '1',
  lane = process.env.IMPORT_PARITY_LANE === '1', watch = process.env.IMPORT_PARITY_WATCH === '1' }) {
  if (!files.length) fail('IMPORT_PARITY_FILES lists no files');
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  if (lane || watch) {
    return runLaneRecipeParity({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, files, baseline, outPath, expired, watch });
  }
  const rows = [];
  const flagged = flaggedChanges(files, fail);
  const stale = baseline?.find(entry => entry.file && Object.values(entry.exports || {}).some(value => typeof value === 'string'));
  if (stale) fail(`the baseline entry for ${stale.file} holds whole-file hashes (recorded before R1-100): record it again on the reference build with this script`);
  // #251 part 4b (flagged): its kill switch is read at boot, and stays set in
  // this run's profile for every file below.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('parity boot', `!!document.getElementById('studioImportAutoCrop')`);
  await evaluate(`localStorage.setItem('nc_autoframe_neutral_lines_v1', 'off')`);
  for (const path of files) {
    if (!existsSync(path)) fail('parity file missing: ' + path);
    const name = basename(path);
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('parity boot', `!!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await wait(500);
    await evaluate(CAPTURE);
    if (cropDuringSemantic) await evaluate(SEMANTIC_HOLD);
    if (expired) {
      await evaluate(`(() => {
        const crop = document.getElementById('studioImportAutoCrop'); if (crop.checked) crop.click();
        const frame = document.getElementById('autoFrameEnabledInput');
        if (frame.checked) { frame.checked = false; frame.dispatchEvent(new Event('change', { bubbles: true })); }
        const label = document.getElementById('uploadExpiredBtn');
        label.addEventListener('click', event => event.preventDefault(), { once: true });
        label.click();
      })()`);
      if (!await evaluate(`document.body.classList.contains('studio-expired')`)) fail('the expired-roll entry did not switch the session');
    }
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [path], nodeId: input.result.nodeId });
    await waitFor('parity import ' + name, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`, 600_000);
    if (cropDuringSemantic) {
      const cropMode = `document.getElementById('canvasContainer').classList.contains('crop-mode')`;
      await waitFor('semantic inference started ' + name, `window.__paritySemantic.created > 0`, 120_000);
      await evaluate(`document.getElementById('cropBtn').click()`);
      await waitFor('crop mode during the inference', cropMode, 60_000);
      await wait(1000);
      await evaluate(`document.getElementById('cancelCropBtn').click()`);
      await waitFor('crop mode cancelled', `!${cropMode}`, 60_000);
      await wait(300);
      const hold = await evaluate(`(() => { const h = window.__paritySemantic; h.release(); return { created: h.created, terminated: h.terminated, delivered: h.delivered }; })()`);
      console.log('import parity: crop mode opened and cancelled during the semantic inference', JSON.stringify(hold));
    }
    // Background passes that may still change the recipe (semantic colour,
    // the rescue's fog surface).
    if (expired) {
      await waitFor('parity rescue measured ' + name, `document.getElementById('expiredDiagnosis').dataset.state === 'analysed'
        && [...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120_000);
    }
    await wait(expired ? 20_000 : 10_000);
    await waitFor('parity settled ' + name, ready, 120_000);
    const take = async label => {
      await waitFor(label, `window.__parityDownloads.length > 0`, 600_000);
      return evaluate(`window.__parityDownloads.shift()`);
    };
    await evaluate(`document.getElementById('studioSaveProject').click()`);
    const project = JSON.parse((await take('parity project ' + name)).text);
    const settings = project.files.find(file => file.name === name)?.settings;
    if (!settings) fail('saved project has no settings for ' + name);
    const exports = {};
    const fileHashes = {};
    for (const [format, depth] of [['png', 8], ['png', 16], ['tiff', 8], ['tiff', 16], ['jpeg', 8]]) {
      await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
      await wait(300);
      await evaluate(`document.getElementById('exportSingleBtn').click()`);
      const entry = await take(`parity export ${format}${depth} ${name}`);
      exports[`${format}${depth}`] = entry.parity;
      fileHashes[`${format}${depth}`] = entry.sha256.slice(0, 16);
      await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled`, 600_000);
    }
    const row = { file: name, settings, exports };
    if (cropDuringSemantic) row.semantic = await evaluate(`({ ...window.__paritySemantic, queued: undefined, release: undefined })`);
    rows.push(row);
    console.log('import parity:', name, JSON.stringify(exports), 'file SHA-256 (logged, not compared):', JSON.stringify(fileHashes));
    const reference = baseline?.find(entry => entry.file === name);
    if (baseline && !reference) fail('baseline has no entry for ' + name);
    if (reference) {
      const diff = parityDifferences(name, reference, row, flagged.get(name) || [], fail);
      if (diff.length) fail(`import parity differs for ${name}:\n${diff.join('\n')}`);
      console.log('ok: settled settings and 8/16-bit PNG/TIFF and JPEG exports match the baseline for', name,
        flagged.has(name) ? `(apart from what ${flagged.get(name).join(' and ')} leave out)` : '');
    }
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log('import parity written to', outPath);
  }
}

// Runs in the page before the app boots: a desktop IPC that knows the folder
// watch and answers everything else the boot asks with nothing.
const WATCH_STUB = `(() => {
  const w = window.__parityWatch = { calls: [], files: new Map(), handler: null, session: 'parity-watch' };
  window.__TAURI__ = {
    core: { invoke: async (command, args = {}) => {
      w.calls.push(command);
      if (command === 'watch_import_folder') return { session: w.session, path: '/parity/watched' };
      if (command === 'read_import_file') {
        const bytes = w.files.get(args.path);
        if (!bytes || args.session !== w.session) throw new Error('unknown watched file ' + args.path);
        return bytes.slice(args.offset).buffer;
      }
      if (command === 'display_proxy_list') return [];
      if (command === 'display_proxy_space') return { freeBytes: 0, totalBytes: 0 };
      return null;
    } },
    event: { listen: async (name, handler) => {
      if (name === 'import-folder-file') w.handler = handler;
      return () => { if (w.handler === handler) w.handler = null; };
    } }
  };
  w.remove = () => { delete window.__TAURI__; };
})()`;

async function runLaneRecipeParity({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, files, baseline, outPath, expired, watch }) {
  const names = files.map(path => basename(path));
  for (const path of files) if (!existsSync(path)) fail('parity file missing: ' + path);
  if (watch) {
    if (files.length < 2) fail('the watch mode opens the first file and watches the others arrive');
    for (const path of files.slice(1)) if (readFileSync(path).length >= 1024 * 1024) fail('a watched file must be under 1 MiB (one read): ' + path);
    await send('Page.addScriptToEvaluateOnNewDocument', { source: WATCH_STUB });
  }
  // The detector's #251 part 4b input is read at boot.
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('parity boot', `!!document.getElementById('studioImportAutoCrop')`);
  await evaluate(`localStorage.setItem('nc_autoframe_neutral_lines_v1', 'off')`);
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('parity boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await wait(500);
  await evaluate(CAPTURE);
  const setup = await evaluate(`(() => {
    const crop = document.getElementById('studioImportAutoCrop'); if (!crop.checked) crop.click();
    const frame = document.getElementById('autoFrameEnabledInput');
    if (!frame.checked) { frame.checked = true; frame.dispatchEvent(new Event('change', { bubbles: true })); }
    if (${expired}) {
      const label = document.getElementById('uploadExpiredBtn');
      label.addEventListener('click', event => event.preventDefault(), { once: true });
      label.click();
    }
    return { autoCrop: crop.checked, autoFrame: frame.checked, watchButton: !!document.getElementById('studioWatchFolder') };
  })()`);
  if (expired) await waitFor('the expired-roll session', `document.body.classList.contains('studio-expired')`, 10_000);
  if (watch && !setup.watchButton) fail('the stubbed desktop shows no Watch a folder entry');
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: watch ? [files[0]] : files, nodeId: input.result.nodeId });
  await waitFor('parity import ' + names[0], `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(names[0])}`, 600_000);
  if (watch) {
    await evaluate(`document.getElementById('studioWatchFolder').click()`);
    await waitFor('folder watch started', `window.__parityWatch.calls.includes('watch_import_folder') && !!window.__parityWatch.handler`, 30_000);
    await wait(500);
    for (const path of files.slice(1)) {
      const name = basename(path);
      const bytes = readFileSync(path).toString('base64');
      await evaluate(`(() => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0));
        window.__parityWatch.files.set('/parity/watched/' + ${JSON.stringify(name)}, bytes);
      })()`);
    }
    // One sampler scan: every arrival within a few milliseconds.
    await evaluate(`(() => {
      const w = window.__parityWatch;
      for (const [path, bytes] of w.files) {
        w.handler({ payload: { name: path.split('/').pop(), size: bytes.length, path, session: w.session, modified: '1700000000000000000' } });
      }
    })()`);
  }
  const rows = `[...document.querySelectorAll('#fileListItems .file-list-name')]`;
  await waitFor('every tile ready', `${ready} && ${rows}.length === ${names.length} && ${rows}.every(row => row.dataset.previewState === 'ready')`, 600_000);
  if (expired) {
    await waitFor('parity rescue measured ' + names[0], `document.getElementById('expiredDiagnosis').dataset.state === 'analysed'
      && [...document.querySelectorAll('#expiredDiagnosis li')].some(li => /^Uneven fog:/.test(li.textContent))`, 120_000);
  }
  await wait(expired ? 20_000 : 10_000);
  await waitFor('parity settled', `${ready} && ${rows}.every(row => row.dataset.previewState === 'ready')`, 120_000);
  const open = await evaluate(`document.getElementById('studioFilename').textContent`);
  if (open !== names[0]) fail('another photo was opened: ' + open);
  let desktop = null;
  if (watch) desktop = await evaluate(`(() => { const calls = [...new Set(window.__parityWatch.calls)]; window.__parityWatch.remove(); return calls; })()`);
  const take = async label => {
    await waitFor(label, `window.__parityDownloads.length > 0`, 600_000);
    return evaluate(`window.__parityDownloads.shift()`);
  };
  await evaluate(`document.getElementById('studioSaveProject').click()`);
  const project = JSON.parse((await take('parity project')).text);
  const settings = {};
  for (const name of names) {
    settings[name] = project.files.find(file => file.name === name)?.settings;
    if (!settings[name]) fail('saved project has no settings for ' + name);
  }
  const exports = {};
  for (const [format, depth] of [['png', 8], ['tiff', 8], ['tiff', 16]]) {
    await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
    await wait(300);
    await evaluate(`document.getElementById('exportAllBtn').click()`);
    for (let i = 0; i < names.length; i++) {
      const entry = await take(`parity Export All ${format}${depth} (${i + 1}/${names.length})`);
      exports[`${entry.name} ${format}${depth}`] = entry.sha256;
    }
    await waitFor('Export All settled', `${ready} && !document.getElementById('exportAllBtn').disabled`, 600_000);
    await wait(500);
  }
  const mode = watch ? 'watch' : 'lane';
  const row = { mode, expired, files: names, settings, exports, desktop };
  const geometry = Object.fromEntries(names.map(name => [name, { rotationAngle: settings[name].rotationAngle, cropRegion: settings[name].cropRegion,
    expired: Boolean(settings[name].expiredAnalysis), wb: [settings[name].wbR, settings[name].wbG, settings[name].wbB, settings[name].wbAutoConfidence] }]));
  console.log(`import parity (${mode}${expired ? ', expired' : ''}):`, JSON.stringify({ geometry, exports, desktop }));
  if (outPath) {
    writeFileSync(outPath, JSON.stringify([row], null, 2));
    console.log('import parity written to', outPath);
  }
  const reference = baseline?.find(entry => entry.mode === mode && entry.expired === expired);
  if (baseline && !reference) fail(`baseline has no ${mode} entry`);
  if (reference) {
    const diff = [...differences(reference.settings, settings).map(line => 'settings.' + line),
      ...differences(reference.exports, exports).map(line => 'exports.' + line)];
    if (diff.length) fail(`import parity (${mode}) differs:\n${diff.join('\n')}`);
    console.log(`ok: recipes and Export All PNG8/TIFF8/TIFF16 match the baseline (${mode}${expired ? ', expired' : ''})`);
  }
}
