import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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

function fixture({ providers = ['webgpu'] } = {}) {
  const timers = [];
  const releases = [];
  const sessions = [];
  const context = vm.createContext({
    console, File: globalThis.File,
    AI_REPAIR_IDLE_RELEASE_MS: constant('AI_REPAIR_IDLE_RELEASE_MS'),
    AI_REPAIR_IDLE_RECHECK_MS: constant('AI_REPAIR_IDLE_RECHECK_MS'),
    DEFAULT_MODEL_URL: '/models/migan_pipeline_v2.onnx',
    aiRepair: { release: null, trim: null, status: 'idle', provider: '', run: null, source: '', sourceRef: null, prefer: '', released: false, error: '', percent: 0, tiles: 0, ms: 0, revision: 0 },
    aiRepairIdleTimer: null, aiRepairRunsInFlight: 0, aiRepairLastUsed: 0, activeLongJobs: 0,
    pendingBrushRepairs: 0, dustDetectionTimer: null, now: 0,
    state: { dustRemoval: { processing: false } },
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
  });
  vm.runInContext(['noteAiRepairUsed', 'canReleaseIdleAiRepair', 'releaseIdleAiRepair', 'releaseAiRepairSession', 'aiRepairLoadArgs', 'performAiRepairModelLoad']
    .map(functionSource).join('\n'), context);
  return { context, timers, releases, sessions };
}
const idle = constant('AI_REPAIR_IDLE_RELEASE_MS');
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
  assert.equal(timers.at(-1).ms, constant('AI_REPAIR_IDLE_RECHECK_MS'), 'and the idle check is retried');
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
console.log('AI repair idle release: five-minute rule, busy guards, same-model same-provider reload without a revision bump');
