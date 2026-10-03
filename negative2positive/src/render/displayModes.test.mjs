// #253: the look and the expired-film rescue on the GPU display.
//  1. A line-by-line fp32 model of the mode programs' displayStep3
//     (test-fixtures/displayStagesModel.mjs) against pixelAdjustments.js at the
//     exact colour model ('full'), on every recipe of the parity smoke: rescue with
//     offsets, with the fog surface, with local contrast 30 and 100, the look
//     (matrix + curves, curves only), rescue + look + vibrance with WB, C/M/Y and
//     curves, hold-to-compare, and the apply program's chain in front of them. The
//     budget is the issue's: mean ≤ 1 level, p99.9 ≤ 3.
//  2. The orientation fixture fails a flipped v and a transposed look matrix.
//  3. displayStageUniforms mirrors the CPU's flags and keeps the mean grid and the
//     look's curves for the same analysis and look; main.js rebuilds the stages
//     only when the look, the analysis, a strength or hold-to-compare changes.
//  4. The self-test's comparison, the border underlay's viewport and u_frame.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

await import('../pipeline/oracle/adapterParity.mjs'); // ImageData and file: fetch for the profiles
const {
  buildDisplayModesCases, buildDisplayModesCase, agedPositiveFixture, expiredAnalysisOf, displayModesSpecs, displayParity,
  compareDisplayModes, syntheticLook, buildPreviewCase, parityFrame, DISPLAY_PARITY_MEAN, DISPLAY_PARITY_P999,
} = await import('./gpuPreviewSelfTest.js');
const { displayStageUniforms, displayModesSupported, wholeFrame, regionFrame, packRescueOffsets, packCurveRow, applyUniforms } = await import('./previewTables.js');
const { photoViewport } = await import('./borderUnderlay.js');
const { modelDisplayStep3 } = await import('../../test-fixtures/displayStagesModel.mjs');
const { modelApplyProgram } = await import('../../test-fixtures/previewShaderModel.mjs');
const { computeAdjustmentParams } = await import('../workers/pixelAdjustments.js');
const { applyPreparedAdjustmentsToBuffer } = await import('../app/adjustmentPipeline.js');
const { buildExpiredRescueStages, buildExpiredSpatialStage, sanitizeExpiredAnalysis, sanitizeExpiredRescueParams, EXPIRED_RESCUE_KEYS, OFFSET_BINS, RESCUE_LUMA } = await import('../pipeline/expiredRescue.js');
const { sanitizeLookForSettings } = await import('../app/labMatch.js');
const { getSprocketFrameLayout } = await import('../app/sprocketFrame.js');
const { filmPresets } = await import('../silvercore/engine/FilmPresets.js');

assert.equal(OFFSET_BINS, 64);
assert.deepEqual([...RESCUE_LUMA], [0.2126, 0.7152, 0.0722]);

// ---- 1 + 2. The model against the CPU, and the orientation fixture ----
let checked = 0;
const worst = { mean: 0, p999: 0, name: '' };
for (const [width, height] of [[64, 48], [96, 64], [211, 137]]) {
  const cases = buildDisplayModesCases(width, height);
  const byName = Object.fromEntries(cases.map((c) => [c.name, c]));
  assert.ok(byName.offsets.params.rescueStages.offsets, 'the aged fixture leans: the colour table is on');
  assert.ok(byName['offsets + fog'].stages.fogOn && !byName.offsets.stages.fogOn);
  assert.equal(byName['offsets + fog + local 30'].stages.local, 0.3 * 0.6);
  assert.equal(byName['look curves'].stages.lookMatrixOn, 0);
  assert.equal(byName['hold to compare'].stages.rescueOn, 0, 'hold-to-compare drops the rescue, not the look');
  assert.equal(byName['hold to compare'].stages.lookMatrixOn, 1);
  for (const c of cases) {
    for (const [variant, round] of [['fp32', Math.fround], ['wide', (x) => x]]) {
      const result = displayParity(c.expected, modelDisplayStep3({ image: c.image, step3: c.step3, stages: c.stages }, round));
      assert.ok(result.ok, `${c.name} ${width}x${height} (${variant}): ${JSON.stringify(result)}`);
      if (result.mean > worst.mean || result.p999 > worst.p999) Object.assign(worst, result, { name: `${c.name} ${width}x${height} (${variant})` });
    }
    const fog = c.stages.fogOn || c.stages.local > 0;
    const flipped = displayParity(c.expected, modelDisplayStep3({ image: c.image, step3: c.step3, stages: c.stages, flipV: true }));
    if (fog) assert.ok(!flipped.ok, `${c.name}: a flipped v must fail (${JSON.stringify(flipped)})`);
    if (c.stages.lookMatrixOn) {
      const transposed = displayParity(c.expected, modelDisplayStep3({ image: c.image, step3: c.step3, stages: c.stages, transposeLook: true }));
      assert.ok(!transposed.ok, `${c.name}: a transposed look matrix must fail (${JSON.stringify(transposed)})`);
    }
    checked++;
  }
}

// The uneven fog of the fixture is strongest at the top-left, so v matters.
{
  const image = agedPositiveFixture(96, 64);
  const analysis = expiredAnalysisOf(image);
  const stage = buildExpiredSpatialStage({ expiredEnabled: true, expiredAnalysis: analysis, expiredUnevenFog: 100 });
  const surface = (u, v, ch = 0) => {
    const k = ch * 6, c = stage.fog;
    return c[k] + c[k + 1] * u + c[k + 2] * v + c[k + 3] * u * u + c[k + 4] * v * v + c[k + 5] * u * v;
  };
  assert.ok(surface(0, 0) > surface(1, 0) && surface(0, 0) > surface(0, 1), 'fog strongest top-left');
  assert.ok(surface(1, 0) !== surface(0, 1), 'and not symmetric in u and v');
}

// The apply program's chain (SilverCore stages, >> 8) in front of the modes, as
// APPLY_MODES_FRAGMENT_SHADER runs it, against the engine then pixelAdjustments.js.
{
  const image = agedPositiveFixture(96, 64);
  const analysis = expiredAnalysisOf(image);
  const spec = displayModesSpecs(analysis).find((s) => s.name === 'rescue + look + vibrance');
  const preview = buildPreviewCase({
    name: 'apply', mode: 'color', settings: { filmType: 'color', colorModel: 'standard', temperature: 8, contrast: 12 },
    image: parityFrame('color', 96, 64), filmPresets,
  });
  const converted8 = { width: 96, height: 64, data: new Uint8ClampedArray(preview.expected) };
  const c = buildDisplayModesCase({ name: 'apply + modes', image: converted8, settings: spec.settings, curves: 'tone' });
  const uniforms = applyUniforms({ mode: preview.mode, params: preview.params, plan: preview.plan, positive: preview.positive, hasStops: false });
  const applied = modelApplyProgram({
    image: preview.prepared, uniforms, toneLut: preview.plan.luts, paperLut: preview.plan.paper, profile: preview.profile,
    preSatRamp: preview.engine.preSaturationRamp(preview.params), satRamp: preview.engine.saturationRamp(preview.params),
  });
  const result = displayParity(c.expected, modelDisplayStep3({ image: { width: 96, height: 64, data: applied }, step3: c.step3, stages: c.stages }));
  assert.ok(result.ok, `apply + modes: ${JSON.stringify(result)}`);
  checked++;
}

// A region drawn with regionFrame sees the whole frame's positions: the rescue of a
// crop equals the crop of the whole frame's rescue.
{
  const [c] = buildDisplayModesCases(96, 64).filter((x) => x.name === 'offsets + fog + local 30');
  const whole = modelDisplayStep3({ image: c.image, step3: c.step3, stages: c.stages });
  const region = { x: 40, y: 16, width: 32, height: 24 };
  const crop = new Uint8ClampedArray(region.width * region.height * 4);
  const wholeCrop = new Uint8ClampedArray(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) {
    const from = ((region.y + y) * c.width + region.x) * 4;
    crop.set(c.image.data.subarray(from, from + region.width * 4), y * region.width * 4);
    wholeCrop.set(whole.subarray(from, from + region.width * 4), y * region.width * 4);
  }
  const drawn = modelDisplayStep3({
    image: { width: region.width, height: region.height, data: crop }, step3: c.step3, stages: c.stages,
    frame: regionFrame(region, region.width, region.height, c.width, c.height),
  });
  assert.ok(displayParity(wholeCrop, drawn).max <= 1, 'u_frame keeps a region normalised to the whole frame');
  const unframed = modelDisplayStep3({ image: { width: region.width, height: region.height, data: crop }, step3: c.step3, stages: c.stages });
  assert.ok(!displayParity(wholeCrop, unframed).ok, 'without it the fog surface lands elsewhere');
}

// ---- 3. The stages mirror the CPU's parameters ----
{
  const cases = buildDisplayModesCases(64, 48);
  for (const c of cases) {
    const p = c.params, s = c.stages;
    assert.equal(s.rescueOn, p.doRescue ? 1 : 0, c.name);
    assert.equal(s.fogOn, p.rescueSpatial?.fog ? 1 : 0, c.name);
    assert.equal(s.offsetsOn, p.rescueStages?.offsets ? 1 : 0, c.name);
    assert.equal(s.lookMatrixOn, p.doLookMatrix ? 1 : 0, c.name);
    assert.equal(s.lookCurvesOn, p.lookR ? 1 : 0, c.name);
    assert.equal(s.active, Boolean(p.doRescue || p.doLook), c.name);
    const perPixel = p.doHsl || p.doLookMatrix || p.doRescueSpatial || p.doRescuePixel;
    assert.equal(s.roundBeforeCmy, perPixel ? 1 : 0, `${c.name}: the CPU path's rounding before C/M/Y`);
    if (s.tone) assert.equal(s.tone.data, p.rescueStages.tone, 'the tone curve is the CPU\'s Float32Array');
    if (s.mean) assert.equal(s.mean.data, p.rescueSpatial.mean, 'the mean grid is the CPU\'s (values × 255)');
    if (s.offsets) {
      assert.equal(s.offsets.data.length, 64 * 4);
      for (let i = 0; i < 64; i++) for (let ch = 0; ch < 3; ch++) assert.equal(s.offsets.data[i * 4 + ch], p.rescueStages.offsets[i * 3 + ch]);
    }
  }
  assert.deepEqual([...packRescueOffsets(new Float32Array(192).map((_, i) => i)).subarray(0, 8)], [0, 1, 2, 0, 3, 4, 5, 0]);
  // The new GPU textures stay far under 1 MB: the grid at its 128 x 128 cap, the
  // colour table, the tone curve and the look's curve row.
  const worstGrid = 128 * 128 * 4;
  for (const c of cases) {
    const s = c.stages;
    const bytes = (s.mean ? s.mean.data.length * 4 : 0) + (s.offsets ? s.offsets.data.byteLength : 0)
      + (s.tone ? s.tone.data.byteLength : 0) + (s.lookCurves ? s.lookCurves.data.byteLength : 0);
    assert.ok(bytes <= worstGrid + 64 * 16 + 256 * 4 + 256 * 4 && bytes < 1024 * 1024, `${c.name}: ${bytes} B of stage textures`);
  }
  const identity = packCurveRow(null);
  assert.deepEqual([...identity.subarray(4 * 200, 4 * 201)], [200, 200, 200, 255]);
  // Off: the plain programs draw.
  const off = displayStageUniforms(computeAdjustmentParams({ curves: { r: [], g: [], b: [] } }));
  assert.equal(off.active, false);
  // Reuse: the mean grid for the same analysis, the look's curves for the same look.
  const base = cases.find((c) => c.name === 'offsets + fog + local 30');
  const next = computeAdjustmentParams({ ...base.recipe, expiredLocalContrast: 60 }, { width: 1, height: 1 });
  const again = displayStageUniforms(next, { previous: base.stages, sameAnalysis: true });
  assert.equal(again.mean, base.stages.mean, 'a strength tick keeps the uploaded grid');
  assert.notEqual(displayStageUniforms(next, { previous: base.stages }).mean, base.stages.mean);
  const lookCase = cases.find((c) => c.name === 'look matrix + curves');
  assert.equal(displayStageUniforms(lookCase.params, { previous: lookCase.stages, sameLook: true }).lookCurves, lookCase.stages.lookCurves);
}

// main.js's currentDisplayStages: the display recipe's stages, rebuilt only on a
// change of the look, the analysis, a strength or hold-to-compare.
{
  const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
  const fn = (name) => {
    const match = new RegExp(`^    function ${name}\\(`, 'm').exec(source);
    assert.ok(match, `runtime function exists: ${name}`);
    return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
  };
  const image = agedPositiveFixture(64, 48);
  const analysis = expiredAnalysisOf(image);
  const state = {
    curves: { r: [], g: [], b: [] }, look: syntheticLook(), expiredAnalysis: analysis,
    expiredEnabled: true, expiredLevels: 100, expiredNeutralize: 100, expiredCrossover: 100, expiredBrightness: 10,
    expiredContrast: 25, expiredUnevenFog: 100, expiredLocalContrast: 30,
  };
  let builds = 0;
  const context = vm.createContext({
    state, sanitizeNumeric: (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value ?? fallback))), expiredCompareHeld: false, EXPIRED_RESCUE_KEYS, sanitizeLookForSettings, sanitizeExpiredRescueParams, sanitizeExpiredAnalysis,
    computeAdjustmentParams: (...args) => { builds++; return computeAdjustmentParams(...args); },
    displayStageUniforms, displayStageCache: { key: null, look: undefined, analysis: undefined, stages: null },
  });
  vm.runInContext(fn('currentDisplayStages'), context);
  const first = context.currentDisplayStages();
  assert.equal(context.currentDisplayStages(), first, 'an unchanged recipe reuses its stages');
  assert.equal(builds, 1);
  // What the CPU display computes for the same recipe.
  const cpu = computeAdjustmentParams({ ...state, look: sanitizeLookForSettings(state.look) }, { width: 1, height: 1 });
  assert.deepEqual(first.fog, cpu.rescueSpatial.fog);
  assert.deepEqual([...first.tone.data], [...cpu.rescueStages.tone]);
  assert.deepEqual(first.lookMatrix, cpu.lookMatrix);
  state.expiredLevels = 80;
  const tick = context.currentDisplayStages();
  assert.notEqual(tick, first);
  assert.notEqual(tick.tone, first.tone, 'a strength tick uploads a new tone curve');
  assert.equal(tick.mean, first.mean, 'but not the grid');
  assert.equal(tick.lookCurves, first.lookCurves, 'nor the look');
  assert.deepEqual([...tick.tone.data], [...buildExpiredRescueStages({ ...state, expiredAnalysis: sanitizeExpiredAnalysis(analysis) }).tone]);
  context.expiredCompareHeld = true;
  const held = context.currentDisplayStages();
  assert.equal(held.rescueOn, 0, 'hold-to-compare drops the rescue on screen');
  assert.equal(held.lookMatrixOn, 1);
  context.expiredCompareHeld = false;
  state.look = null;
  const noLook = context.currentDisplayStages();
  assert.equal(noLook.lookMatrixOn + noLook.lookCurvesOn, 0);
  assert.equal(noLook.rescueOn, 1);
  // The live cache recipe formerly omitted vibrance even though the CPU's
  // per-pixel HSL path rounds before C/M/Y.
  state.expiredEnabled = false;
  state.look = syntheticLook({ matrix: false });
  state.vibrance = 0;
  const plain = context.currentDisplayStages();
  Object.assign(state, { vibrance: 35, cyan: 6, magenta: -4, yellow: 3, wbR: 1.06, wbG: 0.97, wbB: 0.92 });
  const vibrance = context.currentDisplayStages();
  assert.notEqual(vibrance, plain, 'vibrance invalidates the stage cache');
  assert.equal(vibrance.roundBeforeCmy, 1);
  const aged = agedPositiveFixture(211, 137);
  const c = buildDisplayModesCase({ name: 'live curves + vibrance', image: aged, settings: { ...state, look: sanitizeLookForSettings(state.look) } });
  assert.deepEqual(vibrance, c.stages, 'live stages equal the full recipe stages');
  const parity = displayParity(c.expected, modelDisplayStep3({ image: aged, step3: c.step3, stages: vibrance }));
  assert.equal(parity.p999, 0, JSON.stringify(parity));
  const missingRound = displayParity(c.expected, modelDisplayStep3({ image: aged, step3: c.step3,
    stages: { ...vibrance, roundBeforeCmy: 0 } }));
  assert.equal(missingRound.p999, 2, 'the live recipe catches the missing rounding flag');
  // R2-020: keep the original identity-WB fixture and strict pixel target.
  // An unsupported mode must take the actual CPU display path rather than
  // accepting the shader's half-level rounding differences.
  const identityWb = buildDisplayModesCase({ name: 'identity WB + vibrance', image: aged,
    settings: { ...c.recipe, wbR: 1, wbG: 1, wbB: 1 } });
  const gate = vm.createContext({ state: { ...identityWb.recipe, processedImageData: aged, currentStep: 3 },
    webglState: { gl: {}, modesReady: true, disabledByError: false }, displayModesSupported });
  vm.runInContext(['displayModesNeeded', 'isWebGLActive'].map(fn).join('\n'), gate);
  const shaderParity = displayParity(identityWb.expected, modelDisplayStep3({ image: aged,
    step3: identityWb.step3, stages: vibrance }));
  const cpuDisplay = { width: aged.width, height: aged.height, data: new Uint8ClampedArray(aged.data.length) };
  applyPreparedAdjustmentsToBuffer(aged, identityWb.recipe, cpuDisplay, { quality: 'full' });
  const identityParity = displayParity(identityWb.expected, gate.isWebGLActive()
    ? modelDisplayStep3({ image: aged, step3: identityWb.step3, stages: vibrance }) : cpuDisplay.data);
  assert.equal(identityParity.p999, 0, `original identity-WB recipe: ${JSON.stringify(identityParity)}`);
  assert.equal(identityParity.max, 0, 'the CPU fallback preserves every original fixture pixel');
  assert.equal(gate.isWebGLActive(), false, 'the affected mode stays on CPU until its strict shader target passes');
  assert.equal(shaderParity.p999, 2, 'the unchanged fixture still diagnoses the unsupported fp32 shader');
  console.log('live vibrance rounding:', { parity, identityParity, missingRound });
}

// ---- 4. The self-test's comparison, the underlay viewport, u_frame ----
{
  const cases = buildDisplayModesCases(32, 24);
  const n = 32, m = 24, width = n * cases.length;
  const pixels = new Uint8Array(width * m * 4);
  cases.forEach((c, k) => {
    for (let y = 0; y < m; y++) pixels.set(c.expected.subarray(y * n * 4, (y + 1) * n * 4), ((m - 1 - y) * width + k * n) * 4);
  });
  assert.equal(compareDisplayModes(cases, pixels, width, m).ok, true, 'a readback of the references passes');
  const flipped = new Uint8Array(pixels.length);
  for (let y = 0; y < m; y++) flipped.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), (m - 1 - y) * width * 4);
  assert.equal(compareDisplayModes(cases, flipped, width, m).ok, false, 'an upside-down readback fails');
  const off = pixels.slice();
  for (let i = 0; i < off.length; i += 4) off[i] ^= 0x10;
  assert.equal(compareDisplayModes(cases, off, width, m).ok, false, 'the corrupted self-test fails');
  assert.equal(DISPLAY_PARITY_MEAN, 1);
  assert.equal(DISPLAY_PARITY_P999, 3);
}
{
  const landscape = getSprocketFrameLayout(1800, 1200, {});
  assert.deepEqual(photoViewport(landscape), [landscape.x, landscape.frameHeight - landscape.y - landscape.height, landscape.width, landscape.height],
    'the photo rectangle, flipped to GL\'s bottom-left origin');
  const portrait = getSprocketFrameLayout(1200, 1800, {});
  assert.ok(portrait.frameHeight > portrait.frameWidth && portrait.x > 0);
  assert.deepEqual(photoViewport(portrait), [portrait.x, portrait.frameHeight - portrait.y - portrait.height, portrait.width, portrait.height]);
  const half = photoViewport(landscape, landscape.frameWidth / 2, landscape.frameHeight / 2);
  assert.ok(Math.abs(half[2] - landscape.width / 2) <= 1 && Math.abs(half[3] - landscape.height / 2) <= 1, 'scaled with a capped buffer');
  assert.deepEqual(wholeFrame(200, 100), [0, 0, 1 / 200, 1 / 100]);
}

// The display stages of an identity look are off (sanitizeLookForSettings drops it).
assert.equal(displayStageUniforms(computeAdjustmentParams({ curves: { r: [], g: [], b: [] }, look: sanitizeLookForSettings(syntheticLook({ matrix: false, curves: false })) })).active, false);
void sanitizeExpiredRescueParams;

console.log(`displayModes: ${checked} display-mode recipes within mean ${DISPLAY_PARITY_MEAN} / p99.9 ${DISPLAY_PARITY_P999} (fp32 and wide; worst ${JSON.stringify(worst)}), flipped v and transposed look fail, stages mirror the CPU and are rebuilt only on a change`);
