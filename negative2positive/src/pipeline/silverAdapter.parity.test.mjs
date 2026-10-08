// #238 parity: the live adapter (HSL pre-test, transient work planes, prepared prefix
// planes, positive gain-1 fold, B&W grey plane and table) against the frozen 1703835
// adapter and engine. Same request sequences through both, each with its own caches;
// SHA-256 of the 16-bit plane, the 8-bit data and the analysis preview must match.
import assert from 'node:assert/strict';
import { convertBoth, resetBoth, live, oracle } from './oracle/adapterParity.mjs';
import { Engine } from '../silvercore/engine/Engine.js';
import { Engine as OracleEngine } from './oracle/Engine.oracle.js';
import { filmPresets } from '../silvercore/engine/FilmPresets.js';
import { PAPER_IDS, TONING_IDS, paperProfiles } from '../silvercore/engine/PaperProfiles.js';
import { PROFILES } from '../silvercore/engine/EnhancedProfiles.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import { sanitizeFlatFieldMap } from '../app/flatField.js';

const W = 40, H = 30;

// A colour-negative-like frame: orange base, gradients, a few saturated patches,
// transparent corners (rotation fill) and a half-transparent strip.
function negative(seed = 1, w = W, h = H) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (w + h);
      let r = 52000 - 30000 * t, g = 36000 - 22000 * t, b = 24000 - 15000 * t;
      if ((x * 7 + y * 5 + seed) % 13 === 0) { r *= 0.6; g *= 1.2; }
      if ((x * 3 + y * 11 + seed) % 17 === 0) { b *= 1.8; }
      if ((x + y * seed) % 29 === 0) { r = g = b = 30000 + seed * 100; }
      const corner = (x < 3 || x >= w - 3) && (y < 3 || y >= h - 3);
      data[i] = Math.min(65535, Math.round(r + ((x * 131 + y * 71 * seed) % 900)));
      data[i + 1] = Math.min(65535, Math.round(g + ((x * 97 + y * 53 * seed) % 700)));
      data[i + 2] = Math.min(65535, Math.round(b + ((x * 61 + y * 89 * seed) % 500)));
      data[i + 3] = corner ? 0 : y === 12 ? 32768 : 65535;
    }
  }
  return { width: w, height: h, data };
}

// A slide scan: bright (gain 1, high-confidence cast → WB active) or dim (gain > 1).
function positive(scale, cast = [1.1, 1, 0.9], w = W, h = H) {
  const data = new Uint16Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const x = p % w, y = (p / w) | 0;
    const v = (0.25 + 0.75 * (x + y) / (w + h)) * scale;
    let r = v, g = v, b = v;
    if ((x * 7 + y * 3) % 11 === 0) { r = v * 0.9; g = v * 0.5; b = v * 0.2; }
    const corner = (x < 2 || x >= w - 2) && (y < 2 || y >= h - 2);
    data.set([
      Math.min(65535, Math.round(r * cast[0] * 65535)),
      Math.min(65535, Math.round(g * cast[1] * 65535)),
      Math.min(65535, Math.round(b * cast[2] * 65535)),
      corner ? 0 : 65535,
    ], p * 4);
  }
  return { width: w, height: h, data };
}

function crop(image, left, top, w, h) {
  const data = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + left + w) * 4), y * w * 4);
  return { width: w, height: h, data };
}

function as8bit(image) {
  const data = new Uint8ClampedArray(image.data.length);
  for (let i = 0; i < data.length; i++) data[i] = image.data[i] >>> 8;
  return new ImageData(data, image.width, image.height);
}

const flatField = sanitizeFlatFieldMap({
  id: 'pad', width: 4, height: 4,
  gains: Array.from({ length: 48 }, (_, i) => 1 + ((i * 7) % 11) / 25),
});
const flatFieldSettings = {
  flatField,
  flatFieldGeometry: { baseWidth: W, baseHeight: H, rotationAngle: 0, mirrored: false, rotatedWidth: W, rotatedHeight: H, cropRegion: null },
};
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false };
const strokes = (x) => ({
  localExposure: { strokes: [
    { stops: 0.8, size: 0.3, feather: 0.5, points: [{ x, y: 0.4, p: 1 }, { x: x + 0.2, y: 0.6, p: 0.8 }] },
    { stops: -0.6, size: 0.25, feather: 0.3, points: [{ x: 0.7, y: 0.2, p: 1 }] },
  ] },
  localExposureGeometry: geometry,
});

const BASE = {
  color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  positive: { positiveMode: 'correct' },
};
const SOURCE = {
  color: [negative(1), negative(2)],
  bw: [negative(1), negative(3)],
  positive: [positive(1), positive(0.7)],
};

let checks = 0;
async function expectSame(label, mode, image, settings, options) {
  const { live: a, oracle: b } = await convertBoth(mode, image, settings, options);
  assert.deepEqual(a, b, label);
  checks++;
}

// --- 1. settings sweep per mode (interactive preview slot, then forced full slot) ------
function settingsSweep(mode) {
  const list = [
    {}, { brightness: 20 }, { contrast: -15 }, { temperature: 30, tint: -10 }, { exposure: 40 },
    { highlights: -30, shadows: 25, whites: 10, blacks: -10 }, { glow: 30, fade: 20 },
    { saturation: 0 }, { saturation: 130 }, { saturation: 200 },
    { preSaturation: 0 }, { preSaturation: 120 }, { preSaturation: 200 },
    { preSaturation: 120, saturation: 130 }, { preSaturation: 0, saturation: 200 },
    { curvePrecision: 'precise', contrast: 20 }, { borderBuffer: 0 }, { borderBuffer: 30 },
    { analysisRegion: { left: 0.1, top: 0.2, width: 0.5, height: 0.6 } },
    { colorCyan: 12 }, { autoToneLevel: 40, autoColorLevel: 60 },
  ];
  for (const colorModel of ['standard', 'frontier', 'noritsu', 'none', 'warm']) list.push({ colorModel });
  for (const bwMix of Object.keys(bwMixWeights)) list.push({ bwMix }, { bwMix, preSaturation: 120 });
  const kind = mode === 'positive' ? 'positive' : mode;
  const papers = PAPER_IDS.filter((id) => id === 'none' || paperProfiles[id].kind === (kind === 'color' ? 'ra4' : kind === 'bw' ? 'bw' : '-'));
  for (const paper of papers) {
    for (const paperToning of TONING_IDS) {
      for (const paperToningStrength of [50, 100]) list.push({ paper, paperToning, paperToningStrength });
    }
  }
  for (const enhancedProfile of PROFILES) {
    for (const profileStrength of [50, 100, 200]) list.push({ enhancedProfile, profileStrength });
  }
  for (const [id, preset] of Object.entries(filmPresets)) {
    if (preset.category === (mode === 'color' ? 'color' : mode)) list.push({ filmPreset: id });
  }
  list.push({ enhancedProfile: 'frontier', profileStrength: 80, preSaturation: 120, saturation: 130, paper: papers.at(-1), paperToning: 'sepia' });
  return list;
}

for (const mode of ['color', 'bw', 'positive']) {
  const [source] = SOURCE[mode];
  const reference = crop(source, 4, 3, 24, 20);
  for (const options of [{ preview: true, includeAnalysisPreview: false }, { forceFullProcess: true, analysisImageData: reference }]) {
    resetBoth();
    for (const change of settingsSweep(mode)) {
      await expectSame(`${mode} ${JSON.stringify(options).slice(0, 40)} ${JSON.stringify(change)}`, mode, source, { ...BASE[mode], ...change }, options);
    }
  }
}

// --- 2. slot × reference × forceFullProcess sequences ----------------------------------
function slotSequence(mode) {
  const base = BASE[mode];
  const [a, b] = SOURCE[mode];
  return [
    [a, base], [a, { ...base, brightness: 15 }], [a, { ...base, preSaturation: 120 }],
    [a, { ...base, preSaturation: 120, brightness: 25 }], [a, { ...base, ...strokes(0.2) }],
    [a, { ...base, ...strokes(0.2), brightness: 35 }], [a, { ...base, ...strokes(0.3), brightness: 35 }],
    [a, { ...base, ...strokes(0.3), preSaturation: 80 }], [a, { ...base, brightness: 35 }],
    [a, { ...base, borderBuffer: 0 }], [b, { ...base, borderBuffer: 0 }], [b, { ...base, ...flatFieldSettings }],
    [b, { ...base, ...flatFieldSettings, contrast: 20 }], [b, { ...base, ...flatFieldSettings, ...strokes(0.4) }],
    [a, { ...base, filmBaseMethod: 'linear', filmBaseStrength: 0.5 }], [as8bit(a), base], [as8bit(a), { ...base, brightness: 10 }],
    [a, base],
  ];
}

for (const mode of ['color', 'bw', 'positive']) {
  const [source] = SOURCE[mode];
  const references = [crop(source, 4, 3, 24, 20), crop(SOURCE[mode][1], 2, 2, 30, 22)];
  for (const slot of [{ preview: true }, {}, { preview: true, scratch: true }]) {
    for (const withReference of [false, true]) {
      for (const force of [false, true]) {
        for (const includeAnalysisPreview of withReference ? [false, true] : [false]) {
          resetBoth();
          const sequence = slotSequence(mode);
          for (let step = 0; step < sequence.length; step++) {
            const [image, settings] = sequence[step];
            const options = { ...slot, includeAnalysisPreview, forceFullProcess: force || undefined };
            // Swap the reference sample halfway through.
            if (withReference) options.analysisImageData = references[step < 10 ? 0 : 1];
            await expectSame(`${mode} slot ${JSON.stringify(slot)} ref ${withReference} force ${force} preview ${includeAnalysisPreview} step ${step}`, mode, image, settings, options);
          }
        }
      }
    }
  }
}

// --- 3. positive gain = 1 (WB active) and gain > 1, preview and forced ----------------
for (const image of [positive(1), positive(0.7), positive(0.45, [1, 1, 1]), positive(1, [1, 1, 1])]) {
  resetBoth();
  for (const options of [{ preview: true }, { forceFullProcess: true }, { forceFullProcess: true, analysisImageData: crop(image, 3, 3, 20, 20) }]) {
    for (const change of [{}, { brightness: 12 }, strokes(0.5), { positiveMode: 'edit' }, { preSaturation: 140 }, { colorModel: 'frontier' }]) {
      await expectSame(`positive ${JSON.stringify(options).slice(0, 30)} ${JSON.stringify(change).slice(0, 40)}`, 'positive', image, { positiveMode: 'correct', ...change }, options);
    }
  }
}

// --- 4. sharpening (a spatial stage) keeps B&W on the generic path -----------------
{
  const patch = (proto) => {
    const original = proto.buildSettings;
    proto.buildSettings = function (params) { return { ...original.call(this, params), sharpenAmount: 60, sharpenRadius: 1.2 }; };
    return () => { proto.buildSettings = original; };
  };
  const restore = [patch(Engine.prototype), patch(OracleEngine.prototype)];
  let greyTables = 0;
  const buildGreyTable = Engine.prototype._greyTable;
  Engine.prototype._greyTable = function (...args) { greyTables++; return buildGreyTable.apply(this, args); };
  try {
    resetBoth();
    const [source] = SOURCE.bw;
    for (const options of [{ preview: true }, { forceFullProcess: true }, { preview: true, analysisImageData: crop(source, 4, 3, 24, 20) }]) {
      for (const change of [{}, { brightness: 20 }, { preSaturation: 130 }, strokes(0.3), { paper: 'multigrade-rc', paperToning: 'selenium' }]) {
        await expectSame(`bw sharpen ${JSON.stringify(options).slice(0, 30)}`, 'bw', source, { ...BASE.bw, ...change }, options);
      }
    }
    assert.equal(greyTables, 0, 'a spatial stage never uses the grey table');
  } finally {
    restore.forEach((fn) => fn());
    Engine.prototype._greyTable = buildGreyTable;
  }
}

// Neither adapter wrote to the caller's source.
assert.deepEqual(SOURCE.color[0], negative(1));
assert.deepEqual(SOURCE.positive[0], positive(1));
resetBoth();
void live; void oracle;
console.log(`silverAdapter.parity: ${checks} conversions identical to 1703835 (16-bit, 8-bit, analysis preview)`);
