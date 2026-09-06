// Flat-field correction for camera scanning: a blank frame of the light source
// becomes a per-channel gain map that removes the light pad's corner falloff
// and colour non-uniformity from every frame shot on it. Lens profiles fix the
// lens; this fixes the panel.
//
// The map is a small grid (64 x 64 by default) in normalised coordinates of
// the unrotated base image, built in linear light, smoothed so dust on the
// blank does not print through, and normalised to the 98th percentile so gains
// are >= 1 almost everywhere. Frames are corrected by mapping each working
// pixel back to base coordinates (rotation, mirror, crop) and multiplying in
// linear light, before film base compensation and the histogram analysis.

import { workingPointToBase } from './localExposure.js';

const DEFAULT_SIZE = 64;
const GAIN_MIN = 0.5;
const GAIN_MAX = 4;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

const LINEAR_8 = new Float32Array(256);
for (let i = 0; i < 256; i++) LINEAR_8[i] = Math.pow(i / 255, 2.2);

function linearOf16(value) {
  return Math.pow(value / 65535, 2.2);
}

// Box-averages the frame into a size x size grid of linear RGB means.
function gridAverage(imageData, size) {
  const { width, height } = imageData;
  const plane16 = imageData.__image16 && imageData.__image16.data instanceof Uint16Array ? imageData.__image16.data : null;
  const data8 = imageData.data;
  const sums = new Float64Array(size * size * 3);
  const counts = new Uint32Array(size * size);
  const stepX = Math.max(1, Math.floor(width / (size * 6)));
  const stepY = Math.max(1, Math.floor(height / (size * 6)));
  for (let y = 0; y < height; y += stepY) {
    const gy = Math.min(size - 1, Math.floor((y / height) * size));
    for (let x = 0; x < width; x += stepX) {
      const gx = Math.min(size - 1, Math.floor((x / width) * size));
      const i = (y * width + x) * 4;
      if (data8[i + 3] === 0) continue;
      const cell = gy * size + gx;
      if (plane16) {
        sums[cell * 3] += linearOf16(plane16[i]);
        sums[cell * 3 + 1] += linearOf16(plane16[i + 1]);
        sums[cell * 3 + 2] += linearOf16(plane16[i + 2]);
      } else {
        sums[cell * 3] += LINEAR_8[data8[i]];
        sums[cell * 3 + 1] += LINEAR_8[data8[i + 1]];
        sums[cell * 3 + 2] += LINEAR_8[data8[i + 2]];
      }
      counts[cell]++;
    }
  }
  const grid = new Float32Array(size * size * 3);
  for (let cell = 0; cell < size * size; cell++) {
    const n = counts[cell] || 1;
    grid[cell * 3] = sums[cell * 3] / n;
    grid[cell * 3 + 1] = sums[cell * 3 + 1] / n;
    grid[cell * 3 + 2] = sums[cell * 3 + 2] / n;
  }
  return grid;
}

function boxSmooth(grid, size, passes = 2) {
  let current = grid;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(current.length);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0; let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= size) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= size) continue;
              sum += current[(yy * size + xx) * 3 + ch];
              n++;
            }
          }
          next[(y * size + x) * 3 + ch] = sum / n;
        }
      }
    }
    current = next;
  }
  return current;
}

function percentileOf(values, fraction) {
  const sorted = Float32Array.from(values).sort();
  return sorted[clamp(Math.floor(sorted.length * fraction), 0, sorted.length - 1)];
}

// 3x3 median per channel: robust to a single dark or bright cell (dust or a
// scratch on the blank), unlike the box mean.
function medianSmooth(grid, size) {
  const out = new Float32Array(grid.length);
  const window = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      for (let ch = 0; ch < 3; ch++) {
        window.length = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= size) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= size) continue;
            window.push(grid[(yy * size + xx) * 3 + ch]);
          }
        }
        window.sort((a, b) => a - b);
        out[(y * size + x) * 3 + ch] = window[window.length >> 1];
      }
    }
  }
  return out;
}

// Dust suppression: a cell far from its median neighbourhood (a dust shadow
// on the blank) takes the median instead.
function suppressSpecks(grid, median) {
  const out = new Float32Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const reference = median[i];
    const value = grid[i];
    out[i] = value < reference * 0.94 || value > reference * 1.06 ? reference : value;
  }
  return out;
}

// Builds the gain map from a blank frame. `stats` describe the blank so the
// UI can show the falloff it removes.
export function buildFlatFieldMap(imageData, { size = DEFAULT_SIZE, id = null, source = '' } = {}) {
  if (!imageData || !imageData.data || imageData.width < 8 || imageData.height < 8) return null;
  const raw = gridAverage(imageData, size);
  const median = medianSmooth(raw, size);
  const cleaned = boxSmooth(suppressSpecks(raw, median), size, 2);
  const gains = new Float32Array(size * size * 3);
  const reference = [0, 1, 2].map((ch) => {
    const values = new Float32Array(size * size);
    for (let cell = 0; cell < size * size; cell++) values[cell] = cleaned[cell * 3 + ch];
    return percentileOf(values, 0.98);
  });
  let minLuminance = Infinity; let maxLuminance = 0;
  for (let cell = 0; cell < size * size; cell++) {
    let luminance = 0;
    for (let ch = 0; ch < 3; ch++) {
      const value = cleaned[cell * 3 + ch];
      gains[cell * 3 + ch] = value > 1e-6 ? clamp(reference[ch] / value, GAIN_MIN, GAIN_MAX) : GAIN_MAX;
      luminance += value;
    }
    minLuminance = Math.min(minLuminance, luminance / 3);
    maxLuminance = Math.max(maxLuminance, luminance / 3);
  }
  const corners = [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]].map(([x, y]) => {
    const cell = y * size + x;
    return (cleaned[cell * 3] + cleaned[cell * 3 + 1] + cleaned[cell * 3 + 2]) / 3;
  });
  const centreCell = Math.floor(size / 2) * size + Math.floor(size / 2);
  const centre = (cleaned[centreCell * 3] + cleaned[centreCell * 3 + 1] + cleaned[centreCell * 3 + 2]) / 3;
  const cornerFalloff = centre > 0 ? 1 - Math.min(...corners) / centre : 0;
  const mean = [0, 1, 2].map((ch) => {
    let sum = 0;
    for (let cell = 0; cell < size * size; cell++) sum += cleaned[cell * 3 + ch];
    return sum / (size * size);
  });
  // Colour cast across the panel: spread of the red and blue shares.
  const shares = { r: [], b: [] };
  for (let cell = 0; cell < size * size; cell++) {
    const r = cleaned[cell * 3]; const g = cleaned[cell * 3 + 1]; const b = cleaned[cell * 3 + 2];
    const s = r + g + b;
    if (s > 0) { shares.r.push(r / s); shares.b.push(b / s); }
  }
  const castSpread = Math.max(percentileOf(shares.r, 0.95) - percentileOf(shares.r, 0.05), percentileOf(shares.b, 0.95) - percentileOf(shares.b, 0.05));
  return {
    id: id || `flat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    source: String(source || ''),
    width: size,
    height: size,
    gains,
    stats: {
      cornerFalloff: Number(clamp(cornerFalloff, 0, 1).toFixed(4)),
      uniformity: Number((maxLuminance > 0 ? minLuminance / maxLuminance : 0).toFixed(4)),
      meanLinear: mean.map((v) => Number(v.toFixed(5))),
      castSpread: Number(castSpread.toFixed(4))
    }
  };
}

// Heuristic: is this frame a blank shot of the light source? Bright, smooth
// (after box smoothing) and without strong local structure.
export function scoreBlankFrame(imageData, { size = 32 } = {}) {
  if (!imageData || !imageData.data) return { blank: false, score: 0, mean: 0, variation: 1, texture: 1 };
  const raw = gridAverage(imageData, size);
  const smoothed = boxSmooth(raw, size, 1);
  let sum = 0; let n = 0; let texture = 0;
  const luminances = [];
  const margin = Math.floor(size * 0.1);
  for (let y = margin; y < size - margin; y++) {
    for (let x = margin; x < size - margin; x++) {
      const cell = y * size + x;
      const lum = (smoothed[cell * 3] + smoothed[cell * 3 + 1] + smoothed[cell * 3 + 2]) / 3;
      const rawLum = (raw[cell * 3] + raw[cell * 3 + 1] + raw[cell * 3 + 2]) / 3;
      luminances.push(lum);
      sum += lum; n++;
      texture += Math.abs(rawLum - lum);
    }
  }
  const mean = n ? sum / n : 0;
  let variance = 0;
  for (const lum of luminances) variance += (lum - mean) * (lum - mean);
  const variation = mean > 0 ? Math.sqrt(variance / Math.max(1, n)) / mean : 1;
  const textureRatio = mean > 0 ? texture / n / mean : 1;
  const bright = clamp((mean - 0.2) / 0.4, 0, 1);
  const smooth = clamp(1 - variation / 0.25, 0, 1);
  const flat = clamp(1 - textureRatio / 0.06, 0, 1);
  const score = Number((bright * smooth * flat).toFixed(3));
  return { blank: mean > 0.3 && variation < 0.2 && textureRatio < 0.05, score, mean: Number(mean.toFixed(4)), variation: Number(variation.toFixed(4)), texture: Number(textureRatio.toFixed(4)) };
}

export function sampleFlatFieldGain(map, u, v, channel) {
  const { width, height, gains } = map;
  const fx = clamp(u, 0, 1) * (width - 1);
  const fy = clamp(v, 0, 1) * (height - 1);
  const x0 = Math.floor(fx); const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1); const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0; const ty = fy - y0;
  const g = (x, y) => gains[(y * width + x) * 3 + channel];
  return (g(x0, y0) * (1 - tx) + g(x1, y0) * tx) * (1 - ty) + (g(x0, y1) * (1 - tx) + g(x1, y1) * tx) * ty;
}

// Applies the map to a 16-bit RGBA working buffer in place. `geometry` is the
// frame geometry (baseWidth, baseHeight, rotationAngle, mirrored,
// rotatedWidth, rotatedHeight, cropRegion, width, height) of that buffer.
export function applyFlatFieldToImage16(image16, map, geometry) {
  if (!image16 || !map || !geometry) return image16;
  const { width, height, data } = image16;
  if (geometry.width !== width || geometry.height !== height) return image16;
  const max = 65535;
  const steps = 4096;
  const toLinear = new Float32Array(steps + 1);
  for (let i = 0; i <= steps; i++) toLinear[i] = Math.pow(i / steps, 2.2);
  const encode = (linear) => Math.pow(Math.min(1, Math.max(0, linear)), 1 / 2.2);
  for (let y = 0; y < height; y++) {
    // The mapping is affine, so one row needs two evaluations.
    const start = workingPointToBase({ x: 0.5, y: y + 0.5 }, geometry);
    const end = workingPointToBase({ x: width - 0.5, y: y + 0.5 }, geometry);
    const du = width > 1 ? (end.x - start.x) / (width - 1) : 0;
    const dv = width > 1 ? (end.y - start.y) / (width - 1) : 0;
    let u = start.x; let v = start.y;
    for (let x = 0; x < width; x++, u += du, v += dv) {
      const o = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const gain = sampleFlatFieldGain(map, u, v, ch);
        if (gain === 1) continue;
        const idx = (data[o + ch] / max) * steps;
        const i0 = Math.floor(idx); const f = idx - i0;
        const linear = toLinear[i0] * (1 - f) + toLinear[Math.min(steps, i0 + 1)] * f;
        data[o + ch] = Math.round(encode(linear * gain) * max);
      }
    }
  }
  return image16;
}

// Compact, structured-clone friendly record for the session registry.
export function sanitizeFlatFieldMap(input) {
  if (!input || typeof input !== 'object') return null;
  const width = Number(input.width); const height = Number(input.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || width > 256 || height > 256) return null;
  const gains = input.gains instanceof Float32Array ? input.gains : (Array.isArray(input.gains) ? Float32Array.from(input.gains) : null);
  if (!gains || gains.length !== width * height * 3) return null;
  const clean = new Float32Array(gains.length);
  for (let i = 0; i < gains.length; i++) clean[i] = Number.isFinite(gains[i]) ? clamp(gains[i], GAIN_MIN, GAIN_MAX) : 1;
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : `flat-${Date.now().toString(36)}`,
    source: typeof input.source === 'string' ? input.source.slice(0, 200) : '',
    width,
    height,
    gains: clean,
    stats: input.stats && typeof input.stats === 'object' ? { ...input.stats } : {}
  };
}
