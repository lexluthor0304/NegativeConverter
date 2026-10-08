// The two-stage decode plan (#255) from TIFF/DNG headers:
// - parseImageDimensions returns the matched IFD's photometric, and its
//   rewritten IFD walk finds exactly the sizes the 1703835 parser found
//   (frozen copy below) on random IFD trees and truncated buffers;
// - readImageHeaderDimensions follows IFD offsets past the first 256 KiB with
//   a bounded number of small reads (an IFD0 at the end of the file);
// - rawDecodePlan: CFA >= 40 MP -> 2 stages whatever the byte size, CFA
//   below it, LinearRaw, iPhone DNGs and .tif -> 1, an unreadable header
//   keeps the 100 MiB rule, and so does every file while the flag is off.
// Opt-in: the repo-root RAW fixtures (gitignored) are checked when present.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseImageDimensions, readImageHeaderDimensions, rawDecodePlan, isIPhoneDngHeader, RAW_SIZE_HEAVY,
  PHOTOMETRIC_CFA, PHOTOMETRIC_LINEAR_RAW
} from './imageDimensions.js';

// ---- frozen 1703835 parser (TIFF branch), sizes only -------------------------
function valid(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Number.isSafeInteger(width * height) ? { width, height } : null;
}
function parseTiffReference(buffer, { raw = false } = {}) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 8) return null;
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) return null;
  if (view.getUint16(2, little) !== 42) return null;
  const offsets = [view.getUint32(4, little)], visited = new Set();
  let best = null;
  while (offsets.length && visited.size < 64) {
    const offset = offsets.pop();
    if (!offset || visited.has(offset) || offset + 2 > bytes.length) continue;
    visited.add(offset);
    const count = view.getUint16(offset, little);
    if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.length) continue;
    let width, height, photo;
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry, little), type = view.getUint16(entry + 2, little);
      const n = view.getUint32(entry + 4, little);
      const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
      if (!size || !n || n > 64) continue;
      const start = n * size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (start + n * size > bytes.length) continue;
      const read = j => size === 2 ? view.getUint16(start + j * size, little) : view.getUint32(start + j * size, little);
      if (tag === 256) width = read(0);
      if (tag === 257) height = read(0);
      if (tag === 262) photo = read(0);
      if (tag === 330) for (let j = 0; j < n; j++) offsets.push(read(j));
    }
    const found = valid(width, height);
    if (found && (!raw || photo === 32803 || photo === 34892)
      && (!best || found.width * found.height > best.width * best.height)) best = found;
    offsets.push(view.getUint32(offset + 2 + count * 12, little));
  }
  return best;
}
const sizeOnly = value => value ? { width: value.width, height: value.height } : null;

// ---- a small TIFF writer --------------------------------------------------------
// ifds: [{ entries: [[tag, type, values]], sub: [index...], next: index|null }];
// `order` lays the IFDs out (IFD0 is ifds[0]); `gap` bytes of padding go
// before the IFD at `gapBefore`; `head` bytes after the 8-byte header.
function buildTiff(ifds, { little = true, order = ifds.map((_, i) => i), gapBefore = -1, gap = 0, head = null, tail = 0 } = {}) {
  const sizes = ifds.map(ifd => {
    const extra = ifd.entries.reduce((sum, [, type, values]) => {
      const bytes = values.length * (type === 3 ? 2 : 4);
      return sum + (bytes > 4 ? bytes + (bytes & 1) : 0);
    }, 0) + (ifd.sub?.length > 1 ? ifd.sub.length * 4 : 0);
    return 2 + (ifd.entries.length + (ifd.sub?.length ? 1 : 0)) * 12 + 4 + extra;
  });
  const offsets = new Array(ifds.length);
  let at = 8 + (head ? head.length : 0);
  at += at & 1;
  for (const index of order) {
    if (index === gapBefore) at += gap;
    offsets[index] = at;
    at += sizes[index];
    at += at & 1;
  }
  const buffer = new ArrayBuffer(at + tail);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  bytes[0] = bytes[1] = little ? 0x49 : 0x4d;
  view.setUint16(2, 42, little);
  view.setUint32(4, offsets[0], little);
  if (head) bytes.set(head, 8);
  ifds.forEach((ifd, index) => {
    const entries = ifd.entries.map(entry => entry.slice());
    if (ifd.sub?.length) entries.push([330, 4, ifd.sub.map(i => offsets[i])]);
    entries.sort((a, b) => a[0] - b[0]);
    const base = offsets[index];
    let extraAt = base + 2 + entries.length * 12 + 4;
    view.setUint16(base, entries.length, little);
    entries.forEach(([tag, type, values], i) => {
      const entry = base + 2 + i * 12;
      const size = type === 3 ? 2 : 4;
      view.setUint16(entry, tag, little);
      view.setUint16(entry + 2, type, little);
      view.setUint32(entry + 4, values.length, little);
      let target = entry + 8;
      if (values.length * size > 4) {
        view.setUint32(entry + 8, extraAt, little);
        target = extraAt;
        extraAt += values.length * size + ((values.length * size) & 1);
      }
      values.forEach((value, j) => size === 2 ? view.setUint16(target + j * 2, value, little) : view.setUint32(target + j * 4, value, little));
    });
    view.setUint32(base + 2 + entries.length * 12, ifd.next == null ? 0 : offsets[ifd.next], little);
  });
  return buffer;
}
const image = (width, height, photometric, extra = []) => ({ entries: [[254, 4, [photometric === 2 ? 1 : 0]], [256, 4, [width]], [257, 4, [height]], [262, 3, [photometric]], ...extra] });
// A camera DNG: IFD0 a small RGB preview with SubIFDs (raw + a larger preview).
function cameraDng(width, height, photometric = PHOTOMETRIC_CFA, options = {}) {
  const ifd0 = { ...image(256, 171, 2), sub: [1, 2] };
  return buildTiff([ifd0, image(width, height, photometric), image(1920, 1280, 2)], options);
}
function fileOf(buffer, name) {
  const file = new File([buffer], name);
  const counted = { name, size: file.size, reads: [], slice(start, end) { counted.reads.push([start, end]); return file.slice(start, end); } };
  return counted;
}
// A file-like whose bytes are never materialised (size only).
function sizedFile(name, size, head) {
  return { name, size, slice: (start, end) => new Blob([head.slice(start, Math.max(start, Math.min(end, head.byteLength)))]) };
}

// ---- photometric + parity with the 1703835 walk --------------------------------
{
  const dng = cameraDng(9536, 6336);
  assert.deepEqual(parseImageDimensions(dng, { raw: true }), { width: 9536, height: 6336, photometric: PHOTOMETRIC_CFA });
  assert.deepEqual(parseImageDimensions(dng), { width: 9536, height: 6336, photometric: PHOTOMETRIC_CFA });
  const linear = cameraDng(9536, 6336, PHOTOMETRIC_LINEAR_RAW);
  assert.equal(parseImageDimensions(linear, { raw: true }).photometric, PHOTOMETRIC_LINEAR_RAW);
  const noPhoto = buildTiff([{ entries: [[256, 3, [640]], [257, 3, [480]]] }]);
  assert.deepEqual(parseImageDimensions(noPhoto), { width: 640, height: 480 }, 'no tag 262, no photometric key');
  assert.equal(parseImageDimensions(noPhoto, { raw: true }), null);
}
{
  // Random IFD trees, both byte orders, every truncation of some of them.
  let seed = 12345;
  const rand = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const photometrics = [2, 6, 32803, 34892, 1];
  let compared = 0, found = 0;
  for (let trial = 0; trial < 400; trial++) {
    const count = 1 + rand(5);
    const ifds = [];
    for (let i = 0; i < count; i++) {
      const extra = rand(3) === 0 ? [[273, 4, [1, 2, 3]]] : [];
      const ifd = image(1 + rand(20000), 1 + rand(14000), photometrics[rand(photometrics.length)], extra);
      if (rand(4) === 0) ifd.entries = ifd.entries.filter(([tag]) => tag !== 262);
      ifds.push(ifd);
    }
    for (let i = 0; i < count; i++) {
      const later = [...Array(count).keys()].filter(j => j > i);
      if (later.length && rand(2)) ifds[i].sub = later.filter(() => rand(2)).slice(0, 3);
      if (!ifds[i].sub?.length) delete ifds[i].sub;
      if (i + 1 < count && rand(3) === 0) ifds[i].next = i + 1;
    }
    const order = [...Array(count).keys()].sort(() => rand(3) - 1);
    const buffer = buildTiff(ifds, { little: Boolean(rand(2)), order, head: rand(3) === 0 ? new Uint8Array(rand(300)) : null });
    const cuts = trial % 20 === 0 ? [...Array(buffer.byteLength + 1).keys()] : [buffer.byteLength, rand(buffer.byteLength + 1)];
    for (const cut of cuts) {
      const slice = buffer.slice(0, cut);
      for (const raw of [false, true]) {
        const expected = parseTiffReference(slice, { raw });
        assert.deepEqual(sizeOnly(parseImageDimensions(slice, { raw })), expected, `trial ${trial}, cut ${cut}, raw ${raw}`);
        compared++;
        if (expected) found++;
      }
    }
  }
  assert.ok(compared > 5000 && found > 400, `parity sweep compared ${compared} headers (${found} with a size)`);
}

// ---- IFD0 past the first 256 KiB ----------------------------------------------
{
  // Like L1009967.dng: IFD0 (and its SubIFDs) written after the image data.
  const dng = cameraDng(9536, 6336, PHOTOMETRIC_CFA, { gapBefore: 0, gap: 400 * 1024, order: [0, 1, 2] });
  const head = dng.slice(0, 256 * 1024);
  assert.equal(parseImageDimensions(head, { raw: true }), null, 'the first 256 KiB hold no IFD');
  assert.deepEqual(parseImageDimensions(dng, { raw: true }), { width: 9536, height: 6336, photometric: PHOTOMETRIC_CFA }, 'the whole file is walked');
  const file = fileOf(dng, 'L1009967.dng');
  assert.deepEqual(await readImageHeaderDimensions(file, { raw: true }), { width: 9536, height: 6336, photometric: PHOTOMETRIC_CFA });
  assert.equal(file.reads[0][1] - file.reads[0][0], 256 * 1024, 'the header read first');
  assert.ok(file.reads.length <= 3, `bounded reads past the header: ${JSON.stringify(file.reads)}`);
  for (const [start, end] of file.reads.slice(1)) assert.ok(end - start <= 64 * 1024 + 4096, 'small reads');
  // A dangling IFD offset past the end: nothing found, no unbounded reads.
  const dangling = new Uint8Array(dng.slice(0, 16));
  new DataView(dangling.buffer).setUint32(4, 50_000_000, true);
  const lost = fileOf(dangling.buffer, 'lost.dng');
  assert.equal(await readImageHeaderDimensions(lost, { raw: true }), null);
  assert.equal(lost.reads.length, 1);
}

// ---- rawDecodePlan ------------------------------------------------------------------
{
  const MP40 = 40e6;
  const m11 = cameraDng(9536, 6336);
  // Compressed size is irrelevant once the header answers: a 60 MP CFA DNG of any size.
  assert.deepEqual(await rawDecodePlan(fileOf(m11, 'L1000617.DNG'), { minPixels: MP40 }),
    { stages: 2, width: 9536, height: 6336, photometric: PHOTOMETRIC_CFA });
  assert.equal((await rawDecodePlan(fileOf(m11, 'L1000617.DNG'), { buffer: m11, minPixels: MP40 })).stages, 2, 'from the whole buffer');
  assert.equal((await rawDecodePlan(fileOf(cameraDng(6048, 4024), 'frame.nef'), { minPixels: MP40 })).stages, 1, 'CFA below 40 MP');
  assert.equal((await rawDecodePlan(fileOf(cameraDng(8000, 5000), 'frame.nef'), { minPixels: MP40 })).stages, 2, 'CFA at 40 MP');
  assert.equal((await rawDecodePlan(fileOf(cameraDng(9536, 6336, PHOTOMETRIC_LINEAR_RAW), 'linear.dng'), { minPixels: MP40 })).stages, 1, 'LinearRaw never');
  assert.deepEqual(await rawDecodePlan(fileOf(m11, 'scan.tif'), { minPixels: MP40 }), { stages: 1 }, '.tif never');
  assert.deepEqual(await rawDecodePlan(fileOf(m11, 'scan.jpg'), { minPixels: MP40 }), { stages: 1 }, 'not a RAW');
  // iPhone ProRAW: the same "iPhone" text test as rawFileLoader's UTIF route.
  const iphone = cameraDng(8064, 6048, PHOTOMETRIC_CFA, { head: new TextEncoder().encode('Apple\0iPhone 15 Pro\0') });
  assert.equal(isIPhoneDngHeader(iphone), true);
  assert.equal(isIPhoneDngHeader(m11), false);
  assert.deepEqual(await rawDecodePlan(fileOf(iphone, 'IMG_0001.DNG'), { minPixels: MP40 }), { stages: 1 });
  // Unreadable header: the compressed-size rule, above and below 100 MiB.
  const garbage = new Uint8Array(4096).fill(7).buffer;
  assert.deepEqual(await rawDecodePlan(sizedFile('x.cr3', RAW_SIZE_HEAVY + 1, garbage), { minPixels: MP40 }), { stages: 2 });
  assert.deepEqual(await rawDecodePlan(sizedFile('x.cr3', RAW_SIZE_HEAVY, garbage), { minPixels: MP40 }), { stages: 1 });
  const truncated = m11.slice(0, 64);
  assert.deepEqual(await rawDecodePlan(sizedFile('cut.dng', RAW_SIZE_HEAVY + 1, truncated), { minPixels: MP40 }), { stages: 2 }, 'IFDs past a short file');
  // Flag off: today's rule for every file, parsable or not.
  for (const minPixels of [null, 0, undefined].filter(v => v !== undefined)) {
    assert.deepEqual(await rawDecodePlan(fileOf(m11, 'L1000617.DNG'), { minPixels }), { stages: 1 }, 'off: a 60 MP DNG under 100 MiB decodes once');
    assert.deepEqual(await rawDecodePlan(sizedFile('big.dng', RAW_SIZE_HEAVY + 1, m11), { minPixels }), { stages: 2 }, 'off: over 100 MiB');
    assert.deepEqual(await rawDecodePlan(sizedFile('big.tif', RAW_SIZE_HEAVY + 1, m11), { minPixels }), { stages: 1 }, 'off: TIFFs stay single');
  }
  // The debug threshold the smoke test uses (twoStageMinMp=1).
  assert.equal((await rawDecodePlan(fileOf(cameraDng(1200, 900), 'small.dng'), { minPixels: 1e6 })).stages, 2);
  // An IFD0 at the end, header only and from the buffer.
  const late = cameraDng(9536, 6336, PHOTOMETRIC_CFA, { gapBefore: 0, gap: 300 * 1024 });
  assert.equal((await rawDecodePlan(fileOf(late, 'L1009967.dng'), { minPixels: MP40 })).stages, 2);
  assert.equal((await rawDecodePlan(fileOf(late, 'L1009967.dng'), { buffer: late, minPixels: MP40 })).stages, 2);
}

// ---- opt-in: the repo-root RAW fixtures (headers only) ---------------------------
{
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const expectations = {
    'L1009967.dng': 2, '_DSC3111.NEF': 1, '_DSC5290.dng': 1,
    'DSC_4127.NEF': 1, 'DSC_8798.NEF': 1, 'DSC_8800.NEF': 1, 'DSC_8806.NEF': 1
  };
  let checked = 0;
  for (const [name, stages] of Object.entries(expectations)) {
    const path = root + name;
    if (!existsSync(path)) continue;
    const size = statSync(path).size;
    const file = {
      name, size,
      slice(start, end) {
        const from = Math.max(0, start), to = Math.min(size, end ?? size);
        return { arrayBuffer: async () => {
          const fd = openSync(path, 'r');
          try { const out = Buffer.alloc(Math.max(0, to - from)); readSync(fd, out, 0, out.length, from); return out.buffer.slice(out.byteOffset, out.byteOffset + out.length); }
          finally { closeSync(fd); }
        } };
      }
    };
    const plan = await rawDecodePlan(file, { minPixels: 40e6 });
    assert.equal(plan.stages, stages, `${name}: ${JSON.stringify(plan)}`);
    if (size < 64 * 1024 * 1024) {
      const whole = readFileSync(path);
      const buffer = whole.buffer.slice(whole.byteOffset, whole.byteOffset + whole.length);
      assert.deepEqual(await rawDecodePlan(file, { buffer, minPixels: 40e6 }), plan, `${name}: buffer and header agree`);
      assert.deepEqual(sizeOnly(parseImageDimensions(buffer, { raw: true })), parseTiffReference(buffer, { raw: true }), `${name}: parity`);
    }
    checked++;
  }
  if (checked) console.log(`  (checked ${checked} local RAW fixture headers)`);
}

console.log('Decode plan: photometric, IFD walk parity, IFDs past 256 KiB, CFA/linear/iPhone/TIFF/unknown gating and the off switch passed');
