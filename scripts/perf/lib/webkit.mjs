// WebKit modes (docs/performance-benchmark.md, "WebKit").
//
// --browser safari: safaridriver with W3C Perform Actions (trusted pointer,
//   key and wheel input); S1, S2, S4 and S7. The probe comes from the preview
//   server (index.html?perf=1) and fixtures from its /__perf/fixtures route,
//   imported by the probe through DataTransfer (memory-backed File: its size
//   adds to the WebContent footprint, which results label). Safari runs at
//   the display's DPR.
// --browser tauri: the macOS desktop app's real WKWebView loads the harness
//   preview server (never the dev server) through `tauri dev --release
//   --no-watch` with devUrl overridden; the probe self-drives S1, S2 and S7
//   (synthetic input, labelled) and posts raw events to /__perf/results.
// Both: rAF and timer gaps stand in for long tasks (WebKit ships neither
// LoAF nor the Long Tasks API), Event Timing where available, and
// phys_footprint of com.apple.WebKit.WebContent / .GPU. A probe worker
// reports main-thread silences; the harness then samples WebContent.

import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebDriverSession, startSafariDriver, KEY } from './webdriver.mjs';
import { FootprintReader, MemorySampler, findWebKitProcesses } from './memory.mjs';
import {
  byKind, dragMetrics, importMetrics, switchMetrics, zoomStepMetrics, panMetrics, busyFromTimerTicks, timerGapSummary,
  rafGapSummary, eventTimingP95, settledAt
} from './metrics.mjs';
import { summarizeRepetitions, median, round } from './stats.mjs';
import { compareRuns, collectRunSummaries, renderCompareMarkdown } from './compare.mjs';
import { readSwapUsage, readPowerConditions } from './guards.mjs';
import { git } from './worktree.mjs';
import { S2_SLIDERS } from '../scenarios/s2-sliders.mjs';

import { sleep } from '../scenarios/common.mjs';

export const WEBKIT_SCENARIOS = { safari: ['s1', 's2', 's4', 's7'], tauri: ['s1', 's2', 's7'] };

const REVEAL = `
  const element = document.getElementById(arguments[0]);
  if (!element) return null;
  const pane = element.closest('.studio-pane');
  if (pane && pane.hidden) document.getElementById('studioTab-' + pane.id.replace('studioPane-', ''))?.click();
  for (let d = element.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
  element.scrollIntoView({ block: 'center' });
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, value: element.value, min: Number(element.min || 0), max: Number(element.max || 100) };`;
const READY_EXPR = `(document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.querySelector('.loading-overlay.visible'))`;
const READY = `return ${READY_EXPR};`;

/** WebKit long-task proxies from a probe window. */
export function webkitWindowMetrics(window) {
  const gaps = timerGapSummary(window.ticks);
  const frames = rafGapSummary(window.frames);
  return {
    timerGapCount: gaps.n, maxTimerGapMs: gaps.maxMs, rafGapsOver50: frames.gapsOver, rafFps: frames.fps,
    mainBusyPct: busyFromTimerTicks(window.ticks, { start: window.start, end: window.end })
  };
}

/** Metrics of a self-driven (Tauri) report, keyed like the Chrome scenarios. */
export function metricsFromSelfDriven(report) {
  const metrics = {};
  const put = (key, value) => { if (value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value))) metrics[key] = value; };
  const scenario = report.scenario;
  for (const part of report.parts || []) {
    const events = (part.events || []).slice().sort((a, b) => a.t - b.t);
    const window = part.window || { frames: [], ticks: [] };
    if (part.name === 'import') {
      const changeT = byKind(events, 'input').find(event => event.type === 'change' && event.id === 'fileInput')?.t ?? part.before;
      const m = importMetrics(events, { changeT });
      for (const key of ['firstPixelsDrawnMs', 'firstPhotoVisibleMs', 'firstPositiveVisibleMs', 'readyMs', 'librawDecodes']) put(`${scenario}.${key}`, m[key]);
      for (const [key, value] of Object.entries(webkitWindowMetrics(window))) put(`${scenario}.${key}`, value);
    } else if (part.name.startsWith('drag:')) {
      const dpr = Math.round(report.dpr || 2);
      const m = dragMetrics(events, { targetId: part.id, window: { start: part.start, release: part.release, end: part.release + 3000 }, initialValue: part.initial, frameTimes: window.frames, allowUntrusted: true });
      for (const [key, value] of Object.entries({ ...m, ...webkitWindowMetrics(window) })) put(`s2.${part.id}.dpr${dpr}.${key}`, value);
    } else if (part.name.startsWith('switch:')) {
      const m = switchMetrics(events, { keyT: part.keyT, target: part.target, until: Infinity });
      for (const key of ['firstPixelsMs', 'firstDisplayPositiveMs', 'readyMs', 'librawDecodes']) put(`s7.${part.cls}.${key}#${part.index}`, m[key]);
    }
  }
  // Several samples of one switch class: the median, like the Chrome S7.
  const grouped = {};
  for (const [key, value] of Object.entries(metrics)) {
    const at = key.indexOf('#');
    if (at < 0) continue;
    (grouped[key.slice(0, at)] ||= []).push(value);
    delete metrics[key];
  }
  for (const [key, values] of Object.entries(grouped)) metrics[key] = round(median(values));
  return metrics;
}

async function webkitMemory(label) {
  const reader = new FootprintReader();
  await reader.start();
  const sampler = new MemorySampler({
    reader,
    resolvePids: async () => {
      const found = await findWebKitProcesses();
      return { renderer: found.webContent, gpu: found.gpu, other: found.networking };
    }
  });
  sampler.start();
  return {
    summary: () => sampler.summary(),
    stop: () => { sampler.stop(); reader.stop(); },
    label
  };
}

function watchHeartbeats(resultsDir, onSilence) {
  const seen = new Set();
  const timer = setInterval(() => {
    if (!existsSync(resultsDir)) return;
    for (const file of readdirSync(resultsDir)) {
      if (!file.startsWith('heartbeat-') || seen.has(file)) continue;
      seen.add(file);
      try { onSilence(JSON.parse(readFileSync(join(resultsDir, file), 'utf8'))); } catch {}
    }
  }, 1000);
  return () => clearInterval(timer);
}

async function sampleWebContent(outDir, label) {
  const { webContent } = await findWebKitProcesses();
  return Promise.all(webContent.map(pid => new Promise(resolve => {
    const file = join(outDir, `hang-${label}-sample-${pid}.txt`);
    execFile('sample', [String(pid), '3', '-file', file], { timeout: 30_000 }, error => resolve(error ? { pid, error: error.message } : { pid, file }));
  })));
}

// ---- Safari ----

async function safariPoll(wd, script, { timeoutMs = 600_000, pollMs = 100 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await wd.execute(script)) return true;
    await sleep(pollMs);
  }
  throw new Error(`Safari: timed out waiting (${script.slice(0, 80)})`);
}

async function safariDrain(wd, events) {
  const out = await wd.execute('return globalThis.__ncPerf ? globalThis.__ncPerf.drain() : null');
  if (out) { events.push(...out.events); events.sort((a, b) => a.t - b.t); }
  return out;
}

async function safariBoot(wd, origin) {
  for (let i = 0; i < 3; i++) {
    await wd.navigate(`${origin}/?lang=en&perf=1`);
    await safariPoll(wd, `return !!document.getElementById('studioImportAutoCrop') && document.body.classList.contains('studio') && !!globalThis.__ncPerf;`, { timeoutMs: 120_000 });
  }
  await sleep(1500);
}

async function safariImport(wd, names, events) {
  await safariDrain(wd, events);
  events.length = 0;
  await wd.execute(`globalThis.__ncPerf.beginWindow('import'); return true;`);
  const before = await wd.execute('return performance.now()');
  await wd.executeAsync(`const done = arguments[arguments.length - 1]; globalThis.__ncPerf.importFixtures(arguments[0]).then(done, error => done(String(error)));`, [names]);
  await safariPoll(wd, READY, { timeoutMs: 1_800_000 });
  const started = Date.now();
  let settled = null;
  while (Date.now() - started < 90_000 && settled === null) {
    await safariDrain(wd, events);
    settled = settledAt(events, before, { until: await wd.execute('return performance.now()') });
    if (settled === null) await sleep(500);
  }
  const window = await wd.execute('return globalThis.__ncPerf.endWindow()');
  await safariDrain(wd, events);
  const changeT = byKind(events, 'input').find(event => event.type === 'change' && event.id === 'fileInput')?.t ?? before;
  return { metrics: importMetrics(events, { changeT, until: settled ?? Infinity }), window, changeT };
}

async function safariDrag(wd, events, id, prefix, record) {
  const info = await wd.execute(REVEAL, [id]);
  if (!info) { record(`${prefix}.missing`, 1); return; }
  await sleep(500);
  const span = info.width - 16;
  const fraction = (Number(info.value) - info.min) / Math.max(1e-9, info.max - info.min);
  const x0 = info.x + 8 + fraction * span, y = info.y + info.height / 2;
  const x1 = x0 + (fraction <= 0.5 ? 1 : -1) * 0.4 * span;
  await safariDrain(wd, events);
  const start = await wd.execute(`return globalThis.__ncPerf.beginWindow(${JSON.stringify(prefix)})`);
  await wd.drag({ from: { x: x0, y }, to: { x: x1, y }, steps: 180 });
  await sleep(500);
  const window = await wd.execute('return globalThis.__ncPerf.endWindow()');
  await sleep(2500);
  await safariDrain(wd, events);
  const inputs = byKind(events, 'input').filter(event => event.t >= start);
  const press = inputs.find(event => event.type === 'mousedown');
  const release = press ? inputs.find(event => event.type === 'mouseup' && event.t >= press.t) : null;
  if (!press || !release) { record(`${prefix}.noTrustedInput`, 1); return; }
  const m = dragMetrics(events, { targetId: id, window: { start: press.t, release: release.t, end: release.t + 3000 }, initialValue: info.value, frameTimes: window.frames });
  const out = { ...m, ...webkitWindowMetrics(window), eventTimingP95Ms: eventTimingP95(events, { start: press.t, end: release.t + 500, inputCount: m.inputs }) };
  for (const [key, value] of Object.entries(out)) record(`${prefix}.${key}`, value);
  await wd.execute(`const e = document.getElementById(arguments[0]); e.value = arguments[1]; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true;`, [id, info.value]);
  await sleep(1500);
  await safariPoll(wd, READY);
}

export async function safariScenario(id, { wd, origin, fixture, roll, record, note }) {
  const events = [];
  await safariBoot(wd, origin);
  const dpr = Math.round(await wd.execute('return devicePixelRatio'));
  if (id === 's1') {
    const { metrics, window } = await safariImport(wd, [fixture.name], events);
    for (const key of ['firstPixelsDrawnMs', 'firstPhotoVisibleMs', 'firstPositiveVisibleMs', 'readyMs', 'settledMs', 'librawDecodes', 'changeToLibrawOpenMs']) record(`s1.${key}`, metrics[key]);
    for (const [key, value] of Object.entries(webkitWindowMetrics(window))) record(`s1.${key}`, value);
    return;
  }
  if (id === 's2') {
    await safariImport(wd, [fixture.name], events);
    for (const slider of S2_SLIDERS) await safariDrag(wd, events, slider, `s2.${slider}.dpr${dpr}`, record);
    return;
  }
  if (id === 's4') {
    await safariImport(wd, [fixture.name], events);
    const rect = await wd.execute(`const r = document.getElementById('canvasContainer').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };`);
    const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
    await safariDrain(wd, events);
    let before = await wd.execute('return performance.now()');
    await wd.click(cx, cy, { count: 2 });
    await sleep(3000);
    await safariDrain(wd, events);
    const dbl = byKind(events, 'input').find(event => event.type === 'dblclick' && event.t >= before);
    const snap = await wd.execute('return globalThis.__ncPerf.snapshot()');
    const zoom = zoomStepMetrics(events, { inputT: dbl?.t ?? before, until: (dbl?.t ?? before) + 3000, sourceWidth: fixture.width || Infinity, displayedCssWidth: snap.glCanvas?.rect?.width, dpr });
    for (const [key, value] of Object.entries(zoom)) record(`s4.dpr${dpr}.fitTo2x.${key}`, value);
    await wd.execute(`if (document.getElementById('canvasContainer')?.classList.contains('zoom-pan-active')) document.getElementById('zoomResetBtn')?.click(); return true;`);
    await sleep(800);
    try {
      before = await wd.execute('return performance.now()');
      await wd.wheel(cx, cy, -60, 24);
      await sleep(1000);
      await safariDrain(wd, events);
      const wheels = byKind(events, 'input').filter(event => event.type === 'wheel' && event.t >= before);
      const transforms = byKind(events, 'mut').filter(event => event.what === 'transform' && event.t >= before);
      const perNotch = wheels.map(wheel => transforms.find(mutation => mutation.t >= wheel.t)).map((mutation, i) => (mutation ? mutation.t - wheels[i].t : null)).filter(Number.isFinite);
      record(`s4.dpr${dpr}.wheel.transformAppliedMs`, round(median(perNotch)));
    } catch (error) {
      note(`Safari wheel actions unavailable: ${error.message}`);
    }
    await wd.execute(`if (document.getElementById('canvasContainer')?.classList.contains('zoom-pan-active')) document.getElementById('zoomResetBtn')?.click(); return true;`);
    await sleep(800);
    await wd.click(cx, cy, { count: 2 });
    await sleep(1500);
    await safariDrain(wd, events);
    before = await wd.execute(`return globalThis.__ncPerf.beginWindow('pan')`);
    await wd.drag({ from: { x: cx - 120, y: cy }, to: { x: cx + 120, y: cy + 40 }, steps: 120 });
    await sleep(500);
    const window = await wd.execute('return globalThis.__ncPerf.endWindow()');
    await safariDrain(wd, events);
    const moves = byKind(events, 'input').filter(event => event.type === 'mousemove' && event.b && event.t >= before);
    const pan = panMetrics(events, { start: moves[0]?.t ?? before, end: moves.at(-1)?.t ?? window.end, frameTimes: window.frames });
    record(`s4.dpr${dpr}.pan.transformFramesPerSecond`, pan.transformFramesPerSecond);
    record(`s4.dpr${dpr}.pan.moveToFrameP95Ms`, pan.moveToFrameP95Ms);
    for (const [key, value] of Object.entries(webkitWindowMetrics(window))) record(`s4.dpr${dpr}.pan.${key}`, value);
    return;
  }
  if (id === 's7') {
    await safariImport(wd, roll.map(entry => entry.name), events);
    const plan = [{ to: 1, cls: 'coldUnanalysed' }, { to: 0, cls: 'warm1Back' }, { wait: true }, { to: 2, cls: 'coldAnalysed' }, { to: 0, cls: 'warm1Back' }];
    const samples = {};
    for (const step of plan) {
      if (step.wait) { await safariPoll(wd, `return document.querySelectorAll('.file-list-settings-badge').length >= ${roll.length};`, { timeoutMs: 3_600_000, pollMs: 500 }); continue; }
      const order = await wd.execute(`return [...document.querySelectorAll('.file-list-name')].map(button => Number(button.dataset.index));`);
      const position = order.indexOf(step.to);
      const from = order[position > 0 ? position - 1 : position + 1];
      await wd.execute(`document.querySelector('.file-list-name[data-index="' + arguments[0] + '"]').focus(); return true;`, [from]);
      await safariDrain(wd, events);
      const before = await wd.execute(`return globalThis.__ncPerf.beginWindow('switch')`);
      await wd.keys([position > 0 ? KEY.ArrowRight : KEY.ArrowLeft, KEY.Enter]);
      const target = roll[step.to].name;
      await safariPoll(wd, `return ${READY_EXPR} && document.getElementById('studioFilename')?.textContent === ${JSON.stringify(target)};`, { timeoutMs: 600_000 });
      await sleep(1500);
      const window = await wd.execute('return globalThis.__ncPerf.endWindow()');
      await safariDrain(wd, events);
      const keyT = byKind(events, 'input').find(event => event.type === 'keydown' && event.key === 'Enter' && event.t >= before)?.t ?? before;
      const m = { ...switchMetrics(events, { keyT, target, until: window.end }), ...webkitWindowMetrics(window) };
      (samples[step.cls] ||= []).push(m);
    }
    for (const [cls, list] of Object.entries(samples)) {
      for (const key of ['firstPixelsMs', 'firstDisplayPositiveMs', 'readyMs', 'librawDecodes', 'timerGapCount', 'maxTimerGapMs', 'mainBusyPct']) {
        const values = list.map(entry => entry[key]).filter(Number.isFinite);
        if (values.length) record(`s7.${cls}.${key}`, round(median(values)));
      }
    }
  }
}

// ---- Tauri ----

export function tauriDevArgs({ port, scenario, fixtures, sliders = S2_SLIDERS }) {
  const url = `http://127.0.0.1:${port}/?lang=en&perf=1&scenario=${scenario}&fixtures=${encodeURIComponent(fixtures.join(','))}&sliders=${sliders.join(',')}`;
  return ['dev', '--release', '--no-watch', '--config', JSON.stringify({ build: { beforeDevCommand: '', devUrl: url } })];
}

async function tauriScenario(id, { ref, fixtureNames, record, note, log, outDir, label }) {
  const bin = join(ref.worktree.path, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
  const before = new Set(existsSync(ref.resultsDir) ? readdirSync(ref.resultsDir) : []);
  const child = spawn(bin, tauriDevArgs({ port: ref.port, scenario: id, fixtures: fixtureNames }), {
    cwd: ref.worktree.path, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: process.env
  });
  let output = '';
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
  child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
  let exited = null;
  child.once('exit', code => { exited = code; });
  const stopHeartbeats = watchHeartbeats(ref.resultsDir, async beat => {
    note(`main thread silent ${Math.round(beat.gapMs / 1000)} s; sampling WebContent`);
    const samples = await sampleWebContent(outDir, label);
    note(`samples: ${samples.map(sample => sample.file || sample.error).join(', ')}`);
  });
  try {
    const deadline = Date.now() + 90 * 60 * 1000; // includes the first cargo build
    while (Date.now() < deadline && exited === null) {
      const fresh = (existsSync(ref.resultsDir) ? readdirSync(ref.resultsDir) : []).filter(file => file.startsWith('result-') && !before.has(file));
      if (fresh.length) {
        const report = JSON.parse(readFileSync(join(ref.resultsDir, fresh.sort().at(-1)), 'utf8'));
        if (report.error) note(`self-drive: ${report.error}`);
        for (const [key, value] of Object.entries(metricsFromSelfDriven(report))) record(key, value);
        record(`${id}.inputMode`, 'synthetic');
        return report;
      }
      await sleep(1000);
    }
    throw new Error(`tauri dev produced no result${exited !== null ? ` (exited ${exited})` : ''}: ${output.slice(-1500)}`);
  } finally {
    stopHeartbeats();
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch {}
    await sleep(1000);
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {}
    log(`${label}: tauri dev stopped`);
  }
}

export async function runWebKit({ args, repo, outBase, noisy, log, prepareRef, prepareFixtures, writeOutputs, fixtureConditions }) {
  if (process.platform !== 'darwin') throw new Error(`--browser ${args.browser} needs macOS (WKWebView)`);
  const ids = args.scenarios.filter(id => WEBKIT_SCENARIOS[args.browser].includes(id));
  if (!ids.length) { console.error(`--browser ${args.browser} runs ${WEBKIT_SCENARIOS[args.browser].join(', ')}`); return 2; }
  const headSha = (await git(repo, ['rev-parse', 'HEAD'])).slice(0, 12);
  const outDir = join(outBase, `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${headSha}-${args.browser}`);
  mkdirSync(outDir, { recursive: true });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'nc-perf-webkit-'));
  const { findChrome } = await import('./chrome.mjs');
  const scenarios = ids.map(id => ({ id, fixtureGroup: id === 's7' ? 'roll' : id === 's1' ? 'singles' : 'interactive' }));
  const groups = await prepareFixtures({ args, scenarios, repo, chromeBin: findChrome() });
  const fixtureMap = Object.fromEntries(Object.values(groups).flat().filter(Boolean).map(entry => [entry.name, entry.path]));
  const refSpecs = args.mode === 'compare'
    ? [{ label: 'base', ref: args.compare[0] }, { label: 'head', ref: args.compare[1] }]
    : [{ label: 'run', ref: args.ref, headWorktree: args.headWorktree }];
  const refs = [];
  const results = { harnessVersion: 1, mode: args.mode, browser: args.browser, label: args.label, reps: args.reps, profile: false, startedAt: new Date().toISOString(), runs: [], hangs: [] };
  const collector = { groups, gpu: 'WebKit (system)', chromeVersion: null, fixtureInfo: await fixtureConditions(groups) };
  const swapStart = (await readSwapUsage()).used;
  const loadStart = loadavg();
  const power = await readPowerConditions();
  let driver = null;
  let exitCode = 0;
  try {
    for (let i = 0; i < refSpecs.length; i++) {
      refs.push(await prepareRef({ ...refSpecs[i], repo, tmpRoot, port: args.port + i, cdpPort: args.cdpPort + i,
        previewEnv: { NC_PERF_WEBKIT: '1', NC_PERF_FIXTURES: JSON.stringify(fixtureMap) } }));
    }
    if (args.browser === 'safari') driver = await startSafariDriver({ port: args.cdpPort + 20, log });
    for (const ref of refs) results.runs.push({ label: ref.label, ref: ref.ref, sha: ref.sha, dirty: ref.dirty, browser: args.browser, scenarios: {} });
    for (const scenario of scenarios) {
      const list = scenario.fixtureGroup === 'roll' ? [null] : groups[scenario.fixtureGroup];
      for (const run of results.runs) run.scenarios[scenario.id] = { title: scenario.id, status: 'ok', fixtures: {} };
      for (const fixture of list) {
        const fixtureName = fixture ? fixture.name : `roll (${groups.roll.length} files)`;
        const repsByRef = new Map(refs.map(ref => [ref.label, []]));
        for (let rep = 0; rep < args.reps; rep++) {
          for (const ref of refs) {
            const label = `${args.browser}-${ref.label}-${scenario.id}-${(fixture?.name || 'roll')}-r${rep + 1}`.replace(/[^\w.-]+/g, '_');
            const result = { label, status: 'ok', metrics: {}, notes: [] };
            const record = (key, value) => { if (value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value))) result.metrics[key] = value; };
            const note = text => { result.notes.push(text); log(`${label}: ${text}`); };
            const memory = await webkitMemory(label);
            log(`${label}`);
            try {
              if (args.browser === 'safari') {
                const wd = await WebDriverSession.create(driver.url);
                const stopHeartbeats = watchHeartbeats(ref.resultsDir, async beat => {
                  note(`main thread silent ${Math.round(beat.gapMs / 1000)} s; sampling WebContent`);
                  result.status = 'hang';
                  results.hangs.push({ label, info: { silentMs: beat.gapMs }, file: (await sampleWebContent(outDir, label)).map(sample => sample.file).join(', ') });
                });
                try {
                  await wd.setWindowRect({ width: 1440, height: 900, x: 0, y: 0 });
                  await safariScenario(scenario.id, { wd, origin: ref.origin, fixture, roll: groups.roll, record, note });
                } finally {
                  stopHeartbeats();
                  await wd.close();
                }
              } else {
                const names = fixture ? [fixture.name] : groups.roll.map(entry => entry.name);
                await tauriScenario(scenario.id, { ref, fixtureNames: names, record, note, log, outDir, label });
              }
            } catch (error) {
              result.status = result.status === 'ok' ? 'error' : result.status;
              result.detail = String(error.message || error);
              note(result.detail);
            } finally {
              const summary = memory.summary();
              memory.stop();
              if (summary) {
                record(`${scenario.id}.memory.webContentPeakMB`, summary.rendererPeakMB);
                record(`${scenario.id}.memory.webContentLifetimePeakMB`, summary.rendererLifetimePeakMB);
                record(`${scenario.id}.memory.webkitGpuPeakMB`, summary.gpuPeakMB);
                record(`${scenario.id}.memory.rendererPeakMB`, summary.rendererPeakMB);
              }
              record(`${scenario.id}.fixtureImport`, 'memory-backed File via /__perf/fixtures (adds the file size to WebContent)');
            }
            repsByRef.get(ref.label).push(result);
          }
        }
        for (const run of results.runs) {
          const reps = repsByRef.get(run.label);
          run.scenarios[scenario.id].fixtures[fixtureName] = {
            fixture: { name: fixtureName },
            summary: summarizeRepetitions(reps.filter(rep => rep.status === 'ok').map(rep => rep.metrics)),
            notes: reps.flatMap(rep => rep.notes.map(text => `${rep.label}: ${text}`)),
            reps: reps.map(rep => ({ label: rep.label, status: rep.status, detail: rep.detail }))
          };
          if (reps.some(rep => rep.status !== 'ok')) run.scenarios[scenario.id].status = reps.find(rep => rep.status !== 'ok').status;
        }
        writeOutputs(outDir, results, refs, { args, collector, loadStart, swapStart, power, noisy });
      }
    }
    if (args.mode === 'compare' || args.mode === 'against') {
      const budgets = JSON.parse(readFileSync(new URL('../budgets.json', import.meta.url), 'utf8'));
      const saved = args.mode === 'against' ? JSON.parse(readFileSync(args.against, 'utf8')) : null;
      const before = saved ? (saved.runs.find(run => run.label !== 'base') || saved.runs.at(-1)) : results.runs[0];
      const after = saved ? results.runs[0] : results.runs[1];
      const compare = compareRuns({ budgets, before: collectRunSummaries(before), after: collectRunSummaries(after), allowPixelChange: true });
      compare.baseLabel = saved ? `${before.sha?.slice(0, 7)} (saved)` : args.compare[0];
      compare.headLabel = saved ? after.sha?.slice(0, 7) : args.compare[1];
      results.compare = compare;
      console.log(`\n${renderCompareMarkdown(compare, { baseLabel: compare.baseLabel, headLabel: compare.headLabel })}\n`);
      exitCode = compare.exitCode;
    }
    results.finishedAt = new Date().toISOString();
    writeOutputs(outDir, results, refs, { args, collector, loadStart, swapStart, swapEnd: (await readSwapUsage()).used, power, noisy });
    log(`results: ${join(outDir, 'results.json')}`);
  } finally {
    driver?.stop();
    for (const ref of refs) {
      await ref.preview?.stop().catch(() => {});
      if (!args.keepWorktree) await ref.worktree?.cleanup().catch(() => {});
    }
    if (!args.keepWorktree) rmSync(tmpRoot, { recursive: true, force: true });
  }
  return exitCode;
}
