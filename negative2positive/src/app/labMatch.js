// Match a lab scan: learn a colour "look" that turns our conversion into the
// lab's rendering of the same frame. The look is a 3x3 matrix with offset in
// display space followed by a per-channel 256-entry curve, applied as the
// last stage of the 8-bit adjustment pipeline. Pure functions; alignment
// lives in imageAlignment.js.

const LUT_SIZE = 256;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export const IDENTITY_LOOK = Object.freeze({
  matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  offset: [0, 0, 0],
  curves: null
});

// Collects paired pixels (ours -> theirs) where both images have content.
// Clipped pixels are skipped: they carry no information about the transform.
export function collectPairs(source, target, { step = 3, skipClipped = true, maxPairs = 60000 } = {}) {
  if (!source || !target || source.width !== target.width || source.height !== target.height) return { src: new Float32Array(0), dst: new Float32Array(0), count: 0 };
  const { width, height } = source;
  const s = source.data; const t = target.data;
  const src = []; const dst = [];
  const stride = Math.max(1, Math.round(step));
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      if (s[i + 3] === 0 || t[i + 3] === 0) continue;
      if (skipClipped) {
        let clipped = false;
        for (let ch = 0; ch < 3; ch++) {
          if (s[i + ch] <= 2 || s[i + ch] >= 253 || t[i + ch] <= 2 || t[i + ch] >= 253) { clipped = true; break; }
        }
        if (clipped) continue;
      }
      src.push(s[i], s[i + 1], s[i + 2]);
      dst.push(t[i], t[i + 1], t[i + 2]);
      if (src.length / 3 >= maxPairs) break;
    }
    if (src.length / 3 >= maxPairs) break;
  }
  return { src: Float32Array.from(src), dst: Float32Array.from(dst), count: src.length / 3 };
}

// Solves a 4x4 symmetric system by Gaussian elimination (normal equations).
function solve(a, b, n) {
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

// Least-squares affine fit dst_c = sum_k M[c][k] * src_k + o_c per output channel.
export function fitAffineMatrix(pairs) {
  const { src, dst, count } = pairs;
  if (count < 16) return null;
  const matrix = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const offset = [0, 0, 0];
  // Normal equations on [r, g, b, 1].
  const ata = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const atb = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < count; i++) {
    const v = [src[i * 3], src[i * 3 + 1], src[i * 3 + 2], 1];
    for (let a = 0; a < 4; a++) {
      for (let b = 0; b < 4; b++) ata[a][b] += v[a] * v[b];
      for (let c = 0; c < 3; c++) atb[c][a] += v[a] * dst[i * 3 + c];
    }
  }
  // Ridge term keeps the fit sane when the pairs span little colour range.
  for (let a = 0; a < 3; a++) ata[a][a] += count * 0.5;
  for (let c = 0; c < 3; c++) {
    const x = solve(ata, atb[c], 4);
    if (!x) return null;
    matrix[c * 3] = x[0]; matrix[c * 3 + 1] = x[1]; matrix[c * 3 + 2] = x[2];
    offset[c] = x[3];
  }
  // Reject degenerate solutions (negative or runaway gains).
  for (let c = 0; c < 3; c++) {
    const diag = matrix[c * 3 + c];
    if (!Number.isFinite(diag) || diag < 0.2 || diag > 4) return null;
  }
  return { matrix: matrix.map((v) => Number(v.toFixed(5))), offset: offset.map((v) => Number(v.toFixed(3))) };
}

export function applyMatrixToPixel(matrix, offset, r, g, b) {
  return [
    clamp(matrix[0] * r + matrix[1] * g + matrix[2] * b + offset[0], 0, 255),
    clamp(matrix[3] * r + matrix[4] * g + matrix[5] * b + offset[1], 0, 255),
    clamp(matrix[6] * r + matrix[7] * g + matrix[8] * b + offset[2], 0, 255)
  ];
}

// Per-channel histogram matching: a monotone curve that maps the source
// distribution onto the target distribution. Works on any pixel lists; used
// for the residual after the matrix and for the unaligned fallback.
export function histogramMatchCurves(srcValues, dstValues, count) {
  const curves = [new Uint8Array(LUT_SIZE), new Uint8Array(LUT_SIZE), new Uint8Array(LUT_SIZE)];
  for (let ch = 0; ch < 3; ch++) {
    const srcHist = new Float64Array(LUT_SIZE); const dstHist = new Float64Array(LUT_SIZE);
    for (let i = 0; i < count; i++) {
      srcHist[clamp(Math.round(srcValues[i * 3 + ch]), 0, 255)]++;
      dstHist[clamp(Math.round(dstValues[i * 3 + ch]), 0, 255)]++;
    }
    const srcCdf = new Float64Array(LUT_SIZE); const dstCdf = new Float64Array(LUT_SIZE);
    let sa = 0; let da = 0;
    for (let v = 0; v < LUT_SIZE; v++) { sa += srcHist[v]; da += dstHist[v]; srcCdf[v] = sa / Math.max(1, count); dstCdf[v] = da / Math.max(1, count); }
    let j = 0;
    for (let v = 0; v < LUT_SIZE; v++) {
      while (j < LUT_SIZE - 1 && dstCdf[j] < srcCdf[v]) j++;
      curves[ch][v] = j;
    }
    // Keep the ends anchored so black stays black and white stays white
    // outside the sampled range, and enforce monotonicity.
    for (let v = 1; v < LUT_SIZE; v++) if (curves[ch][v] < curves[ch][v - 1]) curves[ch][v] = curves[ch][v - 1];
  }
  return { r: curves[0], g: curves[1], b: curves[2] };
}

// Smooths a curve LUT with a small box filter (histogram matching is jagged
// on sparse data) while keeping it monotone and anchored.
export function smoothCurve(curve, radius = 3) {
  const out = new Uint8Array(LUT_SIZE);
  for (let v = 0; v < LUT_SIZE; v++) {
    let sum = 0; let n = 0;
    for (let d = -radius; d <= radius; d++) {
      const i = v + d;
      if (i < 0 || i >= LUT_SIZE) continue;
      sum += curve[i]; n++;
    }
    out[v] = Math.round(sum / n);
  }
  for (let v = 1; v < LUT_SIZE; v++) if (out[v] < out[v - 1]) out[v] = out[v - 1];
  return out;
}

// Mean absolute difference between two pixel lists (display space, 0-255).
export function meanAbsoluteDifference(a, b, count) {
  if (!count) return 0;
  let sum = 0;
  for (let i = 0; i < count * 3; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (count * 3);
}

export function applyLookToPixels(look, values, count) {
  const out = new Float32Array(count * 3);
  const matrix = look.matrix || IDENTITY_LOOK.matrix;
  const offset = look.offset || IDENTITY_LOOK.offset;
  for (let i = 0; i < count; i++) {
    let [r, g, b] = applyMatrixToPixel(matrix, offset, values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
    if (look.curves) {
      r = look.curves.r[Math.round(r)]; g = look.curves.g[Math.round(g)]; b = look.curves.b[Math.round(b)];
    }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

// Fits the full look from aligned pairs: matrix first, then residual curves.
// Returns { look, deltaBefore, deltaAfter, method }.
export function fitLook(pairs, { aligned = true } = {}) {
  const { src, dst, count } = pairs;
  if (count < 16) return null;
  const deltaBefore = meanAbsoluteDifference(src, dst, count);
  let matrix = null;
  if (aligned) matrix = fitAffineMatrix(pairs);
  const base = matrix ? { matrix: matrix.matrix, offset: matrix.offset, curves: null } : { ...IDENTITY_LOOK };
  const afterMatrix = applyLookToPixels(base, src, count);
  const raw = histogramMatchCurves(afterMatrix, dst, count);
  const curves = { r: smoothCurve(raw.r), g: smoothCurve(raw.g), b: smoothCurve(raw.b) };
  const look = { matrix: base.matrix, offset: base.offset, curves };
  const deltaAfter = meanAbsoluteDifference(applyLookToPixels(look, src, count), dst, count);
  return { look, deltaBefore: Number(deltaBefore.toFixed(2)), deltaAfter: Number(deltaAfter.toFixed(2)), method: matrix ? 'aligned-affine' : 'histogram' };
}

export function isIdentityLook(look) {
  if (!look) return true;
  const matrix = look.matrix || IDENTITY_LOOK.matrix;
  const offset = look.offset || IDENTITY_LOOK.offset;
  for (let i = 0; i < 9; i++) if (Math.abs(matrix[i] - IDENTITY_LOOK.matrix[i]) > 1e-6) return false;
  for (let i = 0; i < 3; i++) if (Math.abs(offset[i]) > 1e-6) return false;
  if (look.curves) {
    for (const ch of ['r', 'g', 'b']) {
      const curve = look.curves[ch];
      if (!curve) continue;
      for (let v = 0; v < LUT_SIZE; v++) if (curve[v] !== v) return false;
    }
  }
  return true;
}

export function sanitizeLookForSettings(input) {
  if (!input || typeof input !== 'object') return null;
  const matrix = Array.isArray(input.matrix) || ArrayBuffer.isView(input.matrix) ? Array.from(input.matrix, Number) : IDENTITY_LOOK.matrix.slice();
  const offset = Array.isArray(input.offset) || ArrayBuffer.isView(input.offset) ? Array.from(input.offset, Number) : IDENTITY_LOOK.offset.slice();
  if (matrix.length !== 9 || offset.length !== 3 || !matrix.every(Number.isFinite) || !offset.every(Number.isFinite)) return null;
  let curves = null;
  if (input.curves && typeof input.curves === 'object') {
    curves = {};
    for (const ch of ['r', 'g', 'b']) {
      const source = input.curves[ch];
      if (!source || source.length !== LUT_SIZE) return null;
      curves[ch] = Uint8Array.from(source, (v) => clamp(Math.round(Number(v) || 0), 0, 255));
    }
  }
  const look = {
    matrix: matrix.map((v) => Number(clamp(v, -8, 8).toFixed(5))),
    offset: offset.map((v) => Number(clamp(v, -255, 255).toFixed(3))),
    curves,
    source: typeof input.source === 'string' ? input.source.slice(0, 120) : '',
    method: typeof input.method === 'string' ? input.method.slice(0, 32) : '',
    inliers: Number.isFinite(Number(input.inliers)) ? Math.max(0, Math.round(Number(input.inliers))) : 0,
    deltaBefore: Number.isFinite(Number(input.deltaBefore)) ? Number(input.deltaBefore) : null,
    deltaAfter: Number.isFinite(Number(input.deltaAfter)) ? Number(input.deltaAfter) : null
  };
  return isIdentityLook(look) ? null : look;
}
