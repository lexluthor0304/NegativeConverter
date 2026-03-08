import { convertColorWithSilverCore, convertBwWithSilverCore, convertPositiveWithSilverCore } from './silverAdapter.js';
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
    const useLegacy = settings.positiveEngine === 'legacy';
    if (useLegacy) {
      return convertPositiveLegacy(imageData);
    }
    return convertPositiveWithSilverCore(imageData, settings);
  }
  if (mode === 'bw') {
    return convertBwWithSilverCore(imageData, settings);
  }
  return convertColorWithSilverCore(imageData, settings);
}
