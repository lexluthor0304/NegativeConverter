import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHarness, makeBase, functionSource } from './geometryTestHarness.mjs';
import { createSharedDecodes } from './sharedDecodes.js';
import { planLibRawThreads } from './librawRuntime.js';

const base = makeBase(4, 4);
const h = createHarness(base);
const { target: t, context: c, state } = h;
const file = { name: 'frame.dng' };
state.loadedFile = file;
state.baseDescriptor = c.describeBase(base, file);
state.loadedBaseImageData = null;
let loaded;
t.loadFileToImageData = async (input, options) => { loaded = options; return base; };
vm.runInContext(functionSource('decodeForBackground'), c);
t.sharedDecodes = createSharedDecodes({ decode: (input, { signal, context }) => c.decodeForBackground(input, signal, context) });
assert.equal(await c.ensureBase(), base);
assert.equal(loaded.priority, 'user', 'ensureBase reaches the actual shared loader at user priority');
assert.equal(loaded.filmStats, false, 'a restored original never needs default-recipe statistics');
assert.equal(loaded.claim, t.frameClaims[0]);
assert.equal(t.frameClaims[0].priority, 'foreground');
assert.equal(t.frameClaims[0].released, true);
assert.equal(planLibRawThreads({ isolated: true, hardwareConcurrency: 8, background: loaded.priority === 'background' }), 8);

// A held roll frame can lose its worker after adoption. Exercise the actual
// foreground helper and shared loader, so their fallback cannot default the
// saved recipe back to an unnecessary statistics request.
vm.runInContext(functionSource('adoptSharedDecode'), c);
t.claimForActivation = () => t.createFrameClaim(file, { priority: 'foreground' });
for (const filmStats of [false, true]) {
  t.sharedDecodes = createSharedDecodes({ decode: (input, { signal, context }) => c.decodeForBackground(input, signal, context) });
  const lane = t.sharedDecodes.open(file, { decode: async () => ({ held: {
    async takePlanes() { throw Error('held worker lost'); }, release() {}
  } }) });
  await lane.result;
  const adopted = c.adoptSharedDecode(file, { filmStats });
  assert.equal((await adopted.result).base, base);
  assert.equal(loaded.filmStats, filmStats, 'fallback preserves the actual recipe need');
  assert.equal(loaded.priority, 'user');
  adopted.release(); lane.release();
}

// ensureBase also adopts held frames, but it never builds a default recipe.
state.loadedBaseImageData = null;
state.baseDescriptor = c.describeBase(base, file);
const lane = t.sharedDecodes.open(file, { decode: async () => ({ held: {
  async takePlanes() { throw Error('held worker lost'); }, release() {}
} }) });
await lane.result;
assert.equal(await c.ensureBase(), base);
assert.equal(loaded.filmStats, false, 'ensureBase adoption fallback skips statistics too');
assert.equal(loaded.claim.released, true);
lane.release();
console.log('foregroundDecodePriority: foreground claims, CPU priority and recipe-dependent fallback statistics passed');
