const PIXEL_MAX_16 = 65535;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeFilmBase(base) {
  if (!base || typeof base !== 'object') return null;

  const r16 = Number(base.r16);
  const g16 = Number(base.g16);
  const b16 = Number(base.b16);
  if (Number.isFinite(r16) && Number.isFinite(g16) && Number.isFinite(b16)) {
    return {
      r: clamp(Math.round(r16), 1, PIXEL_MAX_16),
      g: clamp(Math.round(g16), 1, PIXEL_MAX_16),
      b: clamp(Math.round(b16), 1, PIXEL_MAX_16),
    };
  }

  const r = Number(base.r);
  const g = Number(base.g);
  const b = Number(base.b);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
  return {
    r: clamp(Math.round(r * 257), 1, PIXEL_MAX_16),
    g: clamp(Math.round(g * 257), 1, PIXEL_MAX_16),
    b: clamp(Math.round(b * 257), 1, PIXEL_MAX_16),
  };
}

function normalizeMethod(method) {
  return method === 'linear' ? 'linear' : 'density';
}

export function computeFilmBaseGains(base, options = {}) {
  const safeBase = sanitizeFilmBase(base);
  if (!safeBase) return null;

  const method = normalizeMethod(options.method);
  const strength = clamp(finiteNumber(options.strength, 1), 0, 1.5);
  let target;

  if (method === 'linear') {
    target = (safeBase.r + safeBase.g + safeBase.b) / 3;
  } else {
    const rT = safeBase.r / PIXEL_MAX_16;
    const gT = safeBase.g / PIXEL_MAX_16;
    const bT = safeBase.b / PIXEL_MAX_16;
    target = Math.exp((Math.log(rT) + Math.log(gT) + Math.log(bT)) / 3) * PIXEL_MAX_16;
  }

  if (!Number.isFinite(target) || target <= 0) return null;

  return {
    r: clamp(Math.pow(target / safeBase.r, strength), 0.25, 4),
    g: clamp(Math.pow(target / safeBase.g, strength), 0.25, 4),
    b: clamp(Math.pow(target / safeBase.b, strength), 0.25, 4),
    method,
    strength
  };
}

export function applyFilmBaseCompensationToBuffer(data, base, options = {}) {
  const gains = computeFilmBaseGains(base, options);
  if (!gains) return null;

  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(Math.round(data[i] * gains.r), 0, PIXEL_MAX_16);
    data[i + 1] = clamp(Math.round(data[i + 1] * gains.g), 0, PIXEL_MAX_16);
    data[i + 2] = clamp(Math.round(data[i + 2] * gains.b), 0, PIXEL_MAX_16);
  }

  return gains;
}
