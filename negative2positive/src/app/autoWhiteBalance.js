// Automatic gray-point estimation for the converted positive.
//
// Runs the same math as the manual gray-point click (gains = gray / channel
// mean over a neutral sample, G-normalized) but replaces the human's patch
// choice with an iteratively refined set of near-neutral pixels, cross-checked
// against a Shades-of-Gray estimate. The caller gets gains plus a confidence
// verdict: apply on high/medium, leave the image untouched on low and let the
// existing gray-point guide nudge the user instead.
//
// Everything works on the gamma-encoded 8-bit RGB the manual click samples,
// because the downstream pipeline (uWb uniform / pixelAdjustments) multiplies
// gains onto those same gamma-encoded values. No linearization on purpose.

const WB_GAIN_MIN = 0.5;
const WB_GAIN_MAX = 2;

const DEFAULTS = Object.freeze({
  // Sampling budget; a 250k-px preview buffer strides down to roughly this.
  maxSamples: 120000,
  // Exclude (near-)clipped pixels: film-base blowouts and crushed shadows
  // carry no usable chroma information.
  lumaMin: 20,
  lumaMax: 235,
  // When this much of the frame blows past lumaMax the conversion itself is
  // pathological (thin/underexposed negative → blown positive, e.g. Harman
  // Phoenix underexposed at 43% blown vs ≤3% on healthy scans). Whatever
  // "neutrals" remain sit against the clip boundary with compressed channel
  // ratios, so the only honest answer is to leave the frame alone.
  clippedHighMax: 0.2,
  // Near-neutral selection thresholds on (|Cb| + |Cr|) / Y, one per round.
  // Round 0 must admit true neutrals still carrying the full cast — a gain
  // error at the magnitudeMax ceiling (×1.6 / ÷1.6) puts a gray pixel at
  // ratio ≈ 0.5 — while later rounds re-score against the current correction
  // and prune down to crisp neutrals.
  // The final threshold repeats so the selection settles: near-threshold
  // colored pixels (e.g. muted yellows under a cool cast) take an extra round
  // to fall out once the correction sharpens.
  chromaThresholds: Object.freeze([0.5, 0.25, 0.12, 0.06, 0.06]),
  // Fraction of valid samples that must survive as neutral.
  coverageHigh: 0.02,
  coverageMin: 0.005,
  // Above this coverage the neutral evidence speaks for itself and the
  // Shades-of-Gray cross-check loses its veto (SoG is easily skewed by large
  // saturated areas — exactly the scenes where a solid neutral set is the
  // better witness).
  coverageStrong: 0.1,
  // |log gain| ceilings for the confidence verdict.
  magnitudeHigh: Math.log(1.35),
  magnitudeMax: Math.log(1.6),
  // Agreement between the neutral-set estimate and Shades-of-Gray.
  disagreementHigh: 0.035,
  disagreementMax: 0.12,
  // Never apply the full correction: professional AWB leaves a little of the
  // cast to avoid overshoot and keep skin tones from going clinical.
  strengthHigh: 0.9,
  strengthMedium: 0.6,
  shadesOfGrayP: 6,
});

const IDENTITY = Object.freeze({ wbR: 1, wbG: 1, wbB: 1 });

function clampGain(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(WB_GAIN_MIN, Math.min(WB_GAIN_MAX, value));
}

/** gray/mean gains, normalized so G stays 1 (same shape as the manual click). */
function gainsFromMeans(meanR, meanG, meanB) {
  if (meanR <= 0 || meanG <= 0 || meanB <= 0) return null;
  const gray = (meanR + meanG + meanB) / 3;
  const wbG = gray / meanG;
  return { wbR: gray / meanR / wbG, wbG: 1, wbB: gray / meanB / wbG };
}

/** Damp a G-normalized gain triple in log domain (keeps G at exactly 1). */
function dampGains(gains, strength) {
  return {
    wbR: Math.exp(strength * Math.log(gains.wbR)),
    wbG: 1,
    wbB: Math.exp(strength * Math.log(gains.wbB)),
  };
}

function logDistance(a, b) {
  return Math.max(Math.abs(Math.log(a.wbR / b.wbR)), Math.abs(Math.log(a.wbB / b.wbB)));
}

function lowResult(extra = {}) {
  return { ...IDENTITY, confidence: 'low', coverage: 0, disagreement: 0, clippedHigh: 0, ...extra };
}

/**
 * Estimate white balance gains from a converted positive.
 *
 * @param {{ data: Uint8ClampedArray|Uint8Array, width: number, height: number }} imageData
 *   The pre-WB positive (preview resolution is fine; gains are global ratios).
 * @param {Object} [options] - Overrides for DEFAULTS, mostly for tests/tuning.
 * @returns {{ wbR: number, wbG: number, wbB: number,
 *             confidence: 'high'|'medium'|'low',
 *             coverage: number, disagreement: number }}
 *   Gains are damped, G-normalized, and clamped to the slider range. On 'low'
 *   confidence they are identity — the caller should not apply anything.
 */
export function estimateAutoWhiteBalance(imageData, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!imageData || !imageData.data || !imageData.width || !imageData.height) {
    return lowResult();
  }
  const { data, width, height } = imageData;
  const totalPixels = Math.floor(Math.min(data.length / 4, width * height));
  if (totalPixels < 256) return lowResult();

  // Stride sampling: cap the pixel count without favoring any region.
  const stride = Math.max(1, Math.round(Math.sqrt(totalPixels / opts.maxSamples)));

  // Collect valid (non-clipped) samples once; iterations re-score this set.
  const rs = [];
  const gs = [];
  const bs = [];
  let sampledCount = 0;
  let clippedHighCount = 0;
  for (let y = 0; y < height; y += stride) {
    const row = y * width;
    for (let x = 0; x < width; x += stride) {
      const i = (row + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      sampledCount++;
      if (luma > opts.lumaMax) {
        clippedHighCount++;
        continue;
      }
      if (luma < opts.lumaMin) continue;
      rs.push(r);
      gs.push(g);
      bs.push(b);
    }
  }
  const validCount = rs.length;
  const clippedHigh = clippedHighCount / Math.max(1, sampledCount);
  if (validCount < 64 || clippedHigh > opts.clippedHighMax) {
    return lowResult({ clippedHigh });
  }

  // --- Primary: iterative near-neutral selection -------------------------
  // Each round scores neutrality under the current correction, then recomputes
  // gains from the RAW means of the surviving set — the manual click formula
  // applied to an automatically chosen patch. Two robustness measures:
  //   * Pixels are weighted by how neutral they currently look. Threshold-edge
  //     contaminants (sand, wood, skin under a cast) are numerous enough to
  //     drag a plain mean the wrong way, but their weight goes to zero.
  //   * A tightened round that selects nothing means the loosely-neutral
  //     cluster fell apart under its own correction — that estimate is not
  //     trustworthy, so the verdict is low instead of shipping it anyway.
  let gains = { ...IDENTITY };
  let neutralCount = 0;
  for (let round = 0; round < opts.chromaThresholds.length; round++) {
    const threshold = opts.chromaThresholds[round];
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    let weightSum = 0;
    let count = 0;
    for (let k = 0; k < validCount; k++) {
      const r = rs[k] * gains.wbR;
      const g = gs[k];
      const b = bs[k] * gains.wbB;
      const yLuma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (yLuma <= 0) continue;
      const cb = (b - yLuma) * 0.564;
      const cr = (r - yLuma) * 0.713;
      const ratio = (Math.abs(cb) + Math.abs(cr)) / yLuma;
      if (ratio > threshold) continue;
      const w = (1 - ratio / threshold) ** 2;
      sumR += rs[k] * w;
      sumG += gs[k] * w;
      sumB += bs[k] * w;
      weightSum += w;
      count++;
    }
    if (count === 0 || weightSum <= 0) return lowResult();
    const next = gainsFromMeans(sumR / weightSum, sumG / weightSum, sumB / weightSum);
    if (!next) return lowResult();
    gains = next;
    neutralCount = count;
  }
  const coverage = neutralCount / validCount;

  // --- Cross-check: Shades-of-Gray (Minkowski p-norm) --------------------
  const p = opts.shadesOfGrayP;
  let pr = 0;
  let pg = 0;
  let pb = 0;
  for (let k = 0; k < validCount; k++) {
    pr += Math.pow(rs[k] / 255, p);
    pg += Math.pow(gs[k] / 255, p);
    pb += Math.pow(bs[k] / 255, p);
  }
  const sogGains = gainsFromMeans(
    Math.pow(pr / validCount, 1 / p),
    Math.pow(pg / validCount, 1 / p),
    Math.pow(pb / validCount, 1 / p)
  );

  // --- Verdict ------------------------------------------------------------
  const magnitude = Math.max(Math.abs(Math.log(gains.wbR)), Math.abs(Math.log(gains.wbB)));
  const disagreement = sogGains ? logDistance(gains, sogGains) : opts.disagreementMax;

  // The SoG veto is conditional on thin neutral evidence: a small neutral set
  // could be a biased colored subset the iteration wrongly neutralized, so a
  // strong disagreement kills it; a large neutral set outranks SoG.
  const strongEvidence = coverage >= opts.coverageStrong;
  if (
    coverage < opts.coverageMin
    || magnitude > opts.magnitudeMax
    || (!strongEvidence && disagreement > opts.disagreementMax)
  ) {
    return lowResult({ coverage, disagreement, clippedHigh });
  }

  const confidence = (
    coverage >= opts.coverageHigh
    && magnitude <= opts.magnitudeHigh
    && (strongEvidence || disagreement <= opts.disagreementHigh)
  ) ? 'high' : 'medium';

  const damped = dampGains(gains, confidence === 'high' ? opts.strengthHigh : opts.strengthMedium);
  return {
    wbR: clampGain(damped.wbR),
    wbG: 1,
    wbB: clampGain(damped.wbB),
    confidence,
    coverage,
    disagreement,
    clippedHigh,
  };
}
