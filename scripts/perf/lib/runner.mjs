// npm run bench:interactive — orchestration (docs/performance-benchmark.md).
//
// lock → pre-flight → worktree(s) → build with source maps → vite preview →
// fixtures → scenarios (fresh Chrome per repetition, repetitions interleaved
// across refs in compare mode) → results.json + report.md → cleanup.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, tmpdir, totalmem, type as osType } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE, UsageError } from './args.mjs';
import { cleanupResources } from './resources.mjs';
import { acquireLock, releaseOnExit, LockHeldError } from './lock.mjs';
import {
  readPressureLevel, readSwapUsage, readPowerConditions, freeDiskBytes, evaluatePreflight, waitForQuietMachine, memoryCeilingBytes
} from './guards.mjs';
import { createRefWorktree, resolveCommit, snapshotWorktree, repoRootOf, git } from './worktree.mjs';
import { buildRef, startPreview, suspiciousRequests } from './build.mjs';
import { findChrome, isSoftwareGl } from './chrome.mjs';
import { ChromeSession, ScenarioAbort } from './session.mjs';
import { createSourceMapper } from './sourcemap.mjs';
import { createTraceAnalyzer, createTraceFileWriter, recordTrace } from './trace.mjs';
import { summarizeRepetitions } from './stats.mjs';
import { loafAttribution, workerTimingSummary } from './metrics.mjs';
import { compareRuns, collectRunSummaries, renderCompareMarkdown, findMetricDef, comparisonSelection, probeControlSummaries } from './compare.mjs';
import { renderReport } from './report.mjs';
import { resolveFixtureGroups, syntheticNamesFor, sha256File } from './fixture-sets.mjs';
import { selectScenarios } from '../scenarios/index.mjs';
import { ensureFixtures, syntheticFixtureSpecs, fixtureDir } from '../fixtures.mjs';
import { runWebKit } from './webkit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const HARNESS_VERSION = 1;
export const HARNESS_ROOT = resolve(here, '..', '..', '..');
const HARNESS_CONFIG = join(here, '..', 'vite.preview.config.js');
const BUDGETS_PATH = join(here, '..', 'budgets.json');

const log = (...parts) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...parts);

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** A scenario repetition in a fresh Chrome. */
async function runRepetition({ scenario, fixture, group, ref, rep, args, profiled, extra, outDir, chromeBin, ceilingBytes, swapAtStart, freeDiskAtStart, collector, sessionFactory = options => ChromeSession.open(options) }) {
  const label = `${ref.label}-${scenario.id}-${fixture ? fixture.name : group}-${extra?.label || (profiled ? 'profiled' : `r${rep + 1}`)}`.replace(/[^\w.-]+/g, '_');
  const mapper = createSourceMapper({ distDir: ref.dist, origin: ref.origin });
  const probe = args.probe || profiled || scenario.expectHang || Boolean(extra);
  let sessionNumber = 0;
  const openSession = () => sessionFactory({
    chromeBin, cdpPort: ref.cdpPort, probe, headful: args.headful, dpr: args.dprs.includes(2) ? 2 : args.dprs[0],
    log, mapper, outDir, label: `${label}-session${sessionNumber++}`, ceilingBytes, swapAtStart, force: args.force, freeDiskAtStart, guardDiskPath: outDir,
    captureStacks: profiled || scenario.id === 'h' || Boolean(scenario.expectHang),
    fakeCamera: Boolean(scenario.fakeCamera),
    keepExportChunks: Boolean(extra?.keepExportChunks), watchdogWithoutProbe: true
  });
  const result = { label, ref: ref.label, rep, profiled, extra: extra?.label || null, status: 'ok', metrics: {}, hashes: {}, routes: [], notes: [], raw: {}, hangs: [] };
  let session;
  try {
    session = await openSession();
  } catch (error) {
    log(`${label}: the browser did not start — ${error.message}`);
    return { ...result, status: 'error', detail: `browser did not start: ${error.message}` };
  }
  const trace = { recorder: null, analyzer: null, file: null, count: 0 };
  const startTrace = async continuous => {
    trace.analyzer = createTraceAnalyzer({ mapper });
    trace.file = join(outDir, `trace-${label}${trace.count++ ? `-${trace.count}` : ''}.json.gz`);
    trace.recorder = await recordTrace(session.connection, { continuous, analyzer: trace.analyzer, writer: createTraceFileWriter(trace.file) });
    trace.recorder.file = trace.file;
    session.traceRecorder = trace.recorder;
  };
  const ctx = {
    args, scenario, fixture, rep, profiled, extra, outDir, label, log,
    origin: ref.origin,
    perfFlag: extra?.perfFlag !== false,
    dprs: args.dprs,
    roll: group === 'roll' || group.startsWith('export') ? collector.groups[group] : null,
    get session() { return session; },
    metrics: result.metrics,
    routes: result.routes,
    raw: result.raw,
    hangs: result.hangs,
    record(key, value) { if (value !== null && value !== undefined && !(typeof value === 'number' && !Number.isFinite(value))) result.metrics[key] = value; },
    hash(key, value) { if (value) result.hashes[key] = value; },
    bump(key) { result.metrics[key] = (result.metrics[key] || 0) + 1; },
    note(text) { result.notes.push(text); log(`${label}: ${text}`); },
    takeUploadedExport(name) {
      const dir = ref.exportDir;
      const safe = basename(name).replace(/[^\w.-]+/g, '_');
      const files = readdirSync(dir).filter(file => file.endsWith(`-${safe}`)).map(file => join(dir, file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      return files[0] || null;
    },
    async restartSession() {
      await session.close();
      session = await openSession();
      if (scenario.continuousTrace && args.browser === 'chrome') await startTrace(true);
    }
  };
  if (ctx.roll) ctx.fixture = ctx.roll[0] || null;
  try {
    if (profiled) await startTrace(false);
    else if (scenario.continuousTrace) await startTrace(true);
    await scenario.run(ctx);
    session.check();
  } catch (error) {
    if (error instanceof ScenarioAbort || session.status !== 'ok') {
      result.status = session.status !== 'ok' ? session.status : error.status;
      result.detail = session.abortReason || error.detail;
    } else {
      result.status = 'error';
      result.detail = String(error.stack || error.message || error);
    }
    result.abortedStep = session.currentWindow || scenario.id;
    log(`${label}: ${result.status} — ${String(result.detail).split('\n')[0]}`);
  } finally {
    try {
      if (trace.recorder && session.status === 'ok') {
        await trace.recorder.stop();
        // A continuous ring buffer that ended without a hang is not kept.
        if (profiled) result.profile = labelThreads(trace.analyzer.finalize());
        else if (scenario.continuousTrace) rmSync(trace.file, { force: true });
      }
    } catch (error) {
      result.notes.push(`trace: ${error.message}`);
    }
    if (session.status === 'ok' && probe) {
      try {
        await session.drain();
        result.appMemory = await session.evaluate('globalThis.__ncPerf.snapshot().memory');
        // The memory budget's ledger and grant log (#258, ?perf=1), to set
        // next to the measured footprint.
        result.memoryBudget = await session.evaluate(`globalThis.__ncMemory
          ? { snapshot: globalThis.__ncMemory.snapshot(), log: globalThis.__ncMemory.log() } : null`);
        await session.evaluate('globalThis.__ncPerf.clearUserTiming(); true');
      } catch {}
    }
    result.probeSelfMs = session.selfMs;
    result.counters = session.counters;
    result.observed = session.observed;
    result.loaf = loafAttribution(session.events, mapper);
    result.workerTiming = workerTimingSummary(session.events, session.workerTiming, session.pageTimeOrigin);
    if (session.status !== 'ok' && session.lastMemorySample) {
      result.lastMemorySample = {
        rendererMB: Math.round(session.lastMemorySample.rendererBytes / 1048576),
        gpuMB: Math.round(session.lastMemorySample.gpuBytes / 1048576),
        totalMB: Math.round(session.lastMemorySample.totalBytes / 1048576)
      };
    }
    if (session.status === 'memory-ceiling') {
      result.memoryCeiling = {
        ...session.memoryCeiling,
        lastSample: session.lastMemorySample ? {
          rendererMB: Math.round(session.lastMemorySample.rendererBytes / 1048576),
          gpuMB: Math.round(session.lastMemorySample.gpuBytes / 1048576),
          totalMB: Math.round(session.lastMemorySample.totalBytes / 1048576)
        } : null,
        window: session.currentWindow || null
      };
    }
    if (session.hangDump && !result.hangs.length) {
      result.hangs.push({ label, info: session.hangDump.info, file: session.hangDump.file, topFrame: session.hangDump.stacks?.find(stack => stack.kind === 'page')?.frames?.[0]?.function });
    }
    if (ctx.selftestPassed !== undefined) result.selftestPassed = ctx.selftestPassed;
    if (ctx.gpu) collector.gpu ||= ctx.gpu;
    collector.chromeVersion ||= session.chrome?.version?.Browser || null;
    await session.close();
  }
  if (scenario.expectHang && result.status === 'hang') result.status = 'ok';
  return result;
}

function labelThreads(profile) {
  for (const thread of profile.threads) {
    const top = thread.hot.find(entry => /src\//.test(entry.label));
    const file = top ? top.label.split(' ').pop().split(':')[0].split('/').pop() : null;
    thread.label = `${thread.name || `tid ${thread.tid}`}${file ? ` (${file})` : ''}`;
  }
  return profile;
}

function summarizeGroup(reps) {
  const timing = reps.filter(rep => !rep.profiled && !rep.extra);
  const summary = summarizeRepetitions(timing.map(rep => rep.metrics));
  const verify = reps.filter(rep => rep.extra === 'verify' || rep.extra === 'verify-zip');
  const noflag = reps.filter(rep => rep.extra === 'verify-noflag');
  for (const rep of verify) for (const [key, value] of Object.entries(rep.hashes)) summary[key] = { value, n: 1 };
  for (const rep of verify) for (const [key, value] of Object.entries(rep.metrics)) if (/bitDepth$|hasGainMap$|rotationAngle$|mirrored$|cropRegion$/.test(key)) summary[key] = typeof value === 'number' ? { median: value, min: value, max: value, n: 1, values: [value] } : { value, n: 1 };
  if (verify.length && noflag.length) {
    const flaggedHashes = Object.assign({}, ...verify.map(rep => rep.hashes));
    const keys = Object.keys(noflag[0].hashes);
    const same = keys.length > 0 && keys.every(key => flaggedHashes[key] === noflag[0].hashes[key]);
    summary['s9.perfFlagParity'] = { value: same ? 'identical' : `differs (${keys.filter(key => flaggedHashes[key] !== noflag[0].hashes[key]).join(', ')})`, n: 1 };
  }
  for (const rep of reps.filter(rep => rep.status !== 'ok')) {
    summary[`${rep.abortedStep || rep.label || 'scenario'}.status`] = { value: rep.status, n: 1 };
  }
  const selfPct = timing.flatMap(rep => Object.entries(rep.metrics).filter(([key]) => key.endsWith('.probeSelfPct')).map(([, value]) => value));
  if (selfPct.length) summary['probe.selfPctMax'] = { median: Math.max(...selfPct), min: Math.min(...selfPct), max: Math.max(...selfPct), n: selfPct.length, values: selfPct };
  return summary;
}

async function prepareRef({ label, ref, headWorktree, repo, tmpRoot, port, cdpPort, previewEnv = {} }) {
  let sha, dirty = false;
  if (headWorktree) {
    const snapshot = await snapshotWorktree(resolve(headWorktree));
    sha = snapshot.sha;
    dirty = snapshot.dirty;
  } else {
    sha = await resolveCommit(repo, ref);
  }
  log(`${label}: ${ref}${headWorktree ? ` (${headWorktree})` : ''} → ${sha.slice(0, 12)}${dirty ? ' + uncommitted changes' : ''}`);
  const worktree = await createRefWorktree({ repo, sha, tmpRoot, invokingRoot: HARNESS_ROOT, log });
  const dist = join(tmpRoot, `dist-${sha.slice(0, 12)}-${label}`);
  await buildRef({ worktree: worktree.path, outDir: dist, log });
  const exportDir = join(tmpRoot, `exports-${label}`);
  const resultsDir = join(tmpRoot, `results-${label}`);
  mkdirSync(exportDir, { recursive: true });
  const preview = await startPreview({
    worktree: worktree.path, outDir: dist, port, harnessConfig: HARNESS_CONFIG, log,
    env: { NC_PERF_EXPORT_DIR: exportDir, NC_PERF_RESULTS_DIR: resultsDir, ...previewEnv }
  });
  return { label, ref, sha, dirty, worktree, dist, preview, origin: preview.origin, port, cdpPort, exportDir, resultsDir };
}

async function prepareFixtures({ args, scenarios, repo, chromeBin, freeDiskAtStart }, deps = {}) {
  const specsFor = deps.syntheticFixtureSpecs || syntheticFixtureSpecs;
  const ensure = deps.ensureFixtures || ensureFixtures;
  const groups = [...new Set(scenarios.map(scenario => scenario.fixtureGroup))];
  let synthetic = {};
  if (args.fixtures === 'synthetic' || groups.includes('hang')) {
    const names = new Set(syntheticNamesFor(groups.filter(group => args.fixtures === 'synthetic' || group === 'hang'), { rollSize: args.rollSize, exportCount: args.exportCount, quick: args.quick }));
    const specs = specsFor({ rollSize: Math.max(12, args.rollSize, args.exportCount) }).filter(spec => names.has(spec.name));
    if (specs.length) {
      const { openJpegEncoderBrowser } = await import('./fixture-browser.mjs');
      let encoder = null;
      try {
        if (chromeBin) encoder = await openJpegEncoderBrowser({ port: args.cdpPort + 10, log });
        else log('no Chrome for the DNG previews: they are stub JPEGs (labelled "stub" in fixtures.json)');
        const { stubJpegEncoder } = await import('../fixtures.mjs');
        synthetic = await ensure({ dir: fixtureDir(repo), specs, encodeJpeg: encoder ? encoder.encodeJpeg : stubJpegEncoder, encoderLabel: encoder ? encoder.encoderLabel : 'stub', log,
          diskPolicy: { force: args.force, freeDiskAtStart } });
      } finally {
        await encoder?.close();
      }
    }
  }
  const resolved = resolveFixtureGroups({ set: args.fixtures, synthetic, rollSize: args.rollSize, exportCount: args.exportCount, quick: args.quick, only: args.fixture, repoRoot: repo });
  return resolved;
}

async function fixtureConditions(groups) {
  const seen = new Map();
  for (const list of Object.values(groups)) {
    for (const entry of list || []) {
      if (seen.has(entry.name)) continue;
      seen.set(entry.name, { name: entry.name, sha256: entry.sha256 || await sha256File(entry.path).catch(() => null), synthetic: Boolean(entry.synthetic) });
    }
  }
  return [...seen.values()];
}

function recordBaselines(results, budgetsPath = BUDGETS_PATH) {
  const budgets = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const date = new Date().toISOString().slice(0, 10);
  let added = 0;
  for (const run of results.runs) {
    for (const scenario of Object.values(run.scenarios)) {
      for (const [fixture, group] of Object.entries(scenario.fixtures || {})) {
        const route = group.routes?.[0]?.route || null;
        for (const [key, summary] of Object.entries(group.summary || {})) {
          const def = findMetricDef(budgets, key);
          if (!def || !budgets.metrics[def.key] || summary.median === undefined || summary.median === null) continue;
          const entry = budgets.metrics[def.key];
          entry.baselines = (entry.baselines || []).filter(item => !(item.ref === run.sha.slice(0, 7) && item.fixture === fixture && (item.metric ?? def.key) === key));
          entry.baselines.push({ ref: run.sha.slice(0, 7), fixture, route, value: summary.median, range: summary.n > 1 ? [summary.min, summary.max] : null, source: `bench:interactive ${date}`, ...(def.key !== key ? { metric: key } : {}) });
          added++;
        }
      }
    }
  }
  writeFileSync(budgetsPath, JSON.stringify(budgets, null, 2) + '\n');
  log(`recorded ${added} baselines in ${budgetsPath}`);
}

/**
 * `deps` replaces the browser, build and machine-facing steps in the
 * harness's own tests (runner.test.mjs); real runs use the defaults.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = {
    prepareRef, prepareFixtures, probeGpu, runRepetition, findChrome, suspiciousRequests, waitForQuietMachine, readPressureLevel,
    freeDiskBytes, budgetsPath: BUDGETS_PATH,
    ...Object.fromEntries(Object.entries(deps).filter(([, value]) => value !== undefined))
  };
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) { console.error(`${error.message}\n\n${USAGE}`); return 2; }
    throw error;
  }
  if (args.help) { console.log(USAGE); return 0; }

  let lock;
  try {
    lock = releaseOnExit(acquireLock({ argv: ['bench:interactive', ...argv] }));
  } catch (error) {
    if (error instanceof LockHeldError) { console.error(error.message); return 3; }
    throw error;
  }

  const repo = await repoRootOf(HARNESS_ROOT);
  const outBase = d.outBase || resolve(repo, 'output', 'perf');
  mkdirSync(outBase, { recursive: true });
  const pressure = await d.readPressureLevel();
  const freeDiskAtStart = d.freeDiskBytes(outBase);
  const preflight = evaluatePreflight({ pressure, freeDisk: freeDiskAtStart });
  if (!preflight.ok && !args.force) {
    console.error(`Refusing to start: ${preflight.problems.join('; ')}. Free memory/disk or pass --force.`);
    lock.release();
    return 4;
  }
  const quiet = await d.waitForQuietMachine({ log });
  if (quiet.noisy) log(`load average ${quiet.load.toFixed(1)} stayed above ${quiet.limit}; results are labelled noisy`);

  if (args.browser !== 'chrome') {
    try {
      return await runWebKit({ args, repo, outBase, noisy: quiet.noisy, log, prepareRef, prepareFixtures, writeOutputs, fixtureConditions, budgetsPath: BUDGETS_PATH, freeDiskAtStart });
    } finally {
      try { cleanupResources({ removeWorktrees: !args.keepWorktree }); } finally { lock.release(); }
    }
  }

  const chromeBin = d.findChrome();
  if (!chromeBin) { console.error('Chrome not found (set CHROME_BIN).'); lock.release(); return 5; }
  const headSha = (await git(repo, ['rev-parse', 'HEAD'])).slice(0, 12);
  const outDir = resolve(args.out || join(outBase, `${utcStamp()}-${headSha}`));
  mkdirSync(outDir, { recursive: true });
  const tmpRoot = mkdtempSync(join(tmpdir(), 'nc-perf-'));
  const refs = [];
  const swapStart = (await readSwapUsage()).used;
  const loadStart = loadavg();
  const power = await readPowerConditions();
  const results = {
    harnessVersion: HARNESS_VERSION, mode: args.mode, browser: 'chrome', label: args.label, reps: args.reps, profile: args.profile,
    startedAt: new Date().toISOString(), runs: [], hangs: []
  };
  let exitCode = 0;
  const cleanup = async () => {
    cleanupResources({ removeWorktrees: !args.keepWorktree });
    for (const ref of refs) {
      await ref.preview?.stop().catch(() => {});
      if (!args.keepWorktree) await ref.worktree?.cleanup().catch(() => {});
    }
    if (!args.keepWorktree) rmSync(tmpRoot, { recursive: true, force: true });
  };
  try {
    const refSpecs = args.mode === 'compare'
      ? [{ label: 'base', ref: args.compare[0] }, { label: 'head', ref: args.compare[1] }]
      : [{ label: 'run', ref: args.ref, headWorktree: args.headWorktree }];
    for (let i = 0; i < refSpecs.length; i++) {
      refs.push(await d.prepareRef({ ...refSpecs[i], repo, tmpRoot, port: args.port + i, cdpPort: args.cdpPort + i }));
    }
    const scenarios = selectScenarios(args.scenarios, { injectHang: args.injectHang });
    const groups = await d.prepareFixtures({ args, scenarios, repo, chromeBin, freeDiskAtStart });
    results.selection = comparisonSelection(scenarios, groups, args.dprs);
    const collector = { groups, gpu: null, chromeVersion: null, fixtureInfo: await fixtureConditions(groups) };
    await d.probeGpu({ ref: refs[0], args, chromeBin, collector, freeDiskAtStart, swapAtStart: swapStart });
    const ceilingBytes = memoryCeilingBytes();
    for (const ref of refs) results.runs.push({ label: ref.label, ref: ref.ref, sha: ref.sha, dirty: ref.dirty, scenarios: {} });

    for (const scenario of scenarios) {
      const isRoll = scenario.fixtureGroup === 'roll' || scenario.fixtureGroup.startsWith('export');
      const fixtures = isRoll ? [null] : groups[scenario.fixtureGroup] || [];
      if (!groups[scenario.fixtureGroup]?.length) {
        for (const run of results.runs) run.scenarios[scenario.id] = { title: scenario.title, status: 'skipped', detail: `no ${scenario.fixtureGroup} fixtures`, fixtures: {} };
        exitCode = 1;
        continue;
      }
      for (const run of results.runs) run.scenarios[scenario.id] = { title: scenario.title, status: 'ok', fixtures: {} };
      for (const fixture of fixtures) {
        const fixtureName = fixture ? (fixture.label || fixture.name) : `${scenario.fixtureGroup} (${groups[scenario.fixtureGroup].length} files)`;
        const repsByRef = new Map(refs.map(ref => [ref.label, []]));
        const reps = scenario.singleRep ? 1 : args.reps;
        // Interleave A B A B … so drift cancels between refs.
        for (let rep = 0; rep < reps; rep++) {
          for (const ref of refs) {
            log(`${scenario.id} ${fixtureName} ${ref.label} rep ${rep + 1}/${reps}`);
            repsByRef.get(ref.label).push(await d.runRepetition({ scenario, fixture, group: scenario.fixtureGroup, ref, rep, args, profiled: false, outDir, chromeBin, ceilingBytes, swapAtStart: swapStart, freeDiskAtStart, collector }));
          }
        }
        if (args.profile && !scenario.singleRep) {
          for (const ref of refs) {
            log(`${scenario.id} ${fixtureName} ${ref.label} profiled repetition`);
            repsByRef.get(ref.label).push(await d.runRepetition({ scenario, fixture, group: scenario.fixtureGroup, ref, rep: reps, args, profiled: true, outDir, chromeBin, ceilingBytes, swapAtStart: swapStart, freeDiskAtStart, collector }));
          }
        }
        for (const extra of scenario.extraReps || []) {
          for (const ref of refs) {
            log(`${scenario.id} ${fixtureName} ${ref.label} ${extra.label} repetition`);
            repsByRef.get(ref.label).push(await d.runRepetition({ scenario, fixture, group: scenario.fixtureGroup, ref, rep: -1, args, profiled: false, extra, outDir, chromeBin, ceilingBytes, swapAtStart: swapStart, freeDiskAtStart, collector }));
          }
        }
        for (const run of results.runs) {
          const reps = repsByRef.get(run.label);
          const statuses = reps.map(rep => rep.status);
          const group = {
            fixture: fixture ? { name: fixture.name, synthetic: Boolean(fixture.synthetic) } : { name: fixtureName },
            summary: summarizeGroup(reps),
            routes: reps.flatMap(rep => rep.routes).filter((route, i, list) => list.findIndex(other => other.photo === route.photo) === i),
            profile: reps.find(rep => rep.profiled && rep.profile)?.profile || null,
            loaf: reps.find(rep => !rep.profiled && rep.loaf?.length)?.loaf || null,
            workerTiming: reps.find(rep => !rep.profiled && rep.workerTiming)?.workerTiming || null,
            notes: reps.flatMap(rep => rep.notes.map(note => `${rep.label}: ${note}`)),
            reps: reps.map(({ raw, ...rest }) => rest),
            raw: reps.map(rep => ({ label: rep.label, raw: rep.raw }))
          };
          if (statuses.some(status => status !== 'ok')) {
            run.scenarios[scenario.id].status = statuses.find(status => status !== 'ok');
            if (args.mode !== 'compare' || run.label === 'head') exitCode = 1;
          }
          run.scenarios[scenario.id].fixtures[fixtureName] = group;
          for (const rep of reps) results.hangs.push(...rep.hangs);
          if (scenario.expectHang && reps.some(rep => rep.selftestPassed === false)) exitCode = 1;
        }
        writeOutputs(outDir, results, refs, { args, collector, loadStart, swapStart, power, noisy: quiet.noisy });
      }
    }

    // Production assertion: no dev-server request may have reached the preview.
    for (const ref of refs) {
      const suspicious = await d.suspiciousRequests(ref.origin);
      const run = results.runs.find(entry => entry.label === ref.label);
      run.production = suspicious.length === 0;
      if (suspicious.length) {
        run.productionViolations = suspicious;
        log(`${ref.label}: dev-server requests reached the preview (${suspicious.slice(0, 3).map(entry => entry.url).join(', ')}); the run is invalid`);
        exitCode = 1;
      }
    }

    if (args.mode === 'compare' || args.mode === 'against') {
      const saved = args.mode === 'against' ? JSON.parse(readFileSync(resolve(args.against), 'utf8')) : null;
      const before = args.mode === 'compare' ? results.runs[0] : pickSavedRun(saved);
      const after = args.mode === 'compare' ? results.runs[1] : results.runs[0];
      const budgets = JSON.parse(readFileSync(d.budgetsPath, 'utf8'));
      const crossProbeControl = saved?.browser === 'chrome' && typeof saved.conditions?.probe === 'boolean' && saved.conditions.probe !== args.probe;
      const summaries = crossProbeControl
        ? probeControlSummaries({ before, after, saved, selection: results.selection })
        : { before: collectRunSummaries(before), after: collectRunSummaries(after) };
      const compare = compareRuns({ budgets, ...summaries, allowPixelChange: args.allowPixelChange });
      if (crossProbeControl) {
        compare.scope = summaries.scope;
        if (!summaries.compatible) {
          compare.exitCode = 1;
          compare.scopeError = 'no common intended scenario, fixture and DPR scope';
        }
      }
      compare.baseLabel = args.mode === 'compare' ? args.compare[0] : `${before.sha?.slice(0, 7)} (saved)`;
      compare.headLabel = args.mode === 'compare' ? args.compare[1] : after.sha?.slice(0, 7);
      results.compare = compare;
      console.log(`\n${renderCompareMarkdown(compare, { baseLabel: compare.baseLabel, headLabel: compare.headLabel })}\n`);
      exitCode = Math.max(exitCode, compare.exitCode);
    }
    results.finishedAt = new Date().toISOString();
    const swapEnd = (await readSwapUsage()).used;
    writeOutputs(outDir, results, refs, { args, collector, loadStart, swapStart, swapEnd, power, noisy: quiet.noisy });
    if (args.recordBaselines) recordBaselines(results, d.budgetsPath);
    log(`results: ${join(outDir, 'results.json')}\nreport:  ${join(outDir, 'report.md')}`);
  } catch (error) {
    console.error(error.stack || error.message);
    exitCode = exitCode || 1;
  } finally {
    try { await cleanup(); } finally { lock.release(); }
  }
  return exitCode;
}

function pickSavedRun(saved) {
  return saved.runs.find(run => run.label === 'head') || saved.runs.find(run => run.label === 'run') || saved.runs.at(-1);
}

function writeOutputs(outDir, results, refs, { args, collector, loadStart, swapStart, swapEnd = null, power, noisy }) {
  results.conditions = {
    harnessVersion: HARNESS_VERSION,
    cpuModel: cpus()[0]?.model,
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 1024 ** 3),
    os: `${osType()} ${release()}`,
    browser: { name: 'chrome', version: collector.chromeVersion || null, headless: !args.headful },
    gpu: collector.gpu,
    softwareGl: isSoftwareGl(collector.gpu),
    dprs: args.dprs,
    fixtureSet: args.fixtures,
    fixtures: collector.fixtureInfo || [],
    refs: refs.map(ref => ({ label: ref.label, ref: ref.ref, sha: ref.sha, dirty: ref.dirty })),
    loadStart, loadEnd: loadavg(), swapStart, swapEnd, power, noisy, probe: args.probe,
    memoryCeilingGB: Math.round((memoryCeilingBytes() / 1024 ** 3) * 10) / 10
  };
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2));
  const budgets = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'));
  writeFileSync(join(outDir, 'report.md'), renderReport(results, budgets));
}

/** One short session per ref: record the GPU string and refuse software GL. */
async function probeGpu({ ref, args, chromeBin, collector, freeDiskAtStart, swapAtStart }) {
  const session = await ChromeSession.open({ chromeBin, cdpPort: ref.cdpPort, probe: false, headful: args.headful, dpr: 2, log, outDir: tmpdir(), label: 'gpu', ceilingBytes: memoryCeilingBytes(), guardDiskPath: tmpdir(), force: args.force, freeDiskAtStart, swapAtStart });
  try {
    await session.boot(`${ref.origin}/?lang=en`);
    collector.gpu = await session.gpuRenderer();
    collector.chromeVersion = session.chrome.version?.Browser || null;
  } finally {
    await session.close();
  }
  log(`GPU: ${collector.gpu} (${collector.chromeVersion})`);
  if (isSoftwareGl(collector.gpu) && !args.allowSoftwareGl) {
    throw new Error(`software GL renderer (${collector.gpu}); pass --allow-software-gl to measure anyway (results are labelled)`);
  }
}

export { fixtureConditions, labelThreads, summarizeGroup, pickSavedRun, prepareRef, prepareFixtures, writeOutputs, runRepetition };
