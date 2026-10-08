// Exact cache keys for settings arrays that carry curve LUTs.
//
// JSON.stringify writes a Uint8Array(256) as an index-keyed object, about
// 3 KB per LUT, and every settings object carries three. The photo-session,
// preview-cache and filmstrip keys only need equality, so each exact
// { r, g, b } Uint8Array triple under `curves` in the first `lutSlots`
// values is replaced by null through an object spread (which keeps the key
// order) and its bytes are appended after a raw U+0000, after their lengths.
//
// JSON never emits a raw U+0000, so the JSON part ends at the first one and a
// key without replaced LUTs (plain JSON, as before) can never equal a key
// with them. The slot mask records which `curves` were replaced, so a native
// `curves: null` cannot collide with a replaced one. Two keys are equal only
// when the plain JSON of the same values would be equal; typed arrays with
// expando properties are not expected anywhere in the settings.
//
// Deliberately no memoisation: the key gates warm-session and preview-cache
// reuse, and curve LUTs are rewritten in place (updateCurveFromPoints).

const MAX_INLINE_LUT = 1024;
// Scratch for the LUT bytes of one key, read back two bytes per UTF-16 code
// unit. String.fromCharCode maps every code unit (lone surrogates included)
// to itself, so the bytes stay recoverable; the byte order only has to be
// stable within the session, since keys are never persisted. The units go
// through a plain array because apply() takes its fast path only for those.
let packed = new Uint8Array(6 * 256);
let packedUnits = new Uint16Array(packed.buffer);
const unitArrays = new Map();

function unitArray(length) {
  let units = unitArrays.get(length);
  if (!units) {
    if (unitArrays.size >= 8) unitArrays.clear();
    units = new Array(length).fill(0);
    unitArrays.set(length, units);
  }
  return units;
}

function isLut(value) {
  return value !== null && typeof value === 'object'
    && Object.getPrototypeOf(value) === Uint8Array.prototype && value.length <= MAX_INLINE_LUT;
}

function isLutTriple(curves) {
  if (!curves || typeof curves !== 'object' || Object.getPrototypeOf(curves) !== Object.prototype) return false;
  let count = 0;
  for (const key in curves) {
    if (key !== (count === 0 ? 'r' : count === 1 ? 'g' : count === 2 ? 'b' : '')) return false;
    count++;
  }
  return count === 3 && isLut(curves.r) && isLut(curves.g) && isLut(curves.b);
}

export function exactSettingsKey(values, lutSlots = 1) {
  let mask = 0;
  let replaced = values;
  const triples = [];
  for (let slot = 0; slot < lutSlots && slot < values.length; slot++) {
    const value = values[slot];
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
      || Object.hasOwn(value, 'toJSON') || !isLutTriple(value.curves)) continue;
    if (replaced === values) replaced = values.slice();
    replaced[slot] = { ...value, curves: null };
    mask |= 1 << slot;
    triples.push(value.curves.r, value.curves.g, value.curves.b);
  }
  const json = JSON.stringify(replaced);
  if (!mask) return json;
  let lengths = '';
  let size = 0;
  for (const lut of triples) { lengths += `${lut.length},`; size += lut.length; }
  if (packed.length < size + 1) {
    packed = new Uint8Array((size >> 1) * 2 + 2);
    packedUnits = new Uint16Array(packed.buffer);
  }
  let offset = 0;
  for (const lut of triples) { packed.set(lut, offset); offset += lut.length; }
  if (offset & 1) packed[offset++] = 0;
  const units = unitArray(offset >> 1);
  for (let i = 0; i < units.length; i++) units[i] = packedUnits[i];
  return `${json}\u0000${mask}:${lengths}:${String.fromCharCode.apply(null, units)}`;
}
