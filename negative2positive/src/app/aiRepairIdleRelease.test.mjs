import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inpaintWithModel, TILE, CONTEXT } from './aiInpaint.js';
import { amendDustDelta, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

// MI-GAN idle release (#236 part 4): the real release rule and reload path,
// with the model load and the worker session faked.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}
const constant = name => Number(new RegExp(`const ${name} = ([^;]+);`).exec(source)[1].split('*').reduce((product, factor) => product * Number(factor), 1));

// The Studio's Retouch tab, the AI brush checkbox and the window's visibility.
function fakeDocument() {
  const elements = {
    aiBrushEnabled: { checked: false },
    'studioTab-repair': { selected: false, getAttribute(name) { return name === 'aria-selected' ? String(this.selected) : null; } },
  };
  return { visibilityState: 'visible', getElementById: id => elements[id] || null, elements };
}

function fixture({ providers = ['webgpu'] } = {}) {
  const timers = [];
  const releases = [];
  const sessions = [];
  const loads = [];
  const document = fakeDocument();
  const context = vm.createContext({
    console, File: globalThis.File, document,
    AI_REPAIR_IDLE_RELEASE_MS: constant('AI_REPAIR_IDLE_RELEASE_MS'),
    AI_REPAIR_IDLE_RECHECK_MS: constant('AI_REPAIR_IDLE_RECHECK_MS'),
    DEFAULT_MODEL_URL: '/models/migan_pipeline_v2.onnx',
    aiRepair: { release: null, trim: null, status: 'idle', provider: '', run: null, source: '', sourceRef: null, prefer: '', released: false, error: '', percent: 0, tiles: 0, ms: 0, revision: 0 },
    aiRepairIdleTimer: null, aiRepairRunsInFlight: 0, aiRepairLastUsed: 0, activeLongJobs: 0,
    pendingBrushRepairs: 0, dustDetectionTimer: null, now: 0,
    state: { currentStep: 3, cropping: false, samplingMode: null, beforeAfterActive: false,
      dustRemoval: { processing: false, ai: true, enabled: false, showMask: false } },
    getPerfNow: () => context.now,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: noop => noop,
    updateAiRepairUI: () => {}, hasFrameRepairs: () => false, scheduleDustDetection: () => {},
    defaultInferencePreference: () => 'webgpu',
    fetchModelBytes: async () => new Uint8Array(4),
    createInpaintSessionInWorker: async (bytes, { prefer }) => {
      const provider = providers[Math.min(sessions.length, providers.length - 1)];
      const session = { provider, prefer, run: () => {}, release: async () => { releases.push(provider); } };
      sessions.push(session);
      return session;
    },
    loadAiRepairModel: (...args) => { loads.push(args); return context.performAiRepairModelLoad(...args); },
  });
  vm.runInContext(['noteAiRepairUsed', 'canReleaseIdleAiRepair', 'releaseIdleAiRepair', 'releaseAiRepairSession', 'aiRepairLoadArgs',
    'performAiRepairModelLoad', 'aiRepairBrushArmed', 'reloadAiRepairForArmedBrush', 'canPaintAiBrush', 'retouchTabSelected',
    'dustBrushToolActive', 'ensureAiRepairPreload', 'countAiRepairRun']
    .map(functionSource).join('\n'), context);
  return { context, timers, releases, sessions, loads, document };
}
const idle = constant('AI_REPAIR_IDLE_RELEASE_MS');
const recheck = constant('AI_REPAIR_IDLE_RECHECK_MS');
assert.equal(idle, 5 * 60 * 1000);

// Released after five idle minutes; the reload keeps the model, the provider
// and the revision, so a warm photo session keyed on it stays a cache hit.
{
  const { context: c, timers, releases, sessions } = fixture();
  await c.performAiRepairModelLoad(...c.aiRepairLoadArgs({ refresh: false }));
  assert.equal(c.aiRepair.status, 'ready');
  const revision = c.aiRepair.revision;
  assert.equal(timers.at(-1).ms, idle, 'a ready model arms the idle check');
  c.now = idle - 1;
  assert.equal(await c.releaseIdleAiRepair(), false, 'not before five idle minutes');
  c.now = idle + 1;
  assert.equal(await timers.at(-1).fn(), true);
  assert.equal(c.aiRepair.status, 'idle');
  assert.deepEqual(releases, ['webgpu'], 'the session and its worker are released');
  const [reloadSource, reloadOptions] = c.aiRepairLoadArgs({ refresh: false });
  assert.equal(reloadSource, '/models/migan_pipeline_v2.onnx');
  assert.equal(reloadOptions.prefer, 'webgpu');
  await c.performAiRepairModelLoad(reloadSource, reloadOptions);
  assert.equal(c.aiRepair.status, 'ready');
  assert.equal(sessions.at(-1).prefer, 'webgpu', 'reloads on the same provider');
  assert.equal(c.aiRepair.revision, revision, 'a same-model, same-provider reload keeps the revision');
}

// Nothing is released while a run, a brush repair, a long job (a batch export
// or the contact sheet) or a dust pass is pending; the check comes back later
// instead.
for (const busy of ['aiRepairRunsInFlight', 'pendingBrushRepairs', 'activeLongJobs', 'processing', 'dustDetectionTimer']) {
  const { context: c, timers, releases } = fixture();
  await c.performAiRepairModelLoad('/models/migan_pipeline_v2.onnx', {});
  c.now = idle * 2;
  if (busy === 'processing') c.state.dustRemoval.processing = true;
  else c[busy] = 1;
  assert.equal(await c.releaseIdleAiRepair(), false, `${busy} keeps the model resident`);
  assert.equal(c.aiRepair.status, 'ready');
  assert.deepEqual(releases, []);
  assert.equal(timers.at(-1).ms, recheck, 'and the idle check is retried');
}

// WASM stays sticky after a WebGPU failure, and a picked model file is the
// reload source. A provider change on reload does change the revision.
{
  const { context: c, sessions } = fixture({ providers: ['wasm', 'webgpu'] });
  const picked = new File([new Uint8Array(4)], 'custom.onnx');
  await c.performAiRepairModelLoad(picked, { prefer: 'wasm' });
  c.now = idle + 1;
  await c.releaseIdleAiRepair();
  const [again, options] = c.aiRepairLoadArgs();
  assert.equal(again, picked, 'the picked model file is reloaded, not the bundled one');
  assert.equal(options.prefer, 'wasm', 'WASM stays sticky');
  const revision = c.aiRepair.revision;
  await c.performAiRepairModelLoad(again, options);
  assert.equal(sessions.at(-1).prefer, 'wasm');
  assert.notEqual(c.aiRepair.revision, revision, 'a reload that lands on another provider is a new revision');
}

// A dust-brush stroke's MI-GAN refresh (#259) is a run: it restarts the five
// minutes, so a user who keeps brushing is never idle. Runs the real refresh
// over a small frame with a stand-in model.
{
  const { context: c, timers, releases } = fixture();
  const width = 600, height = 400;
  const frame = fill => {
    const image = new ImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);
    image.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(fill * 257) };
    return image;
  };
  const mask = new Uint8Array(width * height);
  for (let y = 190; y < 210; y++) for (let x = 290; x < 310; x++) mask[y * width + x] = 255;
  Object.assign(c.state.dustRemoval, { enabled: true, mask, cleanSource: frame(100), inpaintedImageData: frame(100), revision: 1 });
  Object.assign(c, {
    state: Object.assign(c.state, { repairStrokes: [] }), undoStack: [], coreReprocessToken: 1, brushRepairWaiters: [],
    dustAiRefresh: { rects: [], timer: null }, inpaintWithModel, copyImageRect, pasteImageRect, amendDustDelta, ImageData, performance,
    AI_TILE: TILE, AI_CONTEXT: CONTEXT, refreshDustDisplay: () => {}, showToast: () => {}, DOMException,
    repairStamps: { forget: () => {} },
  });
  vm.runInContext(['queueDustAiRefresh', 'mergeDustRefreshRects', 'dustAiWindow', 'cropDustImage', 'cropDustMask',
    'runDustAiRefresh', 'noteBrushRepairSettled', 'aiRepairReady', 'settleAiRepairModel', 'assertRepairCurrent']
    .map(functionSource).join('\n') + '\nlet dustRefreshRepairMask = null;', c);
  await c.performAiRepairModelLoad('/models/migan_pipeline_v2.onnx', {});
  let runs = 0;
  c.aiRepair.run = async (image, tileMask, size) => { runs++; return image.slice(); };
  // Four minutes of brushing after the load, then a refresh.
  c.now = 4 * 60 * 1000;
  c.dustAiRefresh.rects.push({ x: 290, y: 190, width: 20, height: 20 });
  await c.runDustAiRefresh();
  assert.equal(runs, 1, 'the refresh ran MI-GAN');
  assert.equal(c.dustAiRefresh.rects.length, 0);
  assert.equal(c.aiRepairLastUsed, 4 * 60 * 1000, 'the refresh counts as use');
  assert.equal(c.aiRepairRunsInFlight, 0);
  assert.equal(timers.at(-1).ms, idle, 'and arms a fresh five minutes');
  // Six minutes after the load, two after the refresh: still in use.
  c.now = 6 * 60 * 1000;
  assert.equal(await c.releaseIdleAiRepair(), false, 'brushing keeps the model');
  assert.equal(c.aiRepair.status, 'ready');
  c.now = 9 * 60 * 1000 + 1;
  assert.equal(await c.releaseIdleAiRepair(), true, 'five minutes after the last refresh it is released');
  assert.deepEqual(releases, ['webgpu']);
}

// An armed repair brush keeps its model past the idle rule: the AI brush, or
// the dust brush with AI repair on, on the Retouch tab of a visible window.
// Leaving the tab, turning AI repair off for the dust brush or hiding the
// window lets the rule release it.
{
  const cases = [
    ['AI brush on Retouch', ({ document }) => { document.elements.aiBrushEnabled.checked = true; document.elements['studioTab-repair'].selected = true; }, false],
    ['dust brush with AI on Retouch', ({ context, document }) => {
      Object.assign(context.state.dustRemoval, { enabled: true, showMask: true });
      document.elements['studioTab-repair'].selected = true;
    }, false],
    ['AI brush checked on another tab', ({ document }) => { document.elements.aiBrushEnabled.checked = true; }, true],
    ['dust brush with AI repair off', ({ context, document }) => {
      Object.assign(context.state.dustRemoval, { enabled: true, showMask: true, ai: false });
      document.elements['studioTab-repair'].selected = true;
    }, true],
    ['AI brush on Retouch, window hidden', ({ document }) => {
      document.elements.aiBrushEnabled.checked = true;
      document.elements['studioTab-repair'].selected = true;
      document.visibilityState = 'hidden';
    }, true],
  ];
  for (const [label, arm, releasable] of cases) {
    const f = fixture();
    const { context: c, timers, releases } = f;
    await c.performAiRepairModelLoad('/models/migan_pipeline_v2.onnx', {});
    arm(f);
    c.now = idle * 3;
    assert.equal(c.canReleaseIdleAiRepair(), releasable, label);
    assert.equal(await c.releaseIdleAiRepair(), releasable, label);
    assert.equal(c.aiRepair.status, releasable ? 'idle' : 'ready', label);
    assert.equal(releases.length, releasable ? 1 : 0, label);
    if (!releasable) assert.equal(timers.at(-1).ms, recheck, `${label}: the check comes back`);
  }
}

// #241's hidden-window shedding still releases the session of an armed brush
// (the window is hidden, nothing can paint), and showing the window loads the
// released model again, on its provider and under its revision.
{
  const f = fixture();
  const { context: c, releases, loads, document } = f;
  Object.assign(c, {
    hiddenJobs: { status: () => ({ limited: true }), recheck: () => {} },
    hiddenJobRunning: () => true,
    photoSessions: { clear() {} }, photoPreviews: { clear() {} }, photoPrefetch: { clear() {} },
    thumbnailSources: { clear() {} }, watchRollSamples: { clear() {} },
    exportWorkerPendingCount: () => 0, terminateExportWorker: () => {},
    analyzeFrameInWorker: { releaseHelpers() {} },
  });
  c.state.fileQueue = [{ settings: { repairStrokes: [] } }];
  vm.runInContext(['shedHiddenJobMemory', 'hiddenWindowLimited', 'hiddenJobUsesAiRepair'].map(functionSource).join('\n'), c);
  await c.performAiRepairModelLoad('/models/migan_pipeline_v2.onnx', { prefer: 'wasm' });
  const revision = c.aiRepair.revision;
  document.elements.aiBrushEnabled.checked = true;
  document.elements['studioTab-repair'].selected = true;
  assert.equal(c.aiRepairBrushArmed(), true);
  document.visibilityState = 'hidden';
  c.shedHiddenJobMemory();
  await new Promise(setImmediate);
  assert.equal(c.aiRepair.status, 'idle', 'the hidden window releases the armed brush\'s model');
  assert.deepEqual(releases, ['webgpu']);
  loads.length = 0;
  c.reloadAiRepairForArmedBrush();
  assert.equal(loads.length, 0, 'nothing reloads while the window stays hidden');
  document.visibilityState = 'visible';
  c.reloadAiRepairForArmedBrush();
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(loads), JSON.stringify([['/models/migan_pipeline_v2.onnx', { refresh: false, prefer: 'wasm' }]]), 'showing the window reloads it');
  assert.equal(c.aiRepair.status, 'ready');
  assert.equal(c.aiRepair.revision, revision, 'on its provider, under its revision');
  // Without an armed brush, showing the window loads nothing.
  await c.releaseAiRepairSession();
  document.elements.aiBrushEnabled.checked = false;
  loads.length = 0;
  c.reloadAiRepairForArmedBrush();
  assert.equal(loads.length, 0);
}
console.log('AI repair idle release: five-minute rule, busy guards, brush refreshes count as runs, armed brushes keep the model, hidden windows still release it and showing one reloads it');
