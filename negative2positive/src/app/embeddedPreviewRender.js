// Provisional rendering of an embedded camera JPEG: orientation, approximate
// geometry and a quick inversion. Pure functions plus one environment-driven
// renderer, so the same code runs in the scan-decode worker (OffscreenCanvas)
// and, where workers cannot decode images, on the main thread.
//
// The output is presentation-only. It is drawn by the viewer veil or used as
// an `embedded` tile and never becomes a conversion, analysis or export source.
import { locateEmbeddedPreviews, pickForTile, pickForViewer } from './rawEmbeddedPreview.js';

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/**
 * TIFF orientation to apply by hand. createImageBitmap applies a JPEG's own
 * Exif Orientation ('from-image'), so the container's TIFF Orientation is used
 * only when the preview carries none (or 1). Never both.
 */
export function resolvePreviewOrientation(tiffOrientation, exifOrientation) {
  if (exifOrientation >= 2 && exifOrientation <= 8) return 1;
  return tiffOrientation >= 1 && tiffOrientation <= 8 ? tiffOrientation : 1;
}

// Canvas matrices [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f).
export function multiplyMatrix(m, n) {
  // m ∘ n: apply n first.
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * EXIF/TIFF Orientation as the transform from stored pixels to displayed
 * pixels: 3 rotates 180°, 6 rotates 90° clockwise, 8 rotates 90°
 * counter-clockwise, the even values mirror. LibRaw's flip applies the same
 * rotation to the decoded RAW, so the oriented preview is the geometry base.
 */
export function orientationMatrix(orientation, width, height) {
  switch (orientation) {
    case 2: return { width, height, matrix: [-1, 0, 0, 1, width, 0] };
    case 3: return { width, height, matrix: [-1, 0, 0, -1, width, height] };
    case 4: return { width, height, matrix: [1, 0, 0, -1, 0, height] };
    case 5: return { width: height, height: width, matrix: [0, 1, 1, 0, 0, 0] };
    case 6: return { width: height, height: width, matrix: [0, 1, -1, 0, height, 0] };
    case 7: return { width: height, height: width, matrix: [0, -1, -1, 0, height, width] };
    case 8: return { width: height, height: width, matrix: [0, -1, 1, 0, 0, width] };
    default: return { width, height, matrix: [1, 0, 0, 1, 0, 0] };
  }
}

// ---------------------------------------------------------------------------
// Geometry: base -> rotation -> mirror -> crop, then fit
// ---------------------------------------------------------------------------

function normalizeAngle(angle) {
  let a = Number.isFinite(angle) ? angle : 0;
  while (a > 180) a -= 360;
  while (a <= -180) a += 360;
  return a;
}

/**
 * One affine transform from the decoded preview to the provisional frame.
 *
 * The chain matches rebuildGeometryFromBase / buildRollAnalysisSample: the
 * oriented preview is the base, `rotationAngle` expands the canvas like
 * applyRotationToImageData, `mirrored` flips the rotated frame and
 * `cropRegion` (post-mirror, full-resolution pixels) is scaled by the
 * preview's long side over the raw's. The small 9504/9536 inset is ignored.
 * Without geometry the whole preview is shown.
 */
export function provisionalTransform({ sourceWidth, sourceHeight, orientation = 1, geometry = null,
  rawSize = null, maxLongSide = Infinity }) {
  const oriented = orientationMatrix(orientation, sourceWidth, sourceHeight);
  let matrix = oriented.matrix;
  let width = oriented.width, height = oriented.height;
  const baseLong = Math.max(width, height);

  const angle = normalizeAngle(Number(geometry?.rotationAngle) || 0);
  if (Math.abs(angle) >= 0.001) {
    const rightAngle = Math.round(angle / 90) * 90;
    const rad = (Math.abs(angle - rightAngle) < 0.001 ? rightAngle : angle) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const exact = Math.abs(angle - rightAngle) < 0.001;
    const newW = exact ? (Math.abs(rightAngle) === 90 ? height : width)
      : Math.max(1, Math.ceil(width * Math.abs(cos) + height * Math.abs(sin)));
    const newH = exact ? (Math.abs(rightAngle) === 90 ? width : height)
      : Math.max(1, Math.ceil(width * Math.abs(sin) + height * Math.abs(cos)));
    // translate(newW/2, newH/2) · rotate(rad) · translate(-w/2, -h/2)
    const rotate = [cos, sin, -sin, cos, 0, 0];
    matrix = multiplyMatrix([1, 0, 0, 1, newW / 2, newH / 2],
      multiplyMatrix(rotate, multiplyMatrix([1, 0, 0, 1, -width / 2, -height / 2], matrix)));
    width = newW; height = newH;
  }
  if (geometry?.mirrored) matrix = multiplyMatrix([-1, 0, 0, 1, width, 0], matrix);

  const crop = geometry?.cropRegion;
  const rawLong = Math.max(Number(rawSize?.width) || 0, Number(rawSize?.height) || 0);
  let cropped = false;
  if (crop && rawLong > 0 && Number(crop.width) > 0 && Number(crop.height) > 0) {
    const f = baseLong / rawLong;
    const left = Math.max(0, Math.min(width - 1, Math.round((crop.left ?? crop.x ?? 0) * f)));
    const top = Math.max(0, Math.min(height - 1, Math.round((crop.top ?? crop.y ?? 0) * f)));
    const w = Math.max(1, Math.min(width - left, Math.round(crop.width * f)));
    const h = Math.max(1, Math.min(height - top, Math.round(crop.height * f)));
    matrix = multiplyMatrix([1, 0, 0, 1, -left, -top], matrix);
    width = w; height = h;
    cropped = true;
  }

  const limit = Number(maxLongSide) > 0 ? Number(maxLongSide) : Infinity;
  const scale = Math.min(1, limit / Math.max(width, height));
  if (scale < 1) {
    matrix = multiplyMatrix([scale, 0, 0, scale, 0, 0], matrix);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  return { width, height, matrix, cropped };
}

/**
 * Nearest-neighbour resample of an RGBA grid through `matrix` (source ->
 * destination). Used by tests and as a canvas-free reference.
 */
export function transformPixels(data, width, height, { width: outW, height: outH, matrix }) {
  const [a, b, c, d, e, f] = matrix;
  const det = a * d - b * c;
  const inv = [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const [sx, sy] = applyMatrix(inv, x + 0.5, y + 0.5);
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
      const s = (iy * width + ix) * 4, o = (y * outW + x) * 4;
      out[o] = data[s]; out[o + 1] = data[s + 1]; out[o + 2] = data[s + 2]; out[o + 3] = data[s + 3];
    }
  }
  return { width: outW, height: outH, data: out };
}

// ---------------------------------------------------------------------------
// Quick inversion and colour matching
// ---------------------------------------------------------------------------

export const PROVISIONAL_LOW_PERCENTILE = 0.005;
export const PROVISIONAL_HIGH_PERCENTILE = 0.995;
export const PROVISIONAL_GAMMA_LIFT = 1.15;
const MAX_HISTOGRAM_SAMPLES = 262_144;

// Measure the mapped crop, or the central 80 % when nothing is cropped, so the
// film rebate does not set the levels.
export function measurementRegion(width, height, cropped) {
  if (cropped) return { left: 0, top: 0, width, height };
  const left = Math.floor(width * 0.1), top = Math.floor(height * 0.1);
  return { left, top, width: Math.max(1, width - 2 * left), height: Math.max(1, height - 2 * top) };
}

function luminance(r, g, b) {
  return (r * 77 + g * 150 + b * 29 + 128) >> 8;
}

/** Per-channel 256-bin histograms (R, G, B, luminance) of opaque pixels. */
export function histograms(data, width, height, { region = null, invert = false } = {}) {
  const r = region || { left: 0, top: 0, width, height };
  const hist = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const step = Math.max(1, Math.floor(Math.sqrt((r.width * r.height) / MAX_HISTOGRAM_SAMPLES)));
  for (let y = r.top; y < r.top + r.height; y += step) {
    let i = (y * width + r.left) * 4;
    for (let x = 0; x < r.width; x += step, i += 4 * step) {
      if (data[i + 3] === 0) continue;
      const R = invert ? 255 - data[i] : data[i];
      const G = invert ? 255 - data[i + 1] : data[i + 1];
      const B = invert ? 255 - data[i + 2] : data[i + 2];
      hist[0][R]++; hist[1][G]++; hist[2][B]++; hist[3][luminance(R, G, B)]++;
    }
  }
  return hist;
}

function percentile(hist, fraction) {
  let total = 0;
  for (let v = 0; v < 256; v++) total += hist[v];
  if (!total) return fraction < 0.5 ? 0 : 255;
  const target = total * fraction;
  let sum = 0;
  for (let v = 0; v < 256; v++) {
    sum += hist[v];
    if (sum >= target) return v;
  }
  return 255;
}

/** Stretch between the 0.5th and 99.5th percentiles with a mild gamma lift. */
export function stretchLut(hist) {
  const lo = percentile(hist, PROVISIONAL_LOW_PERCENTILE);
  const hi = Math.max(lo + 16, percentile(hist, PROVISIONAL_HIGH_PERCENTILE));
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = Math.round(255 * Math.pow(t, 1 / PROVISIONAL_GAMMA_LIFT));
  }
  return lut;
}

/** Histogram-matching LUT (CDF of `source` onto CDF of `target`). */
export function matchLut(source, target) {
  const cdf = hist => {
    const out = new Float64Array(256);
    let sum = 0, total = 0;
    for (let v = 0; v < 256; v++) total += hist[v];
    for (let v = 0; v < 256; v++) { sum += hist[v]; out[v] = total ? sum / total : v / 255; }
    return out;
  };
  const src = cdf(source), dst = cdf(target);
  const lut = new Uint8Array(256);
  let u = 0;
  for (let v = 0; v < 256; v++) {
    while (u < 255 && dst[u] < src[v] - 1e-12) u++;
    lut[v] = u;
  }
  return lut;
}

/**
 * Tone the mapped preview in place: invert (unless the exact render will not
 * invert either), then histogram-match to a converted thumbnail when one is
 * given, else stretch each channel. B&W frames output luminance.
 */
export function applyProvisionalTone(data, width, height, { invert = true, monochrome = false, cropped = false,
  target = null } = {}) {
  if (!invert && !target) return;
  const region = measurementRegion(width, height, cropped);
  const source = histograms(data, width, height, { region, invert });
  let luts;
  if (target) luts = [0, 1, 2, 3].map(c => matchLut(source[c], target[c]));
  else luts = [0, 1, 2, 3].map(c => stretchLut(source[c]));
  const [lr, lg, lb, ly] = luts;
  for (let i = 0; i < data.length; i += 4) {
    const R = invert ? 255 - data[i] : data[i];
    const G = invert ? 255 - data[i + 1] : data[i + 1];
    const B = invert ? 255 - data[i + 2] : data[i + 2];
    if (monochrome) {
      const y = ly[luminance(R, G, B)];
      data[i] = data[i + 1] = data[i + 2] = y;
    } else {
      data[i] = lr[R]; data[i + 1] = lg[G]; data[i + 2] = lb[B];
    }
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export const TILE_PREVIEW_MIN_LONG_SIDE = 288;
export const TILE_PREVIEW_LONG_SIDE = 320;

function dataUrlBytes(url) {
  const comma = String(url).indexOf(',');
  if (comma < 0 || !/;base64$/.test(url.slice(0, comma))) return null;
  const binary = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function targetHistograms(env, url) {
  const bytes = dataUrlBytes(url);
  if (!bytes) return null;
  const bitmap = await env.decode(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const canvas = env.createCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return histograms(image.data, image.width, image.height);
  } finally { bitmap.close?.(); }
}

/**
 * Locate, decode and render one embedded preview.
 *
 * `env` supplies the platform: `createCanvas(w, h)`, `decode(blob)` (an
 * ImageBitmap honouring the JPEG's own Exif Orientation), `finish(canvas,
 * job)` (bitmap or data URL). The job carries the File, its purpose
 * ('viewer' | 'tile'), the viewer's device-pixel long side, an optional
 * already-located structure, and the tone/geometry inputs.
 *
 * @returns {Promise<{ empty: true, located, bytesRead } | { output, width, height, located, preview, bytesRead }>}
 */
export async function renderEmbeddedPreview(job, env) {
  let located = job.located || null;
  let bytesRead = 0;
  if (!located) {
    located = await locateEmbeddedPreviews(job.file);
    bytesRead += located?.bytesRead || 0;
  }
  const preview = !located ? null : job.purpose === 'tile'
    ? pickForTile(located.previews, TILE_PREVIEW_MIN_LONG_SIDE)
    : pickForViewer(located.previews, job.longSidePx);
  if (!preview) return { empty: true, located, bytesRead };
  const blob = job.file.slice(preview.offset, preview.offset + preview.length, 'image/jpeg');
  bytesRead += preview.length;
  const bitmap = await env.decode(blob);
  let canvas, plan;
  try {
    plan = provisionalTransform({
      sourceWidth: bitmap.width, sourceHeight: bitmap.height,
      orientation: resolvePreviewOrientation(located.orientation, preview.exifOrientation),
      geometry: job.purpose === 'tile' ? null : job.geometry || null,
      rawSize: located.rawSize,
      maxLongSide: job.maxLongSide || (job.purpose === 'tile' ? TILE_PREVIEW_LONG_SIDE : Infinity),
    });
    canvas = env.createCanvas(plan.width, plan.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.setTransform(...plan.matrix);
    context.drawImage(bitmap, 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    if (job.invert !== false || job.matchTo) {
      const target = job.matchTo ? await targetHistograms(env, job.matchTo).catch(() => null) : null;
      const image = context.getImageData(0, 0, plan.width, plan.height);
      applyProvisionalTone(image.data, plan.width, plan.height, {
        invert: job.invert !== false, monochrome: Boolean(job.monochrome), cropped: plan.cropped, target,
      });
      context.putImageData(image, 0, 0);
    }
  } finally { bitmap.close?.(); }
  const output = await env.finish(canvas, job);
  return { output, width: plan.width, height: plan.height, located, preview, bytesRead };
}

/**
 * Main-thread environment for platforms whose workers cannot decode images
 * (macOS 10.15 WebKit, older WebKitGTK). Only small tile previews use it, one
 * per animation frame; viewer frames are skipped there.
 */
export function createDocumentPreviewEnv(doc = globalThis.document) {
  return {
    createCanvas(width, height) {
      const canvas = doc.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    async decode(blob) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
      catch (error) {
        if (error?.name === 'TypeError') return await createImageBitmap(blob);
        throw error;
      }
    },
    finish: async (canvas, job) => canvas.toDataURL('image/jpeg', job.quality || 0.8),
  };
}
