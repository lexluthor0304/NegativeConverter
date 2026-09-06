// Curve generation contract tests: channel routing of the white-balance
// controls, and monotonicity of the exposure/brightness response across the
// full slider range the UI exposes.
import assert from 'node:assert/strict';
import { generateCurves } from './CurveEngine.js';

const channelData = [0, 1, 2].map(() => ({
  whitePointOrigin: 60000,
  blackPointOrigin: 4000,
  meanPoint: 0.5,
  whitePoint: 60000,
  blackPoint: 4000,
}));

function settings(overrides = {}) {
  return {
    imageType: 'negative',
    toneProfile: 'standard',
    brightness: 0, exposure: 0, contrast: 0,
    highlights: 0, shadows: 0, whites: 0, blacks: 0,
    glow: 0, fade: 0,
    temp: 0, tint: 0, cyan: 0,
    wbCyan: 0, wbTemp: 0, wbTint: 0,
    wbTonality: 'addDensity', wbMethod: 'linearFixed', layerOrder: 'colorFirst',
    shadowRange: 5, highlightRange: 5,
    shadowCyan: 0, shadowTint: 0, shadowTemp: 0,
    highlightCyan: 0, highlightTint: 0, highlightTemp: 0,
    midCyan: 0, midTint: 0, midTemp: 0,
    curvePrecision: 'auto',
    autoToneLevel: 1, autoColorLevel: 1,
    softHighlights: false, softShadows: false,
    ...overrides,
  };
}

function midtone(overrides) {
  const luts = generateCurves(channelData, settings(overrides));
  const at = (lut) => lut[Math.round((lut.length - 1) * 0.5)];
  return { r: at(luts.r), g: at(luts.g), b: at(luts.b) };
}

// --- Channel routing -------------------------------------------------------
// The engine convention is cyan -> R, tint -> G, temp -> B. colorLinearLayer
// (`[wbCyan, wbTint, wbTemp]`), the shadow/mid/highlight colour layers and
// WhiteBalance.computeAutoColor all use that order, so the gamma layer must
// agree. Before this was fixed the temperature value drove red and the cyan
// value was silently dropped.
const neutral = midtone({});
assert.equal(neutral.r, neutral.g, 'neutral settings must leave R and G equal');
assert.equal(neutral.g, neutral.b, 'neutral settings must leave G and B equal');

for (const [key, moved] of [['cyan', 'r'], ['tint', 'g'], ['temp', 'b']]) {
  const others = ['r', 'g', 'b'].filter((ch) => ch !== moved);
  const positive = midtone({ [key]: 50 });
  const negative = midtone({ [key]: -50 });

  assert.ok(positive[moved] < neutral[moved], `${key}>0 must lower the ${moved} channel`);
  assert.ok(negative[moved] > neutral[moved], `${key}<0 must raise the ${moved} channel`);
  for (const other of others) {
    assert.equal(positive[other], neutral[other], `${key} must not touch ${other}`);
    assert.equal(negative[other], neutral[other], `${key} must not touch ${other}`);
  }
}

// --- Exposure --------------------------------------------------------------
// The slider runs to -300 (index.html) and the adapter clamps to that range.
// Every value on it has to stay finite, monotone and above black.
const exposureSteps = [300, 200, 100, 50, 25, 10, 0, -10, -20, -25, -30, -36, -50, -100, -200, -300];
let previousExposure = Infinity;
for (const exposure of exposureSteps) {
  const { r, g, b } = midtone({ exposure });
  for (const value of [r, g, b]) {
    assert.ok(Number.isFinite(value), `exposure ${exposure} produced a non-finite LUT entry`);
    assert.ok(value > 0, `exposure ${exposure} collapsed the mid-tone to black`);
    assert.ok(value <= 65535, `exposure ${exposure} overflowed the LUT range`);
  }
  assert.ok(r < previousExposure, `exposure must decrease monotonically (broke at ${exposure})`);
  previousExposure = r;
}

// The response below -36 used to be a black frame; it must now still be dark
// but recognisably an image.
assert.ok(midtone({ exposure: -100 }).r > 1000, 'exposure -100 must not be effectively black');

// Values inside the range people actually used are unchanged by the rewrite.
assert.equal(midtone({ exposure: -10 }).r, 29795, 'exposure -10 response changed');
assert.equal(midtone({ exposure: -20 }).r, 23430, 'exposure -20 response changed');
assert.equal(midtone({ exposure: 100 }).r, 58885, 'exposure +100 response changed');

// --- Brightness ------------------------------------------------------------
// gamma = 1/(1 + b*0.02) divides by zero at -50 and turns negative below it,
// which inverted the mid-tones to white. The divisor is now floored.
let previousBrightness = Infinity;
for (const brightness of [100, 50, 25, 0, -20, -35, -45, -50, -75, -100]) {
  const { r } = midtone({ brightness });
  assert.ok(Number.isFinite(r), `brightness ${brightness} produced a non-finite LUT entry`);
  if (brightness < 0) {
    assert.ok(r < neutral.r, `brightness ${brightness} brightened the mid-tone instead of darkening it`);
  }
  assert.ok(r <= previousBrightness, `brightness must not increase as it goes down (broke at ${brightness})`);
  previousBrightness = r;
}
assert.equal(midtone({ brightness: -45 }).r, 2326, 'brightness -45 response changed');
assert.equal(midtone({ brightness: 50 }).r, 48600, 'brightness +50 response changed');

console.log('CurveEngine tests: all passed');
