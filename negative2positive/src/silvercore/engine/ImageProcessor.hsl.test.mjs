// #238 (1): the strict-max pre-test in applyHSLAdjustments changes no pixel.
// Compares against the frozen 1703835 copy. `npm test` runs the full 256³ lattice for
// the default model plus 1 M random triples and 20 k tie-plane points (×3 planes ×5
// offsets) for every setting; scripts/hsl-parity-sweep.mjs runs the full sweep
// (lattice, 1 M tie points and 10 M random triples for every setting).
import assert from 'node:assert/strict';
import {
  HUE_BANDS_STRICT,
  checkHueBandSupport,
  setHueBandSkipForTesting,
} from './ImageProcessor.js';
import { hslSettings, sweep, compareHSL, randomChunks, tiePlaneChunks, latticeChunks, modelAdjustment } from '../../pipeline/oracle/hslParity.mjs';

// --- the module-init self-check -------------------------------------------------
assert.equal(HUE_BANDS_STRICT, true, 'the shipped hue tables satisfy the band-support check');
{
  // Rebuild the shipped tables' shape, then break one fact at a time.
  const size = 3600;
  const make = (centre) => {
    const t = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const h = i / size;
      let dist = Math.abs(h - centre);
      if (dist > 0.5) dist = 1 - dist;
      t[i] = dist > 1 / 6 ? 0 : 0.5 + 0.5 * Math.cos(dist * 6 * Math.PI);
    }
    return t;
  };
  const tables = () => [make(0), make(1 / 3), make(2 / 3)];
  assert.equal(checkHueBandSupport(tables(), size), true);
  for (const [band, index] of [[0, 600], [0, 3000], [1, 600], [1, 1800], [2, 1800], [2, 3000], [0, 1200], [1, 2400], [2, 100]]) {
    const t = tables();
    t[band][index] = 0.01;
    assert.equal(checkHueBandSupport(t, size), false, `band ${band} non-zero at ${index} must disable the skip`);
  }
  // A wider window reaches into the neighbouring sectors.
  const wide = (centre) => {
    const t = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      let dist = Math.abs(i / size - centre);
      if (dist > 0.5) dist = 1 - dist;
      t[i] = dist > 0.2 ? 0 : 1;
    }
    return t;
  };
  assert.equal(checkHueBandSupport([wide(0), wide(1 / 3), wide(2 / 3)], size), false);
  // A different table size keeps the check meaningful.
  assert.equal(checkHueBandSupport([make(0), make(1 / 3), make(2 / 3)].map((t) => t.subarray(0, 3599)), 3599), false);
}

// --- parity against the frozen copy ----------------------------------------------
const settings = hslSettings();
let failures = sweep({ settings, latticeStep: 257, latticeLabels: ['standard@100'], tiePoints: 20000, randomCount: 1000000 });
assert.deepEqual(failures, [], 'identical 16-bit output and untouched alpha');
// A coarser lattice for every setting (52³ points).
failures = sweep({ settings, latticeStep: 1285, tiePoints: 0, randomCount: 0 });
assert.deepEqual(failures, []);

// --- the forced fallback (unskipped loop) gives the same pixels -------------------
setHueBandSkipForTesting(false);
try {
  for (const hsl of [modelAdjustment('standard', 100), modelAdjustment('frontier', 100), modelAdjustment('noritsu', 50)]) {
    for (const chunk of [randomChunks(200000, 5).next().value, tiePlaneChunks(10000, 3).next().value, latticeChunks(2570, 64).next().value]) {
      assert.equal(compareHSL(chunk, hsl), null, 'fallback output identical');
    }
  }
} finally {
  setHueBandSkipForTesting(true);
}

// Edge inputs: greys, pure primaries, the rails.
{
  const px = [];
  for (const v of [0, 1, 2, 32767, 32768, 65534, 65535]) px.push([v, v, v], [v, 0, 0], [0, v, 0], [0, 0, v], [v, v, 0], [0, v, v], [v, 0, v]);
  px.push([65535, 65534, 65534], [65534, 65535, 65534], [65534, 65534, 65535], [1, 0, 0], [0, 1, 1]);
  const data = new Uint16Array(px.length * 4);
  px.forEach((p, i) => data.set([...p, 65535 - i], i * 4));
  for (const { hsl } of settings) assert.equal(compareHSL(data, hsl), null);
}

console.log(`ImageProcessor.hsl: self-check, ${settings.length} settings × (lattice, tie planes, random), fallback and edges identical to 1703835`);
