import { rotatedDimensions } from './imageGeometry.js';

// The provisional window of a two-stage RAW import (#255): from the moment a
// half-size stand-in of the photo is on screen until the exact full decode is
// installed and its automatic analyses have run again. Pure helpers:
//
// - Crop units. Live state works in the stand-in's units (state.cropRegion is
//   relative to its post-mirror frame), every settings object (item.settings,
//   extractCurrentSettings, undo entries' exact geometry) in full-resolution
//   units. A saved crop is projected for display and kept exactly; a crop the
//   user draws in the window is converted to full units once.
// - Window edits. The analyses of the stand-in are held back and computed
//   again on the full decode. What the user changed in the window wins over
//   the new automatic values; everything else takes them.
// - The flag and the start of the full decode.

// The flag's value without an override (URL `twoStageMinMp`, localStorage
// `nc_two_stage_min_mp`): off until the parity criteria of #255 pass on real
// 60 MP files, then TWO_STAGE_MIN_MP_TARGET. Off keeps today's gate
// (compressed size over 100 MiB); see rawDecodePlan.
export const TWO_STAGE_MIN_MP_DEFAULT = null;
export const TWO_STAGE_MIN_MP_TARGET = 40;

/** Megapixels to pixels for rawDecodePlan; null (off) for anything else. */
export function twoStageMinPixels(value) {
  if (value === null || value === undefined || value === '' || value === 'off') return null;
  const mp = Number(value);
  return Number.isFinite(mp) && mp > 0 ? mp * 1e6 : null;
}

/**
 * Whether the full decode starts together with the stand-in, in a second
 * LibRaw worker (two WASM heaps for about 2 s), or once the stand-in's LibRaw
 * worker is gone. Only Chromium reports deviceMemory: WKWebView, WebKitGTK
 * and Safari are always sequential. `override` ('concurrent' | 'sequential')
 * is the debug switch.
 */
export function stageTwoStartMode({ deviceMemory, hardwareConcurrency, override = null } = {}) {
  if (override === 'concurrent' || override === 'sequential') return override;
  return Number(deviceMemory) >= 8 && Number(hardwareConcurrency) >= 6 ? 'concurrent' : 'sequential';
}

function cropOf(region) {
  if (!region) return null;
  return {
    left: Number(region.left ?? region.x ?? 0),
    top: Number(region.top ?? region.y ?? 0),
    width: Number(region.width),
    height: Number(region.height)
  };
}

/** The rotated (post-mirror) frame a crop of a `size` base lives in. */
export function geometryFrame(size, angle) {
  return rotatedDimensions(size.width, size.height, Number(angle) || 0);
}

/**
 * `crop` in the rotated frame of a `from` base, in the rotated frame of a `to`
 * base at the same angle: scaled per axis by the ratio of the two frames.
 * `outward` rounds the edges away from the centre (a display projection never
 * loses a pixel of the saved window); otherwise each edge rounds to the
 * nearest pixel (the one conversion of a user's crop). Mirroring flips x
 * about the frame's centre, which the per-axis scale preserves.
 */
export function projectCropRegion(crop, angle, from, to, { outward = false } = {}) {
  const rect = cropOf(crop);
  if (!rect || !from || !to) return null;
  const a = geometryFrame(from, angle);
  const b = geometryFrame(to, angle);
  const sx = b.width / a.width, sy = b.height / a.height;
  const low = outward ? Math.floor : Math.round;
  const high = outward ? Math.ceil : Math.round;
  const left = Math.max(0, low(rect.left * sx));
  const top = Math.max(0, low(rect.top * sy));
  const right = Math.min(b.width, high((rect.left + rect.width) * sx));
  const bottom = Math.min(b.height, high((rect.top + rect.height) * sy));
  if (!(right > left) || !(bottom > top)) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function sameCrop(a, b) {
  const x = cropOf(a), y = cropOf(b);
  if (!x || !y) return !x && !y;
  return x.left === y.left && x.top === y.top && x.width === y.width && x.height === y.height;
}

export function sameGeometry(a, b) {
  return Boolean(a && b) && (Number(a.rotationAngle) || 0) === (Number(b.rotationAngle) || 0)
    && Boolean(a.mirrored) === Boolean(b.mirrored) && sameCrop(a.cropRegion, b.cropRegion);
}

function geometryOf(value) {
  return {
    cropRegion: value?.cropRegion ? cropOf(value.cropRegion) : null,
    rotationAngle: Number(value?.rotationAngle) || 0,
    mirrored: Boolean(value?.mirrored)
  };
}

/**
 * Exact geometry for a provisional base (`size`, the stand-in) of a photo
 * whose full decode is `fullSize` (an estimate until the decode lands).
 *
 * - project(settings): records the settings' geometry as exact and returns
 *   the crop to install on the stand-in (never written back anywhere).
 * - installed(live): the live geometry the projection became once the chain
 *   sanitised it.
 * - exact(live): the full-resolution geometry for the live state. While it
 *   is the installed projection that is the saved geometry itself; after a
 *   window edit the live crop is converted once (at 2 px granularity) and
 *   becomes the new exact geometry.
 * - rebase(realFullSize, live): the geometry to install on the real full
 *   decode. A converted edit is converted again against the real size (the
 *   stand-in's full size may be an estimate); saved geometry is kept as is.
 * - save()/restore(): the state an undo entry carries.
 */
export function createExactGeometry({ size, fullSize }) {
  let exact = null;
  let projected = null;
  let derived = false;
  let convertedFrom = null;
  const convert = (live, to) => ({ ...geometryOf(live), cropRegion: projectCropRegion(live.cropRegion, live.rotationAngle, size, to) });
  return {
    size, fullSize,
    project(settings) {
      exact = geometryOf(settings);
      derived = false;
      convertedFrom = null;
      projected = null;
      return exact.cropRegion ? projectCropRegion(exact.cropRegion, exact.rotationAngle, fullSize, size, { outward: true }) : null;
    },
    installed(live) {
      projected = geometryOf(live);
      if (!exact) {
        exact = convert(projected, fullSize);
        derived = true;
        convertedFrom = projected;
      }
    },
    // The exact geometry of `geometry` (live units) without recording it:
    // the saved geometry when it is the installed projection, else a
    // conversion. For analysis results computed on the stand-in.
    toExact(geometry) {
      const current = geometryOf(geometry);
      if (exact && projected && sameGeometry(current, projected)) return { ...exact, cropRegion: exact.cropRegion ? { ...exact.cropRegion } : null };
      return convert(current, fullSize);
    },
    exact(live) {
      const current = geometryOf(live);
      if (!exact || !projected || !sameGeometry(current, projected)) {
        exact = convert(current, fullSize);
        derived = true;
        convertedFrom = current;
        projected = current;
      }
      return { ...exact, cropRegion: exact.cropRegion ? { ...exact.cropRegion } : null };
    },
    rebase(realFullSize, live) {
      const current = this.exact(live);
      if (!derived || !convertedFrom || !realFullSize) return current;
      return convert(convertedFrom, realFullSize);
    },
    save() {
      return { exact: exact ? geometryOf(exact) : null, projected: projected ? geometryOf(projected) : null, derived, convertedFrom: convertedFrom ? geometryOf(convertedFrom) : null };
    },
    restore(saved, live) {
      if (!saved?.exact) { exact = null; projected = null; derived = false; convertedFrom = null; this.installed(live); return; }
      exact = geometryOf(saved.exact);
      derived = Boolean(saved.derived);
      convertedFrom = saved.convertedFrom ? geometryOf(saved.convertedFrom) : null;
      projected = geometryOf(live);
    },
    get derived() { return derived; }
  };
}

// ---------------------------------------------------------------------------
// Window edits
// ---------------------------------------------------------------------------

// Settings keys that change together. A group is the user's when any of its
// `test` keys changed in the window; the whole group is then kept.
export const WINDOW_EDIT_GROUPS = Object.freeze([
  { keys: ['cropRegion', 'rotationAngle', 'mirrored', 'autoFrameMeta'], test: ['cropRegion', 'rotationAngle', 'mirrored'] },
  { keys: ['filmType', 'positiveMode', 'filmTypeSource', 'filmTypeConfidence', 'filmTypeReason'], test: ['filmType', 'positiveMode', 'filmTypeSource'] },
  { keys: ['curvePoints', 'curves'], test: ['curvePoints'] }
]);
// White balance is re-estimated by every conversion while the automatic
// estimator owns it; it is the user's only once a gray point was sampled or
// the gains were set by hand.
const WB_KEYS = ['wbR', 'wbG', 'wbB', 'wbAutoConfidence', 'wbSemanticApplied', 'wbUserOverride', 'grayPointSampled'];
// Measurements only the analyses write. They are always taken from the full
// decode (a conversion measures the expired-film analysis again).
export const AUTOMATIC_ONLY_KEYS = Object.freeze(['expiredAnalysis', 'learnedDefaults', 'filmEdge']);

export function sameSettingValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b);
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] === undefined && b[key] === undefined) continue;
    if (!sameSettingValue(a[key], b[key])) return false;
  }
  return true;
}

function wbTouched(settled, live) {
  if (Boolean(live.wbUserOverride) !== Boolean(settled.wbUserOverride)) return true;
  if (Boolean(live.grayPointSampled) !== Boolean(settled.grayPointSampled)) return true;
  if (!live.wbUserOverride && !live.grayPointSampled) return false;
  return ['wbR', 'wbG', 'wbB'].some(key => !sameSettingValue(live[key], settled[key]));
}

/**
 * The keys the user changed between `settled` (the provisional pass's final
 * settings) and `live` (now), both in full-resolution units. Grouped keys
 * come as a group; automatic-only keys never.
 */
export function windowEditKeys(settled, live) {
  if (!settled || !live) return [];
  const touched = new Set();
  const grouped = new Set([...WB_KEYS, ...AUTOMATIC_ONLY_KEYS]);
  for (const group of WINDOW_EDIT_GROUPS) {
    for (const key of group.keys) grouped.add(key);
    if (group.test.some(key => !sameSettingValue(settled[key], live[key]))) for (const key of group.keys) touched.add(key);
  }
  if (wbTouched(settled, live)) for (const key of WB_KEYS) touched.add(key);
  for (const key of new Set([...Object.keys(settled), ...Object.keys(live)])) {
    if (grouped.has(key)) continue;
    if (!sameSettingValue(settled[key], live[key])) touched.add(key);
  }
  return [...touched];
}

function cloneValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

/** The user's window edits: the touched keys with their live values. */
export function windowEdits(settled, live) {
  const edits = {};
  for (const key of windowEditKeys(settled, live)) edits[key] = cloneValue(live[key]);
  return edits;
}

/** `settings` (automatic values of the full decode) with `edits` on top. */
export function overlayWindowEdits(settings, edits) {
  if (!settings || !edits) return settings;
  const next = { ...settings };
  for (const [key, value] of Object.entries(edits)) next[key] = cloneValue(value);
  return next;
}

/** The geometry part of `edits` (a user's crop, rotation or mirror), or null. */
export function geometryEdits(edits) {
  if (!edits || !('cropRegion' in edits || 'rotationAngle' in edits || 'mirrored' in edits)) return null;
  const out = {};
  for (const key of WINDOW_EDIT_GROUPS[0].keys) if (key in edits) out[key] = cloneValue(edits[key]);
  return out;
}

export function hasWindowEdits(edits) {
  return Boolean(edits && Object.keys(edits).length);
}
