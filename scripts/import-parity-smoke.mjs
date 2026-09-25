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
  baselinePath = process.env.IMPORT_PARITY_BASELINE, outPath = process.env.IMPORT_PARITY_OUT }) {
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
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [path], nodeId: input.result.nodeId });
    await waitFor('parity import ' + name, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`, 600_000);
    // Background passes that may still change the recipe (semantic colour).
    await wait(10_000);
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
