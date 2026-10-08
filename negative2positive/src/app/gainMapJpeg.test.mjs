import assert from 'node:assert/strict';
import { computeGainMap, packGainMapJpeg } from './gainMapJpeg.js';
import { listJpegSegments } from './exportMetadata.js';
import { parseTiff } from '../workers/tiffWriter.js';
import { linear, linearTable8, linearTable16 } from '../workers/gainMap.js';
const bytes = new Uint8Array([255,216,255,218,0,2,34,55,66,255,217]);
const packed = new Uint8Array(await (await packGainMapJpeg(new Blob([bytes]), new Blob([bytes]), { gainMax: 2 })).arrayBuffer());
const segments = listJpegSegments(packed), mpf = segments.find(s => s.marker === 226);
assert.equal(new TextDecoder().decode(mpf.data.subarray(0,4)), 'MPF\0');
const tags = parseTiff(mpf.data.subarray(4)).ifd0;
assert.equal(tags[0xb001].values[0], 2);
const entry = new Uint8Array(tags[0xb002].values), view = new DataView(entry.buffer);
const size = view.getUint32(4,true), offset = view.getUint32(24,true);
assert.equal(offset + 10, size);
assert.deepEqual(packed.subarray(size - (bytes.length - 2), size), bytes.subarray(2), 'primary compressed bytes unchanged');
assert.deepEqual([...packed.subarray(size,size+2)], [255,216]);
assert.match(new TextDecoder().decode(packed), /hdrgm:GainMapMax="2"/);
const sdr = { width: 4, height: 4, data: new Uint8ClampedArray(64).fill(128) };
const map = computeGainMap(sdr, { width: 4, height: 4, data: new Uint16Array(64).fill(128*257) });
assert.equal(map.data[0], 0, '16-bit precision alone must not fabricate HDR');
assert.equal(computeGainMap(sdr, null), null);

// --- Exact tables: frozen copy of the per-sample implementation (HEAD 1703835)
// is the reference. Map bytes and gainMax must be identical, not merely close.
const frozenClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const frozenLinear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const frozenLuminance = (data, i, scale) => 0.2126 * frozenLinear(data[i] / scale) + 0.7152 * frozenLinear(data[i + 1] / scale) + 0.0722 * frozenLinear(data[i + 2] / scale);
function frozenComputeGainMap(sdr, plane16, { step = 4 } = {}) {
  const width = Math.ceil(sdr.width / step), height = Math.ceil(sdr.height / step);
  if (!plane16 || plane16.width !== sdr.width || plane16.height !== sdr.height || plane16.data.length !== sdr.data.length) return null;
  const gains = new Float32Array(width * height);
  let max = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let a = 0, b = 0, count = 0;
    for (let yy = y * step; yy < Math.min((y + 1) * step, sdr.height); yy++) for (let xx = x * step; xx < Math.min((x + 1) * step, sdr.width); xx++) {
      const i = (yy * sdr.width + xx) * 4;
      a += frozenLuminance(sdr.data, i, 255); b += frozenLuminance(plane16.data, i, 65535); count++;
    }
    const gain = frozenClamp(Math.log2((b / count + 1 / 64) / (a / count + 1 / 64)), 0, 3);
    gains[y * width + x] = gain; max = Math.max(max, gain);
  }
  const gainMax = Math.max(max, 0.001);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gains.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(gains[i] / gainMax * 255); data[i * 4 + 3] = 255;
  }
  return { width, height, data, gainMax, gainMin: 0 };
}

// Every table entry is the exact double the per-sample EOTF returns.
{
  const t8 = linearTable8(), t16 = linearTable16();
  assert.ok(t8 instanceof Float64Array && t16 instanceof Float64Array, 'tables stay Float64');
  assert.equal(linearTable16(), t16, 'the 16-bit table is built once');
  for (let v = 0; v < 256; v++) assert.ok(Object.is(t8[v], frozenLinear(v / 255)), `8-bit entry ${v}`);
  for (let v = 0; v < 65536; v++) if (!Object.is(t16[v], frozenLinear(v / 65535))) assert.fail(`16-bit entry ${v}`);
  assert.ok(Object.is(linear(0.5), frozenLinear(0.5)));
}

// Deterministic pseudo-random codes (no Math.random: failures must reproduce).
function lcg(seed) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}
function frame(width, height, seed, { correlated = false } = {}) {
  const next = lcg(seed);
  const plane = new Uint16Array(width * height * 4);
  const sdr = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < plane.length; i++) {
    plane[i] = i % 4 === 3 ? 65535 : next() >>> 16;
    // A correlated SDR is the plane's high byte nudged by a level: a realistic,
    // near-identity map. Otherwise the codes are independent.
    sdr[i] = i % 4 === 3 ? 255 : correlated ? (plane[i] >>> 8) + ((next() >>> 30) - 1) : next() >>> 24;
  }
  return { sdr: { width, height, data: sdr }, plane: { width, height, data: plane } };
}
function assertSameMap(label, sdr, plane) {
  const expected = frozenComputeGainMap(sdr, plane);
  const actual = computeGainMap(sdr, plane);
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(Object.is(actual.gainMax, expected.gainMax), `${label}: gainMax ${actual.gainMax} vs ${expected.gainMax}`);
  assert.equal(actual.gainMin, expected.gainMin);
  assert.deepEqual(actual.data, expected.data, `${label}: map bytes`);
}
for (const [width, height] of [[1, 1], [5, 3], [13, 7], [4, 4], [64, 48], [37, 29]]) {
  for (const seed of [1, 2, 3]) {
    const random = frame(width, height, seed * 7919 + width);
    assertSameMap(`${width}x${height} random #${seed}`, random.sdr, random.plane);
    const near = frame(width, height, seed * 104729 + height, { correlated: true });
    assertSameMap(`${width}x${height} near-identity #${seed}`, near.sdr, near.plane);
  }
}
// Extreme codes: black, the linear-branch boundary, white.
{
  const codes = [0, 1, 10, 11, 12, 2650, 2651, 2652, 32768, 65534, 65535];
  const width = codes.length, height = 1;
  const plane = { width, height, data: new Uint16Array(width * 4) };
  const sdr = { width, height, data: new Uint8ClampedArray(width * 4) };
  codes.forEach((code, x) => { plane.data.fill(code, x * 4, x * 4 + 3); plane.data[x * 4 + 3] = 65535; sdr.data.fill(code >>> 8, x * 4, x * 4 + 3); sdr.data[x * 4 + 3] = 255; });
  assertSameMap('boundary codes', sdr, plane);
}
// Untyped inputs keep the per-sample path and the same result.
{
  const { sdr, plane } = frame(9, 6, 99);
  const loose = { width: 9, height: 6, data: Array.from(plane.data) };
  assert.deepEqual(computeGainMap(sdr, loose), frozenComputeGainMap(sdr, loose));
}
assert.equal(computeGainMap({ width: 4, height: 4, data: new Uint8ClampedArray(64) }, { width: 4, height: 3, data: new Uint16Array(48) }), null, 'size mismatch -> no map');

console.log('gain map: MPF offsets, secondary JPEG, metadata and unchanged SDR scan passed');
console.log('gain map: Float64 tables match the per-sample EOTF bit for bit');
