import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createMemoryBudget } from './memoryBudget.js';
import { planDecodeAhead } from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
function fixture() {
  const idle = deferred(), read = deferred(), decode = deferred();
  const starts = [];
  const budget = createMemoryBudget({ budgetBytes: 1e9 });
  const c = vm.createContext({
    AbortController, DOMException, planDecodeAhead, memoryBudget: budget, heldJobFrames: new Set(),
    navigator: { deviceMemory: 16 }, memoryRuntime: { engine: 'webview2' },
    hiddenJobs: { status: () => ({ hidden: false }) }, hiddenResidentBytes: () => 0,
    isTauriDesktop: () => true, backgroundGate: { idle: () => idle.promise }, BACKGROUND_STEP_WAIT_CAP_MS: 2000,
    imagePixelsForBatch: async () => 16, isRawLikeFileName: () => true, isPngFile: () => false,
    markOwnedPlanes: value => value, releaseOwnedPlanes: value => { value.released = true; },
    coveredMemoryClaim: () => ({ fixed: true, atDecode: async () => {} }),
    decodeReservationBytes: ({ pixels, decodeBytes }) => decodeBytes || estimateRawDecodeBytes(pixels, 1),
    batchPipelineDiagnostics: { decodeAhead: { admitted: 0, refused: { ceiling: 0, foreground: 0 }, lastEstimate: 0 } }
  });
  c.loadFileToImageData = async (file, options) => {
    await read.promise; // The real loader reads/opens and obtains metadata before admission.
    if (options.signal.aborted) throw options.signal.reason;
    await options.claim.atDecode({ width: 4, height: 4, estimatedBytes: 1000 });
    if (options.signal.aborted) throw options.signal.reason;
    starts.push({ foreground: budget.foregroundOutstanding, reserved: budget.reserved });
    await decode.promise;
    return { width: 4, height: 4, data: new Uint8ClampedArray(64) };
  };
  vm.runInContext(functionSource('batchDecodeAhead'), c);
  const ahead = c.batchDecodeAhead('default', { pixelsPerFile: 16, ownReservedBytes: () => 0 });
  const job = { file: { name: 'frame.dng' }, settings: {} };
  const admit = () => ahead.admitPrepare({ job, prepared: [], unwrittenBytes: 0, processing: 0 });
  return { c, budget, idle, read, decode, starts, ahead, job, admit };
}

for (const boundary of ['idle', 'read']) {
  const f = fixture();
  assert.equal(await f.admit(), true);
  const controller = new AbortController();
  const running = f.ahead.prepare(f.job, { signal: controller.signal, stage: () => {} });
  if (boundary === 'read') { f.idle.resolve(); await tick(); }
  const foreground = await f.budget.reserve(100, { priority: 'foreground' });
  f.idle.resolve(); f.read.resolve();
  await tick();
  assert.equal(f.starts.length, 0, `no decoder dispatch when foreground starts during ${boundary}`);
  foreground.release();
  await tick();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].foreground, 0);
  assert.ok(f.starts[0].reserved >= 1000, 'the running prepare is an outstanding reservation');
  f.decode.resolve();
  const base = await running;
  assert.equal(f.c.heldJobFrames.has(base), true, 'the finished claim hands ownership to the ledger');
  assert.equal(f.budget.reserved, 0, 'a ready frame cannot block the lane that takes it');
  f.ahead.take(base);
  assert.equal(f.c.heldJobFrames.size, 0);
  assert.equal(f.budget.idle, true);
}

// Other jobs or a tighter budget can invalidate an optimistic offer too.
// Refuse without queueing behind a lane that will wait for this prepare.
{
  const f = fixture();
  assert.equal(await f.admit(), true);
  const held = await f.budget.reserve(1e9 - 500, { priority: 'user' });
  const running = f.ahead.prepare(f.job, { signal: new AbortController().signal, stage: () => {} });
  f.idle.resolve(); f.read.resolve(); f.decode.resolve();
  assert.equal(await running, null, 'the lane must decode this frame itself');
  assert.equal(f.starts.length, 0);
  held.release();
  assert.equal(f.budget.idle, true);
}
{
  const f = fixture();
  assert.equal(await f.admit(), true);
  const foreground = await f.budget.reserve(1, { priority: 'foreground' });
  const controller = new AbortController();
  const running = f.ahead.prepare(f.job, { signal: controller.signal, stage: () => {} });
  f.idle.resolve(); f.read.resolve();
  await tick(); controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  foreground.release();
  assert.equal(f.budget.idle, true, 'cancelling foreground wait leaks no claim');
}
{
  const f = fixture();
  f.c.loadFileToImageData = async (_file, { claim }) => {
    await claim.atDecode({ width: 4, height: 4, estimatedBytes: 1000 });
    assert.equal(f.budget.reserved, 1000);
    throw Error('decoder failed');
  };
  f.idle.resolve();
  await assert.rejects(f.ahead.prepare(f.job, { signal: new AbortController().signal, stage: () => {} }), /decoder failed/);
  assert.equal(f.budget.idle, true, 'a failed decoder releases its actual reservation');
}
console.log('decodeAheadAdmission: dispatch races, running ownership, refusal without deadlock and cancellation passed');
