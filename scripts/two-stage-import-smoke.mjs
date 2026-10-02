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
// TWO_STAGE_SCENES (comma-separated: settle, during, crop, failure, leave,
// roll, adopt, failure-lanes) runs only those scenes.
//
// Opt-in, real files (never in the repo): TWO_STAGE_PARITY_FILES=/abs/a.DNG:/abs/b.dng
// runs the same scenarios for each file, with the second generated DNG as
// the other photo, at ?twoStageMinMp=TWO_STAGE_PARITY_MIN_MP (default 40, the
// flag's target). One 60 MP file at a time on a 16 GB machine.
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { writeSyntheticDng, previewSizes, stubJpeg } from './perf/fixtures.mjs';

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
      return { name, size: bytes.byteLength, sha256: await hex(bytes), decoded: await window.__twoStageDecoded(bytes), layout: window.__twoStageLayout(bytes) };
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

export async function runTwoStageImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root,
  parityFiles = (process.env.TWO_STAGE_PARITY_FILES || '').split(':').filter(Boolean) }) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-two-stage-'));
  const importFiles = async paths => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
  };
  const boot = async (query, { holdSemantic = false } = {}) => {
    const previous = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1${query}` });
    await waitFor('two-stage boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && !!window.__ncTwoStage`);
    await installDialogAutoAccept();
    await wait(800);
    await evaluate(CAPTURE);
    if (holdSemantic) await evaluate(SEMANTIC_HOLD);
  };
  const take = async label => {
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
  const exportAllFormats = async (count, label) => {
    const out = {};
    for (const format of FORMATS) {
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
  const scenarios = async ({ label, a, b, c = null, twoStage, extra = '', only = null, formats = FORMATS, duringFormats = formats }) => {
    const nameA = basename(a), nameB = basename(b);
    // TWO_STAGE_SCENES=adopt,failure-lanes runs only those scenes (their
    // references still run).
    const scenes = (process.env.TWO_STAGE_SCENES || '').split(',').filter(Boolean);
    const runs = name => (!only || only.includes(name)) && (!scenes.length || scenes.includes(name));
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
    await scenarios({ label: 'synthetic', a: files[0], b: files[1], c: third, twoStage });
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
