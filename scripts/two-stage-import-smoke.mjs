// Two-stage RAW imports (#255) in a real browser, on small generated CFA
// DNGs (scripts/perf/fixtures.mjs) with the threshold forced to 1 MP
// (?twoStageMinMp=1) and stage 2 held or failed through ?debug=1 hooks.
// Every scenario of #255's parity criteria is compared with the same files
// decoded once (the flag off): the settled recipe (all of it), each photo's
// automaticDefaults (the automatic recipe learning compares edits with) and
// the exports in PNG 8, PNG 16, TIFF 16, JPEG and DNG. An export is compared
// by the SHA-256 of its decoded samples (PNG through the app's own decoder,
// the TIFF and DNG strips, the JPEG's primary image and gain map decoded by
// the browser) and by its file bytes, except after a roll analysis, whose
// roll id is new on every run.
// - export after the settle: a half-size stand-in (scale 0.5) shows first,
//   and the full decode is installed behind it without studioBusy;
// - export during stage 2, in each format: it waits, then matches. Such an
//   export (and the exports after a failed stage 2) freezes the recipe at its
//   click (exportSingle's manualEditRevision), before the photo's semantic
//   colour pass could answer: its reference is one decode exported the same
//   way, with that pass's answer held until the exports are written;
// - crop mode open when stage 2 lands: the swap waits for it to close, and
//   meanwhile the memory ledger (#258) counts the full decode with the open
//   photo;
// - stage 2 fails: a toast, the photo stays provisional, the export decodes
//   again;
// - switching away before stage 2 completes aborts it; Export All of both
//   photos (the left one never got a recipe);
// - Analyze roll clicked during stage 2, after an exposure edit on the
//   stand-in, waits for the full decode (#255 review R2-029); the edit comes
//   before the photo's semantic colour pass, in its reference too;
// - the paths a 60 MP file takes, on a 2800x1866 DNG with
//   ?largeImagePixels=2000000: the full decode counts as large (the >16 MP
//   rules: display-resolution conversions, a full-resolution render only for
//   exports) and is over the band pool's 4 MP (the export's conversion
//   bands), the stand-in (1.3 MP) is neither; for the settle and an export
//   during stage 2;
// - TIFF 16 and DNG exports clicked during stage 2 have the full decode's
//   width, height and 16-bit samples (#229 review R1-130);
// - a photo without a recipe opened from the prefetch slot (its base adopted)
//   and the same photo opened directly (two stages) give the same recipe,
//   automaticDefaults and exports (#229 review R1-062);
// - a failed stage 2 holds no background work: with three photos the other
//   two get their thumbnails while the open one stays provisional, nothing of
//   its stand-in is persisted, and an export then decodes again (#255 review
//   R2-033).
//
// TWO_STAGE_SCENES (comma-separated: settle, during, crop, crop-leave, crop-history, failure, leave,
// roll, adopt, failure-lanes) runs only those scenes.
//
// Opt-in, real files (never in the repo): TWO_STAGE_PARITY_FILES=/abs/a.DNG:/abs/b.dng
// runs the same scenarios for each file, with the second generated DNG as
// the other photo, at ?twoStageMinMp=TWO_STAGE_PARITY_MIN_MP (default 40, the
// flag's target). One 60 MP file at a time on a 16 GB machine.
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { writeSyntheticDng, previewSizes, stubJpeg, pack12, cfaValue } from './perf/fixtures.mjs';
import { installFrozenHistoryControl, runInterpretationHistoryCropSmoke } from './interpretation-history-smoke.mjs';

// A separate small CFA fixture with the clear, textured image window used by
// crop-apply-smoke. The benchmark scene's thin side rebate makes its window
// wider than the supported film ratios, so it cannot exercise a crop hit.
// Keep the ordinary synthetic scene (and all of its existing checks) intact.
function writeCropHitDng(path, size) {
  writeSyntheticDng(path, { ...size, seed: 19, kind: 'color' });
  const bytes = readFileSync(path), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = view.getUint32(4, true), count = view.getUint16(ifd, true);
  let strip = null;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (view.getUint16(entry, true) === 273) strip = view.getUint32(entry + 8, true);
  }
  if (strip === null) throw new Error('The generated CFA fixture has no strip');
  const row = new Uint16Array(size.width), sample = new Float64Array(3);
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const px = x * 1500 / size.width, py = y * 1000 / size.height;
      if (px < 150 || px >= 1350 || py < 120 || py >= 880) sample.set([232 / 255, 158 / 255, 92 / 255]);
      else {
        const n = (Math.floor(px / 6) * 6 * 13 + Math.floor(py / 6) * 6 * 29) % 90;
        sample.set([(40 + n) / 255, (22 + n / 2) / 255, (14 + n / 3) / 255]);
      }
      row[x] = cfaValue(sample, x, y);
    }
    pack12(row, bytes, strip + y * size.width * 3 / 2);
  }
  writeFileSync(path, bytes);
}

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioDetecting && !document.querySelector('.loading-overlay.visible')`;
const status = `window.__ncTwoStage.status()`;
const exact = `(() => { const s = ${status}; return !s.provisional && !s.pending && (s.fullDecode === null || s.fullDecode === 'installed'); })()`;

const CAPTURE = `(() => {
  window.showSaveFilePicker = undefined;
  window.__twoStageDownloads = [];
  const pending = new Set();
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
  const hex = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  // The samples, whatever the encoder did: tagged with their layout.
  const samples = (tag, width, height, parts) => {
    const head = new TextEncoder().encode(JSON.stringify([tag, width, height]) + '\\n');
    const all = new Uint8Array(head.length + parts.reduce((sum, part) => sum + part.byteLength, 0));
    all.set(head);
    let at = head.length;
    for (const part of parts) { all.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), at); at += part.byteLength; }
    return hex(all);
  };
  const jpegSamples = async (bytes, tag) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { tag, width: image.width, height: image.height, data: image.data };
  };
  // Where a JPEG's first image ends (its EOI), entropy-coded segments skipped.
  const jpegEnd = u8 => {
    let at = 2;
    while (at + 4 <= u8.length) {
      if (u8[at] !== 0xff) return -1;
      const marker = u8[at + 1];
      if (marker === 0xd9) return at + 2;
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { at += marker === 0xff ? 1 : 2; continue; }
      const length = (u8[at + 2] << 8) | u8[at + 3];
      at += 2 + length;
      if (marker !== 0xda) continue;
      while (at + 1 < u8.length && !(u8[at] === 0xff && u8[at + 1] !== 0x00 && !(u8[at + 1] >= 0xd0 && u8[at + 1] <= 0xd7))) at++;
    }
    return -1;
  };
  const tiffStrips = u8 => {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const ifd = view.getUint32(4, true);
    const tags = {};
    for (let i = 0, n = view.getUint16(ifd, true); i < n; i++) {
      const at = ifd + 2 + i * 12;
      const tag = view.getUint16(at, true), type = view.getUint16(at + 2, true), count = view.getUint32(at + 4, true);
      const size = type === 3 ? 2 : 4;
      const base = count * size <= 4 ? at + 8 : view.getUint32(at + 8, true);
      tags[tag] = Array.from({ length: count }, (_, k) => (type === 3 ? view.getUint16(base + k * 2, true) : view.getUint32(base + k * 4, true)));
    }
    const strips = tags[273].map((offset, k) => u8.subarray(offset, offset + tags[279][k]));
    return { width: tags[256][0], height: tags[257][0], bits: tags[258], photometric: tags[262]?.[0], strips };
  };
  const u8Tiff = bytes => { const u8 = new Uint8Array(bytes); return u8[0] === 73 && u8[1] === 73 && u8[2] === 42; };
  // Width, height and bit depth as the file states them.
  window.__twoStageLayout = bytes => {
    const u8 = new Uint8Array(bytes);
    if (u8[0] === 0x89 && u8[1] === 0x50) {
      const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      return { format: 'png', width: view.getUint32(16), height: view.getUint32(20), bits: [u8[24]] };
    }
    if (u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42) {
      const tiff = tiffStrips(u8);
      return { format: 'tiff', width: tiff.width, height: tiff.height, bits: tiff.bits, photometric: tiff.photometric };
    }
    return null;
  };
  window.__twoStageDecoded = async bytes => {
    const u8 = new Uint8Array(bytes);
    if (u8[0] === 0x89 && u8[1] === 0x50) {
      const { loadPngFile } = await import('/src/app/pngFileLoader.js');
      const image = loadPngFile(bytes);
      const plane = image.__image16;
      return plane ? samples('png16', image.width, image.height, [plane.data]) : samples('png8', image.width, image.height, [image.data]);
    }
    if (u8[0] === 0x49 && u8[1] === 0x49 && u8[2] === 42) {
      const tiff = tiffStrips(u8);
      return samples(['tiff', tiff.bits, tiff.photometric], tiff.width, tiff.height, tiff.strips);
    }
    if (u8[0] === 0xff && u8[1] === 0xd8) {
      // The primary image, then a gain map (MPF) stored after its EOI.
      const end = jpegEnd(u8);
      const images = [await jpegSamples(end > 0 ? u8.subarray(0, end) : u8, 'jpeg')];
      for (let at = Math.max(end, 2); end > 0 && at + 3 < u8.length; at++) {
        if (u8[at] === 0xff && u8[at + 1] === 0xd8 && u8[at + 2] === 0xff) { images.push(await jpegSamples(u8.subarray(at), 'gain map')); break; }
      }
      return samples(images.map(image => [image.tag, image.width, image.height]), images[0].width, images[0].height, images.map(image => image.data));
    }
    return 'unknown format';
  };
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return;
    const href = this.href, name = this.download;
    pending.add(href);
    window.__twoStageDownloads.push(fetch(href).then(r => r.arrayBuffer()).then(async bytes => {
      pending.delete(href); revoke(href);
      let lowBits = null;
      if (u8Tiff(bytes)) {
        const tiff = tiffStrips(new Uint8Array(bytes));
        if (tiff.bits.every(bits => bits === 16)) {
          lowBits = 0;
          for (const strip of tiff.strips) for (let i = 0; i + 1 < strip.length; i += 2) if ((strip[i] + strip[i + 1] * 256) % 257) lowBits++;
        }
      }
      return { name, size: bytes.byteLength, sha256: await hex(bytes), decoded: await window.__twoStageDecoded(bytes), layout: window.__twoStageLayout(bytes), lowBits };
    }));
  };
  window.__twoStageBusy = [];
  new MutationObserver(() => {
    if (window.__twoStageBusyWatch && document.body.dataset.studioBusy) window.__twoStageBusy.push(performance.now());
  }).observe(document.body, { attributes: true, attributeFilter: ['data-studio-busy'] });
  // Toasts come and go; keep every text shown.
  window.__twoStageToasts = [];
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      const toasts = node.classList?.contains('toast-message') ? [node] : [...node.querySelectorAll?.('.toast-message') || []];
      for (const toast of toasts) window.__twoStageToasts.push(toast.textContent);
    }
  }).observe(document.body, { childList: true, subtree: true });
})()`;

// Holds the semantic colour worker's answers (the analyzer sets `onmessage`)
// until release(); a pass whose recipe moved on meanwhile then drops them.
const SEMANTIC_HOLD = `(() => {
  const hold = window.__twoStageSemantic = { on: true, created: 0, delivered: 0, queued: [] };
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
      this.terminate = () => { ended = true; terminate(); };
    }
  };
  hold.release = () => { hold.on = false; for (const deliver of hold.queued.splice(0)) deliver(); };
})()`;
const releaseSemantic = `window.__twoStageSemantic?.release()`;

// The five export formats of the parity criteria.
const FORMATS = [['png', 8], ['png', 16], ['tiff', 16], ['jpeg', 8], ['dng', 16]];
const formatKey = ([format, depth]) => format === 'jpeg' || format === 'dng' ? format : `${format}${depth}`;
// A recipe compared whole. A roll analysis's id is new on every run.
const comparable = settings => {
  if (!settings?.rollFrame) return settings ?? null;
  const { rollId, ...rollFrame } = settings.rollFrame;
  return { ...settings, rollFrame };
};

export async function runTwoStageImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, onCdpEvent, port, root,
  parityFiles = (process.env.TWO_STAGE_PARITY_FILES || '').split(':').filter(Boolean) }) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-two-stage-'));
  await installFrozenHistoryControl({ send, onCdpEvent, root, fail });
  const importFiles = async paths => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
  };
  let captureOrigin = null;
  const navigations = [];
  onCdpEvent(message => {
    if (message.method === 'Page.frameNavigated' && !message.params?.frame?.parentId) {
      navigations.push(message.params.frame.url);
      if (navigations.length > 8) navigations.shift();
    }
  });
  const boot = async (query, { holdSemantic = false } = {}) => {
    const previous = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1${query}` });
    await waitFor('two-stage boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && !!window.__ncTwoStage`);
    await installDialogAutoAccept();
    await wait(800);
    await evaluate(CAPTURE);
    captureOrigin = await evaluate('performance.timeOrigin');
    if (holdSemantic) await evaluate(SEMANTIC_HOLD);
  };
  const take = async label => {
    const scope = await evaluate(`({ origin: performance.timeOrigin, href: location.href,
      captured: Array.isArray(window.__twoStageDownloads) })`);
    if (!scope.captured || scope.origin !== captureOrigin) fail(`${label}: download document changed: ${JSON.stringify({ captureOrigin, ...scope, navigations })}`);
    await waitFor(label, `window.__twoStageDownloads.length > 0`, 600_000);
    return evaluate(`window.__twoStageDownloads.shift()`);
  };
  const selectFormat = async ([format, depth]) => {
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      if (${JSON.stringify(format)} === 'png' || ${JSON.stringify(format)} === 'tiff') document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
    })()`);
    await wait(200);
  };
  const exportAs = async (format, label) => {
    await selectFormat(format);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    const entry = await take(label);
    await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled`, 600_000);
    return entry;
  };
  const exportFormats = async (label, formats = FORMATS) => {
    const out = {};
    for (const format of formats) out[formatKey(format)] = await exportAs(format, `${label} ${formatKey(format)}`);
    return out;
  };
  // Export All in each format, by file name: the queue order (and so the
  // download order) may differ.
  const exportAllFormats = async (count, label, formats = FORMATS) => {
    const out = {};
    for (const format of formats) {
      await selectFormat(format);
      await evaluate(`document.getElementById('exportAllBtn').click()`);
      const byName = {};
      for (let i = 0; i < count; i++) {
        const entry = await take(`${label} ${formatKey(format)} ${i + 1}/${count}`);
        byName[entry.name] = entry;
      }
      await waitFor('batch settled', `!document.querySelector('.loading-overlay.visible') && !document.getElementById('exportAllBtn').disabled`, 600_000);
      out[formatKey(format)] = Object.fromEntries(Object.entries(byName).sort(([a], [b]) => a.localeCompare(b)));
    }
    return out;
  };
  // The settled recipe, once background passes (semantic colour) are done.
  const settledRecipe = async () => {
    let previous = null;
    for (let i = 0; i < 20; i++) {
      await waitFor('recipe settled', `${ready} && ${exact} && !${status}.semanticPending`, 600_000);
      const settings = await evaluate(`JSON.stringify(${status}.settings)`);
      if (settings === previous) return comparable(JSON.parse(settings));
      previous = settings;
      await wait(1000);
    }
    fail('the recipe did not settle');
  };
  // Each photo's automaticDefaults, by name (the queue order may differ).
  const automaticDefaults = async () => {
    const all = JSON.parse(await evaluate(`JSON.stringify(${status}.automaticDefaults)`));
    return Object.fromEntries(Object.entries(all).sort(([x], [y]) => x.localeCompare(y)).map(([name, settings]) => [name, comparable(settings)]));
  };
  const differingKeys = (a, b) => [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
    .filter(key => JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key]));
  const same = (label, a, b) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    const keys = a && b && typeof a === 'object' && typeof b === 'object' ? differingKeys(a, b) : [];
    const detail = keys.length ? keys.map(key => `  ${key}: ${JSON.stringify(a?.[key])?.slice(0, 300)} | one decode: ${JSON.stringify(b?.[key])?.slice(0, 300)}`).join('\n')
      : `${JSON.stringify(a)?.slice(0, 600)}\n${JSON.stringify(b)?.slice(0, 600)}`;
    fail(`${label} differs from one full decode:\n${detail}`);
  };
  // `bytes: false` after a roll analysis (a new roll id in the metadata).
  const sameExport = (label, actual, expected, { bytes = true } = {}) => {
    if (!actual?.decoded || actual.decoded === 'unknown format') fail(`${label}: no decoded samples: ${JSON.stringify(actual)}`);
    if (actual.decoded !== expected.decoded) fail(`${label}: decoded samples differ from one full decode (${actual.decoded.slice(0, 12)} vs ${expected.decoded.slice(0, 12)})`);
    if (bytes && actual.sha256 !== expected.sha256) fail(`${label}: same samples, but the file bytes differ from one full decode (${actual.sha256.slice(0, 12)} vs ${expected.sha256.slice(0, 12)})`);
  };
  const sameExports = (label, actual, expected, options) => {
    const keys = Object.keys(actual);
    if (!keys.length || keys.some(key => !expected[key])) fail(`${label}: exports ${JSON.stringify(keys)}, one full decode ${JSON.stringify(Object.keys(expected))}`);
    for (const key of keys) sameExport(`${label}: ${key}`, actual[key], expected[key], options);
  };
  const lanesReady = `[...document.querySelectorAll('.file-list-name')].every(button => button.dataset.previewState === 'ready')`;
  const clickStrip = name => evaluate(`[...document.querySelectorAll('.file-list-name')].find(button => button.textContent.includes(${JSON.stringify(name)})).click()`);
  const filename = name => `document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`;
  const short = entries => Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key, entry.decoded ? entry.decoded.slice(0, 12) : short(entry)]));
  const editExposure = `(() => { const el = document.getElementById('coreExposure'); el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`;
  const rollCommitted = `window.__twoStageToasts.some(text => /Roll analysis:/.test(text))`;

  // The scenarios for photo `a` (and `b`, the other photo of the roll),
  // against one decode of the same files with the same query `extra`.
  // `formats` are exported after each scenario, `duringFormats` while stage 2
  // is held.
  const scenarios = async ({ label, a, b, c = null, cropFile = a, twoStage, extra = '', only = null, formats = FORMATS, duringFormats = formats }) => {
    const nameA = basename(a), nameB = basename(b);
    // TWO_STAGE_SCENES=adopt,failure-lanes runs only those scenes (their
    // references still run).
    const scenes = (process.env.TWO_STAGE_SCENES || '').split(',').filter(Boolean);
    const runs = name => (!only || only.includes(name)) && (!scenes.length || scenes.includes(name));
    if (only && !only.some(runs)) return;
    const one = extra;
    const two = `${twoStage}${extra}`;
    // A photo installed and converted, with its recipe settled.
    const settledPhoto = async () => ({ recipe: await settledRecipe(), defaults: await automaticDefaults() });

    // References: each file decoded once. A opened alone; B opened with A
    // never opened, the lanes done, then Export All; Analyze roll after an
    // exposure edit on A.
    const reference = {};
    await boot(one);
    await importFiles([a]);
    await waitFor(`${label} reference import`, `${ready} && ${filename(nameA)}`, 900_000);
    Object.assign(reference, await settledPhoto());
    const referencePlan = await evaluate(`window.__ncTwoStage.diagnostics.plans.at(-1)`);
    if (referencePlan?.stages !== 1) fail(`${label}: with the flag off the reference decodes once: ` + JSON.stringify(referencePlan));
    // The decoded size (LibRaw's, which the header's may not be).
    reference.base = (await evaluate(status)).base;
    reference.exports = await exportFormats(`${label} reference`, [...formats, ...duringFormats.filter(format => !formats.includes(format))]);
    console.log(`two-stage smoke ${label} reference:`, JSON.stringify({ crop: reference.recipe.cropRegion, exports: short(reference.exports) }));
    // Exported as soon as the photo shows, its semantic colour answer held
    // until the exports are written (each click freezes the recipe): the
    // reference of exports clicked before the photo settled (during stage 2,
    // after a failed stage 2). The recipe after that, once settled.
    if (runs('during') || runs('failure')) {
      await boot(one, { holdSemantic: true });
      await importFiles([a]);
      await waitFor(`${label} click reference import`, `${ready} && ${filename(nameA)}`, 900_000);
      const exports = await exportFormats(`${label} click reference`, [...formats, ...duringFormats.filter(format => !formats.includes(format))]);
      await evaluate(releaseSemantic);
      reference.click = { exports, ...(await settledPhoto()) };
      console.log(`two-stage smoke ${label} click reference:`, JSON.stringify({ exports: short(exports), wbSemanticApplied: Boolean(reference.recipe.wbSemanticApplied) }));
    }
    if (runs('leave')) {
      await boot(one);
      await importFiles([b, a]);
      await waitFor(`${label} reference import B first`, `${ready} && ${filename(nameB)} && ${lanesReady}`, 900_000);
      await settledRecipe();
      reference.all = await exportAllFormats(2, `${label} reference Export All`);
      reference.allDefaults = await automaticDefaults();
    }

    // 1. Two stages, installed behind the stand-in without locking editing;
    // exports after the settle.
    if (runs('settle')) {
      await boot(two);
      await evaluate('window.__ncTwoStage.holdFullDecodes()');
      await importFiles([a]);
      await waitFor(`${label} stand-in shown`, `${ready} && ${filename(nameA)} && ${status}.pending`, 900_000);
      const standIn = await evaluate(`({ status: ${status}, stage1: window.__ncTwoStage.diagnostics.stage1.at(-1), plan: window.__ncTwoStage.diagnostics.plans.at(-1) })`);
      if (standIn.plan?.stages !== 2) fail(`${label}: the threshold did not plan two stages: ` + JSON.stringify(standIn.plan));
      if (standIn.stage1?.scale !== 0.5 || Math.abs(standIn.status.base?.width * 2 - reference.base.width) > 2) fail(`${label}: stage 1 is not a half-size stand-in: ` + JSON.stringify(standIn));
      if (!standIn.status.provisional) fail(`${label}: the stand-in is not provisional`);
      await evaluate(`window.__twoStageBusy.length = 0; window.__twoStageBusyWatch = true; window.__ncTwoStage.releaseFullDecodes()`);
      await waitFor(`${label} full decode installed`, `${ready} && ${exact}`, 900_000);
      const installed = await evaluate(`({ status: ${status}, busy: window.__twoStageBusy.slice(), stage2: window.__ncTwoStage.diagnostics.stage2.at(-1), swaps: window.__ncTwoStage.diagnostics.swaps })`);
      await evaluate('window.__twoStageBusyWatch = false');
      console.log(`two-stage smoke ${label} install:`, JSON.stringify({ base: installed.status.base, stage2: installed.stage2, swaps: installed.swaps, busy: installed.busy.length }));
      if (installed.status.base?.width !== reference.base.width || installed.status.base.height !== reference.base.height || installed.status.base.scale !== 1) fail(`${label}: the full decode was not installed: ` + JSON.stringify(installed.status));
      if (/twoStageMode=sequential/.test(two) && installed.stage2?.mode !== 'sequential') fail(`${label}: forced sequential mode was not used: ` + JSON.stringify(installed.stage2));
      if (installed.busy.length) fail(`${label}: the swap set studioBusy: ` + JSON.stringify(installed.busy));
      const settled = await settledPhoto();
      // The page's large-image threshold (?largeImagePixels): the full
      // decode is above it and the stand-in below, as for a 60 MP file.
      const threshold = await evaluate(`import('/src/app/imageMemoryBudget.js').then(m => m.LARGE_IMAGE_PIXELS)`);
      const pixels = { full: reference.base.width * reference.base.height, standIn: standIn.status.base.width * standIn.status.base.height };
      console.log(`two-stage smoke ${label} large-image threshold:`, JSON.stringify({ threshold, ...pixels }));
      if (/largeImagePixels/.test(extra) && !(pixels.full > threshold && pixels.standIn <= threshold)) fail(`${label}: the full decode is not large while its stand-in is not: ` + JSON.stringify({ threshold, ...pixels }));
      same(`${label}: the settled recipe`, settled.recipe, reference.recipe);
      same(`${label}: automaticDefaults`, settled.defaults, reference.defaults);
      sameExports(`${label}: export after the settle`, await exportFormats(`${label} two-stage`, formats), reference.exports);
      if (/largeImagePixels/.test(extra)) {
        // The last banded export's conversion ran on the band pool.
        const bands = await evaluate('window.__ncBatchPipeline.diagnostics.singleExport');
        console.log(`two-stage smoke ${label} export bands:`, JSON.stringify(bands));
        if (!((bands?.bandAdjusts || 0) + (bands?.residentAdjusts || 0))) fail(`${label}: the export did not use the band pool: ` + JSON.stringify(bands));
      }
      console.log(`ok: ${label}: two stages settle to the single decode's recipe, automaticDefaults and exports, without studioBusy`);
    }

    // 2. Export clicked while stage 2 is held, in each format: it waits, then
    // matches.
    if (runs('during')) {
      for (const format of duringFormats) {
        const key = formatKey(format);
        await boot(two, { holdSemantic: true });
        await evaluate('window.__ncTwoStage.holdFullDecodes()');
        await importFiles([a]);
        await waitFor(`${label} stand-in shown`, `${ready} && ${status}.pending`, 900_000);
        await selectFormat(format);
        await evaluate(`document.getElementById('exportSingleBtn').click()`);
        await wait(1500);
        if (await evaluate('window.__twoStageDownloads.length')) fail(`${label}: a ${key} export was written from the stand-in`);
        if (!(await evaluate(`${status}.pending`))) fail(`${label}: the photo left the provisional state while stage 2 was held`);
        await evaluate('window.__ncTwoStage.releaseFullDecodes()');
        const entry = await take(`${label} ${key} export during stage 2`);
        // TIFF 16 and the DNG: the full decode's size and 16-bit samples
        // (#229 review R1-130), as one decode writes them.
        if (key === 'tiff16' || key === 'dng') {
          const expected = reference.click.exports[key].layout;
          console.log(`two-stage smoke ${label} ${key} during stage 2:`, JSON.stringify({ layout: entry.layout, oneDecode: expected, base: reference.base }));
          if (!entry.layout || entry.layout.bits.some(bits => bits !== 16) || JSON.stringify(entry.layout) !== JSON.stringify(expected)) {
            fail(`${label}: the ${key} export clicked during stage 2 is not the full decode's 16-bit image: ` + JSON.stringify({ layout: entry.layout, oneDecode: expected }));
          }
        }
        sameExport(`${label}: ${key} export clicked during stage 2`, entry, reference.click.exports[key]);
        await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled && ${exact}`, 900_000);
        await evaluate(releaseSemantic);
        same(`${label}: automaticDefaults after an export during stage 2`, await automaticDefaults(), reference.defaults);
      }
      console.log(`ok: ${label}: an export clicked during stage 2 waits for the full decode and matches, in ${duringFormats.map(formatKey).join(', ')}`);
    }

    // 3. Crop mode open when stage 2 lands: the swap waits for it to close.
    if (runs('crop')) {
      await boot(two);
      await evaluate('window.__ncTwoStage.holdFullDecodes()');
      await importFiles([a]);
      await waitFor(`${label} stand-in shown`, `${ready} && ${status}.pending`, 900_000);
      const { width, height } = reference.base;
      await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click()`);
      await waitFor('crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
      const editorBefore = await evaluate('window.__ncMemory.snapshot().ledger.editor');
      await evaluate('window.__ncTwoStage.releaseFullDecodes()');
      await wait(1500);
      const during = await evaluate(status);
      if (during.fullDecode === 'installed' || !during.provisional) fail(`${label}: the full decode was installed under an open crop draft: ` + JSON.stringify(during));
      // Decoded, waiting for the draft: no plane holds it yet, but the ledger
      // counts its 8- and 16-bit planes (12 B/px) with the open photo (polled:
      // the settle's detections borrow the planes for a moment).
      const fullBytes = width * height * 12;
      const counted = `${status}.fullDecode === 'decoded' && window.__ncMemory.snapshot().ledger.editor - ${editorBefore} >= ${0.9 * fullBytes}`;
      await waitFor('stage 2 decoded under the crop draft', counted, 300_000, { soft: true });
      const editorDuring = await evaluate('window.__ncMemory.snapshot().ledger.editor');
      console.log(`two-stage smoke ${label} ledger:`, JSON.stringify({ editorBefore, editorDuring, fullBytes, fullDecode: (await evaluate(status)).fullDecode }));
      if (!(await evaluate(counted))) fail(`${label}: the memory ledger does not count the full decode waiting for the swap: ` + JSON.stringify({ editorBefore, editorDuring, fullBytes }));
      await evaluate(`document.getElementById('cancelCropBtn').click()`);
      await waitFor(`${label} installed after crop mode`, `${ready} && ${exact}`, 900_000);
      const settled = await settledPhoto();
      same(`${label}: the recipe after crop mode`, settled.recipe, reference.recipe);
      same(`${label}: automaticDefaults after crop mode`, settled.defaults, reference.defaults);
      sameExports(`${label}: export after crop mode`, await exportFormats(`${label} after crop mode`, formats), reference.exports);
      console.log(`ok: ${label}: stage 2 landing during crop mode is installed when the draft closes`);
    }

    // 4. Stage 2 fails: a toast, still provisional, the export decodes again.
    if (runs('failure')) {
      await boot(two, { holdSemantic: true });
      await evaluate('window.__ncTwoStage.failNextFullDecodes(1)');
      await importFiles([a]);
      await waitFor(`${label} stage 2 failed`, `${ready} && ${status}.fullDecode === 'failed'`, 900_000);
      const failed = await evaluate(`({ status: ${status}, toasts: window.__twoStageToasts.slice() })`);
      if (!failed.status.pending || !failed.status.provisional) fail(`${label}: a failed stage 2 must leave the photo provisional: ` + JSON.stringify(failed.status));
      if (!failed.toasts.some(text => /Full resolution could not be loaded/.test(text))) fail(`${label}: no failure toast: ` + JSON.stringify(failed.toasts));
      // The first export decodes again, in the foreground.
      const exports = await exportFormats(`${label} after failure`, formats);
      if (!(await evaluate(exact))) fail(`${label}: the export did not install the full decode`);
      sameExports(`${label}: export after a failed stage 2`, exports, reference.click.exports);
      await evaluate(releaseSemantic);
      const settled = await settledPhoto();
      same(`${label}: the recipe after a failed stage 2`, settled.recipe, reference.click.recipe);
      same(`${label}: automaticDefaults after a failed stage 2`, settled.defaults, reference.click.defaults);
      console.log(`ok: ${label}: a failed stage 2 is reported, and the export decodes again and matches`);
    }

    // 5. Leaving before stage 2 completes aborts it; Export All matches.
    if (runs('leave')) {
      await boot(two);
      await evaluate('window.__ncTwoStage.holdFullDecodes()');
      await importFiles([a, b]);
      await waitFor(`${label} stand-in shown`, `${ready} && ${filename(nameA)} && ${status}.pending`, 900_000);
      const abandonedBefore = await evaluate('window.__ncTwoStage.diagnostics.abandoned');
      await clickStrip(nameB);
      await waitFor('switched', `${filename(nameB)} && window.__ncTwoStage.diagnostics.abandoned > ${abandonedBefore}`, 60_000);
      await evaluate('window.__ncTwoStage.releaseFullDecodes()');
      await waitFor(`${label} second photo exact`, `${ready} && ${filename(nameB)} && ${exact} && ${lanesReady}`, 900_000);
      await settledRecipe();
      const all = await exportAllFormats(2, `${label} Export All after an early switch`);
      for (const key of Object.keys(reference.all)) {
        same(`${label}: Export All file names, ${key}`, Object.keys(all[key]), Object.keys(reference.all[key]));
        sameExports(`${label}: Export All after leaving before stage 2, ${key}`, all[key], reference.all[key]);
      }
      same(`${label}: automaticDefaults after Export All`, await automaticDefaults(), reference.allDefaults);
      console.log(`ok: ${label}: leaving before stage 2 aborts it, and Export All matches the single decodes`);
    }

    // R2-052: the stand-in's crop detector hits, then the photo is left
    // before the full base installs. Export All must replay the same edits
    // and measure the image window on the full base, as one decode does.
    if (runs('crop-leave')) {
      const cropMode = `document.getElementById('canvasContainer').classList.contains('crop-mode')`;
      const flow = async (held, cropRecipe = null) => {
        const scene = `${label} crop then leave, ${held ? 'two stages' : 'one stage'}`;
        await boot(held ? two : one, { holdSemantic: true });
        await evaluate(`(() => { const el = document.getElementById('studioImportAutoCrop'); if (el.checked) el.click(); })()`);
        if (held) await evaluate('window.__ncTwoStage.holdFullDecodes()');
        await importFiles([cropFile, b]);
        await waitFor(scene + ': first photo', `${ready} && ${filename(basename(cropFile))} && ${held ? `${status}.pending` : exact}`, 150_000);
        const base = (await evaluate(status)).base;
        const scale = held ? base.scale : 1;
        const confirm = cropRecipe?.confirm || {
          left: 0, top: 0, width: Math.floor(base.width * 0.35) / scale, height: Math.floor(base.height * 0.35) / scale
        };
        const crop = cropRecipe?.crop || {
          left: 0, top: 0, width: (base.width - 2) / scale, height: (base.height - 2) / scale
        };
        const project = rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value * scale + (key === 'width' || key === 'height' ? 0.01 : 0)]));
        for (const [analysisOnly, rect] of [[true, confirm], [false, crop]]) {
          await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('${analysisOnly ? 'studioConfirmAnalysis' : 'cropBtn'}').click()`);
          await waitFor(scene + ': crop mode', cropMode, 30_000);
          await wait(300);
          await evaluate(`window.__ncAnalysis.setDraftRect(${JSON.stringify(project(rect))}); document.getElementById('applyCropBtn').click()`);
          await waitFor(scene + ': crop applied', `${ready} && !${cropMode} && !window.__ncAnalysis.converting()`, 120_000);
          await evaluate('window.__ncAnalysis.settle()');
        }
        const diagnostics = await evaluate('window.__ncAnalysis.diagnostics()');
        if (diagnostics?.method !== 'manual-image-window' || diagnostics.analysisNeedsReview) fail(scene + ': the crop detector must hit: ' + JSON.stringify(diagnostics));
        if (held && !(await evaluate(`${status}.pending && !${status}.swapped`))) fail(scene + ': stage 2 installed before leaving');
        const geometry = (await evaluate(status)).settings;
        const abandoned = await evaluate('window.__ncTwoStage.diagnostics.abandoned');
        await clickStrip(nameB);
        await waitFor(scene + ': left cropped photo', `${filename(nameB)}${held ? ` && window.__ncTwoStage.diagnostics.abandoned > ${abandoned}` : ''}`, 60_000);
        if (held) await evaluate('window.__ncTwoStage.releaseFullDecodes()');
        await evaluate(releaseSemantic);
        await waitFor(scene + ': second photo exact', `${ready} && ${filename(nameB)} && ${exact} && ${lanesReady}`, 150_000);
        await settledRecipe();
        const beforeExport = await evaluate('window.__ncTwoStage.queuedRecipes()');
        const all = await exportAllFormats(2, scene, [FORMATS[4], ...FORMATS.slice(0, 4)]);
        const afterExport = await evaluate('window.__ncTwoStage.queuedRecipes()');
        return { all, beforeExport, afterExport, geometry: { cropRegion: geometry.cropRegion, rotationAngle: geometry.rotationAngle, mirrored: geometry.mirrored }, recipe: { confirm, crop } };
      };
      // Learned defaults (#229 review): their offsets are fractions, which an
      // opened photo's sliders snap; the photo left inside the window must
      // get the same snapped values. Seed one learned edit for this scene's
      // stock key ('none' preset, colour) and put the device's records back.
      const learnedKeys = ['NONE', 'GENERIC'].map(stock => JSON.stringify([stock, '', 'color']));
      const deviceLearned = await evaluate(`import('/src/app/learnedDefaultsStore.js').then(async m => {
        const records = await m.readLearnedDefaults();
        for (const key of ${JSON.stringify(learnedKeys)}) await m.writeLearnedDefaults({ version: 1, key, rolls: [{ id: 'smoke', frames: { f: { coreTemperature: 6, coreContrast: -6 } } }] });
        return records;
      })`);
      const staged = await flow(true);
      const single = await flow(false, staged.recipe);
      await evaluate(`import('/src/app/learnedDefaultsStore.js').then(async m => {
        await m.resetLearnedDefaults();
        for (const record of ${JSON.stringify(deviceLearned)}) await m.writeLearnedDefaults(record);
        return true;
      })`);
      same(label + ': crop geometry before leaving', staged.geometry, single.geometry);
      const byFile = entries => entries.find(item => item.name === basename(cropFile));
      if (!byFile(staged.beforeExport)?.pendingFrameEdit?.intent.detect) fail(label + ': Export All did not receive the pending crop-detection intent');
      const resolved = byFile(staged.afterExport), reference = byFile(single.afterExport);
      if (resolved.pendingFrameEdit || resolved.pendingEdits || resolved.automatic) fail(label + ': the viewed full recipe did not settle: ' + JSON.stringify(resolved));
      same(label + ': full-base cropped analysis area', resolved.settings.autoFrameMeta.imageArea, reference.settings.autoFrameMeta.imageArea);
      const wb = settings => Object.fromEntries(['wbR', 'wbG', 'wbB', 'wbAutoConfidence', 'wbUserOverride'].map(key => [key, settings[key]]));
      if (!resolved.settings.learnedDefaults || !reference.settings.learnedDefaults) fail(label + ': the seeded learned defaults did not apply: ' + JSON.stringify([resolved.settings.learnedDefaults, reference.settings.learnedDefaults]));
      const learnedValues = settings => ({ coreTemperature: settings.coreTemperature, coreContrast: settings.coreContrast });
      same(label + ': learned values as the sliders show them', learnedValues(resolved.settings), learnedValues(reference.settings));
      same(label + ': settled crop white balance', wb(resolved.settings), wb(reference.settings));
      for (const format of Object.keys(single.all)) sameExports(`${label}: crop then leave Export All ${format}`, staged.all[format], single.all[format]);
      console.log(`ok: ${label}: crop-hit then leave before stage 2 exports one stage's decoded samples in every format, with learned defaults`);
    }

    // R2-052 supplemental: real Apply/slider/Undo/Redo callers through the
    // full-base swap. The pending-at-swap case keeps the old worker request
    // held until the replacement full-base detection and exact exports finish.
    // A separate schedule holds the actual WB conversion reply after dispatch,
    // then creates history by editing exposure while those pixels are pending.
    if (runs('crop-history')) {
      const historyTimings = ['pending-hit', 'completed-hit', 'pending-at-swap', 'conversion-in-flight', 'cold-undo-edit', 'cold-redo-edit',
        'ownership-wb', 'ownership-conversion', 'ownership-reset-wb', 'ownership-reset-conversion', 'ownership-confirm-wb'];
      for (const timing of historyTimings.filter(t => !process.env.TWO_STAGE_HISTORY_TIMINGS
        || process.env.TWO_STAGE_HISTORY_TIMINGS.split(',').includes(t))) {
        const historyRestore = timing.startsWith('cold-');
        const ownershipRestore = timing.startsWith('ownership-');
        const resetRestore = timing.startsWith('ownership-reset-');
        const confirmRestore = timing === 'ownership-confirm-wb';
        const wbReplayOnly = timing.endsWith('-wb');
        const heldConversion = timing === 'conversion-in-flight' || historyRestore || ownershipRestore;
        const unansweredPreview = timing === 'pending-at-swap' || heldConversion;
        const flow = async (staged, recipe = null) => {
          const scene = `${label} ${timing} crop history ${staged ? 'two stages' : 'one stage'}`;
          const wbTimeline = [];
          const noteWb = async phase => wbTimeline.push({ phase, exposure: await evaluate(`${status}.settings.coreExposure`), wb: await evaluate('window.__ncAnalysis.whiteBalance()') });
          await boot(staged ? two : one, { holdSemantic: true });
          await evaluate(`(() => {
            const auto = document.getElementById('studioImportAutoCrop'); if (auto.checked) auto.click();
            const probe = window.__historyCropProbe = { hold: false, held: [], answers: 0, replacement: null,
              once: ${unansweredPreview}, geometryOn: false, historyOn: false,
              geometryHeld: [], conversionOn: false, conversionHeld: [], conversionReplies: 0, wbReplayOnly: false,
              historyRequests: [] };
            const post = Worker.prototype.postMessage;
            Worker.prototype.postMessage = function (message, ...args) {
              if (probe.hold && message?.type === 'detect-crop-area') {
                if (!probe.once || !probe.held.length) {
                  this.addEventListener('message', event => { if (event.data?.id === message.id) probe.answers++; });
                  probe.held.push(() => post.call(this, message, ...args)); return;
                }
                probe.replacement = { swapped: window.__ncTwoStage.status().swapped,
                  base: window.__ncTwoStage.status().base, held: probe.held.length, answers: probe.answers,
                  detection: { ...window.__ncAnalysis.detection } };
              }
              return post.call(this, message, ...args);
            };
            probe.release = () => { probe.hold = false; for (const deliver of probe.held.splice(0)) deliver(); };
            const NativeWorker = window.Worker;
            window.Worker = class extends NativeWorker {
              constructor(url, options) {
                super(url, options);
                const geometry = /geometryWorker/.test(String(url)), conversion = /conversionWorker/.test(String(url));
                if (!geometry && !conversion) return;
                const requests = new Map(), post = this.postMessage.bind(this);
                let handler = null, ended = false;
                Object.defineProperty(this, 'onmessage', { configurable: true, get: () => handler, set: fn => { handler = fn; } });
                this.postMessage = (message, ...args) => {
                  const state = window.__ncTwoStage.status();
                  if (conversion && probe.historyOn) {
                    probe.historyRequests.push({ id: message.id, wbSample: !!message.wbSample,
                      exposure: message.settings?.coreExposure, preview: message.options?.preview,
                      pending: state.pending, provisional: state.provisional,
                      converting: window.__ncAnalysis.converting(), stack: new Error().stack });
                    if (probe.historyRequests.length > 40) probe.historyRequests.shift();
                  }
                  if (geometry && probe.geometryOn && state.swapped) requests.set(message.id, 'geometry');
                  if (conversion && probe.conversionOn && message.wbSample && message.settings?.coreExposure === 15
                    && (!probe.wbReplayOnly || message.options?.preview === true && !window.__ncAnalysis.converting())
                    && (probe.historyOn ? !state.pending && !state.provisional
                      : window.__ncAnalysis.detection.hits === 1 && (${!staged} || state.swapped))) {
                    requests.set(message.id, 'conversion');
                    probe.dispatched = { exposure: message.settings.coreExposure, preview: !!message.options?.preview, width: message.width, height: message.height,
                      swapped: state.swapped, base: state.base, detecting: window.__ncAnalysis.pendingDetection(),
                      geometryPending: window.__ncGeometry.pending(), coldRestores: window.__ncGeometry.diagnostics.coldRestores,
                      diagnostics: window.__ncAnalysis.diagnostics(), heldPreview: probe.held.length, previewAnswers: probe.answers,
                      converting: window.__ncAnalysis.converting(), stack: new Error().stack };
                  }
                  return post(message, ...args);
                };
                this.addEventListener('message', event => {
                  const kind = requests.get(event.data?.id);
                  requests.delete(event.data?.id);
                  const deliver = () => { if (!ended && handler) handler.call(this, event); };
                  if (kind === 'geometry' && probe.geometryOn) probe.geometryHeld.push(deliver);
                  else if (kind === 'conversion' && probe.conversionOn && event.data?.type === 'result') {
                    probe.conversionReplies++; probe.conversionHeld.push(deliver);
                  } else deliver();
                });
                const terminate = this.terminate.bind(this);
                this.terminate = () => { ended = true; terminate(); };
              }
            };
            probe.releaseGeometry = () => { probe.geometryOn = false; for (const deliver of probe.geometryHeld.splice(0)) deliver(); };
            probe.releaseConversion = () => { probe.conversionOn = false; for (const deliver of probe.conversionHeld.splice(0)) deliver(); };
          })()`);
          if (staged) await evaluate('window.__ncTwoStage.holdFullDecodes()');
          await importFiles([cropFile]);
          await waitFor(scene + ': photo', `${ready} && ${filename(basename(cropFile))} && ${staged ? `${status}.pending` : exact}`, 150_000);
          const base = (await evaluate(status)).base, scale = staged ? base.scale : 1;
          recipe ||= { confirm: { left: 0, top: 0, width: Math.floor(base.width * .35) / scale, height: Math.floor(base.height * .35) / scale },
            crop: { left: 0, top: 0, width: (base.width - 2) / scale, height: (base.height - 2) / scale } };
          for (const [analysisOnly, rect] of [[true, recipe.confirm], [false, recipe.crop]]) {
            const projected = Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value * scale + (key === 'width' || key === 'height' ? .01 : 0)]));
            await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('${analysisOnly ? 'studioConfirmAnalysis' : 'cropBtn'}').click()`);
            await waitFor(scene + ': crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
            await wait(300);
            await evaluate(`window.__historyCropProbe.hold = ${!analysisOnly && timing !== 'completed-hit'};
              window.__ncAnalysis.setDraftRect(${JSON.stringify(projected)}); document.getElementById('applyCropBtn').click()`);
            await waitFor(scene + ': applied', `${ready} && !document.getElementById('canvasContainer').classList.contains('crop-mode') && !window.__ncAnalysis.converting()`, 120_000);
            if (analysisOnly || timing === 'completed-hit') await evaluate('window.__ncAnalysis.settle()');
            await noteWb(analysisOnly ? 'confirmed' : 'crop applied');
          }
          if (timing !== 'completed-hit') await waitFor(scene + ': detector held', `window.__historyCropProbe.held.length === 1 && window.__ncAnalysis.pendingDetection()`, 60_000);
          await evaluate(`(() => { const el = document.getElementById('coreExposure'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            el.value = '15'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
          if (heldConversion) await evaluate(`window.__historyCropProbe.conversionOn = true;
            window.__historyCropProbe.geometryOn = ${staged}`);
          if (staged && unansweredPreview) {
            const pending = await evaluate(`({ held: window.__historyCropProbe.held.length, answers: window.__historyCropProbe.answers,
              pending: window.__ncAnalysis.pendingDetection(), detection: { ...window.__ncAnalysis.detection },
              diagnostics: window.__ncAnalysis.diagnostics() })`);
            if (pending.held !== 1 || pending.answers || !pending.pending || pending.detection.hits || !pending.diagnostics?.analysisNeedsReview)
              fail(scene + ': detector must have no answer/hit before promotion: ' + JSON.stringify(pending));
            // Observe the old barrier without awaiting it. It must resolve
            // through cancellation/replacement while the old worker is held.
            await evaluate(`void window.__ncAnalysis.settle().then(() => { window.__historyCropProbe.previousSettled = true; })`);
            await noteWb('old detector pending at promotion');
          } else {
            await evaluate('window.__historyCropProbe.release()');
            if (!heldConversion) {
              await evaluate('window.__ncAnalysis.settle()');
              await noteWb('hit, exposure edited');
              const hit = await evaluate('window.__ncAnalysis.diagnostics()');
              if (hit?.method !== 'manual-image-window' || hit.analysisNeedsReview) fail(scene + ': stand-in/reference detector must hit: ' + JSON.stringify(hit));
            }
          }
          if (staged) {
            if (!(await evaluate(`${status}.pending && !${status}.swapped`))) fail(scene + ': full base installed before history capture');
            await evaluate('window.__ncTwoStage.releaseFullDecodes()');
          }
          if (heldConversion) {
            if (staged) {
              // The crop detector samples the base independently of the
              // geometry worker. Let its hit finish before conversion starts.
              await waitFor(scene + ': replacement hit before geometry settles', `window.__historyCropProbe.geometryHeld.length > 0
                && ${status}.swapped && window.__ncAnalysis.detection.hits === 1 && !window.__ncAnalysis.pendingDetection()`, 60_000);
              await evaluate('window.__historyCropProbe.releaseGeometry()');
            }
            await waitFor(scene + ': dispatched conversion reply held', `window.__historyCropProbe.conversionHeld.length === 1
              && window.__ncAnalysis.converting()`, 60_000);
            const dispatched = await evaluate('window.__historyCropProbe.dispatched');
            if (dispatched.exposure !== 15 || dispatched.diagnostics?.method !== 'manual-image-window'
              || dispatched.diagnostics.analysisNeedsReview || (staged && (!dispatched.swapped || dispatched.detecting
                || dispatched.heldPreview !== 1 || dispatched.previewAnswers || dispatched.base?.width <= base.width)))
              fail(scene + ': dispatch must follow the finished full hit with preview unanswered: ' + JSON.stringify(dispatched));
            await evaluate(`(() => { const el = document.getElementById('coreExposure'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
              el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            if ((await evaluate(`${status}.settings.coreExposure`)) !== 0) fail(scene + ': later exposure edit did not reach live state');
            await noteWb('conversion at 15 held, edited to 0');
            console.log(scene + ' held conversion dispatch proof:', JSON.stringify({ ...dispatched, liveExposure: 0 }));
            await evaluate('window.__historyCropProbe.releaseConversion()');
          }
          await waitFor(scene + ': full source installed', `${ready} && ${exact} && !window.__ncAnalysis.converting()`, 150_000);
          await evaluate('window.__ncAnalysis.settle()');
          await noteWb('full base');
          const result = { recipe, wbTimeline };
          if (staged && unansweredPreview) {
            const replacement = await evaluate(`({ atSwap: window.__historyCropProbe.replacement,
              held: window.__historyCropProbe.held.length, answers: window.__historyCropProbe.answers,
              previousSettled: !!window.__historyCropProbe.previousSettled,
              pending: window.__ncAnalysis.pendingDetection(), detection: { ...window.__ncAnalysis.detection },
              diagnostics: window.__ncAnalysis.diagnostics() })`);
            if (!replacement.atSwap?.swapped || replacement.atSwap.held !== 1 || replacement.atSwap.answers
              || replacement.atSwap.base?.width <= base.width || replacement.atSwap.base?.height <= base.height
              || replacement.atSwap.detection.hits || replacement.held !== 1 || replacement.answers || !replacement.previousSettled
              || replacement.pending || replacement.detection.hits !== 1 || replacement.diagnostics?.analysisNeedsReview
              || replacement.diagnostics?.method !== 'manual-image-window') fail(scene + ': cancellation/replacement scheduling: ' + JSON.stringify(replacement));
            console.log(scene + ' pending-at-swap proof:', JSON.stringify(replacement));
          }
          if (unansweredPreview) {
            if ((await evaluate(`${status}.settings.coreExposure`)) !== (heldConversion ? 0 : 15)) fail(scene + ': promotion lost the exposure edit');
            result.live = { settings: await evaluate(`${status}.settings`), diagnostics: await evaluate('window.__ncAnalysis.diagnostics()'),
              wb: await evaluate('window.__ncAnalysis.whiteBalance()'), exports: await exportFormats(scene + ' live', [FORMATS[0], FORMATS[2]]) };
            if (staged) {
              const stale = await evaluate('window.__ncAnalysis.detection.stale');
              await evaluate('window.__historyCropProbe.release()');
              await waitFor(scene + ': late cancelled preview answer', `window.__historyCropProbe.answers === 1 && window.__ncAnalysis.detection.stale > ${stale}`, 60_000);
              same(scene + ': late preview diagnostics', await evaluate('window.__ncAnalysis.diagnostics()'), result.live.diagnostics);
              same(scene + ': late preview WB', await evaluate('window.__ncAnalysis.whiteBalance()'), result.live.wb);
            }
          }
          if (historyRestore) {
            const heldRestore = async action => {
              const before = await evaluate('window.__ncGeometry.diagnostics.coldRestores');
              await evaluate(`window.__historyCropProbe.historyOn = true; window.__historyCropProbe.conversionOn = true;
                document.getElementById('${action}Btn').click()`);
              await waitFor(scene + ': cold ' + action + ' reply held', `window.__historyCropProbe.conversionHeld.length === 1
                && window.__ncAnalysis.converting() && !window.__ncGeometry.pending()
                && !window.__ncAnalysis.pendingDetection() && !${status}.provisional && !${status}.pending`, 60_000);
              // Observe the actual persistence/export barrier while only
              // the conversion worker's reply is withheld.
              await evaluate(`window.__historyCropProbe.historySettled = false;
                void window.__ncAnalysis.settle().then(() => { window.__historyCropProbe.historySettled = true; })`);
              await wait(50);
              const proof = await evaluate(`({ ...window.__historyCropProbe.dispatched,
                settled: window.__historyCropProbe.historySettled, wb: window.__ncAnalysis.whiteBalance(),
                provisional: ${status}.provisional, pending: ${status}.pending })`);
              if (proof.coldRestores <= before || proof.settled || proof.provisional || proof.pending || proof.geometryPending
                || proof.detecting || proof.exposure !== 15 || proof.diagnostics?.analysisNeedsReview
                || proof.wb.wbR !== 1 || proof.wb.wbG !== 1 || proof.wb.wbB !== 1)
                fail(scene + ': cold history must hold unfinished WB after geometry/detection: ' + JSON.stringify(proof));
              console.log(scene + ' cold ' + action + ' dispatch/barrier proof:', JSON.stringify(proof));
            };
            const restore = async (action, exposure) => {
              await evaluate(`document.getElementById('${action}Btn').click()`);
              await evaluate('window.__ncAnalysis.settle()');
              await waitFor(scene + ': prepare ' + action, `${ready} && !window.__ncAnalysis.converting()
                && document.getElementById('coreExposure').value === '${exposure}'`, 120_000);
            };
            if (timing === 'cold-redo-edit') {
              if (staged) {
                await heldRestore('undo');
                // The second Undo captures the first rebuild's unfinished
                // state on Redo's stack through the real history caller.
                await evaluate(`document.getElementById('undoBtn').click(); window.__historyCropProbe.releaseConversion()`);
                await evaluate('window.__ncAnalysis.settle()');
                await waitFor(scene + ': second Undo settled', `${ready} && !window.__ncAnalysis.converting()
                  && document.getElementById('coreExposure').value === '0'`, 120_000);
              } else { await restore('undo', 15); await restore('undo', 0); }
            }
            const action = timing === 'cold-redo-edit' ? 'redo' : 'undo';
            if (staged) await heldRestore(action);
            else await restore(action, 15);
            await evaluate(`(() => { const el = document.getElementById('coreExposure'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
              el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await noteWb('exposure edited during cold ' + action);
            if (staged) {
              if (await evaluate('window.__historyCropProbe.historySettled')) fail(scene + ': cold history barrier settled before reply release');
              await evaluate('window.__historyCropProbe.releaseConversion()');
            }
            await evaluate('window.__ncAnalysis.settle()');
            await waitFor(scene + ': edit during restoration settled', `${ready} && !window.__ncAnalysis.converting()
              && document.getElementById('coreExposure').value === '0'`, 120_000);
            result.live = { settings: await evaluate(`${status}.settings`), diagnostics: await evaluate('window.__ncAnalysis.diagnostics()'),
              wb: await evaluate('window.__ncAnalysis.whiteBalance()'), exports: await exportFormats(scene + ' nested live', [FORMATS[0], FORMATS[2]]) };
          }
          if (ownershipRestore) {
            const frame = (await evaluate(status)).base;
            recipe.ownershipConfirm ||= { left: Math.floor(frame.width * .2), top: Math.floor(frame.height * .25),
              width: Math.floor(frame.width * .6), height: Math.floor(frame.height * .5) };
            await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('studioConfirmAnalysis').click()`);
            await waitFor(scene + ': later Confirm opened', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
            await wait(300);
            await evaluate(`window.__ncAnalysis.setDraftRect(${JSON.stringify(recipe.ownershipConfirm)}); document.getElementById('applyCropBtn').click()`);
            await waitFor(scene + ': later Confirm settled', `${ready} && !window.__ncAnalysis.converting()
              && !document.getElementById('canvasContainer').classList.contains('crop-mode')`, 120_000);
            await evaluate('window.__ncAnalysis.settle()');
            const confirmed = { diagnostics: await evaluate('window.__ncAnalysis.diagnostics()'), wb: await evaluate('window.__ncAnalysis.whiteBalance()') };
            const restore = async action => {
              await evaluate(`document.getElementById('${action}Btn').click()`);
              await evaluate('window.__ncAnalysis.settle()');
              await waitFor(scene + ': ' + action + ' settled', `${ready} && !window.__ncAnalysis.converting()`, 120_000);
            };
            await restore('undo'); // Hot entry before the later Confirm.
            if (resetRestore && !wbReplayOnly) {
              // Reset is available before cold restoration clears the
              // positive. Its real confirmation can complete afterward.
              await evaluate(`window.__historyResetConfirmHold = event => {
                if (event.target.closest?.('[data-app-dialog-confirm]')) event.stopImmediatePropagation();
              }; document.addEventListener('click', window.__historyResetConfirmHold, true);
              document.getElementById('studioTab-conversion').click(); document.getElementById('studioResetAll').click()`);
              await waitFor(scene + ': reset confirmation held before cold restore', `!!document.querySelector('[data-app-dialog-confirm]')`, 10_000);
            }
            if (staged) {
              const before = await evaluate('window.__ncGeometry.diagnostics.coldRestores');
              await evaluate(`window.__historyCropProbe.historyOn = true; window.__historyCropProbe.conversionOn = true;
                window.__historyCropProbe.wbReplayOnly = ${wbReplayOnly}; document.getElementById('undoBtn').click()`);
              await waitFor(scene + ': obsolete ' + timing + ' reply held', `window.__historyCropProbe.conversionHeld.length === 1
                && ${wbReplayOnly ? '!' : ''}window.__ncAnalysis.converting() && !window.__ncGeometry.pending()
                && !window.__ncAnalysis.pendingDetection() && !${status}.provisional && !${status}.pending`, 60_000);
              await evaluate(`window.__historyCropProbe.oldSettled = false;
                void window.__ncAnalysis.settle().then(() => { window.__historyCropProbe.oldSettled = true; })`);
              await wait(50);
              const proof = await evaluate(`({ ...window.__historyCropProbe.dispatched, settled: window.__historyCropProbe.oldSettled,
                converting: window.__ncAnalysis.converting(), replies: window.__historyCropProbe.conversionHeld.length,
                requests: window.__historyCropProbe.historyRequests })`);
              if (proof.coldRestores <= before || proof.settled || proof.replies !== 1 || proof.geometryPending || proof.detecting
                || proof.exposure !== 15 || proof.converting !== !wbReplayOnly
                || (wbReplayOnly && (!proof.preview || !proof.stack.includes('restorePromotedWhiteBalance'))))
                fail(scene + ': held leaf/old ownership proof: ' + JSON.stringify(proof));
              console.log(scene + ' held superseded restore proof:', JSON.stringify(proof));
              // Hold only the obsolete reply; successor renders are real.
              await evaluate('window.__historyCropProbe.conversionOn = false');
              // The old barrier stays withheld while actual hot Redos replace
              // it. A real slider below captures the superseding history state.
              if (!resetRestore && !confirmRestore) {
                await evaluate(`document.getElementById('redoBtn').click(); document.getElementById('redoBtn').click()`);
                await waitFor(scene + ': hot confirmed recipe restored', `${ready} && document.getElementById('coreExposure').value === '0'`, 60_000);
                same(scene + ': hot Redo diagnostics', await evaluate('window.__ncAnalysis.diagnostics()'), confirmed.diagnostics);
                same(scene + ': hot Redo WB', await evaluate('window.__ncAnalysis.whiteBalance()'), confirmed.wb);
              }
            } else {
              await restore('undo');
              if (!resetRestore && !confirmRestore) { await restore('redo'); await restore('redo'); }
            }
            let expectedWb = confirmed.wb;
            if (resetRestore) {
              if (wbReplayOnly) await evaluate(`document.getElementById('studioTab-conversion').click(); document.getElementById('studioResetAll').click()`);
              else await evaluate(`document.removeEventListener('click', window.__historyResetConfirmHold, true);
                delete window.__historyResetConfirmHold; document.querySelector('[data-app-dialog-confirm]').click()`);
              await waitFor(scene + ': actual reset unity WB', `document.getElementById('coreExposure').value === '0'
                && ['wbR', 'wbG', 'wbB'].every(key => ${status}.settings[key] === 1)`, 30_000);
              expectedWb = await evaluate('window.__ncAnalysis.whiteBalance()');
            } else if (confirmRestore) {
              recipe.ownershipReplacement ||= { left: Math.floor(frame.width * .25), top: Math.floor(frame.height * .15),
                width: Math.floor(frame.width * .5), height: Math.floor(frame.height * .7) };
              await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('studioConfirmAnalysis').click()`);
              await waitFor(scene + ': replacement Confirm opened', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
              await wait(300);
              await evaluate(`window.__ncAnalysis.setDraftRect(${JSON.stringify(recipe.ownershipReplacement)}); document.getElementById('applyCropBtn').click()`);
              await waitFor(scene + ': Confirm alone settled', `${ready} && !window.__ncAnalysis.converting()
                && !document.getElementById('canvasContainer').classList.contains('crop-mode')`, 120_000);
              expectedWb = await evaluate('window.__ncAnalysis.whiteBalance()');
            }
            const finalExposure = confirmRestore ? 0 : 15;
            await evaluate(`(() => { const el = document.getElementById('coreExposure'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
              el.value = '${finalExposure}'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
            await noteWb('new edit after superseding cold ' + timing);
            if (staged) await evaluate('window.__historyCropProbe.releaseConversion()');
            await evaluate('window.__ncAnalysis.settle()');
            await waitFor(scene + ': superseding edit settled', `${ready} && !window.__ncAnalysis.converting()
              && document.getElementById('coreExposure').value === '${finalExposure}'`, 120_000);
            same(scene + ': obsolete completion retains current WB', await evaluate('window.__ncAnalysis.whiteBalance()'), expectedWb);
            result.live = { settings: await evaluate(`${status}.settings`), diagnostics: await evaluate('window.__ncAnalysis.diagnostics()'),
              wb: await evaluate('window.__ncAnalysis.whiteBalance()'), exports: await exportFormats(scene + ' superseding live', [FORMATS[0], FORMATS[2]]) };
          }
          for (const phase of historyRestore || ownershipRestore ? ['undo', 'redo', 'undoRepeat', 'redoRepeat'] : ['undo', 'redo']) {
            const action = phase.startsWith('undo') ? 'undo' : 'redo';
            await evaluate(`document.getElementById('${action}Btn').click()`);
            // The exact consumer also waits for promoted history's analysis.
            await evaluate('window.__ncAnalysis.settle()');
            const exposure = heldConversion && !ownershipRestore || confirmRestore ? (action === 'undo' ? '15' : '0') : (action === 'undo' ? '0' : '15');
            await waitFor(scene + ': ' + phase, `${ready} && !window.__ncAnalysis.converting() && document.getElementById('coreExposure').value === '${exposure}'`, 120_000);
            result[phase] = { settings: await evaluate(`${status}.settings`),
              diagnostics: await evaluate('window.__ncAnalysis.diagnostics()'), wb: await evaluate('window.__ncAnalysis.whiteBalance()'),
              exports: await exportFormats(scene + ' ' + phase, [FORMATS[0], FORMATS[2]]) };
          }
          await evaluate(releaseSemantic);
          console.log(scene + ' WB timeline:', JSON.stringify(wbTimeline));
          return result;
        };
        const staged = await flow(true), single = await flow(false, staged.recipe);
        for (const action of historyRestore || ownershipRestore ? ['live', 'undo', 'redo', 'undoRepeat', 'redoRepeat']
          : unansweredPreview ? ['live', 'undo', 'redo'] : ['undo', 'redo']) {
          const fields = ['filmBase', 'filmType', 'positiveMode', 'cropRegion', 'rotationAngle', 'mirrored', 'coreExposure', 'wbUserOverride'];
          const differing = Object.fromEntries(fields.filter(key => JSON.stringify(staged[action].settings[key]) !== JSON.stringify(single[action].settings[key]))
            .map(key => [key, { staged: staged[action].settings[key], single: single[action].settings[key] }]));
          if (Object.keys(differing).length) console.log(`${label} ${timing} ${action} recipe differences:`, JSON.stringify(differing));
          const wbKeys = new Set(['wbR', 'wbG', 'wbB', 'wbAutoConfidence']);
          const allDifferences = [...new Set([...Object.keys(staged[action].settings), ...Object.keys(single[action].settings)])]
            .filter(key => !wbKeys.has(key) && JSON.stringify(staged[action].settings[key]) !== JSON.stringify(single[action].settings[key]));
          if (allDifferences.length) console.log(`${label} ${timing} ${action} other recipe differences:`, JSON.stringify(Object.fromEntries(allDifferences
            .map(key => [key, { staged: staged[action].settings[key], single: single[action].settings[key] }]))));
          for (const key of fields) same(`${label} ${timing}: ${action} ${key}`, staged[action].settings[key], single[action].settings[key]);
          same(`${label} ${timing}: ${action} diagnostics`, staged[action].diagnostics, single[action].diagnostics);
          same(`${label} ${timing}: ${action} WB`, staged[action].wb, single[action].wb);
          sameExports(`${label} ${timing}: ${action} PNG8/TIFF16`, staged[action].exports, single[action].exports);
          if (ownershipRestore) console.log('ownership export proof:', JSON.stringify({ timing, phase: action,
            staged: staged[action].exports, single: single[action].exports }));
        }
        console.log(`ok: ${label} ${timing}: full-swap Undo/Redo diagnostics, WB and PNG8/TIFF16 samples/bytes equal one stage`);
      }
    }

    // R1-017: an old automatic WB belongs to the saved interpretation.
    // Real project restoration supplies a nonunit derived recipe, then the
    // real controls, exposure history and full RAW swap must invalidate it.
    if (runs('interpretation-history')) {
      const historyFormats = [FORMATS[0], FORMATS[2]];
      const edit = value => evaluate(`(() => {
        const el = document.getElementById('coreExposure');
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.value = '${value}';
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const openSaved = async (query, recipe, held = false) => {
        await boot(query);
        await evaluate(`(() => {
          for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
            const el = document.getElementById(id); if (el.checked) el.click();
          }
        })()`);
        if (held) await evaluate('window.__ncTwoStage.holdFullDecodes()');
        const text = await evaluate(`(async () => {
          const { buildRollProject, serializeRollProject } = await import('/src/app/rollProject.js');
          return serializeRollProject(buildRollProject({ files: [{ name: ${JSON.stringify(nameA)},
            size: ${readFileSync(a).byteLength}, selected: true, settings: ${JSON.stringify(recipe)} }] }));
        })()`);
        const project = join(dir, 'interpretation-history.ncroll.json');
        writeFileSync(project, text);
        const doc = await send('DOM.getDocument');
        const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#projectInput' });
        await send('DOM.setFileInputFiles', { files: [project, a], nodeId: input.result.nodeId });
        await waitFor('interpretation history saved source', `${ready} && ${filename(nameA)}
          && ${status}.settings?.expiredAnalysis?.spatial && ${held ? `${status}.pending && !${status}.swapped` : exact}`, 150_000);
        const queued = await evaluate('window.__ncTwoStage.queuedRecipes().map(item => item.name)');
        same('history fixture original identity', queued, [nameA]);
      };
      const choices = [
        { before: ['color', 'correct'], after: ['bw', 'correct'] },
        { before: ['color', 'correct'], after: ['positive', 'correct'] },
        { before: ['positive', 'correct'], after: ['bw', 'correct'] },
        { before: ['positive', 'correct'], after: ['positive', 'edit'] }
      ];
      for (const { before, after } of choices) {
        const scene = `${label} interpretation history ${before.join('/')} -> ${after.join('/')}`;
        const seed = { ...reference.recipe, filmType: before[0], positiveMode: before[1], filmTypeSource: 'manual',
          wbR: 1.17, wbG: 1, wbB: .86, wbAutoConfidence: 'high', wbUserOverride: false, grayPointSampled: false, wbSemanticApplied: false,
          semanticMap: null, expiredAnalysis: null, rollFrame: null, coreExposure: 19, expiredEnabled: true,
          filmBase: { ...reference.recipe.filmBase, method: 'manual' }, filmBaseSet: true,
          expiredBrightness: 17, expiredContrast: 23, expiredBrightnessUserOverride: true, expiredContrastUserOverride: true };
        await openSaved(two, seed, true);
        const initial = await evaluate(`${status}.settings`);
        same(scene + ': saved automatic WB', [initial.wbR, initial.wbG, initial.wbB], [1.17, 1, .86]);
        if (initial.wbUserOverride || initial.grayPointSampled) fail(scene + ': fixture became user-owned WB');
        await evaluate(`(() => {
          document.querySelector('.film-type-btn[data-type="${after[0]}"]').click();
          const mode = document.getElementById('positiveModeSelect'); mode.value = '${after[1]}';
          if (${JSON.stringify(before[1])} !== '${after[1]}') mode.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitFor(scene + ': changed interpretation measured', `${ready} && ${status}.settings.filmType === '${after[0]}'
          && ${status}.settings.positiveMode === '${after[1]}' && ${status}.settings.expiredAnalysis?.spatial`, 120_000);
        await edit(23);
        if (!(await evaluate(`${status}.pending && !${status}.swapped`))) fail(scene + ': full decode arrived before window history');
        await evaluate('window.__ncTwoStage.releaseFullDecodes()');
        await waitFor(scene + ': full swap', `${ready} && ${exact} && ${status}.settings.expiredAnalysis?.spatial`, 150_000);
        const results = {};
        for (const phase of ['live', 'undo', 'redo']) {
          if (phase !== 'live') {
            await evaluate(`document.getElementById('${phase}Btn').click(); window.__ncAnalysis.settle()`);
            await waitFor(scene + ': ' + phase, `${ready} && !window.__ncAnalysis.converting()
              && ${status}.settings.coreExposure === ${phase === 'undo' ? 19 : 23}
              && ${status}.settings.expiredAnalysis?.spatial`, 120_000);
          }
          const recipe = await evaluate(`${status}.settings`);
          const single = await exportFormats(scene + ' ' + phase, historyFormats);
          const all = await exportAllFormats(1, scene + ' ' + phase + ' batch', historyFormats);
          const batch = Object.fromEntries(Object.entries(all).map(([key, entries]) => [key, Object.values(entries)[0]]));
          sameExports(scene + ' ' + phase + ' actual single/batch', single, batch);
          same(scene + ' ' + phase + ' interpretation', [recipe.filmType, recipe.positiveMode], after);
          same(scene + ' ' + phase + ' automatic WB', [recipe.wbR, recipe.wbG, recipe.wbB], [1, 1, 1]);
          same(scene + ' ' + phase + ' explicit strengths', [recipe.expiredBrightness, recipe.expiredContrast], [17, 23]);
          if (recipe.semanticMap || recipe.rollFrame) fail(scene + ': retained old interpretation analysis');
          if (single.png8.layout?.bits?.[0] !== 8 || single.tiff16.layout?.bits?.[0] !== 16
            || !single.tiff16.lowBits) fail(scene + ': missing exact PNG8/true TIFF16 plane');
          results[phase] = { recipe, single, batch };
        }
        for (const [phase, result] of Object.entries(results)) {
          await openSaved(one, { ...result.recipe, expiredAnalysis: null, semanticMap: null,
            wbR: 1, wbG: 1, wbB: 1, wbAutoConfidence: null });
          const fresh = await exportFormats(scene + ' ' + phase + ' fresh full interpretation', historyFormats);
          sameExports(scene + ' ' + phase + ' exact fresh full samples/files', result.single, fresh);
          result.fresh = fresh;
        }
        console.log('interpretation full-swap history receipt:', JSON.stringify({ scene, before, after, results }));
        console.log(`ok: ${scene}: real saved automatic WB, RAW window/full install, Undo/Redo and exact current/batch/fresh PNG8/TIFF16`);
      }
    }

    if (runs('crop-interpretation-history')) await runInterpretationHistoryCropSmoke({ send, evaluate, waitFor, fail, boot,
      dir, file: cropFile, seedRecipe: reference.recipe, one, two, ready, status, exact,
      exportFormats, exportAllFormats, same, sameExports, formats: [FORMATS[0], FORMATS[2]] });

    // 6. Analyze roll during stage 2 (#255 review R2-029): the stand-in gets an
    // exposure edit, then Analyze roll is clicked while stage 2 is held. The
    // analysis persists the open photo's recipe and reads it back, so it waits
    // for the full decode. Compared with one decode given the same edit and
    // click: the roll recipe, automaticDefaults and the exports' samples. An
    // edit in the window comes before the photo's semantic colour pass could
    // answer (none runs on the stand-in), so in both runs its answer is held
    // until the roll analysis committed: one decode edited as soon as it
    // shows. One decode's export right after that Analyze roll can carry a
    // full-resolution render its edit armed, which lands after the roll's
    // conversion (audit backlog; the two-stage swap drops such renders), so
    // the exports are compared with one decode's render of the same recipe:
    // its Export All.
    if (runs('roll')) {
      const rollScene = async (query, sceneLabel, { recipeRender = false } = {}) => {
        const held = query !== one;
        await boot(query, { holdSemantic: true });
        if (held) await evaluate('window.__ncTwoStage.holdFullDecodes()');
        await importFiles([a, b]);
        await waitFor(`${sceneLabel}: first photo`, `${ready} && ${filename(nameA)} && ${held ? `${status}.pending` : exact}`, 900_000);
        await evaluate(editExposure);
        await waitFor(`${sceneLabel}: exposure edited`, `document.getElementById('coreExposureValue').value === '15' && ${ready}`, 30_000);
        await evaluate(`document.getElementById('analyzeRollBtn').click()`);
        if (held) {
          await wait(1500);
          const during = await evaluate(`({ status: ${status}, committed: ${rollCommitted} })`);
          if (!during.status.pending || !during.status.provisional) fail(`${sceneLabel}: Analyze roll did not wait for stage 2: ` + JSON.stringify(during.status));
          if (during.committed) fail(`${sceneLabel}: the roll analysis committed on the stand-in`);
          await evaluate('window.__ncTwoStage.releaseFullDecodes()');
        }
        await waitFor(`${sceneLabel}: roll analysis committed`, `${rollCommitted} && ${ready} && ${exact} && !!${status}.settings?.rollFrame`, 900_000);
        await evaluate(releaseSemantic);
        const settled = await settledPhoto();
        if (recipeRender) return { ...settled, render: await exportAllFormats(2, `${sceneLabel} recipe render`) };
        return { ...settled, exports: await exportFormats(`${sceneLabel}`, formats) };
      };
      const rollReference = await rollScene(one, `${label} roll reference`, { recipeRender: true });
      if (rollReference.recipe.coreExposure !== 15) fail(`${label}: the reference lost its exposure edit: ` + JSON.stringify(rollReference.recipe.coreExposure));
      const rollTwoStage = await rollScene(two, `${label} roll during stage 2`);
      console.log(`two-stage smoke ${label} roll analysis:`, JSON.stringify({ rollFrame: rollTwoStage.recipe.rollFrame, exports: short(rollTwoStage.exports) }));
      same(`${label}: the roll recipe after Analyze roll during stage 2`, rollTwoStage.recipe, rollReference.recipe);
      same(`${label}: automaticDefaults after Analyze roll during stage 2`, rollTwoStage.defaults, rollReference.defaults);
      // The same file of one decode's Export All, by name.
      const rendered = Object.fromEntries(Object.entries(rollTwoStage.exports).map(([key, entry]) => [key, rollReference.render[key]?.[entry.name] || null]));
      sameExports(`${label}: export after Analyze roll during stage 2`, rollTwoStage.exports, rendered, { bytes: false });
      console.log(`ok: ${label}: Analyze roll clicked during stage 2 waits for the full decode, and matches one decode with the same edit`);
    }

    // 7. A photo without a recipe whose base the prefetch slot holds (#243),
    // opened from it (its base adopted, no stages) or, with the caches
    // dropped, directly (two stages): the same recipe, automaticDefaults and
    // exports (#229 review R1-062). The other photo is opened first; the
    // lanes give A a tile (and a recipe, dropped before A is opened) and the
    // prefetch slot its base.
    if (runs('adopt')) {
      const openA = async adopt => {
        const route = adopt ? 'adopted' : 'direct';
        await boot(`${two}&debugCounters=1`);
        await importFiles([b, a]);
        await waitFor(`${label} ${route}: the other photo first`, `${ready} && ${filename(nameB)} && ${exact} && ${lanesReady}`, 900_000);
        await settledRecipe();
        await waitFor(`${label} ${route}: the next photo prefetched`, `window.__ncHiddenJobs.status().photoPrefetchBytes > 0 && ${lanesReady}`, 300_000);
        const plans = `window.__ncTwoStage.diagnostics.plans.filter(plan => plan.file === ${JSON.stringify(nameA)})`;
        const plansBefore = (await evaluate(plans)).length;
        const forgot = await evaluate(`(() => {
          const button = [...document.querySelectorAll('.file-list-name')].find(entry => entry.textContent.includes(${JSON.stringify(nameA)}));
          if (${!adopt}) window.__ncDebug.forgetPhotoCaches();
          const forgot = window.__ncHiddenJobs.forgetFrameSettings(Number(button.dataset.index));
          button.click();
          return forgot;
        })()`);
        if (!forgot) fail(`${label} ${route}: the photo's recipe could not be dropped`);
        await waitFor(`${label} ${route}: opened`, `${ready} && ${filename(nameA)} && ${exact}`, 900_000);
        const planned = (await evaluate(plans)).slice(plansBefore);
        console.log(`two-stage smoke ${label} ${route} open:`, JSON.stringify(planned));
        if (adopt ? planned.length !== 0 : planned.length !== 1 || planned[0].stages !== 2) fail(`${label}: the ${route} open took another route: ` + JSON.stringify(planned));
        const settled = await settledPhoto();
        return { ...settled, exports: await exportFormats(`${label} ${route}`, formats) };
      };
      const adopted = await openA(true);
      const direct = await openA(false);
      console.log(`two-stage smoke ${label} adopted and direct:`, JSON.stringify({ crop: adopted.recipe.cropRegion, angle: adopted.recipe.rotationAngle, filmBase: adopted.recipe.filmBase, exports: short(adopted.exports) }));
      same(`${label}: the recipe of the photo adopted from the prefetch slot (vs opened directly)`, adopted.recipe, direct.recipe);
      same(`${label}: automaticDefaults after the adopted open (vs opened directly)`, adopted.defaults, direct.defaults);
      sameExports(`${label}: exports of the photo adopted from the prefetch slot (vs opened directly)`, adopted.exports, direct.exports);
      console.log(`ok: ${label}: a photo without a recipe adopted from the prefetch slot gets the recipe and exports of a direct open`);
    }

    // 8. A failed stage 2 holds no background work (#255 review R2-033). With
    // three photos the lanes and the automatic roll import go on: the other
    // two get their thumbnails while the open photo stays provisional, its
    // stand-in neither persisted nor learned from (no roll forms without it).
    // An export then decodes again.
    if (runs('failure-lanes') && c) {
      const nameC = basename(c);
      await boot(two);
      await evaluate('window.__ncTwoStage.failNextFullDecodes(1)');
      await importFiles([a, b, c]);
      await waitFor(`${label} lanes: stage 2 failed`, `${ready} && ${filename(nameA)} && ${status}.fullDecode === 'failed'`, 900_000);
      const othersReady = `[...document.querySelectorAll('.file-list-name')].filter(button => !button.textContent.includes(${JSON.stringify(nameA)}))`
        + `.every(button => button.dataset.previewState === 'ready')`;
      await waitFor(`${label} lanes: thumbnails beside the failed stage 2`, othersReady, 120_000);
      const during = await evaluate(`({ status: ${status}, committed: ${rollCommitted}, tiles: [...document.querySelectorAll('.file-list-name')].map(button => [button.textContent.trim(), button.dataset.previewState]) })`);
      console.log(`two-stage smoke ${label} lanes after a failed stage 2:`, JSON.stringify({ fullDecode: during.status.fullDecode, pending: during.status.pending, tiles: during.tiles, committed: during.committed }));
      if (!during.status.pending || !during.status.provisional || during.status.fullDecode !== 'failed') fail(`${label}: the photo left the failed provisional state: ` + JSON.stringify(during.status));
      if (during.status.automaticDefaults?.[nameA]) fail(`${label}: learned from the stand-in: ` + JSON.stringify(during.status.automaticDefaults[nameA]));
      if (during.committed) fail(`${label}: a roll was analysed beside the failed stage 2 with ${nameB} and ${nameC} alone`);
      // An export decodes again and is the full decode's 16-bit image.
      const exported = await exportAs(['tiff', 16], `${label} lanes: export after the failure`);
      if (!(await evaluate(exact))) fail(`${label}: the export did not install the full decode`);
      if (exported.layout?.width * 2 <= reference.base.width || exported.layout?.bits?.some(bits => bits !== 16)) fail(`${label}: the export after the failure is not the full 16-bit image: ` + JSON.stringify(exported.layout));
      console.log(`ok: ${label}: a failed stage 2 lets the lanes and the roll import go on without persisting or sampling its stand-in`);
    }
  };

  try {
    // Two small CFA DNGs with SubIFD previews (stub JPEGs): 1600x1066 each.
    const size = { width: 1600, height: 1066 };
    const files = ['two-stage-a.dng', 'two-stage-b.dng'].map((name, i) => {
      const path = join(dir, name);
      writeSyntheticDng(path, { width: size.width, height: size.height, seed: 11 + i, kind: 'color' },
        previewSizes(size).map(preview => ({ ...preview, jpeg: stubJpeg(preview.width, preview.height) })));
      return path;
    });
    const twoStage = '&twoStageMinMp=1&twoStageMode=sequential';
    // A third photo for the lanes beside a failed stage 2.
    const third = join(dir, 'two-stage-c.dng');
    writeSyntheticDng(third, { width: size.width, height: size.height, seed: 17, kind: 'color' },
      previewSizes(size).map(preview => ({ ...preview, jpeg: stubJpeg(preview.width, preview.height) })));
    const cropFile = join(dir, 'two-stage-crop-hit.dng');
    writeCropHitDng(cropFile, size);
    await scenarios({ label: 'synthetic', a: files[0], b: files[1], c: third, cropFile, twoStage });
    // The paths 60 MP files take (#255 review R2-032): the full decode is
    // large (a separate preview source) and banded on export; the stand-in
    // is neither.
    const large = { width: 2800, height: 1866 };
    const largeFile = join(dir, 'two-stage-large.dng');
    writeSyntheticDng(largeFile, { ...large, seed: 13, kind: 'color' },
      previewSizes(large).map(preview => ({ ...preview, jpeg: stubJpeg(preview.width, preview.height) })));
    await scenarios({ label: 'synthetic, large-image paths', a: largeFile, b: files[1], twoStage, extra: '&largeImagePixels=2000000', only: ['settle', 'during'], duringFormats: [['png', 16]] });

    // Opt-in parity on real files: one decode against two stages at
    // TWO_STAGE_PARITY_MIN_MP (40 by default, the flag's target).
    const minMp = Number(process.env.TWO_STAGE_PARITY_MIN_MP) || 40;
    for (const path of parityFiles) {
      if (!existsSync(path)) fail('parity file missing: ' + path);
      const name = basename(path);
      console.log('two-stage parity:', name, 'at twoStageMinMp', minMp);
      await scenarios({ label: name, a: path, b: files[1], twoStage: `&twoStageMinMp=${minMp}` });
      console.log('ok: two stages match one decode in every scenario for', name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
