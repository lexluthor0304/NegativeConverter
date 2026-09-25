// Two-stage RAW imports (#255) in a real browser, on small generated CFA
// DNGs (scripts/perf/fixtures.mjs) with the threshold forced to 1 MP
// (?twoStageMinMp=1) and stage 2 held or failed through ?debug=1 hooks:
// - reference: the same files decoded once (the flag off): the settled
//   recipe and 8/16-bit PNG exports of the first, and an Export All in which
//   it was never opened (a photo left before its full decode is a fresh one);
// - two stages: a half-size stand-in (scale 0.5) shows first and the full
//   decode is installed behind it without studioBusy; the settled recipe and
//   every export are byte-identical to the reference;
// - an export clicked while stage 2 is held waits, then matches;
// - crop mode open when stage 2 lands: the swap waits for it to close;
// - stage 2 fails: a toast, the photo stays provisional, the export decodes
//   again and matches;
// - switching away before stage 2 completes aborts it, and Export All of both
//   photos matches the reference.
//
// Opt-in, real files (never in the repo): TWO_STAGE_PARITY_FILES=/abs/a.DNG:/abs/b.dng
// runs the same comparison (reference with the flag off, then
// ?twoStageMinMp=40) for each file: one 60 MP file at a time on a 16 GB machine.
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
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return;
    const href = this.href, name = this.download;
    pending.add(href);
    window.__twoStageDownloads.push(fetch(href).then(r => r.arrayBuffer()).then(async bytes => {
      pending.delete(href); revoke(href);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      return { name, size: bytes.byteLength, sha256: digest };
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

// The recipe fields #255 must keep equal to one full decode's.
const RECIPE_KEYS = ['cropRegion', 'rotationAngle', 'mirrored', 'filmBase', 'filmType', 'filmTypeSource', 'filmTypeConfidence',
  'filmTypeReason', 'wbR', 'wbG', 'wbB', 'wbAutoConfidence', 'filmEdge', 'autoFrameMeta', 'coreExposure', 'expiredAnalysis'];

export async function runTwoStageImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root,
  parityFiles = (process.env.TWO_STAGE_PARITY_FILES || '').split(':').filter(Boolean) }) {
  const dir = mkdtempSync(join(tmpdir(), 'nc-two-stage-'));
  const importFiles = async paths => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
  };
  const boot = async query => {
    const previous = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1${query}` });
    await waitFor('two-stage boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && !!window.__ncTwoStage`);
    await installDialogAutoAccept();
    await wait(800);
    await evaluate(CAPTURE);
  };
  const take = async label => {
    await waitFor(label, `window.__twoStageDownloads.length > 0`, 600_000);
    return evaluate(`window.__twoStageDownloads.shift()`);
  };
  const exportSingle = async (depth, label) => {
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
    await wait(200);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    const entry = await take(label);
    await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled`, 600_000);
    return entry.sha256;
  };
  const exportAll = async (count, label) => {
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click()`);
    await wait(200);
    await evaluate(`document.getElementById('exportAllBtn').click()`);
    const byName = {};
    for (let i = 0; i < count; i++) {
      const entry = await take(`${label} ${i + 1}/${count}`);
      byName[entry.name] = entry.sha256;
    }
    await waitFor('batch settled', `!document.querySelector('.loading-overlay.visible')`, 600_000);
    // By name: the queue order (and so the download order) may differ.
    return Object.fromEntries(Object.entries(byName).sort(([a], [b]) => a.localeCompare(b)));
  };
  // The settled recipe, once background passes (semantic colour) are done.
  const settledRecipe = async () => {
    let previous = null;
    for (let i = 0; i < 20; i++) {
      await waitFor('recipe settled', `${ready} && ${exact} && !${status}.semanticPending`, 600_000);
      const settings = await evaluate(`JSON.stringify(${status}.settings)`);
      if (settings === previous) return JSON.parse(settings);
      previous = settings;
      await wait(1000);
    }
    fail('the recipe did not settle');
  };
  const pick = settings => Object.fromEntries(RECIPE_KEYS.map(key => [key, settings?.[key] ?? null]));
  const same = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${label} differs from one full decode:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`);
  };
  const lanesReady = `[...document.querySelectorAll('.file-list-name')].every(button => button.dataset.previewState === 'ready')`;
  const clickStrip = name => evaluate(`[...document.querySelectorAll('.file-list-name')].find(button => button.textContent.includes(${JSON.stringify(name)})).click()`);
  const filename = name => `document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`;

  try {
    // Two small CFA DNGs with SubIFD previews (stub JPEGs): 1600x1066 each.
    const size = { width: 1600, height: 1066 };
    const files = ['two-stage-a.dng', 'two-stage-b.dng'].map((name, i) => {
      const path = join(dir, name);
      writeSyntheticDng(path, { width: size.width, height: size.height, seed: 11 + i, kind: 'color' },
        previewSizes(size).map(preview => ({ ...preview, jpeg: stubJpeg(preview.width, preview.height) })));
      return path;
    });
    const [nameA, nameB] = files.map(path => basename(path));

    // 1. References: each file decoded once. A opened alone; then B opened
    // with A never opened, the lanes done, and Export All.
    await boot('');
    await importFiles([files[0]]);
    await waitFor('reference import', `${ready} && ${filename(nameA)}`, 300_000);
    const reference = { recipe: pick(await settledRecipe()) };
    const plan = await evaluate(`window.__ncTwoStage.diagnostics.plans.at(-1)`);
    if (plan?.stages !== 1) fail('with the flag off a small DNG decodes once: ' + JSON.stringify(plan));
    reference.png8 = await exportSingle(8, 'reference PNG 8');
    reference.png16 = await exportSingle(16, 'reference PNG 16');
    await boot('');
    await importFiles([files[1], files[0]]);
    await waitFor('reference import B first', `${ready} && ${filename(nameB)} && ${lanesReady}`, 300_000);
    await settledRecipe();
    reference.all = await exportAll(2, 'reference Export All');
    console.log('two-stage smoke reference:', JSON.stringify({ crop: reference.recipe.cropRegion, png16: reference.png16.slice(0, 12), all: Object.keys(reference.all) }));

    // 2. Two stages, installed behind the stand-in without locking editing.
    await boot('&twoStageMinMp=1&twoStageMode=sequential');
    await evaluate('window.__ncTwoStage.holdFullDecodes()');
    await importFiles([files[0]]);
    await waitFor('stand-in shown', `${ready} && ${filename(nameA)} && ${status}.pending`, 300_000);
    const standIn = await evaluate(`({ status: ${status}, stage1: window.__ncTwoStage.diagnostics.stage1.at(-1), plan: window.__ncTwoStage.diagnostics.plans.at(-1) })`);
    if (standIn.plan?.stages !== 2) fail('the forced threshold did not plan two stages: ' + JSON.stringify(standIn.plan));
    if (standIn.stage1?.scale !== 0.5 || standIn.status.base?.width !== size.width / 2) fail('stage 1 is not a half-size stand-in: ' + JSON.stringify(standIn));
    if (!standIn.status.provisional) fail('the stand-in is not provisional');
    await evaluate(`window.__twoStageBusy.length = 0; window.__twoStageBusyWatch = true; window.__ncTwoStage.releaseFullDecodes()`);
    await waitFor('full decode installed', `${ready} && ${exact}`, 300_000);
    const installed = await evaluate(`({ status: ${status}, busy: window.__twoStageBusy.slice(), stage2: window.__ncTwoStage.diagnostics.stage2.at(-1), swaps: window.__ncTwoStage.diagnostics.swaps })`);
    await evaluate('window.__twoStageBusyWatch = false');
    console.log('two-stage smoke install:', JSON.stringify({ base: installed.status.base, stage2: installed.stage2, swaps: installed.swaps, busy: installed.busy.length }));
    if (installed.status.base?.width !== size.width || installed.status.base.scale !== 1) fail('the full decode was not installed: ' + JSON.stringify(installed.status));
    if (installed.stage2?.mode !== 'sequential') fail('forced sequential mode was not used: ' + JSON.stringify(installed.stage2));
    if (installed.busy.length) fail('the swap set studioBusy: ' + JSON.stringify(installed.busy));
    same('the settled recipe', pick(await settledRecipe()), reference.recipe);
    same('the 8-bit PNG export', await exportSingle(8, 'two-stage PNG 8'), reference.png8);
    same('the 16-bit PNG export', await exportSingle(16, 'two-stage PNG 16'), reference.png16);
    console.log('ok: two stages settle to the single decode\'s recipe and exports, without studioBusy');

    // 3. Export clicked while stage 2 is held: it waits, then matches.
    await boot('&twoStageMinMp=1&twoStageMode=sequential');
    await evaluate('window.__ncTwoStage.holdFullDecodes()');
    await importFiles([files[0]]);
    await waitFor('stand-in shown', `${ready} && ${status}.pending`, 300_000);
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click()`);
    await wait(200);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    await wait(1500);
    if (await evaluate('window.__twoStageDownloads.length')) fail('an export was written from the stand-in');
    if (!(await evaluate(`${status}.pending`))) fail('the photo left the provisional state while stage 2 was held');
    await evaluate('window.__ncTwoStage.releaseFullDecodes()');
    same('the export clicked during stage 2', (await take('export during stage 2')).sha256, reference.png16);
    await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled && ${exact}`, 300_000);
    console.log('ok: an export clicked during stage 2 waits for the full decode and matches');

    // 4. Crop mode open when stage 2 lands: the swap waits for it to close.
    await boot('&twoStageMinMp=1&twoStageMode=sequential');
    await evaluate('window.__ncTwoStage.holdFullDecodes()');
    await importFiles([files[0]]);
    await waitFor('stand-in shown', `${ready} && ${status}.pending`, 300_000);
    await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click()`);
    await waitFor('crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
    await evaluate('window.__ncTwoStage.releaseFullDecodes()');
    await wait(1500);
    const during = await evaluate(status);
    if (during.fullDecode === 'installed' || !during.provisional) fail('the full decode was installed under an open crop draft: ' + JSON.stringify(during));
    await evaluate(`document.getElementById('cancelCropBtn').click()`);
    await waitFor('installed after crop mode', `${ready} && ${exact}`, 300_000);
    same('the recipe after crop mode', pick(await settledRecipe()), reference.recipe);
    same('the export after crop mode', await exportSingle(16, 'export after crop mode'), reference.png16);
    console.log('ok: stage 2 landing during crop mode is installed when the draft closes');

    // 5. Stage 2 fails: a toast, still provisional, the export decodes again.
    await boot('&twoStageMinMp=1&twoStageMode=sequential');
    await evaluate('window.__ncTwoStage.failNextFullDecodes(1)');
    await importFiles([files[0]]);
    await waitFor('stage 2 failed', `${ready} && ${status}.fullDecode === 'failed'`, 300_000);
    const failed = await evaluate(`({ status: ${status}, toasts: window.__twoStageToasts.slice() })`);
    if (!failed.status.pending || !failed.status.provisional) fail('a failed stage 2 must leave the photo provisional: ' + JSON.stringify(failed.status));
    if (!failed.toasts.some(text => /Full resolution could not be loaded/.test(text))) fail('no failure toast: ' + JSON.stringify(failed.toasts));
    same('the export after a failed stage 2', await exportSingle(16, 'export after failure'), reference.png16);
    if (!(await evaluate(exact))) fail('the export did not install the full decode');
    console.log('ok: a failed stage 2 is reported, and the export decodes again and matches');

    // 6. Leaving before stage 2 completes aborts it; Export All matches.
    await boot('&twoStageMinMp=1&twoStageMode=sequential');
    await evaluate('window.__ncTwoStage.holdFullDecodes()');
    await importFiles(files);
    await waitFor('stand-in shown', `${ready} && ${filename(nameA)} && ${status}.pending`, 300_000);
    const abandonedBefore = await evaluate('window.__ncTwoStage.diagnostics.abandoned');
    await clickStrip(nameB);
    await waitFor('switched', `${filename(nameB)} && window.__ncTwoStage.diagnostics.abandoned > ${abandonedBefore}`, 60_000);
    await evaluate('window.__ncTwoStage.releaseFullDecodes()');
    await waitFor('second photo exact', `${ready} && ${filename(nameB)} && ${exact} && ${lanesReady}`, 300_000);
    await settledRecipe();
    const all = await exportAll(2, 'Export All after an early switch');
    same('Export All after leaving before stage 2', all, reference.all);
    console.log('ok: leaving before stage 2 aborts it, and Export All matches the single decodes');

    // Opt-in parity on real files: one decode against two stages at 40 MP.
    for (const path of parityFiles) {
      if (!existsSync(path)) fail('parity file missing: ' + path);
      const name = basename(path);
      const run = async query => {
        await boot(query);
        await importFiles([path]);
        await waitFor('parity import ' + name, `${ready} && ${filename(name)} && ${exact}`, 900_000);
        const recipe = pick(await settledRecipe());
        const plans = await evaluate('window.__ncTwoStage.diagnostics.plans.at(-1)');
        return { recipe, plans, png8: await exportSingle(8, 'parity PNG 8 ' + name), png16: await exportSingle(16, 'parity PNG 16 ' + name) };
      };
      const one = await run('');
      const two = await run('&twoStageMinMp=40');
      console.log('two-stage parity:', name, JSON.stringify({ one: one.plans, two: two.plans }));
      if (two.plans?.stages !== 2) console.log('note: not a two-stage file at 40 MP:', name);
      same(`${name}: settled recipe`, two.recipe, one.recipe);
      same(`${name}: 8-bit PNG`, two.png8, one.png8);
      same(`${name}: 16-bit PNG`, two.png16, one.png16);
      console.log('ok: two stages match one decode for', name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
