// #239: the GPU preview shaders.
//  1. The GLSL compiles (glslc, when installed: GLSL ES 3.00 checked as 3.10, which
//     accepts every 3.00 construct used here) and carries the JS stage constants.
//  2. Its arithmetic, modelled line by line in fp32 (test-fixtures/previewShaderModel)
//     and with wider intermediates (fused multiply-add), reproduces the CPU engine's
//     8-bit output for every film preset and the extreme settings of the acceptance
//     list: at most 1 per channel and at least 99.9 % identical pixels. The GLSL text
//     itself is compared with the engine by the in-browser self-test and
//     scripts/gpu-preview-smoke.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

await import('../pipeline/oracle/adapterParity.mjs'); // ImageData and file: fetch for the profiles
const shader = await import('./previewShader.js');
const { resolveSilverCoreParams, toGrayscaleInPlace } = await import('../pipeline/silverAdapter.js');
const { Engine } = await import('../silvercore/engine/Engine.js');
const { loadProfile } = await import('../silvercore/engine/EnhancedProfiles.js');
const { filmPresets } = await import('../silvercore/engine/FilmPresets.js');
const { bwMixWeights } = await import('../silvercore/engine/Presets.js');
const { paperTonings } = await import('../silvercore/engine/PaperProfiles.js');
const { toRGBA8 } = await import('../silvercore/util/image16.js');
const { applyPreviewChain, applyUniforms, packTableTexture, packHueWeights, packLinearLut } = await import('./previewTables.js');
const { buildSelfTestCases, compareSelfTest, selfTestFixture } = await import('./gpuPreviewSelfTest.js');
const { modelApplyProgram, compare8 } = await import('../../test-fixtures/previewShaderModel.mjs');
const { hueWeightTables } = await import('../silvercore/engine/ImageProcessor.js');
const { LINEAR_LUT } = await import('../silvercore/util/localExposure.js');

// ---- 1. GLSL ----
{
  const { APPLY_FRAGMENT_SHADER, STEP3_FRAGMENT_SHADER, VERTEX_SHADER_300, STEP3_FRAGMENT_SHADER_100, UNITS, glslFloat } = shader;
  assert.equal(glslFloat(3600), '3600.0');
  assert.equal(glslFloat(0.299), '0.299');
  assert.throws(() => glslFloat(NaN));
  for (const constant of ['3600.0', '0.299 * v.r', '0.587 * v.g', '0.114 * v.b', '4096.0', '65535.0', '31.0 / MAX16']) {
    assert.ok(APPLY_FRAGMENT_SHADER.includes(constant), `apply shader carries ${constant}`);
  }
  assert.equal(new Set(Object.values(UNITS)).size, Object.keys(UNITS).length, 'every sampler has its own unit');
  for (const source of [APPLY_FRAGMENT_SHADER, STEP3_FRAGMENT_SHADER]) {
    assert.ok(source.startsWith('#version 300 es'));
    assert.ok(source.includes('vec3 applyStep3(vec3 c)'), 'one shared Step-3 function');
    assert.ok(!/u_exposure|u_contrast|u_highlights|u_shadows|u_temp\b|u_tint|u_sat\b.*1\.0/.test(source.replace('uniform float u_sat;', '')),
      'no legacy tone uniforms');
    assert.ok(source.includes('texelFetch'), 'texels are fetched, never filtered');
  }
  assert.ok(!/u_exposure|u_contrast|u_temp/.test(STEP3_FRAGMENT_SHADER_100), 'the WebGL1 fallback lost them too');

  let glslc = null;
  try { execFileSync('glslc', ['--version'], { stdio: 'pipe' }); glslc = 'glslc'; } catch { /* not installed */ }
  if (glslc) {
    const dir = mkdtempSync(join(tmpdir(), 'nc-glsl-'));
    try {
      for (const [name, source, stage] of [['vertex', VERTEX_SHADER_300, 'vert'], ['step3', STEP3_FRAGMENT_SHADER, 'frag'], ['apply', APPLY_FRAGMENT_SHADER, 'frag']]) {
        const file = join(dir, `${name}.${stage}`);
        writeFileSync(file, source.replace('#version 300 es', '#version 310 es'));
        try {
          execFileSync(glslc, [`-fshader-stage=${stage}`, '--target-env=opengl', '-fauto-bind-uniforms', '-fauto-map-locations', file, '-o', join(dir, `${name}.spv`)], { stdio: 'pipe' });
        } catch (err) {
          assert.fail(`${name} shader does not compile:\n${err.stderr}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log('previewShader: GLSL compiles (glslc)');
  } else {
    console.log('previewShader: glslc not installed, GLSL compile check skipped');
  }
}

// ---- Tables ----
{
  const r = new Uint16Array(65536), g = new Uint16Array(65536), b = new Uint16Array(65536);
  for (let v = 0; v < 65536; v++) { r[v] = v; g[v] = 65535 - v; b[v] = (v * 7) & 0xFFFF; }
  const texels = packTableTexture(r, g, b);
  for (const v of [0, 255, 256, 257, 40000, 65535]) {
    const i = ((v >> 8) * 256 + (v & 255)) * 4; // texel (v & 255, v >> 8)
    assert.deepEqual([...texels.subarray(i, i + 4)], [r[v], g[v], b[v], 0]);
  }
  assert.equal(packTableTexture(r, g, b, texels), texels, 'the pack buffer is reused');
  const hue = packHueWeights();
  const [tR, tG, tB] = hueWeightTables();
  assert.equal(hue.width, 64);
  for (const i of [0, 63, 64, 1800, 3599]) {
    const t = ((i >> 6) * 64 + (i & 63)) * 4;
    assert.deepEqual([hue.data[t], hue.data[t + 1], hue.data[t + 2]], [tR[i], tG[i], tB[i]]);
  }
  const linear = packLinearLut();
  assert.equal(linear.height, 65);
  assert.equal(linear.data[4096], LINEAR_LUT[4096]);
}

// ---- 2. Arithmetic: the model against the engine ----
const W = 96, H = 64;
function frame(kind) {
  const data = new Uint16Array(W * H * 4);
  const fixture = selfTestFixture(11);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (y < 32) {
        // Half the frame from the edge-case fixture, half film-like densities.
        data.set(fixture.data.subarray(((y * 2) * 64 + (x % 64)) * 4, ((y * 2) * 64 + (x % 64)) * 4 + 4), i);
      } else {
        const t = (x / W + (y - 32) / 32) / 2;
        const film = kind === 'positive' ? [0.2 + 0.7 * t, 0.15 + 0.7 * t * t, 0.1 + 0.8 * t] : [0.75 - 0.4 * t, 0.5 - 0.3 * t, 0.35 - 0.2 * t];
        data.set([...film.map((v) => Math.round((v + 0.03 * Math.sin(x * 0.7 + y)) * 65535)), 65535], i);
      }
    }
  }
  return { width: W, height: H, data };
}
function stopsMap() {
  const stops = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) if ((p % W) > W / 2) stops[p] = Math.sin(p * 0.37) * 1.8;
  return stops;
}

let cases = 0;
const worst = { maxDiff: 0, identical: 1, name: '' };
async function check(name, mode, settings, { stops = null, positive = null } = {}) {
  const image = frame(mode);
  const params = resolveSilverCoreParams(mode, settings, filmPresets);
  const engine = new Engine(W, H);
  engine.enhancedLut = params.enhancedProfile !== 'none' ? await loadProfile(params.enhancedProfile) : null;
  // analyze() sees the frame as the adapter hands it: mixed down in B&W.
  const sample = { width: W, height: H, data: new Uint16Array(image.data) };
  if (mode === 'bw') toGrayscaleInPlace(sample, params.bwMix);
  engine.analyze(sample, params);
  if (positive) engine.positiveAnalysis = positive;
  const plan = engine.previewPlan(params, { grey: mode === 'bw' });
  const expected = toRGBA8(applyPreviewChain(engine, { width: W, height: H, data: new Uint16Array(image.data) }, params, mode, stops)).data;
  const uniforms = applyUniforms({ mode, params, plan, positive: engine.positiveAnalysis, hasStops: Boolean(stops) });
  const inputs = {
    image, stops, uniforms, toneLut: mode === 'bw' ? plan.greyTable : plan.luts, paperLut: plan.paper,
    profile: engine.enhancedLut, preSatRamp: engine.preSaturationRamp(params), satRamp: engine.saturationRamp(params),
  };
  for (const [variant, round] of [['fp32', Math.fround], ['wide', (x) => x]]) {
    const result = compare8(modelApplyProgram(inputs, round), expected);
    assert.ok(result.maxDiff <= 1 && result.identical >= 0.999, `${name} (${variant}): ${JSON.stringify(result)}`);
    if (result.maxDiff > worst.maxDiff || result.identical < worst.identical) Object.assign(worst, result, { name: `${name} (${variant})` });
  }
  cases++;
}

// Every film preset in its own film type.
for (const [id, preset] of Object.entries(filmPresets)) {
  const mode = preset.category;
  await check(`preset ${id}`, mode, { filmType: mode, filmPreset: id, colorModel: 'standard', temperature: 8, contrast: 12 });
}
// Extremes.
for (const exposure of [-300, 300]) await check(`exposure ${exposure}`, 'color', { colorModel: 'standard', exposure });
for (const saturation of [0, 200]) await check(`saturation ${saturation}`, 'color', { colorModel: 'frontier', saturation });
for (const profileStrength of [0, 100, 200]) {
  await check(`profile ${profileStrength}`, 'color', { colorModel: 'standard', enhancedProfile: 'noritsu', profileStrength });
}
for (const preSaturation of [0, 200]) {
  await check(`pre-saturation ${preSaturation}`, 'color', { colorModel: 'standard', preSaturation });
  await check(`B&W pre-saturation ${preSaturation}`, 'bw', { preSaturation });
}
for (const bwMix of Object.keys(bwMixWeights)) await check(`B&W mix ${bwMix}`, 'bw', { bwMix, contrast: 20 });
for (const toning of Object.keys(paperTonings)) {
  await check(`paper toning ${toning}`, 'bw', { paper: 'multigrade-fb-warmtone', paperToning: toning, paperToningStrength: 80 });
}
await check('RA-4 paper', 'color', { colorModel: 'noritsu', paper: 'endura', saturation: 140 });
await check('positive gain and WB', 'positive', { colorModel: 'basic', whites: 20 }, { positive: { gain: 2.4, wb: [0.9, 1, 0.82] } });
await check('positive WB only', 'positive', { colorModel: 'standard' }, { positive: { gain: 1, wb: [1, 0.95, 0.88] } });
await check('dodge and burn', 'color', { colorModel: 'standard', preSaturation: 130 }, { stops: stopsMap() });
await check('B&W dodge and burn', 'bw', { bwMix: 'green', preSaturation: 70 }, { stops: stopsMap() });
await check('positive dodge and burn', 'positive', { colorModel: 'none' }, { stops: stopsMap(), positive: { gain: 1.6, wb: [1, 1, 1] } });

// The self-test's own cases match the model exactly, and its comparison catches a
// flipped or corrupted readback.
{
  const selfCases = buildSelfTestCases();
  const n = 64, width = n * (selfCases.length + 1);
  const pixels = new Uint8Array(width * n * 4);
  const put = (expected, k) => {
    for (let y = 0; y < n; y++) pixels.set(expected.subarray(y * n * 4, (y + 1) * n * 4), ((n - 1 - y) * width + k * n) * 4);
  };
  selfCases.forEach((testCase, k) => {
    const uniforms = applyUniforms({ mode: testCase.mode, params: testCase.params, plan: testCase.plan, positive: testCase.positive, hasStops: Boolean(testCase.stops) });
    const out = modelApplyProgram({
      image: testCase.prepared, stops: testCase.stops, uniforms,
      toneLut: testCase.mode === 'bw' ? testCase.plan.greyTable : testCase.plan.luts, paperLut: testCase.plan.paper,
      profile: testCase.profile, preSatRamp: testCase.engine.preSaturationRamp(testCase.params), satRamp: testCase.engine.saturationRamp(testCase.params),
    });
    assert.deepEqual(compare8(out, testCase.expected), { maxDiff: 0, identical: 1 }, `self-test ${testCase.name}`);
    put(testCase.expected, k);
  });
  put(selfCases[0].expected, selfCases.length);
  const all = [...selfCases, { name: 'step3', expected: selfCases[0].expected }];
  assert.equal(compareSelfTest(all, pixels, width, n).ok, true);
  const flipped = new Uint8Array(pixels.length);
  for (let y = 0; y < n; y++) flipped.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), (n - 1 - y) * width * 4);
  assert.equal(compareSelfTest(all, flipped, width, n).ok, false, 'an upside-down readback fails');
  pixels[(10 * width + 5) * 4] ^= 0x08;
  assert.equal(compareSelfTest(all, pixels, width, n).ok, false, 'a byte off by 8 fails');
}

console.log(`previewShader: ${cases} settings × fp32/wide within 1 and ≥ 99.9 % identical (worst ${JSON.stringify(worst)})`);
