import { convertColorWithSilverCore, convertBwWithSilverCore } from './silverAdapter.js';
import { convertPositiveLegacy } from './legacyPositive.js';

export function resolveConversionMode(settings = {}) {
  const type = settings.filmType || 'color';
  if (type === 'positive') return 'positive';
  if (type === 'bw') return 'bw';
  return 'color';
}

export async function convertFrameWithRouter({ imageData, settings = {} }) {
  const mode = resolveConversionMode(settings);
  if (mode === 'positive') {
    return convertPositiveLegacy(imageData);
  }
  if (mode === 'bw') {
    return convertBwWithSilverCore(imageData, settings);
  }
  return convertColorWithSilverCore(imageData, settings);
}
