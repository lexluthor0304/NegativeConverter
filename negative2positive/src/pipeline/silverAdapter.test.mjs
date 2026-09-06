// Standalone Node test for silverAdapter.js - run with:
// node negative2positive/src/pipeline/silverAdapter.test.mjs
//
// Covers the parameter/preset plumbing: film-preset merge precedence, the tone-profile
// override, the enhanced-profile whitelist, Border Buffer 0, film-base scoping,
// the B&W split-tone path, buffer ownership and analysis invalidation.

import assert from 'node:assert/strict';

// The adapter hands back a browser ImageData; Node has no such global.
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const {
  buildSilverCoreParams,
  convertColorWithSilverCore,
  convertBwWithSilverCore,
  invalidateSilverCoreCache,
} = await import('./silverAdapter.js');
const { Engine } = await import('../silvercore/engine/Engine.js');
const { analyzeImage } = await import('../silvercore/engine/ImageProcessor.js');
const { toneProfiles } = await import('../silvercore/engine/Presets.js');
const { PROFILES } = await import('../silvercore/engine/EnhancedProfiles.js');
const { filmPresets } = await import('../silvercore/engine/FilmPresets.js');

// The 8 preset keys the app mirrors into its own state and re-sends on every
// conversion (main.js applyFilmPresetSettingsToState).
const MIRRORED_KEYS = [
  'enhancedProfile', 'saturation', 'glow', 'fade',
  'shadows', 'highlights', 'blacks', 'whites',
];

function callerSettings(overrides = {}) {
  // Mirrors what main.js buildCoreConversionSettings sends: every core control is
  // always present, none of the preset-only keys ever are.
  return {
    filmPreset: 'none',
    colorModel: 'standard',
    enhancedProfile: 'none',
    profileStrength: 100,
    preSaturation: 100,
    borderBuffer: 10,
    brightness: 0,
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    wbMode: 'auto',
    temperature: 0,
    tint: 0,
    saturation: 100,
    glow: 0,
    fade: 0,
    curvePrecision: 'auto',
    useWebGL: true,
    ...overrides,
  };
}

// --- F72: film preset supplies defaults, the caller's live sliders win -------------

{
  // Preset-only keys (no UI control, never sent by the caller) still reach the engine.
  const params = await buildSilverCoreParams('color', callerSettings({ filmPreset: 'frontier-lab' }));
  const preset = filmPresets['frontier-lab'].settings;
  assert.equal(params.toneProfile, preset.toneProfile);
  assert.equal(params.shadowTemp, preset.shadowTemp);
  assert.equal(params.shadowTint, preset.shadowTint);
  assert.equal(params.highlightTemp, preset.highlightTemp);
  assert.equal(params.shadowRange, preset.shadowRange);
  assert.equal(params.wbTonality, preset.wbTonality);
  assert.equal(params.layerOrder, preset.layerOrder);
}

{
  // A slider the user moved after picking the preset must not be re-overwritten.
  const params = await buildSilverCoreParams('color', callerSettings({
    filmPreset: 'frontier-lab',
    shadows: 0,
    highlights: 0,
    blacks: 0,
    whites: 0,
    saturation: 100,
    glow: 0,
    fade: 0,
  }));
  assert.equal(params.shadows, 0, 'preset must not override an explicit shadows value');
  assert.equal(params.highlights, 0);
  assert.equal(params.saturation, 100);
  assert.equal(params.glow, 0);
  assert.equal(params.fade, 0);
  // ...while the preset still owns the keys the caller never sends.
  assert.equal(params.toneProfile, 'base');
  assert.equal(params.shadowTemp, 6);
}

{
  // Every mirrored key is one the caller sends, so the caller wins on all of them.
  const marked = callerSettings({
    filmPreset: 'gold-warm',
    shadows: -3, highlights: -4, blacks: -5, whites: -6,
    saturation: 111, glow: 7, fade: 9, enhancedProfile: 'crystal',
  });
  const params = await buildSilverCoreParams('color', marked);
  for (const key of MIRRORED_KEYS) {
    assert.equal(params[key], marked[key], `caller value for ${key} must win over the preset`);
  }
}

{
  // An explicitly undefined caller key must not mask the preset's value.
  const params = await buildSilverCoreParams('color', {
    filmPreset: 'frontier-lab',
    shadows: undefined,
  });
  assert.equal(params.shadows, filmPresets['frontier-lab'].settings.shadows);
}

{
  // Unknown preset ids fall through to the caller's settings untouched.
  const params = await buildSilverCoreParams('color', callerSettings({
    filmPreset: 'no-such-preset',
    shadows: -11,
  }));
  assert.equal(params.shadows, -11);
  assert.equal(params.toneProfile, null);
}

// --- F73: toneProfile reaches the engine ------------------------------------------

{
  const params = await buildSilverCoreParams('color', callerSettings({ filmPreset: 'noritsu-lab' }));
  assert.equal(params.toneProfile, 'base_gamma');

  const engine = new Engine(4, 4);
  const settings = engine.buildSettings(params);
  assert.equal(settings.toneProfile, 'base_gamma');

  // Every shipped preset names a profile the engine actually knows.
  for (const [id, preset] of Object.entries(filmPresets)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(toneProfiles, preset.settings.toneProfile),
      `preset ${id} names unknown tone profile ${preset.settings.toneProfile}`
    );
  }
}

{
  // No override -> derived from the colour model, exactly as before.
  const engine = new Engine(4, 4);
  assert.equal(engine.buildSettings({ colorModel: 'cine-log' }).toneProfile, 'filmic');
  assert.equal(engine.buildSettings({ colorModel: 'standard' }).toneProfile, 'standard');
  // A bogus override is ignored rather than crashing the curve generator.
  assert.equal(
    engine.buildSettings({ colorModel: 'cine-log', toneProfile: 'not-a-profile' }).toneProfile,
    'filmic'
  );
  assert.equal(
    (await buildSilverCoreParams('color', { toneProfile: 'not-a-profile' })).toneProfile,
    null
  );
}

// --- F74: the shipped 'noritsu' 3D LUT profile is not filtered out -----------------

{
  assert.ok(PROFILES.includes('noritsu'));
  const params = await buildSilverCoreParams('color', {
    filmPreset: 'noritsu-lab',
    // caller sends nothing for enhancedProfile -> the preset's value must survive
  });
  assert.equal(params.enhancedProfile, 'noritsu');
  // Every profile a preset asks for must be one the loader can serve.
  for (const [id, preset] of Object.entries(filmPresets)) {
    assert.ok(
      PROFILES.includes(preset.settings.enhancedProfile),
      `preset ${id} asks for unknown enhanced profile ${preset.settings.enhancedProfile}`
    );
  }
  // Junk still collapses to 'none'.
  assert.equal((await buildSilverCoreParams('color', { enhancedProfile: 'bogus' })).enhancedProfile, 'none');
}

// --- F79: Border Buffer 0 means the whole frame ------------------------------------

{
  assert.equal((await buildSilverCoreParams('color', { borderBuffer: 0 })).borderBuffer, 0);
  assert.equal((await buildSilverCoreParams('color', {})).borderBuffer, 10);

  const engine = new Engine(4, 4);
  assert.equal(engine.buildSettings({ borderBuffer: 0 }).borderBuffer, 0);
  assert.equal(engine.buildSettings({}).borderBuffer, 10);

  // A frame that is bright only in its outer 10% border: with borderBuffer 0 the
  // analysis sees the border, with 10 it does not.
  const w = 40, h = 40;
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inBorder = x < w * 0.1 || x >= w * 0.9 || y < h * 0.1 || y >= h * 0.9;
      const v = inBorder ? 65535 : 20000;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 65535;
    }
  }
  const img = { width: w, height: h, data };
  const whole = analyzeImage(img, { borderBuffer: 0, colorModel: 'standard' });
  const inset = analyzeImage(img, { borderBuffer: 10, colorModel: 'standard' });
  assert.notEqual(whole[0].blackPointOrigin, inset[0].blackPointOrigin);
  // borderBuffer 0 must not be treated as "missing" (which used to mean 10).
  assert.notDeepEqual(whole[0], analyzeImage(img, { colorModel: 'standard' })[0]);
}

// --- image helpers for the conversion tests ---------------------------------------

function makeNegative(w, h) {
  const data = new Uint16Array(w * h * 4);
  const n = w * h;
  for (let p = 0; p < n; p++) {
    const t = p / (n - 1);
    const i = p * 4;
    data[i] = Math.round(6000 + t * 52000);
    data[i + 1] = Math.round(11000 + t * 41000);
    data[i + 2] = Math.round(19000 + t * 31000);
    data[i + 3] = 65535;
  }
  return { width: w, height: h, data };
}

// --- F214: the returned 16-bit plane belongs to the caller -------------------------

{
  invalidateSilverCoreCache();
  const img = makeNegative(12, 12);
  const first = await convertColorWithSilverCore(
    img,
    callerSettings({ contrast: 0 }),
    { preview: true, forceFullProcess: true }
  );
  const snapshot = Uint16Array.from(first.__image16.data);

  const second = await convertColorWithSilverCore(
    img,
    callerSettings({ contrast: 90, shadows: -90, blacks: -40 }),
    { preview: true }
  );

  assert.notEqual(first.__image16, second.__image16, 'results must not share one Image16');
  assert.notEqual(first.__image16.data, second.__image16.data, 'results must not share one plane');
  assert.deepEqual(
    Array.from(first.__image16.data),
    Array.from(snapshot),
    'an earlier result must not mutate when a later conversion runs'
  );
  assert.notDeepEqual(
    Array.from(second.__image16.data),
    Array.from(snapshot),
    'the two settings should actually produce different pixels'
  );
  // The 8-bit view and the attached 16-bit plane must describe the same conversion.
  for (let i = 0; i < first.data.length; i++) {
    assert.equal(first.data[i], first.__image16.data[i] >>> 8);
  }
}

// --- F83: analysis is re-run when its inputs change, not on every slider tick ------

{
  invalidateSilverCoreCache();
  const img = makeNegative(24, 24);
  const engineOf = async (settings, options) => {
    const out = await convertColorWithSilverCore(img, settings, options);
    return out;
  };

  await engineOf(callerSettings({ borderBuffer: 10 }), { preview: true, forceFullProcess: true });

  // A pure LUT change must NOT re-analyse.
  let analyzeCalls = 0;
  const origProcess = Engine.prototype.process;
  Engine.prototype.process = function patched(imageData, params) {
    analyzeCalls += 1;
    return origProcess.call(this, imageData, params);
  };
  try {
    await engineOf(callerSettings({ borderBuffer: 10, contrast: 25 }), { preview: true });
    assert.equal(analyzeCalls, 0, 'a contrast change must reuse the cached histogram');

    await engineOf(callerSettings({ borderBuffer: 0, contrast: 25 }), { preview: true });
    assert.equal(analyzeCalls, 1, 'a Border Buffer change must re-run the analysis');

    await engineOf(callerSettings({ borderBuffer: 0, contrast: 25, colorModel: 'frontier' }), { preview: true });
    assert.equal(analyzeCalls, 2, 'a colour-model change must re-run the analysis');

    await engineOf(callerSettings({ borderBuffer: 0, contrast: 25, colorModel: 'frontier', preSaturation: 140 }), { preview: true });
    assert.equal(analyzeCalls, 3, 'a pre-saturation change must re-run the analysis');

    await engineOf(callerSettings({ borderBuffer: 0, contrast: 30, colorModel: 'frontier', preSaturation: 140 }), { preview: true });
    assert.equal(analyzeCalls, 3, 'an unrelated slider must still reuse the histogram');
  } finally {
    Engine.prototype.process = origProcess;
  }
}

// --- F80: pre-saturation actually does something ----------------------------------

{
  invalidateSilverCoreCache();
  const img = makeNegative(12, 12);
  const neutral = await convertColorWithSilverCore(img, callerSettings(), { preview: true, forceFullProcess: true });
  const flat = Array.from(neutral.__image16.data);
  const boosted = await convertColorWithSilverCore(img, callerSettings({ preSaturation: 0 }), { preview: true, forceFullProcess: true });
  assert.notDeepEqual(Array.from(boosted.__image16.data), flat, 'preSaturation must change the render');
}

// --- F273: B&W conversion ignores the (colour-only) film base ---------------------

{
  const img = makeNegative(12, 12);
  invalidateSilverCoreCache();
  const withDefaultBase = await convertBwWithSilverCore(
    img,
    { ...callerSettings({ filmPreset: 'cold-neutral' }), filmBase: { r: 210, g: 140, b: 90 } },
    { preview: true, forceFullProcess: true }
  );
  invalidateSilverCoreCache();
  const withOtherBase = await convertBwWithSilverCore(
    img,
    { ...callerSettings({ filmPreset: 'cold-neutral' }), filmBase: { r: 120, g: 200, b: 240 } },
    { preview: true, forceFullProcess: true }
  );
  invalidateSilverCoreCache();
  const withoutBase = await convertBwWithSilverCore(
    img,
    callerSettings({ filmPreset: 'cold-neutral' }),
    { preview: true, forceFullProcess: true }
  );
  assert.deepEqual(Array.from(withDefaultBase.__image16.data), Array.from(withOtherBase.__image16.data));
  assert.deepEqual(Array.from(withDefaultBase.__image16.data), Array.from(withoutBase.__image16.data));
}

{
  // Colour mode still uses it.
  const img = makeNegative(12, 12);
  invalidateSilverCoreCache();
  const a = await convertColorWithSilverCore(
    img,
    { ...callerSettings(), filmBase: { r: 210, g: 140, b: 90 } },
    { preview: true, forceFullProcess: true }
  );
  const flat = Array.from(a.__image16.data);
  invalidateSilverCoreCache();
  const b = await convertColorWithSilverCore(
    img,
    { ...callerSettings(), filmBase: { r: 120, g: 200, b: 240 } },
    { preview: true, forceFullProcess: true }
  );
  assert.notDeepEqual(Array.from(b.__image16.data), flat, 'colour mode must still honour the film base');
}

// --- F75: B&W split toning survives -----------------------------------------------

function channelSpread(image16) {
  let maxSpread = 0;
  const d = image16.data;
  for (let i = 0; i < d.length; i += 4) {
    const hi = Math.max(d[i], d[i + 1], d[i + 2]);
    const lo = Math.min(d[i], d[i + 1], d[i + 2]);
    if (hi - lo > maxSpread) maxSpread = hi - lo;
  }
  return maxSpread;
}

{
  const img = makeNegative(16, 16);
  invalidateSilverCoreCache();
  const sepia = await convertBwWithSilverCore(
    img,
    callerSettings({ filmPreset: 'sepia-classic' }),
    { preview: true, forceFullProcess: true }
  );
  invalidateSilverCoreCache();
  const cyanotype = await convertBwWithSilverCore(
    img,
    callerSettings({ filmPreset: 'cyanotype' }),
    { preview: true, forceFullProcess: true }
  );

  assert.ok(channelSpread(sepia.__image16) > 0, 'sepia-classic must produce a tint, not neutral grey');
  assert.ok(channelSpread(cyanotype.__image16) > 0, 'cyanotype must produce a tint, not neutral grey');
  assert.notDeepEqual(
    Array.from(sepia.__image16.data),
    Array.from(cyanotype.__image16.data),
    'B&W presets with different toning must not render identically'
  );

  // A preset with no toning at all still comes out neutral.
  invalidateSilverCoreCache();
  const neutral = await convertBwWithSilverCore(
    img,
    callerSettings({ filmPreset: 'flat-bw' }),
    { preview: true, forceFullProcess: true }
  );
  assert.equal(channelSpread(neutral.__image16), 0, 'an untoned B&W preset must stay neutral');
}

{
  // bwMix is applied to the negative, before the analysis, and still changes the render.
  const img = makeNegative(16, 16);
  invalidateSilverCoreCache();
  const standard = await convertBwWithSilverCore(
    img,
    callerSettings({ bwMix: 'standard' }),
    { preview: true, forceFullProcess: true }
  );
  invalidateSilverCoreCache();
  const red = await convertBwWithSilverCore(
    img,
    callerSettings({ bwMix: 'red' }),
    { preview: true, forceFullProcess: true }
  );
  assert.notDeepEqual(Array.from(standard.__image16.data), Array.from(red.__image16.data));
  assert.equal(channelSpread(standard.__image16), 0, 'untoned B&W must be neutral');
}

invalidateSilverCoreCache();
console.log('silverAdapter.test.mjs: all assertions passed');
