// The real main.js registrations and client lifetimes against the retained
// ledger. Small planes only; no OpenCV/model/browser load is needed here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRetainedLedger } from './memoryBudget.js';
import { createDustWorkerClient } from './dustWorkerClient.js';
import { createRollFramePool } from './rollFrameWorkerClient.js';
import { createAutoFrameWorkerPool } from './autoFrameWorkerClient.js';
import { createRollFrameTask } from '../workers/rollFrameTask.js';
import { createDecodeSlots, ROLL_OPENCV_REALM_BYTES } from './batchExportScheduler.js';
import { isSharedPlane } from './crossOriginIsolation.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }\n', match.index) + 6);
}
function registration(name) {
  const start = source.indexOf(`    workerResidents.set('${name}', {`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n    });', start) + 8);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const image = () => ({ width: 24, height: 16, data: new Uint8ClampedArray(24 * 16 * 4),
  __image16: { width: 24, height: 16, data: new Uint16Array(24 * 16 * 4) } });
const mask = new Uint8Array(24 * 16);
const clean = image();
let dustTerminations = 0;
const dust = createDustWorkerClient({ workerFactory: () => ({
  postMessage(message) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id } })); },
  terminate() { dustTerminations++; }
}) });
const context = vm.createContext({
  workerResidents: new Map(), dustWorkerPlaneBytes: 0, dustWorker: dust, disposeDustWorker: dust.dispose,
  ROLL_OPENCV_REALM_BYTES, isSharedPlane, console, IDLE_RETAINED_TARGET_BYTES: 1e9,
  state: { currentStep: 3, processedImageDataIsPreview: false,
    dustRemoval: { enabled: true, showMask: true, cleanSource: clean, mask, maskTag: null } },
  pinDustWorker: dust.pin, unpinDustWorker: dust.unpin, prepareDustPrivateBuffer() {}, nextDustMaskTag: () => 7,
  memoryBudget: { poke() {} }, noteMemoryEvent() {}, relievePressure() { throw new Error('small fixture needs no trim'); }
});
vm.runInContext(['noteDustWorkerMemory', 'syncDustWorkerPin', 'workerResidentBytes', 'runMemoryIdleCheck']
  .map(functionSource).join('\n') + '\n' + registration('dust'), context);
const pageBytes = clean.data.byteLength + clean.__image16.data.byteLength + mask.byteLength;
context.memoryLedger = createRetainedLedger([
  { name: 'editor', roots: () => [clean, mask] },
  { name: 'workers', bytes: () => context.workerResidentBytes() }
]);

context.syncDustWorkerPin();
await tick();
assert.equal(dust.pinned, true);
assert.equal(dust.maskTag, 7);
assert.equal(context.memoryLedger.retained(), pageBytes * 2 + ROLL_OPENCV_REALM_BYTES,
  'the pinned worker holds its own planes and mask as well as the page\'s');
assert.equal(context.runMemoryIdleCheck().released.length, 0, 'the pinned worker cannot be evicted');
context.state.dustRemoval.showMask = false;
context.syncDustWorkerPin();
assert.equal(dust.pinned, false);
assert.equal(context.memoryLedger.retained(), pageBytes * 2 + ROLL_OPENCV_REALM_BYTES, 'unpin retains the copies until release');
assert.deepEqual(Array.from(context.runMemoryIdleCheck().released), ['dust']);
assert.equal(context.memoryLedger.retained(), pageBytes, 'idle release drops every opaque dust byte');
assert.equal(dustTerminations, 1);

// Shared 16-bit views are already counted with the editor. The worker still
// owns an 8-bit plane and a mask. A pending upload cannot be evicted.
const shared = image();
shared.__image16.data = new Uint16Array(new SharedArrayBuffer(shared.__image16.data.byteLength));
context.noteDustWorkerMemory(shared, mask);
const pin = dust.pin(shared, { mask, tag: 8 });
assert.equal(context.workerResidents.get('dust').idle(), false, 'pending work is protected even after unpin');
assert.equal(context.workerResidentBytes(), shared.data.byteLength + mask.byteLength + ROLL_OPENCV_REALM_BYTES);
await pin;
dust.unpin();
context.runMemoryIdleCheck();
assert.equal(context.workerResidentBytes(), 0);

// Roll realms are retained between frames/retries. While a frame is held,
// its lane claim covers that worker, so only the other idle realm is counted.
const rollHeap = ROLL_OPENCV_REALM_BYTES + 1024;
let rollTerminations = 0;
const rollFactory = () => {
  const task = createRollFrameTask({ loadCv: async () => {}, detect: () => null, rotate: value => value,
    readEdge: async () => null, realmStats: () => ({ heapBytes: rollHeap }), yieldTask: tick });
  return {
    postMessage(message, transfers = []) {
      const received = structuredClone(message, { transfer: transfers });
      queueMicrotask(() => { void task.handle(received, (reply, moved) => {
        this.onmessage?.({ data: structuredClone(reply, { transfer: moved }) });
      }); });
    },
    terminate() { rollTerminations++; }
  };
};
let analyzerTerminations = 0, holds = 0;
let analyzerHeap = ROLL_OPENCV_REALM_BYTES + 2048;
Object.assign(context, {
  createRollFramePool: options => createRollFramePool({ ...options, workerFactory: rollFactory }), createDecodeSlots,
  createAutoFrameWorkerPool: options => createAutoFrameWorkerPool({ ...options, workerFactory: () => ({
    postMessage(message) { queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result: null, heapBytes: analyzerHeap } })); },
    terminate() { analyzerTerminations++; }
  }) }),
  rollFrameWorkerUsable: () => true,
  analyzeFrameInWorker: { holdIdle() { holds++; return () => holds--; } }
});
vm.runInContext(functionSource('createRollAnalysisWorkers'), context);
const workers = context.createRollAnalysisWorkers({ framesInFlight: 2, decodeSlots: 1, slotBytes: 1e6 }, { warm: true });
await tick(); await tick();
assert.equal(context.workerResidentBytes(), 2 * rollHeap, 'warmed idle realms are in the ledger');
const adapter = workers.frames.frame();
const raw = { width: 24, height: 16, bits: 16, colors: 3, data: new Uint16Array(24 * 16 * 3).fill(20000) };
await adapter.run(raw, { suppressSensorDefects: true });
assert.equal(context.workerResidentBytes(), rollHeap, 'the acquired realm is covered by the frame\'s claim');
await adapter.held.sample({});
assert.equal(context.workerResidentBytes(), 2 * rollHeap, 'between frames both realms stay counted');
await workers.analyzers.analyze(image(), {}, 'warm-up');
assert.equal(context.workerResidentBytes(), 2 * rollHeap + analyzerHeap, 'idle page-path analyzer counted too');
analyzerHeap = 0;
await workers.analyzers.analyze(image(), {}, 'warm-up');
assert.equal(context.workerResidentBytes(), 2 * rollHeap + ROLL_OPENCV_REALM_BYTES,
  'a build without a public heap size still counts its live analyzer realm');
workers.dispose(); workers.dispose();
assert.equal(context.workerResidents.size, 1, 'finish removes only its own resident, leaving the dust registration');
assert.equal(context.workerResidentBytes(), 0);
assert.equal(rollTerminations, 2);
assert.equal(analyzerTerminations, 1);
assert.equal(holds, 0);
console.log('workerResidentsLedger: pinned dust, unpin/idle release, shared views, roll realms and finish');
