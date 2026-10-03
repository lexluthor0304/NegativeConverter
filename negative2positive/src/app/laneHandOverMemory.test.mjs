// A background lane's hand-over and the memory budget's eviction (#243,
// #258; #229 review R2-038): main.js's lanes (backgroundLanesHarness.mjs),
// rememberPhotoBase, the real memory ledger, relieveMemoryPressure and the
// WebKit idle check, over the real photo-session cache.
//
// A lane's base handed over through putIfRoom is never the session the user
// just left: pressure keeps the 1-back session warm and lets the lane's base
// go, and the idle check releases the lane's base (it has no display form,
// so as the "photo just left" it stayed forever) while the 1-back session
// stays.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createLaneFixture, functionSource, flush } from './backgroundLanesHarness.mjs';
import { createRetainedLedger, relievePressure } from './memoryBudget.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function generatorSource(name) {
  const match = new RegExp(`^    function\\* ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists in main.js`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}
const SNAPSHOT_REF_KEYS = /const SNAPSHOT_REF_KEYS = (\[[^\]]+\]);/.exec(source)[1];

const MEMORY_FUNCTIONS = [
  'memoryLedgerConsumers', 'openPhotoMemoryRoots', 'liveHistoryRoots', 'sampleStoreBytes', 'workerResidentBytes',
  'freedByLedger', 'trimPhotoSessions', 'trimPhotoPreviews', 'demoteFullResolutionForMemory', 'stripHistoryForMemory',
  'relieveMemoryPressure', 'runMemoryIdleCheck', 'noteMemoryEvent', 'rememberPhotoBase'
];

// A plane of `bytes` bytes, with a buffer of its own.
const plane = (bytes, tag) => ({ tag, width: 1, height: 1, data: new Uint8ClampedArray(bytes) });

// The ledger and the eviction steps of main.js in a lane fixture. Nothing
// here is a large frame, and history holds no pixels of its own.
function withMemory(f) {
  const c = f.context;
  Object.assign(c, {
    undoStack: [], redoStack: [], settledAdjustedBuffer: null, previewAdjustedBuffer: null, parkedPhoto: null,
    workerResidents: new Map(), relievePressure,
    isLargeImage: () => false, canDemoteFullResolutionPlane: () => false, evictPlane: () => {},
    historyExclusiveBytes: () => 0, hotGeometrySnapshot: () => null, pruneHistoryForMemory: () => {},
    memoryIdleCheck: { note() {} }, memoryLogEnabled: false, MEMORY_EVENT_LOG_LIMIT: 200, DEBUG_UI: false,
    IDLE_RETAINED_TARGET_BYTES: 1 << 30
  });
  f.state.dustRemoval = { mask: null, inpaintedImageData: null, cleanSource: null, _state: null };
  f.state.rawMetadata = null;
  c.SNAPSHOT_REF_KEYS = vm.runInContext(SNAPSHOT_REF_KEYS, c);
  vm.runInContext([...MEMORY_FUNCTIONS.map(functionSource), generatorSource('boundedStoreBuffers')].join('\n'), c);
  c.memoryLedger = createRetainedLedger(() => c.memoryLedgerConsumers());
}

// The user opens photo 0, then photo 1: switchToFile remembers photo 0
// through rememberPhotoBase (its decoded base, 4000 bytes). Then the lane
// renders photo 2's tile from a decode of its own and hands its base
// (6000 bytes) over to the sessions.
async function laneHandOverAfterAStep({ display = false } = {}) {
  const f = createLaneFixture({ count: 4, current: 0, sessionBudget: 1 << 20, tilesDone: true });
  f.items[2].thumbnail = null;
  withMemory(f);
  const c = f.context;
  const base0 = plane(4000, 'base 0');
  f.state.loadedBaseImageData = base0;
  if (display) {
    // A settled photo's session carries its display form (#249), as
    // rememberPhotoSession puts it.
    assert.equal(c.photoSessions.put(f.items[0], { file: f.items[0].file, base: base0, rawMetadata: null, display: { tier: 'B', level: plane(500, 'level 0') } }), true);
  } else {
    assert.equal(c.rememberPhotoBase(f.items[0]), true);
  }
  f.open(1);
  f.state.loadedBaseImageData = plane(4000, 'base 1');
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['2.dng']);
  const record = f.decodeOf(2)[0];
  record.settled = true;
  const laneBase = plane(6000, 'base 2');
  record.resolve(laneBase);
  await flush();
  await f.finishRender(2);
  assert.equal(c.photoSessions.has(f.items[2]), true, 'the lane kept photo 2\'s base beside the sessions');
  assert.equal(c.photoSessions.peek(f.items[2]).base, laneBase);
  return { f, c, base0, laneBase };
}

// --- pressure keeps the 1-back session warm and lets the lane's base go ------------------
{
  const { f, c, base0 } = await laneHandOverAfterAStep();
  assert.equal(c.photoSessions.lastStoredKey, f.items[0], 'the session the user just left is still photo 0');
  // A request that does not fit (a photo being opened) needs 6000 bytes.
  const freed = c.relieveMemoryPressure(6000, { label: 'open 3.dng', priority: 'foreground' });
  assert.equal(freed, 6000);
  assert.equal(c.photoSessions.has(f.items[2]), false, 'the lane\'s base went');
  assert.equal(c.photoSessions.get(f.items[0])?.base, base0, 'the 1-back switch stays warm');
  // More pressure never trades the 1-back session either.
  assert.equal(c.relieveMemoryPressure(1e6, { label: 'open 3.dng', priority: 'foreground' }), 0);
  assert.equal(c.photoSessions.get(f.items[0])?.base, base0);
}

// --- the idle check releases the lane's base, the 1-back session stays ----------------------
{
  const { f, c, base0 } = await laneHandOverAfterAStep();
  const retained = c.memoryLedger.retained();
  c.IDLE_RETAINED_TARGET_BYTES = retained - 6000;
  const { trimmed } = c.runMemoryIdleCheck();
  assert.equal(trimmed, 6000, 'the lane\'s base (no display form) is released');
  assert.equal(c.photoSessions.has(f.items[2]), false);
  assert.equal(c.photoSessions.get(f.items[0])?.base, base0, 'the 1-back session stays');
  assert.equal(c.memoryLedger.retained(), retained - 6000);
}

// The 1-back session in its display form, which the idle check may demote:
// the lane's base goes first, so it stays as it was.
{
  const { f, c, base0 } = await laneHandOverAfterAStep({ display: true });
  assert.equal(c.photoSessions.lastStoredKey, f.items[0]);
  c.IDLE_RETAINED_TARGET_BYTES = c.memoryLedger.retained() - 6000;
  assert.equal(c.runMemoryIdleCheck().trimmed, 6000);
  assert.equal(c.photoSessions.has(f.items[2]), false, 'the lane\'s base went first');
  assert.equal(c.photoSessions.get(f.items[0])?.base, base0, 'the 1-back session was not demoted');
}

// --- right after an import: the lane's base is the only session, and the idle check
// releases it (it was "the photo just left", without a display form, kept forever) ------
{
  const f = createLaneFixture({ count: 4, current: 0, sessionBudget: 1 << 20, tilesDone: true });
  f.items[1].thumbnail = null;
  withMemory(f);
  const c = f.context;
  f.state.loadedBaseImageData = plane(4000, 'base 0');
  c.kickBackgroundPhotoWork();
  await f.clock.advance(250);
  assert.deepEqual(f.started(), ['1.dng']);
  const record = f.decodeOf(1)[0];
  record.settled = true;
  record.resolve(plane(6000, 'base 1'));
  await flush();
  await f.finishRender(1);
  assert.equal(c.photoSessions.has(f.items[1]), true);
  assert.equal(c.photoSessions.lastStoredKey, undefined, 'no session the user left');
  c.IDLE_RETAINED_TARGET_BYTES = 4000;
  assert.equal(c.runMemoryIdleCheck().trimmed, 6000);
  assert.equal(c.photoSessions.size, 0, 'the idle check released the lane\'s base');
}

console.log('laneHandOverMemory: a lane\'s hand-over is never the 1-back session; pressure and the idle check let it go first');
