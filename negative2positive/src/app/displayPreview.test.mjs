import assert from 'node:assert/strict';
import { displayPreviewSize, resizeDisplayPreview } from './displayPreview.js';
globalThis.ImageData = class {
  constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4); }
};
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800 }), { width: 1200, height: 800 });
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800, dpr: 2 }), { width: 2400, height: 1600 });
assert.deepEqual(displayPreviewSize(6000, 4000, { viewportWidth: 1200, viewportHeight: 800, zoom: 2 }), { width: 2400, height: 1600 });
assert.deepEqual(displayPreviewSize(4000, 6000, { viewportWidth: 360, viewportHeight: 600, dpr: 2 }), { width: 720, height: 1080 });
assert.deepEqual(displayPreviewSize(100, 60, { dpr: 3, zoom: 10 }), { width: 100, height: 60 });
for (const dpr of [1, 2, 3]) for (const zoom of [1, 2, 8]) {
  const result = displayPreviewSize(12000, 8000, { viewportWidth: 7680, viewportHeight: 4320, dpr, zoom, maxDimension: 2048 });
  assert.ok(result.width <= 2048 && result.height <= 2048 && result.width * result.height <= 4_000_000);
}
const source = new ImageData(2, 2);
source.data.set([0, 0, 0, 0, 100, 100, 100, 100, 200, 200, 200, 200, 240, 240, 240, 240]);
assert.equal(resizeDisplayPreview(source, { width: 2, height: 2 }), source);
assert.deepEqual([...resizeDisplayPreview(source, { width: 1, height: 1 }).data], [135, 135, 135, 135]);
source.__image16 = { width: 2, height: 2, data: new Uint16Array([1, 11, 21, 65535, 101, 111, 121, 65535, 201, 211, 221, 65535, 301, 311, 321, 65535]) };
const before = source.__image16.data.slice();
const resized = resizeDisplayPreview(source, { width: 1, height: 1 });
assert.deepEqual([...resized.__image16.data], [151, 161, 171, 65535]);
assert.deepEqual([...resized.data], [1, 1, 1, 255]);
assert.deepEqual(source.__image16.data, before);
console.log('displayPreview: DPR・拡大・メモリ上限・16bit 補間・入力不変を検証');

// #259: after a dust patch, recomputing only the preview pixels whose taps
// fall in the patched rect equals rebuilding the whole preview.
{
  const { updateDisplayPreviewRect } = await import('./displayPreview.js');
  const reference = (image, target) => {
    // The implementation before the rect update was factored out (1703835).
    const output = new ImageData(target.width, target.height);
    const source16 = image.__image16?.data;
    const source = source16 || image.data;
    const data = source16 ? new Uint16Array(target.width * target.height * 4) : output.data;
    const sx = image.width / target.width, sy = image.height / target.height;
    for (let y = 0; y < target.height; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5), y0 = Math.floor(fy), y1 = Math.min(image.height - 1, y0 + 1), dy = fy - y0;
      for (let x = 0; x < target.width; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5), x0 = Math.floor(fx), x1 = Math.min(image.width - 1, x0 + 1), dx = fx - x0;
        const a = (y0 * image.width + x0) * 4, b = (y0 * image.width + x1) * 4;
        const c = (y1 * image.width + x0) * 4, d = (y1 * image.width + x1) * 4;
        const dest = (y * target.width + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          const top = source[a + ch] + (source[b + ch] - source[a + ch]) * dx;
          const bottom = source[c + ch] + (source[d + ch] - source[c + ch]) * dx;
          data[dest + ch] = Math.round(top + (bottom - top) * dy);
          if (source16) output.data[dest + ch] = Math.round(data[dest + ch] / 257);
        }
      }
    }
    if (source16) output.__image16 = { width: target.width, height: target.height, data };
    return output;
  };
  let seed = 5;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
  for (const [w, h, pw, ph, wide] of [[97, 61, 40, 25, true], [300, 200, 173, 111, false], [64, 64, 63, 1, true], [50, 40, 50, 40, false]]) {
    const image = new ImageData(w, h);
    for (let i = 0; i < image.data.length; i++) image.data[i] = next() >>> 24;
    if (wide) image.__image16 = { width: w, height: h, data: Uint16Array.from(image.data, v => v * 257 + (next() >>> 25)) };
    const preview = resizeDisplayPreview(image, { width: pw, height: ph });
    const expectedBefore = reference(image, { width: pw, height: ph });
    if (preview !== image) {
      assert.deepEqual(preview.data, expectedBefore.data, 'refactored resize is unchanged');
      if (wide) assert.deepEqual(preview.__image16.data, expectedBefore.__image16.data);
    }
    for (let n = 0; n < 12; n++) {
      const rect = { x: next() % w, y: next() % h, width: 1 + next() % 9, height: 1 + next() % 9 };
      rect.width = Math.min(rect.width, w - rect.x); rect.height = Math.min(rect.height, h - rect.y);
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          image.data[i + c] = next() >>> 24;
          if (wide) image.__image16.data[i + c] = image.data[i + c] * 257;
        }
      }
      const dirty = updateDisplayPreviewRect(image, preview, rect);
      const expected = reference(image, { width: pw, height: ph });
      if (preview === image) { assert.deepEqual(dirty, rect); continue; }
      assert.ok(!dirty || dirty.width <= Math.ceil(rect.width * pw / w) + 2, 'only a small preview rect is rewritten');
      assert.deepEqual(preview.data, expected.data, `8-bit preview after patch ${n}`);
      if (wide) assert.deepEqual(preview.__image16.data, expected.__image16.data, `16-bit preview after patch ${n}`);
    }
  }
  console.log('displayPreview: dirty-rect updates equal a full resize');
}

// #248 part 2: the table-driven kernel against HEAD's function (1703835) as
// the oracle, both planes, 16-bit and 8-bit sources, several reductions and
// odd sizes; the banded variant too.
const {
  resizeDisplayPreviewInBands, displayLevelFactor, buildDisplayLevel, buildDisplayLevelInBands,
  displayLevelGeometry, resampleDisplayLevel, filterDisplayImage, displayResampleMode,
  updateDisplayPreviewRect, displayFilterOf, runInBands
} = await import('./displayPreview.js');

function headResizeDisplayPreview(image, { width, height }) {
  if (width >= image.width && height >= image.height) return image;
  const output = new ImageData(width, height);
  const source16 = image.__image16?.data;
  const source = source16 || image.data;
  const data = source16 ? new Uint16Array(width * height * 4) : output.data;
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.max(0, (y + 0.5) * sy - 0.5);
    const y0 = Math.floor(fy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const dy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.max(0, (x + 0.5) * sx - 0.5);
      const x0 = Math.floor(fx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const dx = fx - x0;
      const a = (y0 * image.width + x0) * 4;
      const b = (y0 * image.width + x1) * 4;
      const c = (y1 * image.width + x0) * 4;
      const d = (y1 * image.width + x1) * 4;
      const dest = (y * width + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = source[a + ch] + (source[b + ch] - source[a + ch]) * dx;
        const bottom = source[c + ch] + (source[d + ch] - source[c + ch]) * dx;
        data[dest + ch] = Math.round(top + (bottom - top) * dy);
        if (source16) output.data[dest + ch] = Math.round(data[dest + ch] / 257);
      }
    }
  }
  if (source16) output.__image16 = { width, height, data };
  return output;
}

let rng = 17;
const random = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
function noiseImage(width, height, wide) {
  const image = new ImageData(width, height);
  for (let i = 0; i < image.data.length; i++) image.data[i] = Math.floor(random() * 256);
  if (wide) image.__image16 = { width, height, data: Uint16Array.from(image.data, () => Math.floor(random() * 65536)) };
  return image;
}

{
  const cases = [];
  for (const [w, h] of [[611, 409], [300, 200], [97, 61], [1024, 683]]) {
    for (const factor of [1.5, 3.9, 4.85]) cases.push([w, h, Math.max(1, Math.floor(w / factor)), Math.max(1, Math.floor(h / factor))]);
  }
  cases.push([301, 199, 173, 111], [64, 64, 63, 1], [5, 900, 3, 17], [777, 3, 101, 3]);
  for (const [w, h, tw, th] of cases) {
    for (const wide of [true, false]) {
      const image = noiseImage(w, h, wide);
      const expected = headResizeDisplayPreview(image, { width: tw, height: th });
      const actual = resizeDisplayPreview(image, { width: tw, height: th });
      assert.deepEqual(actual.data, expected.data, `8-bit plane ${w}x${h} -> ${tw}x${th} (${wide ? 16 : 8}-bit source)`);
      if (wide) assert.deepEqual(actual.__image16.data, expected.__image16.data, `16-bit plane ${w}x${h} -> ${tw}x${th}`);
      else assert.equal(actual.__image16, undefined);
      assert.equal(displayFilterOf(actual).kind, 'bilinear');
      const banded = await resizeDisplayPreviewInBands(image, { width: tw, height: th }, { budgetMs: 0.01, pause: async () => {} });
      assert.deepEqual(banded.data, expected.data, 'banded kernel equals HEAD');
      if (wide) assert.deepEqual(banded.__image16.data, expected.__image16.data);
    }
  }
  // #270: planes that do not start on a 4-byte boundary take the per-channel
  // stores instead of the word stores; the bytes are the same.
  {
    const image = noiseImage(301, 199, true);
    image.__image16.data[7] = 1234; // one pixel with a translucent alpha
    const expected = headResizeDisplayPreview(image, { width: 173, height: 111 });
    const preview = new ImageData(173, 111);
    preview.data = new Uint8ClampedArray(new ArrayBuffer(preview.data.length + 1), 1, preview.data.length);
    preview.__image16 = { width: 173, height: 111, data: new Uint16Array(new ArrayBuffer(preview.data.length * 2 + 2), 2, preview.data.length) };
    updateDisplayPreviewRect(image, preview, { x: 0, y: 0, width: 301, height: 199 });
    assert.deepEqual([...preview.data], [...expected.data], 'unaligned 8-bit plane');
    assert.deepEqual([...preview.__image16.data], [...expected.__image16.data], 'unaligned 16-bit plane');
  }
  let current = true;
  const aborted = await resizeDisplayPreviewInBands(noiseImage(400, 300, true), { width: 100, height: 75 }, {
    budgetMs: 0.001, pause: async () => { current = false; }, isCurrent: () => current
  });
  assert.equal(aborted, null, 'a band loop stops once its source is stale');

  // Speed at the cap size (60 MP in the issue; 12 MP here, the most a Node
  // test may allocate on this machine). Interleaved medians; the issue's bar is
  // 1.5x at 60 MP, measured there in a scratch script (#270: word stores and
  // the 8-bit table). The assertion leaves room for a loaded CI.
  const big = new ImageData(4242, 2828);
  big.__image16 = { width: 4242, height: 2828, data: new Uint16Array(4242 * 2828 * 4) };
  for (let i = 0; i < big.__image16.data.length; i += 7) big.__image16.data[i] = (i * 2654435761) >>> 16;
  const target = { width: 2452, height: 1630 };
  const oldTimes = [], newTimes = [];
  for (let run = 0; run < 5; run++) {
    let start = performance.now(); headResizeDisplayPreview(big, target); oldTimes.push(performance.now() - start);
    start = performance.now(); resizeDisplayPreview(big, target); newTimes.push(performance.now() - start);
  }
  const median = values => values.sort((a, b) => a - b)[values.length >> 1];
  const speedup = median(oldTimes) / median(newTimes);
  console.log(`displayPreview: 12 MP -> 2452x1630 HEAD ${median(oldTimes).toFixed(1)} ms, table-driven ${median(newTimes).toFixed(1)} ms (${speedup.toFixed(2)}x)`);
  assert.ok(speedup > 1.2, `the table-driven kernel is faster than HEAD's (${speedup.toFixed(2)}x)`);
  console.log('displayPreview: table-driven kernel byte-identical to HEAD in both planes at 1.5x/3.9x/4.85x and odd sizes');
}

// #248 part 3: the level (k x k box) and the display resample from it.
{
  assert.equal(displayLevelFactor(9536, 6336), 3, '60 MP -> k 3');
  assert.equal(displayLevelFactor(6048, 4024), 2, '24 MP -> k 2');
  assert.equal(displayLevelFactor(4000, 2672), 1, '10.7 MP -> k 1');
  assert.equal(displayLevelFactor(4800, 3200), 1, '15.4 MP -> k 1');
  assert.equal(displayLevelFactor(4898, 3265), 2, 'the 16 MP fixture sits on the boundary: its level is the cap');
  assert.equal(displayLevelFactor(800, 600), 1);
  // Never smaller than the 4 MP cap (60 MP: 3178 x 2112 >= 2453 x 1630).
  const cap = displayPreviewSize(9536, 6336, { viewportWidth: 9536, viewportHeight: 6336 });
  assert.ok(Math.floor(9536 / 3) >= cap.width && Math.floor(6336 / 3) >= cap.height);
  assert.deepEqual([Math.floor(9536 / 3), Math.floor(6336 / 3)], [3178, 2112]);

  // Box average against a direct reference, 16-bit and 8-bit sources.
  for (const wide of [true, false]) for (const k of [2, 3, 5]) {
    const image = noiseImage(47, 31, wide);
    const level = buildDisplayLevel(image, k);
    const geometry = displayLevelGeometry(level);
    assert.deepEqual(geometry, { sourceWidth: 47, sourceHeight: 31, k });
    assert.equal(level.width, Math.floor(47 / k));
    assert.equal(level.height, Math.floor(31 / k));
    const source = image.__image16?.data || image.data;
    const scale = wide ? 1 : 257;
    for (let ly = 0; ly < level.height; ly++) for (let lx = 0; lx < level.width; lx++) for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) sum += source[((ly * k + dy) * 47 + lx * k + dx) * 4 + c];
      assert.equal(level.__image16.data[(ly * level.width + lx) * 4 + c], Math.round(sum * scale / (k * k)));
    }
    const banded = await buildDisplayLevelInBands(image, k, { budgetMs: 0.001, pause: async () => {} });
    assert.deepEqual(banded.__image16.data, level.__image16.data, 'banded level equals the whole-frame level');
  }
  const small = noiseImage(10, 10, true);
  assert.equal(buildDisplayLevel(small, 1), small, 'k 1: the source is its own level');
  assert.deepEqual(displayLevelGeometry(small), { sourceWidth: 10, sourceHeight: 10, k: 1 });

  // k 1 and a reduction of at most 2x: the filter is resizeDisplayPreview itself.
  for (const [w, h, tw, th] of [[611, 409, 407, 272], [300, 200, 150, 100], [97, 61, 60, 40]]) {
    const image = noiseImage(w, h, true);
    const filtered = filterDisplayImage(image, { width: tw, height: th });
    const bilinear = headResizeDisplayPreview(image, { width: tw, height: th });
    assert.deepEqual(filtered.__image16.data, bilinear.__image16.data);
    assert.deepEqual(filtered.data, bilinear.data);
    assert.equal(displayFilterOf(filtered).kind, 'area');
  }
  assert.equal(displayResampleMode({ sourceWidth: 9536, sourceHeight: 6336, k: 3 }, { width: 1809, height: 1202 }), 'bilinear');
  assert.equal(displayResampleMode({ sourceWidth: 4000, sourceHeight: 2672, k: 1 }, { width: 1809, height: 1202 }), 'area');

  // #270: the bilinear resample from a level (k 1 and k > 1, up and down
  // to 2x, 16- and 8-bit levels) against a direct per-pixel reference with
  // the same expressions, its 8-bit plane, and row bands of it
  // (resampleDisplayLevelRows over the rows displayResampleRows names).
  {
    const { resampleDisplayLevelRows, displayResampleRows } = await import('./displayPreview.js');
    const reference = (plane, levelWidth, levelHeight, { sourceWidth, sourceHeight, k }, { width, height }) => {
      const out = new (plane instanceof Uint16Array ? Uint16Array : Uint8ClampedArray)(width * height * 4);
      const tap = (t, count, source, levelCount) => {
        const s = source / count;
        const f = k === 1 ? Math.max(0, (t + 0.5) * s - 0.5) : Math.min(levelCount - 1, Math.max(0, ((t + 0.5) * s) / k - 0.5));
        const a = Math.floor(f);
        return [a, Math.min(levelCount - 1, a + 1), f - a];
      };
      for (let ty = 0; ty < height; ty++) {
        const [y0, y1, dy] = tap(ty, height, sourceHeight, levelHeight);
        for (let tx = 0; tx < width; tx++) {
          const [x0, x1, dx] = tap(tx, width, sourceWidth, levelWidth);
          for (let c = 0; c < 4; c++) {
            const at = (x, y) => plane[(y * levelWidth + x) * 4 + c];
            const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * dx;
            const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * dx;
            out[(ty * width + tx) * 4 + c] = Math.round(top + (bottom - top) * dy);
          }
        }
      }
      return out;
    };
    for (const [w, h, k, tw, th] of [[97, 61, 1, 60, 40], [120, 90, 3, 41, 30], [120, 90, 3, 47, 37], [64, 48, 2, 70, 51], [33, 21, 3, 29, 17]]) {
      for (const wide of [true, false]) {
        const image = noiseImage(w, h, wide);
        if (wide) for (let i = 3; i < image.__image16.data.length; i += 44) image.__image16.data[i] = 31000;
        const level = k > 1 ? buildDisplayLevel(image, k) : (wide ? { width: w, height: h, __image16: image.__image16 } : image);
        const geometry = { sourceWidth: w, sourceHeight: h, k };
        const target = { width: tw, height: th };
        assert.equal(displayResampleMode(geometry, target), 'bilinear');
        const plane = level.__image16?.data || level.data;
        const expected = reference(plane, level.width, level.height, geometry, target);
        const actual = resampleDisplayLevel(level, geometry, target);
        assert.deepEqual(actual.data, expected, `bilinear ${w}x${h}/k${k} -> ${tw}x${th} (${wide ? 16 : 8}-bit)`);
        if (tw < w && th < h) {
          // The display filter of a whole image (it never enlarges).
          const filtered = filterDisplayImage(image, target, { k });
          if (filtered.__image16) {
            assert.deepEqual(filtered.__image16.data, expected, '16-bit plane of the display filter');
            assert.deepEqual([...filtered.data], [...expected].map(v => Math.round(v / 257)), 'its 8-bit plane');
          }
        }
        if (plane instanceof Uint16Array) {
          for (const [ty0, ty1] of [[0, 7], [7, Math.floor(th / 2)], [Math.floor(th / 2), th]]) {
            const [lo, hi] = displayResampleRows(geometry, target, level.height, ty0, ty1);
            const block = plane.slice(lo * level.width * 4, hi * level.width * 4);
            const band = resampleDisplayLevelRows(block, lo, level.width, level.height, geometry, target, ty0, ty1);
            assert.deepEqual(band.data, expected.subarray(ty0 * tw * 4, ty1 * tw * 4), `rows ${ty0}-${ty1} from their own block`);
          }
        }
      }
    }
  }

  // Area mode against a direct fractional-coverage average of the level.
  for (const [w, h, k, tw, th] of [[97, 61, 1, 20, 13], [120, 90, 2, 21, 16], [130, 87, 3, 9, 7]]) {
    const image = noiseImage(w, h, true);
    const level = buildDisplayLevel(image, k);
    const geometry = displayLevelGeometry(level);
    assert.equal(displayResampleMode(geometry, { width: tw, height: th }), 'area');
    const out = resampleDisplayLevel(level, geometry, { width: tw, height: th });
    const lw = level.width, lh = level.height, plane = level.__image16?.data || level.data;
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
      const x0 = tx * (w / tw) / k, x1 = Math.min(lw, (tx + 1) * (w / tw) / k);
      const y0 = ty * (h / th) / k, y1 = Math.min(lh, (ty + 1) * (h / th) / k);
      for (let c = 0; c < 4; c++) {
        let sum = 0, area = 0;
        for (let ly = Math.floor(y0); ly < Math.ceil(y1); ly++) for (let lx = Math.floor(x0); lx < Math.ceil(x1); lx++) {
          const cover = (Math.min(x1, lx + 1) - Math.max(x0, lx)) * (Math.min(y1, ly + 1) - Math.max(y0, ly));
          if (cover <= 0) continue;
          sum += cover * plane[(ly * lw + lx) * 4 + c];
          area += cover;
        }
        assert.ok(Math.abs(out.data[(ty * tw + tx) * 4 + c] - sum / area) <= 0.5 + 1e-6, `area average ${w}x${h}/k${k} at ${tx},${ty}`);
      }
    }
  }

  // A 1-px checkerboard reduced 4.85x with k = 3: the 3x3 box bounds the
  // residual at 1/18 of full scale; HEAD's 2x2 bilinear passes much of it.
  const cw = 970, ch = 679;
  const checker = new ImageData(cw, ch);
  checker.__image16 = { width: cw, height: ch, data: new Uint16Array(cw * ch * 4) };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const v = (x + y) % 2 ? 65535 : 0;
    checker.__image16.data.set([v, v, v, 65535], (y * cw + x) * 4);
  }
  const reduced = { width: Math.round(cw / 4.85), height: Math.round(ch / 4.85) };
  const deviation = (image) => {
    const plane = image.__image16.data;
    let sum = 0, sq = 0, n = 0;
    for (let i = 0; i < plane.length; i += 4) { sum += plane[i]; sq += plane[i] * plane[i]; n++; }
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sq / n - mean * mean)) / 65535;
  };
  const filteredChecker = filterDisplayImage(checker, reduced, { k: 3 });
  const bilinearChecker = headResizeDisplayPreview(checker, reduced);
  const filteredStd = deviation(filteredChecker), bilinearStd = deviation(bilinearChecker);
  console.log(`displayPreview: checkerboard at 4.85x, std ${(filteredStd * 100).toFixed(2)} % (k 3 filter) vs ${(bilinearStd * 100).toFixed(2)} % (2x2 bilinear)`);
  assert.ok(filteredStd <= 0.06, 'the area filter suppresses a 1-px checkerboard');
  assert.ok(bilinearStd > 0.1 && bilinearStd > 4 * filteredStd, 'HEAD bilinear passes much of the pattern');

  // Grain (spatially correlated noise) at the same reduction: the standard
  // deviation is within 10 % of an exact area average's.
  const gw = 970, gh = 679;
  const grain = new ImageData(gw, gh);
  grain.__image16 = { width: gw, height: gh, data: new Uint16Array(gw * gh * 4) };
  const white = Float64Array.from({ length: gw * gh }, () => random());
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    // A small grain blur (clumps of about 2 px).
    let v = 0, n = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const yy = Math.min(gh - 1, y + dy), xx = Math.min(gw - 1, x + dx);
      v += white[yy * gw + xx]; n++;
    }
    const value = Math.round(32768 + (v / n - 0.5) * 30000);
    grain.__image16.data.set([value, value, value, 65535], (y * gw + x) * 4);
  }
  const exact = resampleDisplayLevel({ width: gw, height: gh, __image16: grain.__image16 }, { sourceWidth: gw, sourceHeight: gh, k: 1 }, reduced);
  const exactStd = deviation({ __image16: { data: exact.data } });
  const grainStd = deviation(filterDisplayImage(grain, reduced, { k: 3 }));
  console.log(`displayPreview: grain at 4.85x, std ${(grainStd * 65535).toFixed(0)} (k 3 filter) vs ${(exactStd * 65535).toFixed(0)} (exact area)`);
  assert.ok(Math.abs(grainStd / exactStd - 1) <= 0.10, 'grain std within 10 % of an exact area average');

  // Region updates with the area filter equal a full rebuild (k 1 and k 3,
  // bilinear and area resamples).
  for (const [w, h, k, tw, th] of [[97, 61, 1, 30, 19], [300, 200, 3, 80, 53], [300, 200, 3, 60, 40], [211, 143, 2, 101, 68]]) {
    const image = noiseImage(w, h, true);
    const preview = filterDisplayImage(image, { width: tw, height: th }, { k });
    for (let n = 0; n < 10; n++) {
      const rect = { x: Math.floor(random() * w), y: Math.floor(random() * h), width: 1 + Math.floor(random() * 9), height: 1 + Math.floor(random() * 9) };
      rect.width = Math.min(rect.width, w - rect.x); rect.height = Math.min(rect.height, h - rect.y);
      for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
        const i = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          image.__image16.data[i + c] = Math.floor(random() * 65536);
          image.data[i + c] = image.__image16.data[i + c] >> 8;
        }
      }
      const dirty = updateDisplayPreviewRect(image, preview, rect);
      const expected = filterDisplayImage(image, { width: tw, height: th }, { k });
      assert.deepEqual(preview.__image16.data, expected.__image16.data, `area-filter region update ${w}x${h} k${k} patch ${n}`);
      assert.deepEqual(preview.data, expected.data);
      if (dirty) assert.ok(dirty.width <= Math.ceil(rect.width * tw / w) + 4, 'only a small region is rewritten');
    }
  }

  const bands = [];
  assert.equal(await runInBands(10, (a, b) => bands.push([a, b]), { budgetMs: 1e9, pause: async () => {} }), true);
  assert.deepEqual(bands.flat().filter((_, i) => i % 2 === 0)[0], 0);
  assert.equal(bands.at(-1)[1], 10);
  console.log('displayPreview: level box, area/bilinear resample, checkerboard and grain, region updates');
}
