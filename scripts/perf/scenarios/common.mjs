// Shared steps for the Chrome scenarios. Every helper that moves the UI into
// position (reveal a control, reset a slider, open a panel) runs outside the
// measured window, so first-reveal layout work is never measured.

import {
  byKind, dragMetrics, eventTimingP95, longTaskSummary, rafGapSummary, importMetrics, settledAt, pictures, GL_CANVAS, CPU_CANVAS
} from '../lib/metrics.mjs';
import { round } from '../lib/stats.mjs';

// NC_PERF_TIME_SCALE=0 is for the harness's own tests (simulated sessions);
// real runs always wait the full time.
const TIME_SCALE = Number.isFinite(Number(process.env.NC_PERF_TIME_SCALE)) && process.env.NC_PERF_TIME_SCALE !== undefined ? Number(process.env.NC_PERF_TIME_SCALE) : 1;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms * TIME_SCALE));
export const THUMB_PX = 16;

export function appUrl(ctx, extra = '') {
  return `${ctx.origin}/?lang=en${ctx.perfFlag === false ? '' : '&perf=1'}${extra}`;
}

/** Warm HTTP and WASM caches with two loads, then the measured boot. */
export async function bootApp(ctx) {
  const { session } = ctx;
  for (let i = 0; i < 2; i++) await session.boot(appUrl(ctx));
  await sleep(500);
  const bootMs = await session.boot(appUrl(ctx));
  await sleep(1500); // main.js finishes wiring after the Studio appears
  return bootMs;
}

/** --film-type: pin the type through the film-type buttons before import. */
export async function pinFilmType(ctx) {
  if (!ctx.args.filmType || ctx.args.filmType === 'auto') return;
  await ctx.session.evaluate(`(() => {
    const auto = document.getElementById('importFilmTypeAuto');
    if (auto && auto.checked) auto.click();
    const button = document.querySelector('.film-type-btn[data-type=${JSON.stringify(ctx.args.filmType)}]');
    if (button && !button.classList.contains('active')) button.click();
    return true;
  })()`);
}

export async function pageNow(ctx) {
  return ctx.session.evaluate('performance.now()');
}

/** Wait until the page settles (no worker traffic for 2.5 s). Returns page time or null. */
export async function waitSettled(ctx, { from, timeoutMs = 90_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await ctx.session.drain();
    const now = await pageNow(ctx);
    const settled = settledAt(ctx.session.events, from, { until: now });
    if (settled !== null) return settled;
    await sleep(500);
  }
  return null;
}

export function changeTime(events, after = -Infinity) {
  return byKind(events, 'input').find(event => event.type === 'change' && event.id === 'fileInput' && event.t >= after)?.t ?? null;
}

export function routeLabel(req) {
  if (!req) return null;
  if (req.ft === 'positive') return req.pe === 'legacy' ? 'positive-legacy' : 'positive';
  return req.ft || 'color';
}

/** Film type and conversion route of the current photo. */
export async function recordRoute(ctx, prefix, photo) {
  const snapshot = await ctx.session.evaluate('globalThis.__ncPerf ? globalThis.__ncPerf.snapshot() : null');
  const req = byKind(ctx.session.events, 'req').filter(event => event.cls === 'convert').pop();
  const entry = { photo: photo || snapshot?.filename || '?', filmType: snapshot?.filmType || null, route: routeLabel(req), status: snapshot?.filmTypeStatus || null };
  ctx.routes.push(entry);
  if (prefix) {
    ctx.record(`${prefix}.filmType`, entry.filmType);
    ctx.record(`${prefix}.route`, entry.route);
  }
  return entry;
}

/**
 * Boot, import files, wait for the first photo to be ready (and settled).
 * Returns the S1-style import metrics.
 */
export async function importPhotos(ctx, paths, { settle = true, window = 'import', readyTimeoutMs = 600_000 } = {}) {
  const { session } = ctx;
  await pinFilmType(ctx);
  await session.drain();
  const before = await pageNow(ctx);
  await session.beginWindow(window);
  await session.setFiles(paths);
  // Probe-free control measure (also taken with --no-probe): ready by 100 ms polling.
  const readyByPollMs = await session.waitFor('first photo ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !!document.getElementById('studioFilename')?.textContent`, { timeoutMs: readyTimeoutMs });
  await session.drain();
  const changeT = changeTime(session.events, before);
  const settledT = settle ? await waitSettled(ctx, { from: changeT ?? before }) : null;
  const windowData = await session.endWindow();
  const metrics = importMetrics(session.events, { changeT: changeT ?? before, until: settledT ?? Infinity });
  metrics.window = windowData;
  metrics.readyByPollMs = readyByPollMs;
  metrics.changeT = changeT ?? before;
  metrics.settledT = settledT;
  return metrics;
}

export function recordImportMetrics(ctx, prefix, metrics) {
  const keys = ['firstPixelsDrawnMs', 'firstPhotoVisibleMs', 'firstPositiveVisibleMs', 'readyMs', 'settledMs', 'librawDecodes', 'changeToLibrawOpenMs'];
  for (const key of keys) ctx.record(`${prefix}.${key}`, metrics[key]);
  ctx.record(`${prefix}.longTaskCount`, metrics.longTasks.n);
  ctx.record(`${prefix}.longTaskTotalMs`, metrics.longTasks.totalMs);
  ctx.record(`${prefix}.maxLongTaskMs`, metrics.longTasks.maxMs);
  if (metrics.window?.mainBusyPct !== undefined) ctx.record(`${prefix}.mainBusyPct`, metrics.window.mainBusyPct);
  ctx.record(`${prefix}.control.readyByPollMs`, metrics.readyByPollMs);
  ctx.record(`${prefix}.control.mainBusyPct`, metrics.window?.mainBusyPct);
  ctx.record(`${prefix}.control.scriptMs`, metrics.window?.scriptMs);
  // Stage columns of the 2026-09-23 S1 table: the first request of each kind.
  const stage = (predicate) => metrics.stages.find(predicate)?.ms ?? null;
  ctx.record(`${prefix}.stage.librawDecodeMs`, stage(entry => entry.cls === 'libraw' && entry.fn === 'imageData'));
  // Before #232 the shared sensor-defect worker got 'suppress'; since then a
  // per-decode worker gets one 'process' request (pack, defects, mirror, stats).
  ctx.record(`${prefix}.stage.sensorDefectsMs`, stage(entry => entry.cls === 'suppress'));
  ctx.record(`${prefix}.stage.rawPostDecodeMs`, stage(entry => entry.cls === 'process'));
  ctx.record(`${prefix}.stage.autoFrameMs`, stage(entry => entry.cls === 'analyze-frame'));
  ctx.record(`${prefix}.stage.filmEdgeMs`, stage(entry => entry.cls === 'read-film-edge'));
  ctx.record(`${prefix}.stage.scanDecodeMs`, stage(entry => entry.cls === 'decode'));
  ctx.record(`${prefix}.stage.previewConvertMs`, stage(entry => entry.cls === 'convert'));
  ctx.raw[`${prefix}.stages`] = metrics.stages;
  ctx.raw[`${prefix}.measures`] = metrics.measures;
}

export async function recordMemory(ctx, prefix, from) {
  const summary = ctx.session.memorySummary(from);
  if (!summary) return null;
  for (const [key, value] of Object.entries(summary)) if (key !== 'samples') ctx.record(`${prefix}.memory.${key}`, value);
  const heap = await ctx.session.heapAfterGcMB();
  ctx.record(`${prefix}.memory.jsHeapAfterGcMB`, heap);
  return summary;
}

/** Long tasks from the Long Tasks API (Chrome) or timer gaps (WebKit). */
export function longTasks(ctx, start, end) {
  return longTaskSummary(ctx.session.events, start, end);
}

function inputsBetween(events, start, end, predicate = () => true) {
  return byKind(events, 'input').filter(event => event.t >= start && event.t <= end && predicate(event));
}

/**
 * One slider drag: 180 trusted moves at 60 Hz over 40 % of the track, then
 * 3 s of observation. Records `${prefix}.<metric>`.
 */
export async function dragSlider(ctx, id, prefix, { cpu = false, observeMs = 3000 } = {}) {
  const { session } = ctx;
  const rect = await session.reveal(id);
  const info = await session.evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return { value: e.value, min: Number(e.min || 0), max: Number(e.max || 100) }; })()`);
  const span = rect.width - THUMB_PX;
  const fraction = (Number(info.value) - info.min) / Math.max(1e-9, info.max - info.min);
  const x0 = rect.x + THUMB_PX / 2 + fraction * span;
  const y = rect.y + rect.height / 2;
  const direction = fraction <= 0.5 ? 1 : -1;
  const x1 = x0 + direction * 0.4 * span;
  await sleep(500);
  await session.drain();
  const windowStart = await session.beginWindow(`${prefix}`);
  await session.drag({ from: { x: x0, y }, to: { x: x1, y }, steps: 180 });
  await sleep(500);
  const window = await session.endWindow();
  // Probe-free control measures, comparable between probe and --no-probe runs.
  ctx.record(`${prefix}.control.mainBusyPct`, window.mainBusyPct);
  ctx.record(`${prefix}.control.scriptMs`, window.scriptMs);
  await sleep(Math.max(0, observeMs - 500));
  if (!ctx.args.probe && !ctx.extra) { await resetSlider(ctx, id, info.value); return null; }
  await session.drain();
  const events = session.events;
  const press = inputsBetween(events, windowStart, Infinity, event => event.type === 'mousedown')[0];
  const release = press ? inputsBetween(events, press.t, Infinity, event => event.type === 'mouseup')[0] : null;
  if (!press || !release) {
    ctx.note(`${prefix}: no trusted press/release recorded on #${id}`);
    await resetSlider(ctx, id, info.value);
    return null;
  }
  const metrics = dragMetrics(events, {
    targetId: id, canvasId: cpu ? CPU_CANVAS : GL_CANVAS, initialValue: info.value, frameTimes: window.frames,
    window: { start: press.t, release: release.t, end: release.t + observeMs }
  });
  const values = inputsBetween(events, press.t, release.t, event => event.type === 'input' && event.id === id);
  const firstInput = values[0]?.t ?? press.t;
  const lastInput = values.at(-1)?.t ?? release.t;
  const tasks = longTasks(ctx, firstInput, lastInput + 500);
  const gaps = rafGapSummary(window.frames);
  const texture = byKind(events, 'gl.upload').filter(upload => upload.c === GL_CANVAS && upload.w * upload.h > 65536 && upload.t >= press.t && upload.t <= release.t).pop();
  const out = {
    ...metrics,
    previewWidth: texture?.w ?? null,
    previewHeight: texture?.h ?? null,
    eventTimingP95Ms: eventTimingP95(events, { start: press.t, end: release.t + 500, inputCount: metrics.inputs }),
    mainBusyPct: window.mainBusyPct,
    longTaskCount: tasks.n,
    longTaskTotalMs: tasks.totalMs,
    maxLongTaskMs: tasks.maxMs,
    rafGapsOver50: gaps.gapsOver,
    rafFps: gaps.fps,
    probeSelfPct: window.probeSelfPct
  };
  for (const [key, value] of Object.entries(out)) ctx.record(`${prefix}.${key}`, value);
  await resetSlider(ctx, id, info.value);
  return out;
}

export async function resetSlider(ctx, id, value) {
  await ctx.session.evaluate(`(() => {
    const e = document.getElementById(${JSON.stringify(id)});
    e.value = ${JSON.stringify(String(value))};
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(1500);
  await ctx.session.waitForReady({ timeoutMs: 120_000 });
}

/** Turn the WebGL display path on or off through #coreUseWebGL. */
export async function setWebGl(ctx, enabled) {
  await ctx.session.reveal('coreUseWebGL');
  await ctx.session.evaluate(`(() => { const box = document.getElementById('coreUseWebGL'); if (box.checked !== ${enabled}) box.click(); return box.checked; })()`);
  await sleep(1500);
  await ctx.session.waitForReady({ timeoutMs: 300_000 });
}

/** All pictures on either display canvas, time-ordered. */
export function allPictures(events) {
  return [...pictures(events, GL_CANVAS), ...pictures(events, CPU_CANVAS)].sort((a, b) => a.t - b.t);
}

/** First event of `type` on `id` at or after `after` (page time). */
export function firstInput(events, type, { id = null, after = -Infinity } = {}) {
  return byKind(events, 'input').find(event => event.type === type && event.t >= after && (id === null || event.id === id)) || null;
}

/** Click an element by id with trusted input; returns the click's page time. */
export async function clickElement(ctx, id, { reveal = false } = {}) {
  const rect = reveal ? await ctx.session.reveal(id) : await ctx.session.rect(`#${id}`);
  if (!rect || !rect.width) throw new Error(`#${id} is not visible`);
  const before = await pageNow(ctx);
  await ctx.session.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await ctx.session.drain();
  return firstInput(ctx.session.events, 'click', { id, after: before })?.t ?? before;
}

export function sourceWidthEstimate(events, fallback) {
  const frame = byKind(events, 'res').filter(res => res.cls === 'analyze-frame' && res.crop).pop();
  if (frame) return { width: frame.crop.w, method: 'auto-frame crop' };
  const raw = byKind(events, 'res').filter(res => (res.cls === 'libraw' || res.cls === 'decode') && res.w).pop();
  if (raw) return { width: raw.w, method: `${raw.cls} result` };
  return { width: fallback, method: 'fixture width' };
}

export { round };
