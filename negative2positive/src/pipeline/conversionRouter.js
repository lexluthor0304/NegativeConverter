import { convertColorWithSilverCore, convertBwWithSilverCore } from './silverAdapter.js';
import { convertPositiveLegacy } from './legacyPositive.js';

export function resolveConversionMode(settings = {}, preset = null) {
  const settingType = settings.filmType;
  const presetType = preset && typeof preset === 'object' ? preset.type : null;
  const type = presetType || settingType || 'color';
  if (type === 'positive') return 'positive';
  if (type === 'bw') return 'bw';
  return 'color';
}

export function convertFrameWithRouter({ imageData, settings = {}, preset = null }) {
  const mode = resolveConversionMode(settings, preset);
  if (mode === 'positive') {
    return convertPositiveLegacy(imageData);
  }
  if (mode === 'bw') {
    return convertBwWithSilverCore(imageData, settings);
  }
  return convertColorWithSilverCore(imageData, settings);
}
