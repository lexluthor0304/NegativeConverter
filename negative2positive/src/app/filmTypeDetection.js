// Pixel evidence is advisory: without a rebate/DX code, polarity is not
// uniquely recoverable (a grayscale positive and negative are both gray).
// Keep this bounded and independent of file names, camera metadata and format.
export function detectFilmType(image, { fallback = 'positive', filmEdge = null } = {}) {
  if (filmEdge?.found && ['color', 'bw', 'positive'].includes(filmEdge.filmKind)
      && !(filmEdge.polarity === 'light' && filmEdge.filmKind !== 'positive')) {
    return { filmType: filmEdge.filmKind, confidence: 'high', reason: 'dx' };
  }
  const source = image?.__image16 || image;
  if (!source?.data || !source.width || !source.height) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const { width, height, data } = source;
  const maximum = data instanceof Uint16Array ? 65535 : 255;
  const stride = Math.max(1, Math.ceil(Math.sqrt(width * height / 24000)));
  const all = [], inner = [], edge = [];
  for (let y = 0; y < height; y += stride) for (let x = 0; x < width; x += stride) {
    const i = (y * width + x) * 4;
    if (!data[i + 3]) continue;
    const r = data[i] / maximum, g = data[i + 1] / maximum, b = data[i + 2] / maximum;
    const peak = Math.max(r, g, b), low = Math.min(r, g, b);
    if (peak < .02 || low > .98) continue;
    const pixel = { r, g, b, luma: .2126 * r + .7152 * g + .0722 * b,
      gray: peak - low < .035,
      orange: r > g * 1.18 && g > b * 1.18 && r - b > .16 };
    all.push(pixel);
    if (x < width * .05 || x >= width * .95 || y < height * .05 || y >= height * .95) edge.push(pixel);
    else inner.push(pixel);
  }
  if (all.length < 64) return { filmType: fallback, confidence: 'low', reason: 'empty' };
  const fraction = (pixels, key) => pixels.filter(p => p[key]).length / Math.max(1, pixels.length);
  const quantile = (pixels, key, q) => {
    const values = pixels.map(p => p[key]).sort((a, b) => a - b);
    return values[Math.floor((values.length - 1) * q)] ?? 0;
  };
  const edgeRange = quantile(edge, 'luma', .9) - quantile(edge, 'luma', .1);
  const edgeLuma = quantile(edge, 'luma', .5), innerLuma = quantile(inner, 'luma', .5);
  const orangeFraction = fraction(all, 'orange');
  // A uniform orange rebate substantially brighter than the image is stronger
  // evidence than a warm scene. Cropped scans still use whole-image mask evidence.
  if (edge.length >= 32 && fraction(edge, 'orange') > .85 && edgeRange < .14
      && edgeLuma > innerLuma + .07 && orangeFraction > .35) {
    return { filmType: 'color', confidence: 'high', reason: 'orangeRebate' };
  }
  if (orangeFraction > .72 && quantile(all, 'r', .1) > quantile(all, 'b', .9) * .9) {
    return { filmType: 'color', confidence: 'medium', reason: 'orangeMask' };
  }
  if (fraction(all, 'gray') > .96) {
    if (edge.length >= 32 && fraction(edge, 'gray') > .98 && edgeRange < .06
        && edgeLuma > .65 && edgeLuma > innerLuma + .22) {
      return { filmType: 'bw', confidence: 'medium', reason: 'clearRebate' };
    }
    // No guess at monochrome polarity: show the ambiguity and keep orientation
    // (or the explicitly chosen import type when auto detection is disabled).
    return { filmType: fallback, confidence: 'low', reason: 'monochrome' };
  }
  if (orangeFraction > .35) return { filmType: fallback, confidence: 'low', reason: 'warmScene' };
  return { filmType: 'positive', confidence: 'medium', reason: 'noMask' };
}

export function detectedImportSettings(image, { automatic = true, filmType = 'color', positiveMode = 'correct' } = {}) {
  if (!automatic) return { filmType, positiveMode, filmTypeSource: 'manual', filmTypeConfidence: null, filmTypeReason: null };
  const detection = detectFilmType(image);
  return { filmType: detection.filmType, positiveMode, filmTypeSource: 'auto', filmTypeConfidence: detection.confidence, filmTypeReason: detection.reason };
}
