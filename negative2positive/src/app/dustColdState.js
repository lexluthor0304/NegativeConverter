// The dust state of a cold history entry (#281). History's memory budget
// (#244) strips the oldest entries of their pixel references; above about
// 30 MP that dropped the only copies of a step's clean source and repaired
// image, and its undo detected dust again, losing the settled mask, the
// particle count and every brush refinement.
//
// A cold entry keeps its dust state compacted instead: the set pixels of the
// mask (runs of pixel indices and their bytes), the pixels where the repaired
// image differs from the clean source (runs, RGBA8 and RGBA16), and a digest
// of the clean source's 8- and 16-bit planes. Its undo rebuilds the clean
// source from the base (geometry, then conversion), checks that the frame has
// that digest, and rebuilds the mask and the repaired image from the record,
// bit for bit, without a detection. The record is about 13 bytes per masked
// pixel (1 mask byte, 4 + 8 bytes of repaired pixel) plus 8 bytes per run of
// consecutive pixels in the mask and in the repair: a few MB for a 60 MP
// frame with hundreds of specks.
//
// Every step is a generator that yields between slices of about a million
// pixels or a few MB, so the page can run it across tasks (runStepsInSlices)
// or, when something must not wait, at once (runSteps).

export const COLD_DUST_SLICE_PIXELS = 1 << 20;
const DIGEST_SLICE_BYTES = 8 * 1024 * 1024;
const COPY_SLICE_BYTES = 32 * 1024 * 1024;

const C1 = 0x239b961b, C2 = 0xab0e9789, C3 = 0x38b34ae5, C4 = 0xa1e38b93;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const fmix = (h) => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
};
const hex = (h) => {
  let out = '';
  for (let shift = 0; shift < 32; shift += 8) out += ((h >>> shift) & 0xff).toString(16).padStart(2, '0');
  return out;
};
const bytesOf = (view) => (view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength));

/**
 * MurmurHash3 x86_128 fed in pieces: the same digest as
 * `murmurHash3x86_128(all bytes, seed)` in contentHash.js, at about a quarter
 * of its cost per MB, so a 60 MP frame's 720 MB hash in about 0.2 s of slices.
 */
export function createMurmur128(seed = 0) {
  let h1 = seed | 0, h2 = seed | 0, h3 = seed | 0, h4 = seed | 0;
  let length = 0;
  const carry = new Uint8Array(16);
  let carried = 0;
  const word = (bytes, i) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
  function block(k1, k2, k3, k4) {
    k1 = Math.imul(k1, C1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, C2); h1 ^= k1;
    h1 = (h1 << 19) | (h1 >>> 13); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(k2, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C3); h2 ^= k2;
    h2 = (h2 << 17) | (h2 >>> 15); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(k3, C3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, C4); h3 ^= k3;
    h3 = (h3 << 15) | (h3 >>> 17); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(k4, C4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, C1); h4 ^= k4;
    h4 = (h4 << 13) | (h4 >>> 19); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
  }
  // The block loop over aligned words, inlined: this is the whole cost.
  function blocks(words, count) {
    let a = h1, b = h2, c = h3, d = h4;
    for (let i = 0, end = count * 4; i < end; i += 4) {
      let k1 = words[i], k2 = words[i + 1], k3 = words[i + 2], k4 = words[i + 3];
      k1 = Math.imul(k1, C1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, C2); a ^= k1;
      a = (a << 19) | (a >>> 13); a = (a + b) | 0; a = (Math.imul(a, 5) + 0x561ccd1b) | 0;
      k2 = Math.imul(k2, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C3); b ^= k2;
      b = (b << 17) | (b >>> 15); b = (b + c) | 0; b = (Math.imul(b, 5) + 0x0bcaa747) | 0;
      k3 = Math.imul(k3, C3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, C4); c ^= k3;
      c = (c << 15) | (c >>> 17); c = (c + d) | 0; c = (Math.imul(c, 5) + 0x96cd1c35) | 0;
      k4 = Math.imul(k4, C4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, C1); d ^= k4;
      d = (d << 13) | (d >>> 19); d = (d + a) | 0; d = (Math.imul(d, 5) + 0x32ac3b17) | 0;
    }
    h1 = a; h2 = b; h3 = c; h4 = d;
  }
  return {
    update(view) {
      const bytes = bytesOf(view);
      length += bytes.length;
      let offset = 0;
      if (carried) {
        const take = Math.min(16 - carried, bytes.length);
        carry.set(bytes.subarray(0, take), carried);
        carried += take;
        offset = take;
        if (carried < 16) return this;
        block(word(carry, 0), word(carry, 4), word(carry, 8), word(carry, 12));
        carried = 0;
      }
      const count = (bytes.length - offset) >>> 4;
      const start = bytes.byteOffset + offset;
      if (LITTLE_ENDIAN && start % 4 === 0) {
        blocks(new Int32Array(bytes.buffer, start, count * 4), count);
      } else {
        for (let i = 0; i < count; i++) {
          const at = offset + i * 16;
          block(word(bytes, at), word(bytes, at + 4), word(bytes, at + 8), word(bytes, at + 12));
        }
      }
      offset += count * 16;
      carried = bytes.length - offset;
      carry.set(bytes.subarray(offset), 0);
      return this;
    },
    digest() {
      // The tail and finalisation of contentHash.js.
      let k1 = 0, k2 = 0, k3 = 0, k4 = 0;
      let a = h1, b = h2, c = h3, d = h4;
      const tail = carry;
      /* eslint-disable no-fallthrough */
      switch (carried) {
        case 15: k4 ^= tail[14] << 16;
        case 14: k4 ^= tail[13] << 8;
        case 13: k4 ^= tail[12];
          k4 = Math.imul(k4, C4); k4 = (k4 << 18) | (k4 >>> 14); k4 = Math.imul(k4, C1); d ^= k4;
        case 12: k3 ^= tail[11] << 24;
        case 11: k3 ^= tail[10] << 16;
        case 10: k3 ^= tail[9] << 8;
        case 9: k3 ^= tail[8];
          k3 = Math.imul(k3, C3); k3 = (k3 << 17) | (k3 >>> 15); k3 = Math.imul(k3, C4); c ^= k3;
        case 8: k2 ^= tail[7] << 24;
        case 7: k2 ^= tail[6] << 16;
        case 6: k2 ^= tail[5] << 8;
        case 5: k2 ^= tail[4];
          k2 = Math.imul(k2, C2); k2 = (k2 << 16) | (k2 >>> 16); k2 = Math.imul(k2, C3); b ^= k2;
        case 4: k1 ^= tail[3] << 24;
        case 3: k1 ^= tail[2] << 16;
        case 2: k1 ^= tail[1] << 8;
        case 1: k1 ^= tail[0];
          k1 = Math.imul(k1, C1); k1 = (k1 << 15) | (k1 >>> 17); k1 = Math.imul(k1, C2); a ^= k1;
      }
      /* eslint-enable no-fallthrough */
      a ^= length; b ^= length; c ^= length; d ^= length;
      a = (a + b) | 0; a = (a + c) | 0; a = (a + d) | 0;
      b = (b + a) | 0; c = (c + a) | 0; d = (d + a) | 0;
      a = fmix(a); b = fmix(b); c = fmix(c); d = fmix(d);
      a = (a + b) | 0; a = (a + c) | 0; a = (a + d) | 0;
      b = (b + a) | 0; c = (c + a) | 0; d = (d + a) | 0;
      return hex(a) + hex(b) + hex(c) + hex(d);
    }
  };
}

/**
 * The digest of a frame's pixels: its size and the MurmurHash3 x86_128 of
 * its 8-bit plane and of its 16-bit plane ('-' without one), hashed in
 * slices of `sliceBytes`. Two frames with the same digest hold the same
 * pixels (an accidental 128-bit collision is negligible; the frames are not
 * adversarial).
 */
export function* frameDigestSteps(image, { sliceBytes = DIGEST_SLICE_BYTES } = {}) {
  const parts = [`${image.width}x${image.height}`];
  for (const plane of [image.data, image.__image16?.data || null]) {
    if (!plane) { parts.push('-'); continue; }
    const bytes = bytesOf(plane);
    const hasher = createMurmur128(0);
    const step = Math.max(16, sliceBytes - (sliceBytes % 16));
    for (let offset = 0; offset < bytes.length; offset += step) {
      hasher.update(bytes.subarray(offset, Math.min(bytes.length, offset + step)));
      if (offset + step < bytes.length) yield;
    }
    parts.push(hasher.digest());
  }
  return parts.join(':');
}

// Runs [start, end) of pixel indices, kept in a Uint32Array that grows.
function createRuns(maxBytes) {
  let runs = new Uint32Array(256), count = 0;
  return {
    push(start, end) {
      if ((count + 1) * 8 > maxBytes) return false;
      if (count * 2 + 2 > runs.length) {
        const next = new Uint32Array(runs.length * 2);
        next.set(runs);
        runs = next;
      }
      runs[count * 2] = start;
      runs[count * 2 + 1] = end;
      count++;
      return true;
    },
    done: () => runs.slice(0, count * 2)
  };
}

const runPixels = (runs) => {
  let total = 0;
  for (let i = 0; i < runs.length; i += 2) total += runs[i + 1] - runs[i];
  return total;
};

const int32View = (view) => (view.byteOffset % 4 === 0 && view.byteLength % 4 === 0
  ? new Int32Array(view.buffer, view.byteOffset, view.byteLength / 4) : null);

// The runs of non-zero mask bytes in [p, end), continuing an open run in
// `scan.start`; empty 32-bit words are skipped. False once the runs pass
// their cap. (Plain functions: the loops stay out of the generators.)
function scanMaskSlice(mask, words, scan, runs, p, end) {
  let start = scan.start;
  while (p < end) {
    if (start < 0) {
      if (words !== null && (p & 3) === 0) {
        let w = p >>> 2;
        const last = end >>> 2;
        while (w < last && words[w] === 0) w++;
        p = w << 2;
        if (p >= end) break;
      }
      if (mask[p] !== 0) start = p;
    } else if (mask[p] === 0) {
      if (!runs.push(start, p)) return false;
      start = -1;
    }
    p++;
  }
  scan.start = start;
  return true;
}

function* maskRunSteps(mask, slicePixels, maxBytes) {
  const runs = createRuns(maxBytes);
  const n = mask.length;
  const words = mask.byteOffset % 4 === 0 ? new Uint32Array(mask.buffer, mask.byteOffset, n >>> 2) : null;
  const scan = { start: -1 };
  for (let p = 0; p < n;) {
    const end = Math.min(n, p + slicePixels);
    if (!scanMaskSlice(mask, words, scan, runs, p, end)) return null;
    p = end;
    if (p < n) yield;
  }
  if (scan.start >= 0 && !runs.push(scan.start, n)) return null;
  return runs.done();
}

// Where two frames differ, pixel by pixel: one 32-bit word of the 8-bit
// plane and two of the 16-bit plane per pixel when the planes are aligned,
// else every byte or element.
function scanDiffSlice16(a8, b8, a16, b16, scan, runs, p, end) {
  let start = scan.start;
  for (; p < end; p++) {
    const q = p << 1;
    if (a8[p] !== b8[p] || a16[q] !== b16[q] || a16[q + 1] !== b16[q + 1]) {
      if (start < 0) start = p;
    } else if (start >= 0) {
      if (!runs.push(start, p)) return false;
      start = -1;
    }
  }
  scan.start = start;
  return true;
}

function scanDiffSlice8(a8, b8, scan, runs, p, end) {
  let start = scan.start;
  for (; p < end; p++) {
    if (a8[p] !== b8[p]) {
      if (start < 0) start = p;
    } else if (start >= 0) {
      if (!runs.push(start, p)) return false;
      start = -1;
    }
  }
  scan.start = start;
  return true;
}

function scanDiffSliceElements(a, b, p16, q16, scan, runs, p, end) {
  let start = scan.start;
  for (; p < end; p++) {
    let differs = false;
    for (let c = p * 4; c < p * 4 + 4 && !differs; c++) differs = a.data[c] !== b.data[c] || (p16 !== null && p16[c] !== q16[c]);
    if (differs) {
      if (start < 0) start = p;
    } else if (start >= 0) {
      if (!runs.push(start, p)) return false;
      start = -1;
    }
  }
  scan.start = start;
  return true;
}

// The runs of pixels where `a` and `b` differ in any 8-bit or 16-bit channel.
function* diffRunSteps(a, b, slicePixels, maxBytes) {
  const runs = createRuns(maxBytes);
  const n = a.width * a.height;
  const a8 = int32View(a.data), b8 = int32View(b.data);
  const p16 = a.__image16?.data || null, q16 = b.__image16?.data || null;
  const a16 = p16 && int32View(p16), b16 = q16 && int32View(q16);
  const words = Boolean(a8 && b8 && (!p16 || (a16 && b16)));
  const scan = { start: -1 };
  for (let p = 0; p < n;) {
    const end = Math.min(n, p + slicePixels);
    const ok = !words ? scanDiffSliceElements(a, b, p16, q16, scan, runs, p, end)
      : p16 ? scanDiffSlice16(a8, b8, a16, b16, scan, runs, p, end)
        : scanDiffSlice8(a8, b8, scan, runs, p, end);
    if (!ok) return null;
    p = end;
    if (p < n) yield;
  }
  if (scan.start >= 0 && !runs.push(scan.start, n)) return null;
  return runs.done();
}

/**
 * Compacts a dust state: `cleanSource` (the converted frame dust was
 * detected on), `mask` (one byte per pixel) and `inpaintedImageData` (null,
 * the clean source itself, or a repaired image of the same size and planes).
 * `digest` is the clean source's frameDigest when already known. Returns null
 * when the state cannot be described (sizes or planes that do not match) or
 * its record would exceed `maxBytes`.
 */
export function* compactDustSteps({ cleanSource, mask, inpaintedImageData = null }, {
  digest = null, maxBytes = Infinity, slicePixels = COLD_DUST_SLICE_PIXELS
} = {}) {
  const { width, height } = cleanSource;
  const pixels = width * height;
  if (!(mask instanceof Uint8Array) || mask.length !== pixels) return null;
  const has16 = Boolean(cleanSource.__image16?.data);
  let repaired = 'none';
  if (inpaintedImageData === cleanSource) repaired = 'clean';
  else if (inpaintedImageData) {
    if (inpaintedImageData.width !== width || inpaintedImageData.height !== height
      || inpaintedImageData.data?.length !== cleanSource.data.length
      || Boolean(inpaintedImageData.__image16?.data) !== has16
      || (has16 && inpaintedImageData.__image16.data.length !== cleanSource.__image16.data.length)) return null;
    repaired = 'own';
  }
  const cleanDigest = digest || (yield* frameDigestSteps(cleanSource));
  let bytes = 0;
  const maskRuns = yield* maskRunSteps(mask, slicePixels, maxBytes);
  if (!maskRuns) return null;
  bytes += maskRuns.byteLength + runPixels(maskRuns);
  if (bytes > maxBytes) return null;
  const maskBytes = new Uint8Array(runPixels(maskRuns));
  for (let i = 0, offset = 0, since = 0; i < maskRuns.length; i += 2) {
    const start = maskRuns[i], end = maskRuns[i + 1];
    maskBytes.set(mask.subarray(start, end), offset);
    offset += end - start;
    since += end - start;
    if (since >= slicePixels) { since = 0; yield; }
  }
  let diff = null;
  if (repaired === 'own') {
    const runs = yield* diffRunSteps(inpaintedImageData, cleanSource, slicePixels, maxBytes - bytes);
    if (!runs) return null;
    const count = runPixels(runs);
    bytes += runs.byteLength + count * (has16 ? 12 : 4);
    if (bytes > maxBytes) return null;
    const rgba8 = new Uint8ClampedArray(count * 4);
    const rgba16 = has16 ? new Uint16Array(count * 4) : null;
    const plane = has16 ? inpaintedImageData.__image16.data : null;
    for (let i = 0, offset = 0, since = 0; i < runs.length; i += 2) {
      const start = runs[i] * 4, end = runs[i + 1] * 4;
      rgba8.set(inpaintedImageData.data.subarray(start, end), offset);
      if (rgba16) rgba16.set(plane.subarray(start, end), offset);
      offset += end - start;
      since += (end - start) >>> 2;
      if (since >= slicePixels) { since = 0; yield; }
    }
    diff = { runs, rgba8, rgba16 };
  }
  return { width, height, digest: cleanDigest, has16, mask: { runs: maskRuns, bytes: maskBytes }, repaired, diff };
}

/** The bytes a record keeps in typed arrays. */
export function coldDustRecordBytes(record) {
  if (!record) return 0;
  let bytes = record.mask.runs.byteLength + record.mask.bytes.byteLength;
  if (record.diff) bytes += record.diff.runs.byteLength + record.diff.rgba8.byteLength + (record.diff.rgba16?.byteLength || 0);
  return bytes;
}

/**
 * The mask and repaired image a record describes, on `source`: a frame with
 * the record's digest, which the caller has checked. The mask is new; the
 * repaired image is `source` itself, null, or a copy of `source` (copied in
 * slices of `sliceBytes`) with the record's pixels written back.
 */
export function* rebuildDustSteps(record, source, {
  createImage = (data, width, height) => new ImageData(data, width, height),
  sliceBytes = COPY_SLICE_BYTES, slicePixels = COLD_DUST_SLICE_PIXELS
} = {}) {
  const { width, height } = record;
  if (source.width !== width || source.height !== height || Boolean(source.__image16?.data) !== record.has16) return null;
  const mask = new Uint8Array(width * height);
  const { runs: maskRuns, bytes: maskBytes } = record.mask;
  for (let i = 0, offset = 0, since = 0; i < maskRuns.length; i += 2) {
    const start = maskRuns[i], end = maskRuns[i + 1];
    mask.set(maskBytes.subarray(offset, offset + end - start), start);
    offset += end - start;
    since += end - start;
    if (since >= slicePixels) { since = 0; yield; }
  }
  if (record.repaired === 'none') return { mask, inpaintedImageData: null };
  if (record.repaired === 'clean') return { mask, inpaintedImageData: source };
  const data = new Uint8ClampedArray(source.data.length);
  const plane = record.has16 ? new Uint16Array(source.__image16.data.length) : null;
  for (const [target, from] of [[data, source.data], [plane, source.__image16?.data]]) {
    if (!target) continue;
    const step = Math.max(4, Math.floor(sliceBytes / target.BYTES_PER_ELEMENT));
    for (let offset = 0; offset < target.length; offset += step) {
      target.set(from.subarray(offset, offset + step), offset);
      yield;
    }
  }
  const { runs, rgba8, rgba16 } = record.diff;
  for (let i = 0, offset = 0, since = 0; i < runs.length; i += 2) {
    const start = runs[i] * 4, end = runs[i + 1] * 4;
    data.set(rgba8.subarray(offset, offset + end - start), start);
    if (plane) plane.set(rgba16.subarray(offset, offset + end - start), start);
    offset += end - start;
    since += (end - start) >>> 2;
    if (since >= slicePixels) { since = 0; yield; }
  }
  const image = createImage(data, width, height);
  if (plane) image.__image16 = { width, height, data: plane };
  return { mask, inpaintedImageData: image };
}

/** Runs a generator of steps to its end in this task; returns its value. */
export function runSteps(steps) {
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
  }
}

/**
 * Runs a generator of steps with `pause()` awaited between slices; resolves
 * `undefined` as soon as `isCurrent()` turns false, else the value.
 */
export async function runStepsInSlices(steps, { pause, isCurrent = () => true }) {
  for (;;) {
    const { done, value } = steps.next();
    if (done) return value;
    await pause();
    if (!isCurrent()) return undefined;
  }
}
