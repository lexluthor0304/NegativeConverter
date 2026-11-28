// The numerical core of the dynamic range compression (dynamicRange.js):
// a complex FFT for lengths 2^a 3^b 5^c, the DCT-II pair built on it, and the
// Poisson equation with Neumann boundaries solved exactly in that basis.
//
// Written from the textbook definitions (no third-party code): the FFT is a
// recursive mixed-radix decimation in time, the DCT uses Makhoul's
// reordering (J. Makhoul, "A fast cosine transform in one and two
// dimensions", IEEE TASSP 1980), and the discrete Laplacian with reflected
// borders is diagonal in the DCT-II basis with eigenvalues
// 2 cos(pi k / N) - 2 per axis. Everything is Float64 and every loop has a
// fixed length, so a solve is the same bytes on every run.

const RADICES = [4, 2, 3, 5];

/** True when n factors into 2, 3 and 5 only. */
export function isSmoothLength(n) {
  if (!(n >= 1) || n !== Math.floor(n)) return false;
  for (const p of [2, 3, 5]) while (n % p === 0) n /= p;
  return n === 1;
}

/** The nearest length >= 1 made of 2, 3 and 5 (ties go down). */
export function nearestSmoothLength(n) {
  const target = Math.max(1, Math.round(n));
  for (let d = 0; ; d++) {
    if (target - d >= 1 && isSmoothLength(target - d)) return target - d;
    if (isSmoothLength(target + d)) return target + d;
  }
}

const plans = new Map();

function fftPlan(n) {
  let plan = plans.get(n);
  if (plan) return plan;
  if (!isSmoothLength(n)) throw new Error(`FFT length ${n} is not a product of 2, 3 and 5`);
  const factors = [];
  let rest = n;
  while (rest > 1) {
    const p = RADICES.find((radix) => rest % radix === 0);
    factors.push(p);
    rest /= p;
  }
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = -Math.sin((2 * Math.PI * k) / n);
  }
  plan = { n, factors, cos, sin, tr: new Float64Array(5), ti: new Float64Array(5) };
  plans.set(n, plan);
  return plan;
}

// out[k] = sum_j in[j] exp(-2 pi i j k / m), in read at in[off + j * stride].
function fftRec(plan, re, im, off, stride, outRe, outIm, outOff, m, depth) {
  if (m === 1) {
    outRe[outOff] = re[off];
    outIm[outOff] = im[off];
    return;
  }
  const p = plan.factors[depth];
  const sub = m / p;
  for (let r = 0; r < p; r++) {
    fftRec(plan, re, im, off + r * stride, stride * p, outRe, outIm, outOff + r * sub, sub, depth + 1);
  }
  // Combine: X[k + q sub] = sum_r W_m^{r k} Y_r[k] W_p^{r q}.
  const { cos, sin, n, tr, ti } = plan;
  const step = n / m;
  const pStep = n / p;
  for (let k = 0; k < sub; k++) {
    for (let r = 0; r < p; r++) {
      const idx = outOff + r * sub + k;
      const t = (r * k * step) % n;
      const yr = outRe[idx];
      const yi = outIm[idx];
      tr[r] = yr * cos[t] - yi * sin[t];
      ti[r] = yr * sin[t] + yi * cos[t];
    }
    for (let q = 0; q < p; q++) {
      let sr = 0;
      let si = 0;
      for (let r = 0; r < p; r++) {
        const t = ((r * q) % p) * pStep;
        sr += tr[r] * cos[t] - ti[r] * sin[t];
        si += tr[r] * sin[t] + ti[r] * cos[t];
      }
      outRe[outOff + q * sub + k] = sr;
      outIm[outOff + q * sub + k] = si;
    }
  }
}

/** Forward complex FFT of length n (2^a 3^b 5^c) into outRe/outIm. */
export function fft(re, im, outRe, outIm) {
  const n = re.length;
  fftRec(fftPlan(n), re, im, 0, 1, outRe, outIm, 0, n, 0);
}

const dctScratch = new Map();
function scratchFor(n) {
  let s = dctScratch.get(n);
  if (!s) {
    s = {
      vr: new Float64Array(n), vi: new Float64Array(n), wr: new Float64Array(n), wi: new Float64Array(n),
      cos: new Float64Array(n), sin: new Float64Array(n)
    };
    for (let k = 0; k < n; k++) {
      s.cos[k] = Math.cos((Math.PI * k) / (2 * n));
      s.sin[k] = Math.sin((Math.PI * k) / (2 * n));
    }
    dctScratch.set(n, s);
  }
  return s;
}

/**
 * DCT-II, unnormalised: X[k] = sum_n x[n] cos(pi k (2n + 1) / 2N), read from
 * src at src[off + n * stride] and written back to the same places.
 */
export function dct2InPlace(src, off, stride, n) {
  const s = scratchFor(n);
  const { vr, vi, wr, wi } = s;
  const half = (n + 1) >> 1;
  for (let j = 0; j < half; j++) vr[j] = src[off + 2 * j * stride];
  for (let j = 0; j < (n >> 1); j++) vr[n - 1 - j] = src[off + (2 * j + 1) * stride];
  vi.fill(0);
  fft(vr, vi, wr, wi);
  for (let k = 0; k < n; k++) src[off + k * stride] = wr[k] * s.cos[k] + wi[k] * s.sin[k];
}

/** The inverse of dct2InPlace (a scaled DCT-III), in place with the same addressing. */
export function idct2InPlace(src, off, stride, n) {
  const s = scratchFor(n);
  const { vr, vi, wr, wi } = s;
  // V[k] = exp(i pi k / 2N) (X[k] - i X[N - k]), X[N] = 0; v = IFFT(V); the
  // inverse FFT is the forward one on the conjugate.
  for (let k = 0; k < n; k++) {
    const xk = src[off + k * stride];
    const xnk = k === 0 ? 0 : src[off + (n - k) * stride];
    const c = s.cos[k];
    const sn = s.sin[k];
    // (c + i sn) (xk - i xnk) = (c xk + sn xnk) + i (sn xk - c xnk); conjugated for the inverse.
    vr[k] = c * xk + sn * xnk;
    vi[k] = -(sn * xk - c * xnk);
  }
  fft(vr, vi, wr, wi);
  const inv = 1 / n;
  const half = (n + 1) >> 1;
  for (let j = 0; j < half; j++) src[off + 2 * j * stride] = wr[j] * inv;
  for (let j = 0; j < (n >> 1); j++) src[off + (2 * j + 1) * stride] = wr[n - 1 - j] * inv;
}

/**
 * Solves lap(I) = f on a width x height grid with reflected (Neumann) borders,
 * where lap is the 5-point Laplacian with I[-1] = I[0] and I[n] = I[n-1].
 * f must sum to zero (a divergence with zero flux through the border does);
 * the solution has zero mean. f is a Float64Array, overwritten by I.
 */
export function solvePoissonNeumann(f, width, height) {
  for (let y = 0; y < height; y++) dct2InPlace(f, y * width, 1, width);
  for (let x = 0; x < width; x++) dct2InPlace(f, x, width, height);
  const lx = new Float64Array(width);
  const ly = new Float64Array(height);
  for (let k = 0; k < width; k++) lx[k] = 2 * Math.cos((Math.PI * k) / width) - 2;
  for (let k = 0; k < height; k++) ly[k] = 2 * Math.cos((Math.PI * k) / height) - 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const d = lx[x] + ly[y];
      f[i] = d === 0 ? 0 : f[i] / d;
    }
  }
  for (let x = 0; x < width; x++) idct2InPlace(f, x, width, height);
  for (let y = 0; y < height; y++) idct2InPlace(f, y * width, 1, width);
  return f;
}
