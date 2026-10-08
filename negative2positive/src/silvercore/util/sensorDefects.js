// Suppresses isolated single-channel sensor defects in a demosaiced RAW decode.
//
// LibRaw hands us the sensor data as-is: it does no hot/dead pixel mapping
// (the camera only does that for its own JPEGs). A photosite that is stuck
// low is nearly invisible in a normal photo, but a film negative gets
// inverted — on a colour negative the red channel sits near the top of the
// range in the thin (shadow) areas, so a dead red photosite becomes a
// saturated red dot on black after inversion. Dead green/blue photosites
// turn into green/blue dots, hot ones into single-channel dark dots in the
// highlights. Demosaicing also smears the defect into the 3×3 neighbourhood
// (colour-difference interpolation pulls the adjacent pixels ~25–50 % of the
// way), which is why the dots look 2–3 px wide in an export.
//
// Detection: per channel, a pixel is a defect when it lies outside the
// min/max of its 5×5 ring (the 16 pixels at Chebyshev distance 2 — distance
// 1 is already contaminated) by a margin scaled from the ring's own spread:
// ×2.5 the near-side spread (min→median for a dead candidate, median→max
// for a hot one — ~1.7σ for 16 samples, so the margin sits ~6σ past the
// extreme and plain noise never qualifies) and at least ×1 the full spread
// (so a lower half that happens to cluster cannot make a 4σ wiggle look
// isolated, while a ring straddling an edge still catches a fully dead
// photosite on its dark side). Real content — dust, grain, specular points, a
// distant star — is neutral and moves all three channels together, so a
// candidate whose other channels deviate by a comparable amount is left
// alone. Only isolated points qualify: a line or an edge always has ring
// pixels of its own kind and never trips the test.
//
// Rings near the black floor are left alone: they say nothing about noise
// (an underexposed scan pushed by auto-bright has quantisation steps of
// several thousand, and the near-black blue channel under an orange mask is
// full of clipped zeros), and everything there inverts into a blown
// highlight anyway. So a "hot" pixel on a black-floor ring must reach a
// tenth of full scale, and a "dead" pixel is only chased where the ring's
// lower median clears twice the absolute floor. A clipped-bright ring is
// the opposite and the classic case (thin negative → deep positive shadow):
// any pixel clearly below the clip is a defect.
//
// Repair: the centre takes the ring median in that channel; each of the 8
// contaminated neighbours is rebuilt from the ring pixels adjacent to it,
// but only when it actually deviates from that estimate in the defect's
// direction (a half-size/binned decode has no smear and stays untouched).

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

// Implementation notes (#232). The output is bit-identical to the original
// kernel (frozen in sensorDefects.reference.mjs and checked by the
// differential test); only the work per pixel changed:
//  - The 4-neighbour reject test is two independent any-of tests that stop at
//    their first hit. The original rejected when `v + abs >= min(l, r, u, d)`
//    and `v <= max(l, r, u, d) + abs`; the halves may be met by different
//    neighbours, and IEEE addition is monotone, so `v <= max + abs` holds
//    exactly when `v <= n + abs` holds for some neighbour n. Do not fold it
//    into "one neighbour meets both halves": that rejects fewer pixels.
//  - All three channels' reject tests run before any channel is repaired.
//    That is exact because a repair only ever writes its own channel.
//  - The ring is read once with its min and max. Candidates inside the ring
//    stop there, and a candidate that cannot clear max(floor, full spread) —
//    a lower bound of every margin below — stops before any sorting.
//  - Only the survivors are insertion-sorted, into their own buffer, and the
//    correlation check reads just the min or max of the other channels' rings
//    (live data: an earlier channel of this pixel may have been repaired).
//  - Scan order stays row-major: a repair rewrites a 3×3 block and later
//    pixels read up to 2 px away, so order is part of the output.

// HEAD's reject test for one channel sample at `j`, evaluated lazily.
function isCandidate(data, j, stride, abs) {
  const v = data[j];
  const hi = v + abs;
  const l = data[j - 4];
  if (l <= hi && v <= l + abs) return false; // the left neighbour settles both halves
  const r = data[j + 4];
  const u = data[j - stride];
  const d = data[j + stride];
  const nearLow = l <= hi || r <= hi || u <= hi || d <= hi;
  if (!nearLow) return true;
  return !(v <= l + abs || v <= r + abs || v <= u + abs || v <= d + abs);
}

/**
 * @param {{ width: number, height: number, data: Uint16Array }} image16 RGBA, modified in place
 * @param {{ absoluteThreshold?: number, noiseFactor?: number }} [options]
 * @returns {{ repaired: number, dead: number, hot: number, perChannel: number[] }}
 */
export function suppressSensorDefects(image16, options = {}) {
  const stats = { repaired: 0, dead: 0, hot: 0, perChannel: [0, 0, 0] };
  if (!image16 || !(image16.data instanceof Uint16Array)) return stats;
  const { width, height, data } = image16;
  if (width < 5 || height < 5) return stats;

  const abs = Number.isFinite(options.absoluteThreshold) ? options.absoluteThreshold : DEFAULT_ABSOLUTE_THRESHOLD;
  const noise = Number.isFinite(options.noiseFactor) ? options.noiseFactor : DEFAULT_NOISE_FACTOR;
  const stride = width * 4;
  const ringOff = Int32Array.from(RING, (p) => (p.dy * width + p.dx) * 4);
  const patchOff = Int32Array.from(PATCH, (p) => (p.dy * width + p.dx) * 4);
  const ringValues = new Float64Array(16); // candidate's ring in RING order (for the neighbour estimates)
  const sorted = new Float64Array(16);     // same values, ascending — survivors only

  for (let y = 2; y < height - 2; y++) {
    let i = (y * width + 2) * 4;
    for (let x = 2; x < width - 2; x++, i += 4) {
      // Cheap reject against the 4 direct neighbours — almost every pixel exits here.
      const cand0 = isCandidate(data, i, stride, abs);
      const cand1 = isCandidate(data, i + 1, stride, abs);
      const cand2 = isCandidate(data, i + 2, stride, abs);
      if (!cand0 && !cand1 && !cand2) continue;

      for (let c = 0; c < 3; c++) {
        if (!(c === 0 ? cand0 : c === 1 ? cand1 : cand2)) continue;
        const j = i + c;
        const v = data[j];

        let mn = PIXEL_MAX;
        let mx = 0;
        for (let k = 0; k < 16; k++) {
          const s = data[j + ringOff[k]];
          ringValues[k] = s;
          if (s < mn) mn = s;
          if (s > mx) mx = s;
        }
        if (v >= mn && v <= mx) continue;                 // inside the ring
        const dir = v < mn ? -1 : 1;
        const deviation = dir < 0 ? mn - v : v - mx;
        const fullSpread = FULL_SPREAD_FACTOR * (mx - mn);
        // margin(dir) below is never smaller than this, so nothing is lost.
        const floor = dir > 0 && mn <= abs ? BLACK_FLOOR_HOT_THRESHOLD : abs;
        if (deviation <= Math.max(floor, fullSpread)) continue;

        // Survivors only: insertion sort into the candidate's own buffer.
        sorted[0] = ringValues[0];
        for (let k = 1; k < 16; k++) {
          const s = ringValues[k];
          let m = k - 1;
          while (m >= 0 && sorted[m] > s) { sorted[m + 1] = sorted[m]; m--; }
          sorted[m + 1] = s;
        }
        if (dir < 0 && sorted[7] <= BLACK_FLOOR_DEAD_LEVEL) continue;

        // Margin a candidate must clear on that side.
        let margin;
        if (dir < 0) {
          margin = Math.max(abs, noise * (sorted[7] - sorted[0]), fullSpread);
        } else {
          const fromSpread = Math.max(noise * (sorted[15] - sorted[8]), fullSpread);
          margin = sorted[0] <= abs
            ? Math.max(BLACK_FLOOR_HOT_THRESHOLD, fromSpread)
            : Math.max(abs, fromSpread);
        }
        if (deviation <= margin) continue;

        // Neutral features move every channel by a comparable amount: leave
        // those alone. Only the ring extreme on the defect's side matters.
        const correlatedLevel = CORRELATED_FRACTION * deviation;
        let correlated = false;
        for (let c2 = 0; c2 < 3 && !correlated; c2++) {
          if (c2 === c) continue;
          const j2 = i + c2;
          let extreme = data[j2 + ringOff[0]];
          if (dir < 0) {
            for (let k = 1; k < 16; k++) { const s = data[j2 + ringOff[k]]; if (s < extreme) extreme = s; }
            if (extreme - data[j2] >= correlatedLevel) correlated = true;
          } else {
            for (let k = 1; k < 16; k++) { const s = data[j2 + ringOff[k]]; if (s > extreme) extreme = s; }
            if (data[j2] - extreme >= correlatedLevel) correlated = true;
          }
        }
        if (correlated) continue;

        // Repair centre from the (uncontaminated) ring.
        const median = (sorted[7] + sorted[8]) / 2;
        const magnitude = Math.abs(v - median);
        data[j] = Math.round(median);

        // Repair the smeared neighbours where they actually deviate. Demosaic
        // smear is ~1/2 of the defect on the 4-neighbours and ~1/4 on the
        // diagonals, so anything past 1/8 (and above the noise floor) counts.
        const smearThreshold = Math.max(0.5 * abs, magnitude / 8);
        for (let p = 0; p < 8; p++) {
          const members = PATCH[p].ring;
          let sum = 0;
          for (let k = 0; k < members.length; k++) sum += ringValues[members[k]];
          const estimate = sum / members.length;
          const ni = j + patchOff[p];
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
