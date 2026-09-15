// ADE20K's person label includes clothing: only plausible skin-coloured pixels
// in that class may vote for the skin locus. Classes are never literal colours.
const FOLIAGE = new Set([4, 9, 17, 29, 72]);
const WATER = new Set([21, 26, 60, 113, 128]);
const NEUTRAL = new Set([0, 1, 6, 11, 43, 48]);
export function sanitizeSemanticMap(input) {
  if (!input || !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 64 || input.height > 64) return null;
  if ((!Array.isArray(input.labels) && !ArrayBuffer.isView(input.labels)) || input.labels.length !== input.width * input.height) return null;
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1 || [...input.labels].some(x => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return { width: input.width, height: input.height, labels: Array.from(input.labels), confidence: input.confidence, model: 'efficientvit-b1-ade20k-v1' };
}
export function semanticClassAt(map, x, y, width, height) {
  if (!map || map.confidence < 0.55) return 255;
  const xx = Math.min(map.width - 1, Math.max(0, Math.floor(x * map.width / width)));
  const yy = Math.min(map.height - 1, Math.max(0, Math.floor(y * map.height / height)));
  return map.labels[yy * map.width + xx];
}
export function semanticNeutralWeight(label) {
  if (FOLIAGE.has(label) || WATER.has(label) || label === 2 || label === 12) return 0;
  return NEUTRAL.has(label) ? 3 : 1;
}
export function estimateAnchoredWhiteBalance(image, stats, map) {
  let sumR = 0, sumB = 0, weight = 0, samples = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(image.width * image.height / 40000)));
  for (let y = 0; y < image.height; y += step) for (let x = 0; x < image.width; x += step) {
    const i = (y * image.width + x) * 4;
    const [r, g, b, a] = image.data.subarray(i, i + 4);
    if (!a || Math.min(r, g, b) < 25 || Math.max(r, g, b) > 235) continue;
    const label = semanticClassAt(map, x, y, image.width, image.height);
    const rg = r / g, bg = b / g;
    let targetR, targetB, w;
    if (NEUTRAL.has(label) && Math.max(r, g, b) / Math.min(r, g, b) < 1.7) { targetR = 1; targetB = 1; w = 2; }
    else if (label === 12 && rg > 0.9 && rg < 1.9 && bg > 0.45 && bg < 1.15 && r > b) {
      targetR = Math.max(1.16, Math.min(1.48, rg)); targetB = Math.max(0.68, Math.min(0.94, bg)); w = 1;
    } else if (label === 2 && bg > 0.95 && rg < 1.15) {
      targetR = Math.max(0.65, Math.min(0.97, rg)); targetB = Math.max(1.04, Math.min(1.5, bg)); w = 0.25;
    } else continue;
    sumR += Math.log(targetR / rg) * w; sumB += Math.log(targetB / bg) * w; weight += w; samples++;
  }
  if (samples < 32 || weight <= 0) return stats;
  const r = Math.exp(sumR / weight), b = Math.exp(sumB / weight);
  const disagreement = Math.max(Math.abs(Math.log(r / stats.wbR)), Math.abs(Math.log(b / stats.wbB)));
  // Disagreement lowers confidence; exceptionally large corrections abstain.
  if (Math.max(Math.abs(Math.log(r)), Math.abs(Math.log(b))) > Math.log(1.6)) return { ...stats, confidence: 'low' };
  const confidence = disagreement < 0.06 && stats.confidence !== 'low' ? 'high' : 'medium';
  return { ...stats, wbR: stats.wbR ** 0.15 * r ** 0.85, wbG: 1, wbB: stats.wbB ** 0.15 * b ** 0.85, confidence, disagreement, anchored: true, anchorSamples: samples };
}
