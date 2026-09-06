// 比率は画幅候補の事前分布。実際の境界は画像から検出し、この比率で一律切り抜かない。
export const AUTO_FRAME_FORMAT_RATIOS = Object.freeze({
  '135': 1.5,
  '135-half': 4 / 3,
  '135-panoramic': 65 / 24,
  '120-6x4.5': 1.33,
  '120-6x6': 1,
  '120-6x7': 1.17,
  '120-6x8': 4 / 3,
  '120-6x9': 1.5,
  '120-6x12': 2,
  '120-6x17': 17 / 6
});
export const AUTO_FRAME_DEFAULT_120_FORMATS = Object.freeze(['6x4.5', '6x6', '6x7', '6x8', '6x9', '6x12', '6x17']);

// 自動適用は強い境界根拠がある場合のみ。低信頼結果を無言で確定しない。
export function canAutoApplyImportFrame(result, settings = {}) {
  const threshold = Number.isFinite(settings.highConfidence) ? settings.highConfidence : 0.72;
  return Boolean(result?.cropRegion && Number.isFinite(result.confidence)
    && result.confidence >= threshold && result.confidenceLevel === 'high'
    && Number.isFinite(result.angle)
    && ['left', 'top', 'width', 'height'].every(key => Number.isFinite(result.cropRegion[key]))
    && result.cropRegion.left >= 0 && result.cropRegion.top >= 0
    && result.cropRegion.width > 0 && result.cropRegion.height > 0);
}
