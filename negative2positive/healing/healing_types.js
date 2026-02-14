export const DEFAULT_HEALING_PARAMS = {
  brushRadius: 18,
  feather: 0.6,
  flow: 1.0,

  gap: 8,
  sampleRadiusPreview: 64,
  sampleRadiusFull: 128,

  patchSize: 7,
  patchmatchItersPreview: 3,
  patchmatchItersFull: 6,

  poissonItersPreview: 60,
  poissonItersFull: 180,

  spacingFactor: 0.35
};

export function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

