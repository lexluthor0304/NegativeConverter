// Shareable conversion recipes: a frame's conversion settings (film mode,
// preset, colour model, paper, curves, colour controls, WB, look) without
// its geometry or file data, packed into a short URL-safe code. Deflated
// JSON, base64url, with a version prefix so a newer schema fails cleanly.
// The same code renders as a QR (qrcode-generator) in the UI.

import * as pako from 'pako';

export const RECIPE_VERSION = 1;
export const RECIPE_PREFIX = 'NC';
const HEADER = `${RECIPE_PREFIX}${RECIPE_VERSION}.`;

// Schema v1: everything the "Sync color" copy carries, plus the film mode
// and the WB gains that decide how the colour controls land. The position
// in this list is the key inside the packed payload, so the order is part
// of the schema: append new keys, never reorder or remove.
export const RECIPE_KEYS = Object.freeze([
  'filmType', 'coreFilmPreset', 'coreColorModel', 'coreEnhancedProfile', 'coreProfileStrength',
  'corePreSaturation', 'coreBrightness', 'coreExposure', 'coreContrast',
  'coreHighlights', 'coreShadows', 'coreWhites', 'coreBlacks', 'coreWbMode',
  'coreTemperature', 'coreTint', 'coreCyan', 'coreSaturation', 'coreGlow', 'coreFade',
  'corePaper', 'corePaperToning', 'corePaperToningStrength', 'look',
  'exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'tint',
  'vibrance', 'saturation', 'cyan', 'magenta', 'yellow', 'curvePoints',
  'wbR', 'wbG', 'wbB', 'wbUserOverride',
  'coreSharpenAmount', 'coreSharpenRadius', 'coreSharpenThreshold', 'positiveMode',
  // Expired-film rescue strengths; the per-frame analysis is never shared.
  'expiredEnabled', 'expiredLevels', 'expiredNeutralize', 'expiredCrossover',
  'expiredBrightness', 'expiredContrast', 'expiredUnevenFog', 'expiredLocalContrast'
]);

export const RECIPE_TAG_KEYS = Object.freeze(['stock', 'lab', 'scanner', 'note']);

export class RecipeError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'RecipeError';
    this.reason = reason;
  }
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Numbers are rounded to four decimals (the controls are integers, WB gains
// and look matrices need no more) and typed arrays become plain arrays.
function compactValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : undefined;
  if (ArrayBuffer.isView(value)) return Array.from(value, (v) => compactValue(v));
  if (Array.isArray(value)) return value.map((v) => compactValue(v) ?? null);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const c = compactValue(v);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return value;
}

// Curve points travel as [x, y] pairs per channel.
function packCurvePoints(points) {
  if (!points || typeof points !== 'object') return undefined;
  const out = {};
  for (const ch of ['r', 'g', 'b']) {
    if (Array.isArray(points[ch])) out[ch] = points[ch].map((p) => [compactValue(p.x) ?? 0, compactValue(p.y) ?? 0]);
  }
  return out;
}

function unpackCurvePoints(packed) {
  if (!packed || typeof packed !== 'object') return undefined;
  const out = {};
  for (const ch of ['r', 'g', 'b']) {
    if (Array.isArray(packed[ch])) out[ch] = packed[ch].map((p) => (Array.isArray(p) ? { x: Number(p[0]) || 0, y: Number(p[1]) || 0 } : { x: Number(p?.x) || 0, y: Number(p?.y) || 0 }));
  }
  return out;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(compactValue(a)) === JSON.stringify(compactValue(b));
  return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Math.abs(Number(a) - Number(b)) < 1e-9 : String(a) === String(b);
}

/**
 * The recipe payload for a settings object: only the recipe keys, compacted.
 * With `defaults`, values equal to the default are left out, which is what
 * keeps a typical recipe short.
 */
export function pickRecipeSettings(settings, { defaults = null } = {}) {
  const out = {};
  for (const key of RECIPE_KEYS) {
    const raw = settings?.[key];
    if (raw === undefined || raw === null) continue;
    if (defaults && Object.hasOwn(defaults, key) && sameValue(raw, defaults[key])) continue;
    const value = key === 'curvePoints' ? packCurvePoints(raw) : compactValue(raw);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function sanitizeRecipeTags(tags) {
  const source = tags && typeof tags === 'object' ? tags : {};
  const out = {};
  for (const key of RECIPE_TAG_KEYS) {
    const value = String(source[key] ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
    if (value) out[key] = value;
  }
  return out;
}

/** settings + tags -> "NC1.<base64url(deflate(json))>"; keys are packed as their schema index. */
export function encodeRecipe(settings, tags = {}, { defaults = null } = {}) {
  const picked = pickRecipeSettings(settings, { defaults });
  const packed = {};
  for (const [key, value] of Object.entries(picked)) packed[RECIPE_KEYS.indexOf(key)] = value;
  const payload = { v: RECIPE_VERSION, t: sanitizeRecipeTags(tags), s: packed };
  const bytes = pako.deflateRaw(new TextEncoder().encode(JSON.stringify(payload)), { level: 9 });
  return HEADER + base64UrlEncode(bytes);
}

/** Recognises a recipe code inside pasted text (whitespace, URLs and quotes around it are tolerated). */
export function extractRecipeCode(text) {
  const match = String(text || '').match(/NC(\d+)\.[A-Za-z0-9_-]+/);
  return match ? match[0] : '';
}

/** code -> { version, tags, settings }; throws RecipeError('format' | 'version' | 'corrupt'). */
export function decodeRecipe(text) {
  const code = extractRecipeCode(text);
  if (!code) throw new RecipeError('format', 'Not a recipe code');
  const version = Number(code.slice(RECIPE_PREFIX.length, code.indexOf('.')));
  if (!Number.isInteger(version) || version < 1) throw new RecipeError('format', 'Not a recipe code');
  if (version > RECIPE_VERSION) throw new RecipeError('version', `Recipe version ${version} is newer than this app understands`);
  let payload;
  try {
    const bytes = base64UrlDecode(code.slice(code.indexOf('.') + 1));
    payload = JSON.parse(new TextDecoder().decode(pako.inflateRaw(bytes)));
  } catch {
    throw new RecipeError('corrupt', 'The recipe code is damaged');
  }
  if (!payload || typeof payload !== 'object' || !payload.s || typeof payload.s !== 'object') throw new RecipeError('corrupt', 'The recipe code is damaged');
  const settings = {};
  for (const [packedKey, value] of Object.entries(payload.s)) {
    const key = /^\d+$/.test(packedKey) ? RECIPE_KEYS[Number(packedKey)] : (RECIPE_KEYS.includes(packedKey) ? packedKey : null);
    if (!key) continue;
    settings[key] = key === 'curvePoints' ? unpackCurvePoints(value) : value;
  }
  return { version, tags: sanitizeRecipeTags(payload.t), settings };
}

/** Keys the recipe would change on `current`: [{ key, from, to }]. */
export function recipeDiff(current, recipeSettings) {
  const changes = [];
  for (const key of RECIPE_KEYS) {
    if (!Object.hasOwn(recipeSettings, key)) continue;
    const from = current?.[key];
    const to = recipeSettings[key];
    if (!sameValue(from, to)) changes.push({ key, from: compactValue(from) ?? null, to });
  }
  return changes;
}

/** Short human label for a diff entry (numbers and names; curves as "curve"). */
export function describeRecipeChange(change) {
  const show = (value) => {
    if (value === null || value === undefined) return '–';
    if (typeof value === 'object') return change.key === 'curvePoints' ? 'curve' : change.key === 'look' ? 'look' : '…';
    return String(value);
  };
  return `${change.key}: ${show(change.from)} → ${show(change.to)}`;
}
