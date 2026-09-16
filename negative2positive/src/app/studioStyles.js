// Quick looks are complete, editable recipes. The old buttons only changed the
// scanner color model; warm even fell back to the same model as standard.
// Keep the existing model identifiers so saved recipes and selection agree.
const neutral = {
  coreFilmPreset: 'none', coreEnhancedProfile: 'none',
  coreTemperature: 0, coreTint: 0, coreContrast: 0, coreSaturation: 100,
  coreShadows: 0, coreHighlights: 0, coreGlow: 0, coreFade: 0,
};
const styles = {
  standard: {},
  warm: { coreTemperature: 18, coreTint: 2, coreSaturation: 104 },
  frontier: { coreContrast: 18, coreSaturation: 125, coreShadows: -4, coreHighlights: -4 },
  noritsu: { coreContrast: -18, coreSaturation: 92, coreShadows: 10, coreHighlights: -12, coreFade: 3 },
};

export function studioStyleSettings(model) {
  if (!Object.hasOwn(styles, model)) return null;
  return { ...neutral, ...styles[model], coreColorModel: model };
}
