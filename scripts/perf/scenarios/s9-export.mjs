// S9 export, after the page settled (so semantic analysis and the idle
// full-resolution render cannot race the export): the current photo as PNG8/16,
// linear DNG, TIFF16 and JPEG with the gain map on and off, once as imported and once
// after a fixed geometry recipe (straighten, rotate 90°, mirror, crop); then
// Export All ZIP of --export-count non-current files (default 3). showSaveFilePicker and download
// anchors are captured by the probe. Timing repetitions only count bytes;
// the verification repetitions (?perf=1 on and off) send the bytes to the
// harness, which records SHA-256 of the decoded pixels.
import { readFileSync, rmSync } from 'node:fs';
import { byKind } from '../lib/metrics.mjs';
import { median } from '../lib/stats.mjs';
import { verifyDecodedExport } from '../lib/export-verify.mjs';
import { bootApp, recordRollRoutes, recordMemory, sleep, pageNow, clickElement, longTasks, allPictures, waitSettled, round } from './common.mjs';
import { importRoll, waitForRollBackground } from './s6-roll.mjs';

const META = process.platform === 'darwin' ? 4 : 2;
export const SINGLE_EXPORTS = [
  { id: 'png8', format: 'png', bitDepth: 8 },
  { id: 'png16', format: 'png', bitDepth: 16 },
  { id: 'dng', format: 'dng', bitDepth: 16 },
  { id: 'tiff16', format: 'tiff', bitDepth: 16 },
  { id: 'jpegGain', format: 'jpeg', gainMap: true },
  { id: 'jpegNoGain', format: 'jpeg', gainMap: false }
];
export const ZIP_EXPORTS = [
  { id: 'png8', format: 'png', bitDepth: 8 },
  { id: 'png16.lanes1', format: 'png', bitDepth: 16, lanes: 1 },
  { id: 'dng', format: 'dng', bitDepth: 16 },
  { id: 'tiff16', format: 'tiff', bitDepth: 16 },
  { id: 'jpegGain', format: 'jpeg', gainMap: true }
];
export const PARALLEL_EXPORTS = [{ id: 'png16.lanes3', format: 'png', bitDepth: 16, lanes: 3 }];
export const S9_STEPS = [
  { action: 'import-roll', current: 0, excludeCurrentFromZip: true },
  ...SINGLE_EXPORTS.flatMap(spec => ['imported', 'geometry'].map(recipe => ({ action: 'single-export', recipe, ...spec }))),
  ...ZIP_EXPORTS.map(spec => ({ action: 'zip-export', ...spec }))
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
  if (spec.format !== 'jpeg' && spec.format !== 'dng') {
    const depth = spec.bitDepth || 8;
    await session.waitFor(`${depth}-bit enabled`, `!document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').disabled`, { timeoutMs: 10_000, pollMs: 50 });
    await session.evaluate(`document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click(); true`);
    await session.waitFor(`${depth}-bit pressed`, `document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').getAttribute('aria-pressed') === 'true'`, { timeoutMs: 10_000, pollMs: 50 });
  } else if (spec.format === 'jpeg') {
    await session.evaluate(`(() => { const box = document.getElementById('exportHdrGainMap'); if (box.checked !== ${Boolean(spec.gainMap)}) box.click(); return box.checked; })()`);
  }
  if (spec.lanes) await session.evaluate(`localStorage.setItem('nc_batch_lanes_v1', ${JSON.stringify(String(spec.lanes))}); true`);
  await sleep(200);
}

function memoryNowMB(ctx) {
  const last = ctx.session.sampler?.samples.at(-1);
  return last ? Math.round(last.rendererBytes / 1024 / 1024) : null;
}

export async function runExport(ctx, prefix, spec, { buttonId, files = 1, verify, probeInputs }) {
  const { session } = ctx;
  await configureExport(ctx, spec);
  await session.evaluate('globalThis.__ncPerf.exports.clear(); true');
  const cyan = probeInputs ? await session.rect('#cyan') : null;
  const memoryBefore = memoryNowMB(ctx);
  const memoryFrom = session.memoryMark();
  await session.drain();
  const start = await session.beginWindow(prefix);
  if (prefix.includes('.single.')) {
    const shown = allPictures(session.events).filter(pic => pic.res && (pic.matchedBy === 'hash' || pic.kind !== 'draw')).at(-1);
    const displayed = shown && byKind(session.events, 'req').find(event => event.wid === shown.res.wid && event.id === shown.res.id);
    const cached = byKind(session.events, 'req').filter(event => event.cache && event.geometry).at(-1);
    const req = displayed?.geometry && (!cached || displayed.t > cached.t) ? displayed : cached;
    if (!req) throw new Error(`${prefix}: conversion geometry not captured`);
    for (const key of ['rotationAngle', 'mirrored', 'cropRegion']) ctx.record(`${prefix}.${key}`, JSON.stringify(req.geometry[key]));
  }
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
  if (!done) throw new Error(`${prefix}: export did not finish`);
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
    gpuPeakMB: memory?.gpuPeakMB ?? null,
    memoryAfter10sMB: memory?.rendererAfterMB ?? null
  };
  for (const [key, value] of Object.entries(out)) if (value !== null) ctx.record(`${prefix}.${key}`, value);
  const stages = exportStageMetrics(session.events, { start, end: endT, spec });
  for (const [key, value] of Object.entries(stages)) ctx.record(`${prefix}.${key}`, value);
  if (ctx.extra?.perfFlag !== false && spec.format === 'png' && spec.bitDepth === 16 && stages.encodeMs === undefined) {
    throw new Error(`${prefix}: png/16 encoding trace was not recorded`);
  }
  if (ctx.extra?.perfFlag !== false && spec.format === 'dng' && buttonId === 'exportZipBtn'
    && (stages.linearDngBuildMs === undefined || stages.blobMs === undefined)) {
    throw new Error(`${prefix}: linear DNG batch build/Blob traces were not recorded`);
  }
  if (spec.lanes && stages.lanes !== undefined && (spec.lanes === 1 ? stages.lanes !== 1 : stages.lanes < spec.lanes)) {
    throw new Error(`${prefix}: planner ran ${stages.lanes} lanes; requested coverage needs ${spec.lanes}`);
  }
  if (spec.lanes && stages.lanes === undefined) throw new Error(`${prefix}: batch lane count was not recorded`);
  if (verify) await verifyExports(ctx, prefix, done, spec, files);
  await session.evaluate('globalThis.__ncPerf.exports.clear(); true');
  return out;
}

/** App trace stages and native write windows, shared with the Tauri mapper. */
export function exportStageMetrics(events, { start = -Infinity, end = Infinity, spec = {} } = {}) {
  const inWindow = events.filter(event => event.t >= start && event.t <= end);
  const traces = byKind(inWindow, 'um');
  const result = {};
  const put = (key, values) => { const valid = values.filter(Number.isFinite); if (valid.length) result[key] = round(median(valid)); };
  put('encodeMs', traces.filter(event => event.n === 'nc:imageDataToBlob' && event.detail?.format === spec.format
    && (!spec.bitDepth || event.detail?.bitDepth === spec.bitDepth)).map(event => event.d));
  put('linearDngBuildMs', traces.filter(event => event.n === 'nc:linearDngBatch').map(event => event.detail?.stages?.find(stage => stage.stage === 'build')?.ms));
  put('linearDngTotalMs', traces.filter(event => event.n === 'nc:linearDngBatch').map(event => event.d));
  put('blobMs', traces.filter(event => event.n === 'nc:linearDngBatch').map(event => event.detail?.blobMs));
  put('lanes', traces.filter(event => event.n === 'nc:batchExport').map(event => event.detail?.lanes));
  const writes = byKind(inWindow, 'invoke.end').filter(event => event.cmd === 'finish_export_write' && !event.error && Number.isFinite(event.writeStart));
  put('desktopWriteMs', writes.map(event => event.t - event.writeStart));
  return result;
}

/** Stream the captured bytes to the harness and hash decoded pixels. */
async function verifyExports(ctx, prefix, list, spec, files) {
  const { session } = ctx;
  for (const entry of list) {
    const uploaded = await session.evaluate(`globalThis.__ncPerf.exports.upload(${entry.index}, '/__perf/export?name=' + encodeURIComponent(${JSON.stringify(entry.name)}))`, { timeoutMs: 600_000 });
    if (!uploaded?.ok) throw new Error(`${prefix}: export bytes not captured (${JSON.stringify(uploaded)})`);
    const file = ctx.takeUploadedExport(entry.name);
    if (!file) throw new Error(`${prefix}: uploaded export not found on disk`);
    try {
      const info = await verifyDecodedExport(new Uint8Array(readFileSync(file)), entry.name, bytes =>
        session.evaluate(`globalThis.__ncPerf.exports.jpegBytesSha256(${JSON.stringify(Buffer.from(bytes).toString('base64'))})`, { timeoutMs: 600_000 }));
      if (info.format === 'zip') {
        if (info.entries.length !== files) throw new Error(`${prefix}: ZIP contains ${info.entries.length} files, expected ${files}`);
        info.entries.forEach((item, i) => {
          if (!item.sha256) throw new Error(`${prefix}: ZIP entry ${item.name} has no decoded pixel hash`);
          if (spec.bitDepth === 16 && item.bitDepth !== 16) throw new Error(`${prefix}: requested 16-bit, ZIP entry ${item.name} says ${item.bitDepth}-bit`);
          if (item.sha256) ctx.hash(`${prefix}.entry${i}.pixelsSha256`, item.sha256);
          if (item.bitDepth) ctx.record(`${prefix}.entry${i}.bitDepth`, item.bitDepth);
          if (item.gainMap) ctx.hash(`${prefix}.entry${i}.gainMapSha256`, item.gainMap.sha256);
        });
      } else if (info.format === 'jpeg') {
        ctx.hash(`${prefix}.pixelsSha256`, info.sha256);
        if (info.gainMap) ctx.hash(`${prefix}.gainMapSha256`, info.gainMap.sha256);
        ctx.record(`${prefix}.hasGainMap`, String(Boolean(info.gainMap)));
      } else {
        ctx.hash(`${prefix}.pixelsSha256`, info.sha256);
        ctx.record(`${prefix}.bitDepth`, info.bitDepth);
        if (spec.bitDepth === 16 && info.bitDepth !== 16) throw new Error(`${prefix}: requested 16-bit, file header says ${info.bitDepth}-bit`);
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

const s9 = {
  id: 's9',
  title: 'Export',
  fixtureGroup: 'export',
  steps: S9_STEPS,
  // Separate single, ZIP and no-flag repetitions retain earlier hashes if
  // a later export aborts, without extending an already memory-heavy session.
  extraReps: [
    { label: 'verify', keepExportChunks: true, verify: true, only: SINGLE_EXPORTS.flatMap(spec => ['imported', 'geometry'].map(recipe => `single.${spec.id}.${recipe}`)) },
    { label: 'verify-zip', keepExportChunks: true, verify: true, only: ZIP_EXPORTS.map(spec => `zip.${spec.id}`) },
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

    // Export All as ZIP of the requested non-current files.
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
      for (const spec of ctx.zipExports || ZIP_EXPORTS) {
        const id = `zip.${spec.id}`;
        if (!wanted(id)) continue;
        await runExport(ctx, `s9.${id}`, spec, { buttonId: 'exportZipBtn', files: ctx.roll.length - 1, verify, probeInputs: !verify });
      }
    }
    await recordMemory(ctx, 's9', memoryFrom);
    await recordRollRoutes(ctx);
  }
};

// The >=3-lane path needs 24 MP frames; a 60 MP roll may correctly plan fewer
// lanes on this machine. Keep it a separate registry entry and fresh session.
export const s9Parallel = {
  ...s9, id: 's9-parallel', title: 'PNG16 ZIP with at least three lanes', fixtureGroup: 'export-parallel',
  steps: [{ action: 'import-roll', current: 0, excludeCurrentFromZip: true }, ...PARALLEL_EXPORTS.map(spec => ({ action: 'zip-export', ...spec }))],
  extraReps: [{ label: 'verify', keepExportChunks: true, verify: true, only: PARALLEL_EXPORTS.map(spec => `zip.${spec.id}`) }],
  async run(ctx) { return s9.run({ ...ctx, extra: { ...ctx.extra, only: PARALLEL_EXPORTS.map(spec => `zip.${spec.id}`) }, zipExports: PARALLEL_EXPORTS }); }
};
export default s9;
