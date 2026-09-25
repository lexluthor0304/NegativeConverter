import assert from 'node:assert/strict';

if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(dataOrWidth, width, height) {
      if (typeof dataOrWidth === 'number') {
        this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
      } else {
        this.data = dataOrWidth; this.width = width; this.height = height;
      }
    }
  };
}

const {
  displayProxyKey, derivesEightBit, packDisplayPlane, unpackDisplayPlane, checksum32, displayPlaneHash,
  encodeDisplayProxyRecord, decodeDisplayProxyRecord, displayProxyBytes
} = await import('./displayProxy.js');
const { resizeDisplayPreview } = await import('./displayPreview.js');

function source16(width, height, { seed = 7, alpha = 65535, corners = false } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const image = new ImageData(width, height);
  const plane = new Uint16Array(width * height * 4);
  for (let i = 0; i < plane.length; i += 4) {
    for (let c = 0; c < 3; c++) { plane[i + c] = rnd() % 65536; image.data[i + c] = plane[i + c] >>> 8; }
    plane[i + 3] = alpha; image.data[i + 3] = alpha >>> 8;
  }
  if (corners) { plane[3] = 0; plane[7] = 1234; }
  image.__image16 = { width, height, data: plane };
  return image;
}

const same = (a, b, label) => {
  assert.equal(a.width, b.width, `${label}: width`);
  assert.equal(a.height, b.height, `${label}: height`);
  assert.deepEqual(Buffer.from(a.data.buffer, a.data.byteOffset, a.data.byteLength),
    Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength), `${label}: 8-bit`);
  if (a.__image16 || b.__image16) {
    assert.deepEqual(Buffer.from(a.__image16.data.buffer), Buffer.from(b.__image16.data.buffer), `${label}: 16-bit`);
  }
};

// A display preview built by resizeDisplayPreview rebuilds from its 16-bit
// plane alone, 8-bit included (Math.round(v / 257), alpha too).
{
  const source = source16(301, 197);
  const preview = resizeDisplayPreview(source, { width: 120, height: 79 });
  assert.equal(derivesEightBit(preview), true, 'resizeDisplayPreview derives its 8-bit plane');
  assert.equal(derivesEightBit(source), false, 'a decoder plane (>> 8) does not');
  const packed = packDisplayPlane(preview);
  assert.equal(packed.bits, 16);
  assert.equal(packed.channels, 3, 'opaque alpha is not stored');
  assert.equal(packed.data8, undefined, 'the 8-bit plane is rebuilt, not stored');
  assert.equal(packed.data.length, 120 * 79 * 3);
  same(unpackDisplayPlane(packed), preview, 'RGB16 round trip');

  // A crop that keeps a rotation's transparent corners keeps its alpha.
  const cornered = resizeDisplayPreview(source16(200, 150, { corners: true }), { width: 100, height: 75 });
  const withAlpha = packDisplayPlane(cornered);
  assert.equal(withAlpha.channels, 4, 'non-uniform alpha is stored');
  same(unpackDisplayPlane(withAlpha), cornered, 'RGBA16 round trip');

  // An 8-bit plane that is not derived is stored beside the 16-bit one.
  const packedSource = packDisplayPlane(source);
  assert.ok(packedSource.data8, 'decoder 8-bit plane kept');
  same(unpackDisplayPlane(packedSource), source, 'underived 8-bit round trip');

  // 8-bit-only images.
  const eight = new ImageData(9, 4);
  for (let i = 0; i < eight.data.length; i++) eight.data[i] = (i * 37) & 255;
  for (let i = 3; i < eight.data.length; i += 4) eight.data[i] = 255;
  const packed8 = packDisplayPlane(eight);
  assert.equal(packed8.bits, 8); assert.equal(packed8.channels, 3);
  same(unpackDisplayPlane(packed8), eight, 'RGB8 round trip');
  eight.data[3] = 5;
  same(unpackDisplayPlane(packDisplayPlane(eight)), eight, 'RGBA8 round trip');
}

// Records: the key, metadata, plane and sample survive; truncation,
// corruption, another version or another key read as a miss.
{
  const preview = resizeDisplayPreview(source16(160, 90, { seed: 11 }), { width: 64, height: 36 });
  const sample = { width: 8, height: 5, data: Uint16Array.from({ length: 160 }, (_, i) => i * 409) };
  const key = displayProxyKey({ id: 3, route: 'libraw16', base: { width: 160, height: 90, has16: true },
    rotationAngle: 1.3, mirrored: true, cropRegion: { left: 2, top: 3, width: 100, height: 60 },
    area: [{ x: 0.1, y: 0.1 }], target: { width: 64, height: 36, viewportWidth: 1260, viewportHeight: 880, dpr: 2, zoom: 1, maxPixels: 4e6, maxDimension: 8192 } });
  const record = encodeDisplayProxyRecord({ key, meta: { baseWidth: 160, frame: [161, 92] }, plane: packDisplayPlane(preview), sample });
  const decoded = decodeDisplayProxyRecord(record, { expectKey: key });
  assert.ok(decoded, 'record decodes');
  assert.equal(decoded.key, key);
  assert.deepEqual(decoded.meta, { baseWidth: 160, frame: [161, 92] });
  same(unpackDisplayPlane(decoded.plane), preview, 'record plane');
  assert.deepEqual(decoded.sample, sample, 'record sample');
  assert.equal(decodeDisplayProxyRecord(record, { expectKey: key + 'x' }), null, 'another key misses');
  assert.equal(decodeDisplayProxyRecord(record.slice(0, record.byteLength - 9)), null, 'a truncated record misses');
  const corrupt = record.slice(0);
  new Uint8Array(corrupt)[200] ^= 1;
  assert.equal(decodeDisplayProxyRecord(corrupt), null, 'a flipped bit fails the checksum');
  const versioned = record.slice(0);
  new DataView(versioned).setUint32(4, 99, true);
  assert.equal(decodeDisplayProxyRecord(versioned), null, 'another version misses');
  assert.equal(decodeDisplayProxyRecord(new ArrayBuffer(3)), null);
  const noSample = decodeDisplayProxyRecord(encodeDisplayProxyRecord({ key, plane: packDisplayPlane(preview) }));
  assert.equal(noSample.sample, null);
  assert.equal(displayProxyBytes(packDisplayPlane(preview), sample), 64 * 36 * 3 * 2 + 160 * 2);
}

// Every key part is a miss when it changes; the colour recipe is not a part.
{
  const base = { id: 1, route: 'libraw16', base: { width: 100, height: 80, has16: true }, rotationAngle: 0.5, mirrored: false,
    cropRegion: { left: 1, top: 2, width: 50, height: 40 }, lens: null, area: [1, 2],
    target: { width: 50, height: 40, viewportWidth: 800, viewportHeight: 600, dpr: 2, zoom: 1, maxPixels: 4e6, maxDimension: 8192 } };
  const key = displayProxyKey(base);
  assert.equal(displayProxyKey({ ...base }), key, 'stable');
  const variants = [
    { id: 2 }, { route: 'embedded' }, { base: { width: 100, height: 81, has16: true } }, { rotationAngle: 0.6 }, { mirrored: true },
    { cropRegion: { left: 1, top: 2, width: 51, height: 40 } }, { lens: 'lens' }, { area: [1, 3] },
    { target: { ...base.target, width: 51 } }, { target: { ...base.target, dpr: 1 } }
  ];
  for (const change of variants) assert.notEqual(displayProxyKey({ ...base, ...change }), key, `key part ${Object.keys(change)[0]}`);
  assert.equal(displayProxyKey({ ...base, filmType: 'bw', wbR: 2 }), key, 'recipe values are not key parts');
}

// The checksum reads unaligned views and distinguishes single bits.
{
  const bytes = Uint8Array.from({ length: 103 }, (_, i) => (i * 31) & 255);
  const unaligned = new Uint8Array(bytes.length + 1);
  unaligned.set(bytes, 1);
  assert.equal(checksum32(unaligned.subarray(1)), checksum32(bytes), 'alignment does not change the checksum');
  const flipped = bytes.slice(); flipped[50] ^= 4;
  assert.notEqual(checksum32(flipped), checksum32(bytes));
  const preview = resizeDisplayPreview(source16(40, 30), { width: 20, height: 15 });
  assert.equal(displayPlaneHash(preview), checksum32(new Uint8Array(preview.__image16.data.buffer)));
}

console.log('displayProxy: exact plane rebuild, records, checksum and key invalidation passed');
