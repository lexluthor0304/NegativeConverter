import { analysisPixelBounds } from '../../app/analysisRegion.js';
import { estimateAutoWhiteBalance } from '../../app/autoWhiteBalance.js';

export function identityPositiveChannels() {
  return ['Red', 'Green', 'Blue'].map(channel => ({
    whitePointOrigin: 0, blackPointOrigin: 65535, meanPoint: 0.5,
    settingName: `ToneCurvePV2012${channel}`,
  }));
}

// Analyse a bounded sample, independently of the output geometry/resolution.
// Positives have no orange mask. Never stretch their channels independently.
export function analyzePositive(image, params = {}) {
  if (params.positiveMode === 'edit') return { gain: 1, wb: [1, 1, 1] };
  const { data, width, height } = image;
  const bounds = analysisPixelBounds(width, height, params.analysisRegion, (params.borderBuffer ?? 10) / 100);
  const stride = Math.max(1, Math.ceil(Math.sqrt(bounds.width * bounds.height / 40000)));
  const peaks = [], sample = [];
  for (let y = bounds.top; y < bounds.top + bounds.height; y += stride) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x += stride) {
      const i = (y * width + x) * 4;
      if (!data[i + 3]) continue;
      peaks.push(Math.max(data[i], data[i + 1], data[i + 2]) / 65535);
      sample.push(data[i] >>> 8, data[i + 1] >>> 8, data[i + 2] >>> 8, 255);
    }
  }
  if (peaks.length < 64) return { gain: 1, wb: [1, 1, 1] };
  peaks.sort((a, b) => a - b);
  const p95 = peaks[Math.floor((peaks.length - 1) * .95)];
  // Bounded lift with a shoulder; 0 and 1 stay fixed, all intermediate values
  // remain ordered. A bright tail is retained rather than percentile-clipped.
  const gain = p95 > .02 ? Math.max(1, Math.min(3, .85 * (1 - p95) / (.15 * p95))) : 1;
  const estimate = estimateAutoWhiteBalance({ width: peaks.length, height: 1, data: Uint8ClampedArray.from(sample) });
  // Only strong neutral evidence can alter slide colours. Attenuation avoids
  // clipping channels; the common tone mapping subsequently restores brightness.
  const wb = estimate.confidence === 'high' ? [estimate.wbR, estimate.wbG, estimate.wbB] : [1, 1, 1];
  const ceiling = Math.max(...wb);
  return { gain, wb: wb.map(value => value / ceiling) };
}

export function applyPositiveAnalysis(image, analysis) {
  if (!analysis || (analysis.gain === 1 && analysis.wb.every(value => value === 1))) return;
  const { data } = image;
  const { gain, wb } = analysis;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i] * wb[0], g = data[i + 1] * wb[1], b = data[i + 2] * wb[2];
    const peak = Math.max(r, g, b) / 65535;
    const scale = gain / (1 + (gain - 1) * peak);
    data[i] = Math.round(r * scale);
    data[i + 1] = Math.round(g * scale);
    data[i + 2] = Math.round(b * scale);
  }
}
