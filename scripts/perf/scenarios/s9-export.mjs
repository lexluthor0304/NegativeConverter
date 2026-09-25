// S9 export, after the page settled (so semantic analysis and the idle
// full-resolution render cannot race the export): the current photo as PNG8,
// TIFF16 and JPEG with the gain map on and off, once as imported and once
// after a fixed geometry recipe (straighten, rotate 90°, mirror, crop); then
// Export All ZIP of 3 non-current files. showSaveFilePicker and download
// anchors are captured by the probe. Timing repetitions only count bytes;
// the verification repetitions (?perf=1 on and off) send the bytes to the
// harness, which records SHA-256 of the decoded pixels.
import { readFileSync, rmSync } from 'node:fs';
import { byKind } from '../lib/metrics.mjs';
import { verifyExport } from '../lib/export-verify.mjs';
import { bootApp, recordMemory, sleep, pageNow, clickElement, longTasks, allPictures, waitSettled, round } from './common.mjs';
import { importRoll, waitForRollBackground } from './s6-roll.mjs';

const META = process.platform === 'darwin' ? 4 : 2;
export const SINGLE_EXPORTS = [
  { id: 'png8', format: 'png', bitDepth: 8 },
  { id: 'tiff16', format: 'tiff', bitDepth: 16 },
  { id: 'jpegGain', format: 'jpeg', gainMap: true },
  { id: 'jpegNoGain', format: 'jpeg', gainMap: false }
];
export const ZIP_EXPORTS = [
  { id: 'png8', format: 'png', bitDepth: 8 },
  { id: 'tiff16', format: 'tiff', bitDepth: 16 },
  { id: 'jpegGain', format: 'jpeg', gainMap: true }
];

async function openExportMenu(ctx) {
  await ctx.session.evaluate(`(() => { const menu = document.getElementById('exportDropdownMenu'); if (!menu.classList.contains('show')) document.getElementById('exportBtn').click(); return true; })()`);
  await sleep(300);
}

/** Select format, bit depth and gain map; the 16-bit button syncs one frame later. */
async function configureExport(ctx, spec) {
  const { session } = ctx;
  await openExportMenu(ctx);
  await session.evaluate(`document.querySelector('.format-btn[data-format="${spec.format}"]').click(); true`);
  if (spec.format !== 'jpeg') {
    const depth = spec.bitDepth || 8;
    await session.waitFor(`${depth}-bit enabled`, `!document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').disabled`, { timeoutMs: 10_000, pollMs: 50 });
    await session.evaluate(`document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click(); true`);
    await session.waitFor(`${depth}-bit pressed`, `document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').getAttribute('aria-pressed') === 'true'`, { timeoutMs: 10_000, pollMs: 50 });
  } else {
    await session.evaluate(`(() => { const box = document.getElementById('exportHdrGainMap'); if (box.checked !== ${Boolean(spec.gainMap)}) box.click(); return box.checked; })()`);
  }
  await sleep(200);
}

function memoryNowMB(ctx) {
  const last = ctx.session.sampler?.samples.at(-1);
  return last ? Math.round(last.rendererBytes / 1024 / 1024) : null;
}

async function runExport(ctx, prefix, spec, { buttonId, files = 1, verify, probeInputs }) {
  const { session } = ctx;
  await configureExport(ctx, spec);
  await session.evaluate('globalThis.__ncPerf.exports.clear(); true');
  const cyan = probeInputs ? await session.rect('#cyan') : null;
  const memoryBefore = memoryNowMB(ctx);
  const memoryFrom = session.memoryMark();
  await session.drain();
  const start = await session.beginWindow(prefix);
  const clickT = await clickElement(ctx, buttonId);
  const deadline = Date.now() + 30 * 60 * 1000;
  let done = null;
  let lastProbe = 0;
  while (Date.now() < deadline) {
    session.check();
    const list = await session.evaluate('globalThis.__ncPerf.exports.list()');
    if (list.length && list.every(entry => entry.done)) { done = list; break; }
    if (cyan && Date.now() - lastProbe > 400) {
      lastProbe = Date.now();
      const x = cyan.x + cyan.width * 0.5, y = cyan.y + cyan.height / 2;
      await session.drag({ from: { x, y }, to: { x: x + 6, y }, steps: 3 }).catch(() => {});
    }
    await sleep(100);
  }
  const window = await session.endWindow();
  if (!done) { ctx.note(`${prefix}: export did not finish`); return null; }
  const endT = Math.max(...done.map(entry => entry.end || entry.t));
  const totalMs = round(endT - clickT);
  const tasks = longTasks(ctx, clickT, endT);
  const accepted = byKind(session.events, 'input').filter(event => event.type === 'input' && event.id === 'cyan' && event.t >= start && event.t <= endT).length;
  await sleep(10_000);
  const memory = session.memorySummary(memoryFrom);
  const out = {
    totalMs,
    msPerFile: round(totalMs / files),
    bytes: done.reduce((total, entry) => total + entry.size, 0),
    maxLongTaskMs: tasks.maxMs,
    longTaskCount: tasks.n,
    mainBusyPct: window.mainBusyPct,
    inputsAccepted: cyan ? accepted : null,
    memoryBeforeMB: memoryBefore,
    memoryPeakMB: memory?.rendererPeakMB ?? null,
    memoryAfter10sMB: memory?.rendererAfterMB ?? null
  };
  for (const [key, value] of Object.entries(out)) if (value !== null) ctx.record(`${prefix}.${key}`, value);
  if (verify) await verifyExports(ctx, prefix, done, spec);
  await session.evaluate('globalThis.__ncPerf.exports.clear(); true');
  return out;
}

/** Stream the captured bytes to the harness and hash decoded pixels. */
async function verifyExports(ctx, prefix, list, spec) {
  const { session } = ctx;
  for (const entry of list) {
    const uploaded = await session.evaluate(`globalThis.__ncPerf.exports.upload(${entry.index}, '/__perf/export?name=' + encodeURIComponent(${JSON.stringify(entry.name)}))`, { timeoutMs: 600_000 });
    if (!uploaded?.ok) { ctx.note(`${prefix}: export bytes not captured (${JSON.stringify(uploaded)})`); continue; }
    const file = ctx.takeUploadedExport(entry.name);
    if (!file) { ctx.note(`${prefix}: uploaded export not found on disk`); continue; }
    try {
      const info = verifyExport(new Uint8Array(readFileSync(file)), entry.name);
      if (info.format === 'zip') {
        info.entries.forEach((item, i) => {
          if (item.sha256) ctx.hash(`${prefix}.entry${i}.pixelsSha256`, item.sha256);
          if (item.bitDepth) ctx.record(`${prefix}.entry${i}.bitDepth`, item.bitDepth);
          if (item.gainMap) ctx.hash(`${prefix}.entry${i}.gainMapSha256`, item.gainMap.sha256);
        });
      } else if (info.format === 'jpeg') {
        const decoded = await session.evaluate(`globalThis.__ncPerf.exports.jpegSha256(${entry.index})`, { timeoutMs: 600_000 });
        if (decoded?.sha256) ctx.hash(`${prefix}.pixelsSha256`, decoded.sha256);
        if (info.gainMap) ctx.hash(`${prefix}.gainMapSha256`, info.gainMap.sha256);
        ctx.record(`${prefix}.hasGainMap`, String(Boolean(info.gainMap)));
      } else {
        ctx.hash(`${prefix}.pixelsSha256`, info.sha256);
        ctx.record(`${prefix}.bitDepth`, info.bitDepth);
        if (spec.bitDepth === 16 && info.bitDepth !== 16) ctx.note(`${prefix}: requested 16-bit, file header says ${info.bitDepth}-bit`);
      }
    } finally {
      rmSync(file, { force: true });
    }
  }
}

async function applyGeometryRecipe(ctx) {
  const { session } = ctx;
  const ready = () => session.waitForReady({ timeoutMs: 300_000 });
  // 1. Straighten: crop mode, ⌘-draw a line with a small tilt, apply.
  await clickElement(ctx, 'cropBtn');
  await sleep(1000);
  let area = await session.rect('#cropOverlay');
  const y = area.y + area.height * 0.4;
  await session.drag({ from: { x: area.x + area.width * 0.2, y }, to: { x: area.x + area.width * 0.75, y: y + area.height * 0.03 }, steps: 20, modifiers: META });
  await sleep(800);
  await clickElement(ctx, 'applyCropBtn');
  await sleep(1000);
  await ready();
  // 2. Rotate 90°. 3. Mirror.
  await clickElement(ctx, 'rotateRightBtn');
  await sleep(1000);
  await ready();
  await clickElement(ctx, 'mirrorBtn');
  await sleep(1000);
  await ready();
  // 4. Crop: pull the right and bottom edges in by 10 %.
  await clickElement(ctx, 'cropBtn');
  await sleep(1000);
  area = await session.rect('#cropOverlay');
  const east = await session.rect('#cropOverlay .crop-handle-e');
  await session.drag({ from: { x: east.x + east.width / 2, y: east.y + east.height / 2 }, to: { x: east.x + east.width / 2 - area.width * 0.1, y: east.y + east.height / 2 }, steps: 20 });
  const south = await session.rect('#cropOverlay .crop-handle-s');
  await session.drag({ from: { x: south.x + south.width / 2, y: south.y + south.height / 2 }, to: { x: south.x + south.width / 2, y: south.y + south.height / 2 - area.height * 0.1 }, steps: 20 });
  await sleep(500);
  await clickElement(ctx, 'applyCropBtn');
  await sleep(1000);
  await ready();
  await session.drain();
  return allPictures(session.events).at(-1) || null;
}

export default {
  id: 's9',
  title: 'Export',
  fixtureGroup: 'export',
  // Two extra repetitions after the timing ones: bytes are streamed to the
  // harness for decoded-pixel hashes, with the ?perf=1 hook on and off.
  extraReps: [
    { label: 'verify', keepExportChunks: true, verify: true },
    { label: 'verify-noflag', keepExportChunks: true, verify: true, perfFlag: false, only: ['single.png8.imported', 'single.tiff16.imported', 'single.jpegGain.imported'] }
  ],
  async run(ctx) {
    const { session } = ctx;
    const verify = Boolean(ctx.extra?.verify);
    const only = ctx.extra?.only || null;
    const wanted = id => !only || only.includes(id);
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    const before = memoryNowMB(ctx);
    await importRoll(ctx);
    // Make the fixture the current photo, then let everything settle.
    await session.evaluate(`document.querySelector('.file-list-name[data-index="0"]')?.click(); true`);
    await session.waitFor('fixture current', `document.getElementById('studioFilename')?.textContent === ${JSON.stringify(ctx.roll[0].name)} && document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, { timeoutMs: 600_000 });
    await waitForRollBackground(ctx, ctx.roll.length);
    await waitSettled(ctx, { from: await pageNow(ctx), timeoutMs: 120_000 });
    await session.evaluate('globalThis.__ncPerf.exports.install(); true');
    ctx.record('s9.memory.beforeExportMB', before);

    for (const recipe of ['imported', 'geometry']) {
      if (recipe === 'geometry') {
        if (only && !only.some(id => id.endsWith('.geometry'))) break;
        await applyGeometryRecipe(ctx);
        await waitSettled(ctx, { from: await pageNow(ctx), timeoutMs: 120_000 });
      }
      for (const spec of SINGLE_EXPORTS) {
        const id = `single.${spec.id}.${recipe}`;
        if (!wanted(id)) continue;
        await runExport(ctx, `s9.${id}`, spec, { buttonId: 'exportSingleBtn', verify, probeInputs: !verify });
      }
    }
    ctx.record('s9.memory.retainedAfterExportMB', memoryNowMB(ctx));

    // Export All as ZIP of the 3 non-current files.
    if (!only || only.some(id => id.startsWith('zip.'))) {
      await session.evaluate(`(() => {
        const current = document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index;
        document.querySelectorAll('.file-list-item').forEach(row => {
          const box = row.querySelector('.file-list-checkbox');
          const index = row.querySelector('.file-list-name')?.dataset.index;
          if (box && box.checked === (index === current)) box.click();
        });
        return true;
      })()`);
      await sleep(500);
      for (const spec of ZIP_EXPORTS) {
        const id = `zip.${spec.id}`;
        if (!wanted(id)) continue;
        await runExport(ctx, `s9.${id}`, spec, { buttonId: 'exportZipBtn', files: ctx.roll.length - 1, verify, probeInputs: !verify });
      }
    }
    await recordMemory(ctx, 's9', memoryFrom);
  }
};
