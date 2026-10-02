// Opt-in settings and export parity for the convert-first import (#236).
// The RAW files are not in the repository, so the reference values are
// recorded from a HEAD build and compared on this one:
//
//   # on a checkout of the reference commit, with this script copied in
//   IMPORT_PARITY_FILES=/raw/_DSC3111.NEF:/raw/L1009967.dng IMPORT_PARITY_OUT=head.json \
//     node scripts/smoke-test.mjs --import-parity-only
//   # on this branch
//   IMPORT_PARITY_FILES=/raw/_DSC3111.NEF:/raw/L1009967.dng IMPORT_PARITY_BASELINE=head.json \
//     node scripts/smoke-test.mjs --import-parity-only
//
// For each file (one fresh import each) it records the settled recipe the
// app saves for the photo (a saved project's settings, i.e.
// extractCurrentSettings after settling) and the SHA-256 of 8- and 16-bit
// PNG and TIFF exports, then fails on any difference from the baseline.
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioDetecting`;

const CAPTURE = `(() => {
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
      return { name, size: bytes.byteLength, sha256: digest, text };
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

export async function runImportParitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port,
  files = (process.env.IMPORT_PARITY_FILES || '').split(':').filter(Boolean),
  baselinePath = process.env.IMPORT_PARITY_BASELINE, outPath = process.env.IMPORT_PARITY_OUT,
  cropDuringSemantic = process.env.IMPORT_PARITY_CROP_DURING_SEMANTIC === '1',
  expired = process.env.IMPORT_PARITY_EXPIRED === '1' }) {
  if (!files.length) fail('IMPORT_PARITY_FILES lists no files');
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const rows = [];
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
    for (const [format, depth] of [['png', 8], ['png', 16], ['tiff', 8], ['tiff', 16]]) {
      await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
      await wait(300);
      await evaluate(`document.getElementById('exportSingleBtn').click()`);
      const entry = await take(`parity export ${format}${depth} ${name}`);
      exports[`${format}${depth}`] = entry.sha256;
      await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled`, 600_000);
    }
    const row = { file: name, settings, exports };
    if (cropDuringSemantic) row.semantic = await evaluate(`({ ...window.__paritySemantic, queued: undefined, release: undefined })`);
    rows.push(row);
    console.log('import parity:', name, JSON.stringify(exports));
    const reference = baseline?.find(entry => entry.file === name);
    if (baseline && !reference) fail('baseline has no entry for ' + name);
    if (reference) {
      const diff = [...differences(reference.settings, settings).map(line => 'settings.' + line),
        ...differences(reference.exports, exports).map(line => 'exports.' + line)];
      if (diff.length) fail(`import parity differs for ${name}:\n${diff.join('\n')}`);
      console.log('ok: settled settings and 8/16-bit PNG/TIFF exports match the baseline for', name);
    }
  }
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log('import parity written to', outPath);
  }
}
