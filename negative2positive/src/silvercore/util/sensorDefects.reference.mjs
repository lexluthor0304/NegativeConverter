// Frozen copy of the sensor-defect kernel as it shipped at 1703835, before the
// exact fast rewrite (#232). Imported only by tests: the differential test runs
// it against sensorDefects.js on synthetic frames and requires byte and stats
// equality, and scripts/raw-parity.mjs does the same on real RAW decodes.
// Do not edit — a change here would silently move the parity target.

const PIXEL_MAX = 65535;
const DEFAULT_ABSOLUTE_THRESHOLD = 1500;   // ~2.3 % of full scale — never chase sub-noise-floor wiggles
const DEFAULT_NOISE_FACTOR = 2.5;          // × the ring's near-side spread (min→median or median→max)
const FULL_SPREAD_FACTOR = 1;              // margin is never below the ring's whole min→max spread
const BLACK_FLOOR_HOT_THRESHOLD = 0.1 * PIXEL_MAX; // hot margin when the ring sits on the black floor
const BLACK_FLOOR_DEAD_LEVEL = 2 * DEFAULT_ABSOLUTE_THRESHOLD; // no dead candidates below this ring level
const CORRELATED_FRACTION = 0.25;          // other channel moving ≥ this × the defect ⇒ real content

const PATCH = [];   // 8 neighbours: { dx, dy, ring: [indices into RING] }
const RING = [];    // 16 pixels at Chebyshev distance 2
for (let dy = -2; dy <= 2; dy++) {
  for (let dx = -2; dx <= 2; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) === 2) RING.push({ dx, dy });
  }
}
for (let dy = -1; dy <= 1; dy++) {
  for (let dx = -1; dx <= 1; dx++) {
    if (dx === 0 && dy === 0) continue;
    const ring = [];
    RING.forEach((p, k) => {
      if (Math.max(Math.abs(p.dx - dx), Math.abs(p.dy - dy)) <= 1) ring.push(k);
    });
    PATCH.push({ dx, dy, ring });
  }
}

/**
 * @param {{ width: number, height: number, data: Uint16Array }} image16 RGBA, modified in place
 * @param {{ absoluteThreshold?: number, noiseFactor?: number }} [options]
 * @returns {{ repaired: number, dead: number, hot: number, perChannel: number[] }}
 */
export function suppressSensorDefectsReference(image16, options = {}) {
  const stats = { repaired: 0, dead: 0, hot: 0, perChannel: [0, 0, 0] };
  if (!image16 || !(image16.data instanceof Uint16Array)) return stats;
  const { width, height, data } = image16;
  if (width < 5 || height < 5) return stats;

  const abs = Number.isFinite(options.absoluteThreshold) ? options.absoluteThreshold : DEFAULT_ABSOLUTE_THRESHOLD;
  const noise = Number.isFinite(options.noiseFactor) ? options.noiseFactor : DEFAULT_NOISE_FACTOR;
  const stride = width * 4;
  const ringOff = RING.map((p) => (p.dy * width + p.dx) * 4);
  const patchOff = PATCH.map((p) => (p.dy * width + p.dx) * 4);
  const ringValues = new Float64Array(16); // ring in RING order (for the neighbour estimates)
  const sorted = new Float64Array(16);     // same values, ascending
  const byValue = (a, b) => a - b;

  // Fill ringValues/sorted for channel c around pixel i.
  const readRing = (i, c) => {
    for (let k = 0; k < 16; k++) ringValues[k] = data[i + ringOff[k] + c];
    sorted.set(ringValues);
    sorted.sort(byValue);
  };

  // How far past the ring extreme `v` sits, in the given direction (≤ 0 ⇒ inside the ring).
  const excess = (v, dir) => (dir < 0 ? sorted[0] - v : v - sorted[15]);

  // Margin a candidate must clear on that side.
  const margin = (dir) => {
    const fullSpread = FULL_SPREAD_FACTOR * (sorted[15] - sorted[0]);
    if (dir < 0) return Math.max(abs, noise * (sorted[7] - sorted[0]), fullSpread);
    const fromSpread = Math.max(noise * (sorted[15] - sorted[8]), fullSpread);
    if (sorted[0] <= abs) return Math.max(BLACK_FLOOR_HOT_THRESHOLD, fromSpread);
    return Math.max(abs, fromSpread);
  };

  for (let y = 2; y < height - 2; y++) {
    let i = (y * width + 2) * 4;
    for (let x = 2; x < width - 2; x++, i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        // Cheap reject against the 4 direct neighbours — almost every pixel exits here.
        const l = data[i - 4 + c], r = data[i + 4 + c], u = data[i - stride + c], d = data[i + stride + c];
        let mn = l < r ? l : r; if (u < mn) mn = u; if (d < mn) mn = d;
        let mx = l > r ? l : r; if (u > mx) mx = u; if (d > mx) mx = d;
        if (v + abs >= mn && v <= mx + abs) continue;

        readRing(i, c);
        const dir = v < sorted[0] ? -1 : v > sorted[15] ? 1 : 0;
        if (dir === 0) continue;
        if (dir < 0 && sorted[7] <= BLACK_FLOOR_DEAD_LEVEL) continue;
        const deviation = excess(v, dir);
        if (deviation <= margin(dir)) continue;

        // Neutral features move every channel by a comparable amount: leave those alone.
        let correlated = false;
        for (let c2 = 0; c2 < 3 && !correlated; c2++) {
          if (c2 === c) continue;
          readRing(i, c2);
          if (excess(data[i + c2], dir) >= CORRELATED_FRACTION * deviation) correlated = true;
        }
        if (correlated) continue;

        // Repair centre from the (uncontaminated) ring.
        readRing(i, c);
        const median = (sorted[7] + sorted[8]) / 2;
        const magnitude = Math.abs(v - median);
        data[i + c] = Math.round(median);

        // Repair the smeared neighbours where they actually deviate. Demosaic
        // smear is ~1/2 of the defect on the 4-neighbours and ~1/4 on the
        // diagonals, so anything past 1/8 (and above the noise floor) counts.
        const smearThreshold = Math.max(0.5 * abs, magnitude / 8);
        for (let j = 0; j < 8; j++) {
          const p = PATCH[j];
          let sum = 0;
          for (let k = 0; k < p.ring.length; k++) sum += ringValues[p.ring[k]];
          const estimate = sum / p.ring.length;
          const ni = i + patchOff[j] + c;
          const nv = data[ni];
          if (dir < 0 ? nv < estimate - smearThreshold : nv > estimate + smearThreshold) {
            data[ni] = Math.max(0, Math.min(PIXEL_MAX, Math.round(estimate)));
          }
        }

        stats.repaired++;
        stats.perChannel[c]++;
        if (dir < 0) stats.dead++; else stats.hot++;
      }
    }
  }
  return stats;
}
