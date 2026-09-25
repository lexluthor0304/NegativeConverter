// Reuse between AI-repair commits in the app itself (#246): the real commit,
// export and restore functions of main.js run against counting stand-ins for
// the two passes. A settled commit is exported without repairing again, a
// fresh detection with unchanged mask content skips the dust pass, and every
// input of the recipe forces a new repair when it changes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRepairStamps, sameRepairStrokes, captureDustPass, dustPassMatches, restoreDustPass } from './repairReuse.js';
import { repairsNeedSettling } from './fullResolutionRouting.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}

const W = 150, H = 90;
function frame(seed) {
  const image = new ImageData(Uint8ClampedArray.from({ length: W * H * 4 }, (_, i) => (i * 7 + seed) & 255), W, H);
  image.__image16 = { width: W, height: H, data: Uint16Array.from({ length: W * H * 4 }, (_, i) => (i * 263 + seed) & 0xffff) };
  return image;
}
function copy(image) {
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  out.__image16 = { width: image.width, height: image.height, data: new Uint16Array(image.__image16.data) };
  return out;
}
// Dust in two 64 px blocks; the dust content is what the worker hashed.
const dustContent = new Uint8Array(W * H);
dustContent[10 * W + 12] = dustContent[70 * W + 140] = 255;
const dustBlocks = { size: 64, columns: 3, keys: Uint32Array.of(0, 5) };

function fixture() {
  const clean = frame(3);
  const lens = { maps: {} };
  const infos = new WeakMap();
  const calls = { detect: 0, dust: 0, strokes: 0, dustInputs: [], strokeInputs: [] };
  let bumpDuringStrokes = false;
  const state = {
    originalImageData: clean, loadedBaseImageData: clean, conversionSourceImageData: { __lensMapping: lens },
    processedImageData: clean, processedImageDataIsPreview: false, currentStep: 3,
    repairStrokes: [{ size: 0.02, points: [{ x: 0.5, y: 0.5, p: 1 }] }],
    dustRemoval: { enabled: true, ai: true, mask: null, cleanSource: clean, inpaintedImageData: null,
      processing: false, strength: 3, particleCount: 0, _state: null, maskTag: null, revision: 0 },
  };
  const detectedMask = (content = dustContent, hash = 'dust-a') => {
    const mask = new Uint8Array(content);
    infos.set(mask, { hash, blocks: dustBlocks });
    return mask;
  };
  const c = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, coreReprocessToken: 7, dustDetectionRevision: 11, loadGeneration: 3, dustPassCache: null,
    dustMaskTagSequence: 0, dustAiRefresh: { rects: [], timer: null }, syncDustWorkerPin() {},
    Uint8Array, DOMException, console,
    aiRepair: { status: 'ready', revision: 4, run() {} },
    repairStamps: createRepairStamps(), sameRepairStrokes, captureDustPass, dustPassMatches, restoreDustPass,
    dustMaskInfo: (mask) => infos.get(mask) || null,
    assertRepairCurrent(isCurrent) { if (!isCurrent()) throw new DOMException('Repair superseded', 'AbortError'); },
    ensureFullResolutionReadyForExport: async () => {}, flushScheduledCoreReprocess: async () => {},
    // #237: the export's repair barrier runs for real; every export here
    // follows a settled detection, so it waits for nothing.
    repairsNeedSettling, pendingBrushRepairs: 0, brushRepairWaiters: [], dustDetectionTimer: null,
    dustDetectionRun: null, dustMaskSources: new WeakMap(), rememberRepairMasks() {},
    dustMaxParticleSizeFor: () => 40,
    detectDustOffMainThread: async () => { calls.detect++; return { mask: detectedMask(), particleCount: 2, _state: null }; },
    // Dust pass: changes pixels inside the mask's blocks only, as MI-GAN and TELEA do.
    async inpaintForCommit(input, mask, isCurrent, worker, { report } = {}) {
      calls.dust++;
      calls.dustInputs.push(input);
      const usedAi = c.aiRepairReady();
      if (report) Object.assign(report, { usedAi, revision: c.aiRepair.revision, blocks: usedAi ? dustBlocks : null });
      const out = copy(input);
      for (const [x, y] of [[12, 10], [140, 70], [13, 11]]) {
        out.data[(y * W + x) * 4] ^= usedAi ? 0x55 : 0x33;
        out.__image16.data[(y * W + x) * 4 + 1] ^= usedAi ? 0x5555 : 0x3333;
      }
      return out;
    },
    async inpaintManualBrush(input) {
      calls.strokes++;
      calls.strokeInputs.push(input);
      if (bumpDuringStrokes) { bumpDuringStrokes = false; c.aiRepair.revision++; }
      const out = copy(input);
      out.data[(45 * W + 75) * 4] ^= 0xff;
      return out;
    },
    updateDustStatusUI() {}, cancelFullUpdate() {}, updatePreview() {},
    getLocalizedText: (key, fallback) => fallback,
    applyProcessedImageToState(next) { state.processedImageData = next; },
    isWebGLActive: () => false,
    getCurrentExportImageData: async () => state.processedImageData,
    setTimeout() { throw new Error('no timers in these tests'); },
    clearTimeout() {},
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'getDustSource', 'nextDustMaskTag', 'noteDustReplaced', 'hasFrameRepairs', 'isCurrentLoad', 'currentRepairRecipe',
    'stampRepairResult', 'carryRestoredRepairStamp', 'commitDustPass', 'aiRepairReady',
    'applyDustResultToState', 'runDustDetection', 'runDustDetectionPass', 'prepareCurrentImageForExport', 'renderCurrentImageDataForExport',
    'ensureRepairsReadyForExport', 'dustMaskIsStale', 'whenBrushRepairsSettled'].map(functionSource).join('\n'), c);
  return { c, state, clean, lens, calls, detectedMask, infos, bumpNextStrokePass: () => { bumpDuringStrokes = true; },
    exportImage: () => c.renderCurrentImageDataForExport({ format: 'png', bitDepth: 8 }) };
}
const counts = (f) => ({ dust: f.calls.dust, strokes: f.calls.strokes });

// A settled commit is exported as it is: no dust pass, no stroke pass (and so
// no repairMask), 8 and 16 bits.
{
  const f = fixture();
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 1, strokes: 1 });
  const committed = f.state.dustRemoval.inpaintedImageData;
  assert.equal(f.state.processedImageData, committed);
  const exported = await f.exportImage();
  assert.equal(exported, committed, 'export takes the repair on screen');
  assert.deepEqual(counts(f), { dust: 1, strokes: 1 }, '0 inferences and 0 mask builds on export');
  // After a stand-in was shown the result is applied again before export.
  f.state.processedImageData = f.clean;
  assert.equal(await f.exportImage(), committed);
  assert.deepEqual(counts(f), { dust: 1, strokes: 1 });

  // A fresh detection of the same source with the same mask content: the
  // dust pass is skipped and rebuilt from its blocks, byte for byte.
  const firstDust = f.calls.strokeInputs[0];
  await f.c.runDustDetection();
  assert.equal(f.calls.detect, 2);
  assert.deepEqual(counts(f), { dust: 1, strokes: 2 }, 'unchanged dust content: no dust pass');
  const rebuilt = f.calls.strokeInputs[1];
  assert.notEqual(rebuilt, firstDust);
  assert.deepEqual(rebuilt.data, firstDust.data, 'rebuilt dust image, 8-bit');
  assert.deepEqual(rebuilt.__image16.data, firstDust.__image16.data, 'rebuilt dust image, 16-bit');
  await f.exportImage();
  assert.deepEqual(counts(f), { dust: 1, strokes: 2 }, 'the new commit is stamped too');

  // Other dust-mask content misses; so does another inpainter or model.
  f.c.detectDustOffMainThread = async () => ({ mask: f.detectedMask(dustContent.map((v, i) => i === 3 ? 255 : v), 'dust-b'), particleCount: 3, _state: null });
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 2, strokes: 3 });
  f.c.detectDustOffMainThread = async () => ({ mask: f.detectedMask(), particleCount: 2, _state: null });
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 3, strokes: 4 }, 'only the last dust pass is kept');
  f.c.aiRepair.revision++;
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 4, strokes: 5 }, 'a model reload runs the dust pass again');
  f.state.dustRemoval.ai = false;
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 5, strokes: 6 }, 'TELEA does not reuse a MI-GAN pass');
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 5, strokes: 7 }, 'a TELEA pass is reused like a MI-GAN one');
  // A mask made on the page carries no hash and never hits.
  f.c.detectDustOffMainThread = async () => ({ mask: new Uint8Array(dustContent), particleCount: 2, _state: null });
  await f.c.runDustDetection();
  await f.c.runDustDetection();
  assert.deepEqual(counts(f), { dust: 7, strokes: 9 });
}

// Every input of the recipe re-runs the repair when it changes.
const negatives = [
  ['changed dust mask', (f) => { f.state.dustRemoval.mask = f.detectedMask(dustContent.map((v, i) => i === 7 ? 255 : v), 'dust-c'); }, { dust: 1, strokes: 1 }],
  // A new mask object with the same content re-runs the strokes on the kept dust pass.
  ['re-detected dust mask', (f) => { f.state.dustRemoval.mask = f.detectedMask(); }, { dust: 0, strokes: 1 }],
  ['dust turned off', (f) => { f.state.dustRemoval.enabled = false; }, { dust: 0, strokes: 1 }],
  ['dust turned on', null, { dust: 1, strokes: 1 }],
  ['AI dust turned off', (f) => { f.state.dustRemoval.ai = false; }, { dust: 1, strokes: 1 }],
  ['AI dust turned on', null, { dust: 1, strokes: 1 }],
  ['changed stroke list', (f) => { f.state.repairStrokes = [...f.state.repairStrokes]; }, { dust: 0, strokes: 1 }],
  ['lens toggle', (f) => { f.state.conversionSourceImageData = { __lensMapping: null }; }, { dust: 0, strokes: 1 }],
  ['model reload', (f) => { f.c.aiRepair.revision += 2; }, { dust: 1, strokes: 1 }],
  // A dust-brush stroke patches the repaired image and the mask in place
  // (#259): it forgets both summaries and moves the dust revision.
  ['dust brush stroke', (f) => {
    const { mask, inpaintedImageData } = f.state.dustRemoval;
    mask[20 * W + 30] = 255;
    f.infos.delete(mask);
    f.c.repairStamps.forget(inpaintedImageData);
    f.state.dustRemoval.revision++;
  }, { dust: 1, strokes: 1 }],
  ['dust revision alone', (f) => { f.state.dustRemoval.revision++; }, { dust: 0, strokes: 1 }],
  ['TELEA stand-in', (f) => {
    const standIn = copy(f.clean);
    f.state.dustRemoval.inpaintedImageData = standIn; f.state.processedImageData = standIn;
  }, { dust: 0, strokes: 1 }],
];
for (const [label, mutate, rerun] of negatives) {
  const f = fixture();
  if (label === 'dust turned on') f.state.dustRemoval.enabled = false;
  if (label === 'AI dust turned on') f.state.dustRemoval.ai = false;
  await f.c.runDustDetection();
  const before = counts(f);
  if (label === 'dust turned on') {
    f.state.dustRemoval.enabled = true;
    f.state.dustRemoval.mask = f.detectedMask();
  } else if (label === 'AI dust turned on') {
    f.state.dustRemoval.ai = true;
  } else mutate(f);
  const exported = await f.exportImage();
  const after = counts(f);
  assert.deepEqual({ dust: after.dust - before.dust, strokes: after.strokes - before.strokes }, rerun, label);
  assert.equal(exported, f.state.dustRemoval.inpaintedImageData, `${label}: export commits the new repair`);
  const again = counts(f);
  await f.exportImage();
  assert.deepEqual(counts(f), again, `${label}: the re-run is stamped for the next export`);
}

// A model reload during the pass leaves the result unstamped.
{
  const f = fixture();
  f.bumpNextStrokePass();
  await f.c.runDustDetection();
  assert.equal(f.c.repairStamps.recipeOf(f.state.dustRemoval.inpaintedImageData), null);
  await f.exportImage();
  assert.deepEqual(counts(f), { dust: 2, strokes: 2 });
}

// A restored photo session keeps its stamp when the restored strokes select
// the same pixels; the restore's new token is carried over.
{
  const f = fixture();
  await f.c.runDustDetection();
  f.c.coreReprocessToken++;
  f.state.repairStrokes = structuredClone(f.state.repairStrokes);
  f.c.carryRestoredRepairStamp();
  await f.exportImage();
  assert.deepEqual(counts(f), { dust: 1, strokes: 1 }, 'restored session exports without repairing');
  f.c.coreReprocessToken++;
  f.state.repairStrokes = [{ size: 0.03, points: [{ x: 0.5, y: 0.5, p: 1 }] }];
  f.c.carryRestoredRepairStamp();
  await f.exportImage();
  assert.deepEqual(counts(f), { dust: 1, strokes: 2 }, 'different strokes are repaired again, on the kept dust pass');
}

console.log('repairCommitReuse: settled commits export with 0 passes; unchanged dust content skips the dust pass; recipe changes, reloads and stand-ins re-run');
