// Shared harness for the #238 HSL parity checks: the fast subset runs in `npm test`
// (ImageProcessor.hsl.test.mjs), the full sweep in scripts/hsl-parity-sweep.mjs.
// Every case runs the live applyHSLAdjustments and the frozen 1703835 copy on the
// same pixels and requires identical Uint16 output, alpha included. Pixel sets are
// generated in chunks so the full sweep stays under ~50 MB.
import { applyHSLAdjustments } from '../../silvercore/engine/ImageProcessor.js';
import { applyHSLAdjustments as oracleHSL } from './ImageProcessor.oracle.js';
import { colorModels } from '../../silvercore/engine/Presets.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The adjustment Engine.buildSettings derives from a colour model at a profile strength.
export function modelAdjustment(name, strength) {
  const model = colorModels[name] || colorModels.basic;
  const hsl = model.hslAdjustments;
  if (!hsl) return null;
  const pStr = strength / 100;
  return {
    redHue: (hsl.redHue || 0) * pStr,
    redSaturation: (hsl.redSaturation || 0) * pStr,
    greenHue: (hsl.greenHue || 0) * pStr,
    greenSaturation: (hsl.greenSaturation || 0) * pStr,
    blueHue: (hsl.blueHue || 0) * pStr,
    blueSaturation: (hsl.blueSaturation || 0) * pStr,
  };
}

const ZERO = { redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 };

// `standard` has no colorModels entry and falls back to `basic`, so basic covers it.
export function hslSettings() {
  const cases = [];
  for (const model of ['standard', 'frontier', 'noritsu']) {
    for (const strength of [0, 1, 50, 100, 200]) {
      cases.push({ label: `${model}@${strength}`, hsl: modelAdjustment(model, strength) });
    }
  }
  for (const key of Object.keys(ZERO)) {
    for (const value of [-30, 7.5]) cases.push({ label: `${key}=${value}`, hsl: { ...ZERO, [key]: value } });
  }
  cases.push({ label: 'red+green', hsl: { ...ZERO, redHue: 12, greenSaturation: -20 } });
  cases.push({ label: 'all bands', hsl: { redHue: 5, redSaturation: 10, greenHue: -8, greenSaturation: 4, blueHue: 3, blueSaturation: -6 } });
  return cases;
}

// Alpha is random everywhere, so a write to it cannot hide.

// The 256³ lattice (channel step 257) by default, a few red levels per chunk.
export function* latticeChunks(step = 257, redLevelsPerChunk = 8) {
  const levels = [];
  for (let v = 0; v <= 65535; v += step) levels.push(v);
  if (levels[levels.length - 1] !== 65535) levels.push(65535);
  const n = levels.length;
  const rand = mulberry32(0x238);
  for (let r0 = 0; r0 < n; r0 += redLevelsPerChunk) {
    const reds = levels.slice(r0, r0 + redLevelsPerChunk);
    const data = new Uint16Array(reds.length * n * n * 4);
    let i = 0;
    for (const r of reds) for (const g of levels) for (const b of levels) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = (rand() * 65536) | 0;
      i += 4;
    }
    yield data;
  }
}

// Two-channel tie planes (R = G, G = B, R = B): each seeded point also with the tied
// pair pulled apart by ±1 and ±2.
export function* tiePlaneChunks(points, seed = 17, pointsPerChunk = 100000) {
  const rand = mulberry32(seed);
  const offsets = [0, 1, -1, 2, -2];
  const clamp = (v) => (v < 0 ? 0 : v > 65535 ? 65535 : v);
  for (let done = 0; done < points; done += pointsPerChunk) {
    const count = Math.min(pointsPerChunk, points - done);
    const data = new Uint16Array(count * 3 * offsets.length * 4);
    let i = 0;
    for (let p = 0; p < count; p++) {
      const tie = (rand() * 65536) | 0;
      const other = (rand() * 65536) | 0;
      for (let plane = 0; plane < 3; plane++) {
        for (const off of offsets) {
          const a = tie, b = clamp(tie + off);
          if (plane === 0) { data[i] = a; data[i + 1] = b; data[i + 2] = other; }
          else if (plane === 1) { data[i] = other; data[i + 1] = a; data[i + 2] = b; }
          else { data[i] = a; data[i + 1] = other; data[i + 2] = b; }
          data[i + 3] = (rand() * 65536) | 0;
          i += 4;
        }
      }
    }
    yield data;
  }
}

export function* randomChunks(count, seed = 99, perChunk = 1000000) {
  const rand = mulberry32(seed);
  for (let done = 0; done < count; done += perChunk) {
    const n = Math.min(perChunk, count - done);
    const data = new Uint16Array(n * 4);
    for (let i = 0; i < data.length; i++) data[i] = (rand() * 65536) | 0;
    yield data;
  }
}

// Returns null when identical, else the first differing pixel and both outputs.
export function compareHSL(pixels, hsl) {
  const live = { width: pixels.length / 4, height: 1, data: new Uint16Array(pixels) };
  const frozen = { width: pixels.length / 4, height: 1, data: new Uint16Array(pixels) };
  applyHSLAdjustments(live, hsl);
  oracleHSL(frozen, hsl);
  const a = live.data, b = frozen.data;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] || ((i & 3) === 3 && a[i] !== pixels[i])) {
      const p = i - (i & 3);
      return { input: Array.from(pixels.subarray(p, p + 4)), live: Array.from(a.subarray(p, p + 4)), frozen: Array.from(b.subarray(p, p + 4)) };
    }
  }
  return null;
}

// Runs every set against every setting; returns the failures.
export function sweep({ settings = hslSettings(), latticeStep = 257, latticeLabels = null, tiePoints = 1000000, randomCount = 10000000, log = null } = {}) {
  const failures = [];
  const sets = [
    ['lattice', (label) => (latticeLabels && !latticeLabels.includes(label) ? [] : latticeChunks(latticeStep))],
    ['tie planes', () => tiePlaneChunks(tiePoints)],
    ['random', () => randomChunks(randomCount)],
  ];
  for (const { label, hsl } of settings) {
    const started = Date.now();
    for (const [name, chunks] of sets) {
      for (const chunk of chunks(label)) {
        const diff = compareHSL(chunk, hsl);
        if (diff) { failures.push({ label, set: name, ...diff }); break; }
      }
    }
    if (log) log(`${label}: ${Date.now() - started} ms`);
  }
  return failures;
}
