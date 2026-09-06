// Standalone Node test for filmEdgeReader.js - run with:
// node negative2positive/src/app/filmEdgeReader.test.mjs
//
// Synthesises a 35mm strip scan (light box, orange base, two perforation
// lanes, exposed frames, edge text blocks and ISO 1007 DX edge barcodes) and
// checks geometry, decoding, orientation robustness and the negative
// controls. The real-scan verification lives in docs/film-edge-reader.md.

import assert from 'node:assert/strict';
import {
  decodeDxDataBits,
  encodeDxDataBits,
  runLengthEncode,
  findDxClocks,
  detectPerforationLanes,
  readFilmEdge,
  summarizeDxCodes,
  DX_CLOCK_PATTERN_FN,
  DX_CLOCK_PATTERN_NO_FN
} from './filmEdgeReader.js';
import { makeStrip } from '../../test-fixtures/syntheticFilmStrip.mjs';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

// --- bit level ----------------------------------------------------------------

for (const sample of [
  { dx1: 95, dx2: 7, frameNumber: 30, halfFrame: true },
  { dx1: 112, dx2: 1, frameNumber: 10, halfFrame: true },
  { dx1: 2, dx2: 0, frameNumber: 0, halfFrame: false },
  { dx1: 127, dx2: 15, frameNumber: 63, halfFrame: true },
  { dx1: 40, dx2: 9 }
]) {
  const bits = encodeDxDataBits(sample);
  assert.equal(bits.length, Number.isFinite(sample.frameNumber) ? 23 : 15);
  const decoded = decodeDxDataBits(bits);
  assert.ok(decoded, `decodes ${JSON.stringify(sample)}`);
  assert.equal(decoded.dx1, sample.dx1);
  assert.equal(decoded.dx2, sample.dx2);
  assert.equal(decoded.frameNumber, Number.isFinite(sample.frameNumber) ? sample.frameNumber : null);
  assert.equal(decoded.halfFrame, Boolean(sample.halfFrame && Number.isFinite(sample.frameNumber)));
  assert.equal(decoded.hasFrameNumber, Number.isFinite(sample.frameNumber));
}

// The published example: 1110000 / 0001 / 001010 / 1 with parity 1 -> 112-1 frame 10A.
{
  const bits = [0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0];
  const decoded = decodeDxDataBits(bits);
  assert.deepEqual({ dx1: decoded.dx1, dx2: decoded.dx2, frameNumber: decoded.frameNumber, halfFrame: decoded.halfFrame },
    { dx1: 112, dx2: 1, frameNumber: 10, halfFrame: true });
}

// Parity and separator violations are rejected.
{
  const good = encodeDxDataBits({ dx1: 95, dx2: 7, frameNumber: 31, halfFrame: false });
  const badParity = good.slice(); badParity[21] ^= 1;
  assert.equal(decodeDxDataBits(badParity), null);
  const badSeparator = good.slice(); badSeparator[8] = 1; badSeparator[21] ^= 1;
  assert.equal(decodeDxDataBits(badSeparator), null);
  assert.equal(decodeDxDataBits([0, 0, 0]), null);
  assert.equal(decodeDxDataBits(null), null);
}

// Clock pattern search over a synthetic run sequence (module = 8 px), both directions.
{
  const module = 8;
  const build = (pattern) => {
    const binary = [];
    for (let i = 0; i < 40; i++) binary.push(0);
    pattern.forEach((len, index) => { for (let k = 0; k < len * module; k++) binary.push(index % 2 === 0 ? 1 : 0); });
    for (let i = 0; i < 40; i++) binary.push(0);
    return binary;
  };
  const forward = runLengthEncode(build(DX_CLOCK_PATTERN_FN));
  const found = findDxClocks(forward, { firstValue: forward.firstValue, minModulePx: 4, maxModulePx: 16 });
  assert.equal(found.length, 1);
  assert.equal(found[0].direction, 1);
  assert.equal(found[0].hasFrameNumber, true);
  assert.ok(Math.abs(found[0].moduleSize - module) < 0.01);
  const reversed = runLengthEncode(build(DX_CLOCK_PATTERN_FN.slice().reverse()));
  const foundReversed = findDxClocks(reversed, { firstValue: reversed.firstValue, minModulePx: 4, maxModulePx: 16 });
  assert.equal(foundReversed.length, 1);
  assert.equal(foundReversed[0].direction, -1);
  const short = runLengthEncode(build(DX_CLOCK_PATTERN_NO_FN));
  const foundShort = findDxClocks(short, { firstValue: short.firstValue, minModulePx: 4, maxModulePx: 16 });
  assert.equal(foundShort.length, 1);
  assert.equal(foundShort[0].hasFrameNumber, false);
  const noise = runLengthEncode([1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1]);
  assert.equal(findDxClocks(noise, { firstValue: noise.firstValue, minModulePx: 1, maxModulePx: 16 }).length, 0);
}

// --- synthetic strip (generator shared with the smoke fixture) -------------------

function transform(image, fn, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [sx, sy] = fn(x, y);
    const si = (sy * image.width + sx) * 4;
    const di = (y * width + x) * 4;
    out[di] = image.data[si]; out[di + 1] = image.data[si + 1]; out[di + 2] = image.data[si + 2]; out[di + 3] = 255;
  }
  return new ImageData(out, width, height);
}

const frameLabel = (code) => `${code.frameNumber}${code.halfFrame ? 'A' : ''}`;

function assertDecodes(result, strip, label) {
  assert.equal(result.found, true, `${label}: perforations found`);
  assert.ok(result.dx, `${label}: dx summary present`);
  assert.equal(result.dx.dxNumber, '95-7', `${label}: dx number`);
  assert.equal(result.dx.dxExtract, 1527, `${label}: dx extract`);
  const expected = strip.codes.map(frameLabel).sort();
  const actual = result.dx.frames.map(frameLabel).sort();
  assert.deepEqual(actual, expected, `${label}: frames ${actual.join(',')} vs ${expected.join(',')}`);
  assert.equal(result.dx.votes, result.dx.total, `${label}: all codes agree`);
}

// Baseline negative strip.
const strip = makeStrip();
{
  const t0 = performance.now();
  const result = readFilmEdge(strip.image);
  const elapsed = performance.now() - t0;
  assertDecodes(result, strip, 'baseline');
  assert.equal(result.geometry.axis, 'x');
  assert.equal(result.geometry.lanes.length, 2, 'both perforation lanes');
  assert.ok(Math.abs(result.geometry.pxPerMm - strip.pxPerMm) / strip.pxPerMm < 0.03, `pxPerMm ${result.geometry.pxPerMm}`);
  assert.ok(Math.abs(result.geometry.angleDeg) < 0.3, 'level strip');
  assert.equal(result.polarity, 'dark');
  assert.ok(result.filmBase, 'rebate film base sampled');
  for (const [i, key] of ['r', 'g', 'b'].entries()) {
    assert.ok(Math.abs(result.filmBase[key] - strip.base[i]) <= 4, `film base ${key}=${result.filmBase[key]}`);
  }
  assert.ok(elapsed < 1500, `reader took ${elapsed.toFixed(0)} ms`);
  for (const code of result.dxCodes) {
    assert.equal(code.direction, 1);
    assert.ok(code.clockRows >= 2 && code.dataRows >= 2, 'decoded on several rows');
  }
}

// Orientation and scale variants of the same strip.
{
  const { width: W, height: H } = strip.image;
  const variants = {
    mirrored: transform(strip.image, (x, y) => [W - 1 - x, y], W, H),
    rotated180: transform(strip.image, (x, y) => [W - 1 - x, H - 1 - y], W, H),
    rotated90: transform(strip.image, (x, y) => [y, H - 1 - x], H, W),
    rotated270: transform(strip.image, (x, y) => [W - 1 - y, x], H, W),
    halfSize: transform(strip.image, (x, y) => [x * 2, y * 2], W >> 1, H >> 1)
  };
  for (const [label, image] of Object.entries(variants)) {
    const result = readFilmEdge(image);
    assertDecodes(result, strip, label);
    if (label.startsWith('rotated9') || label.startsWith('rotated27')) assert.equal(result.geometry.axis, 'y', `${label}: vertical lanes`);
    if (label === 'mirrored') assert.ok(result.dxCodes.every((c) => c.direction === -1), 'mirrored codes read right to left');
  }
}

// Slightly tilted strip (about 1 degree) still decodes.
{
  const { width: W, height: H } = strip.image;
  const angle = 1.0 * Math.PI / 180;
  const cos = Math.cos(angle); const sin = Math.sin(angle);
  const tilted = transform(strip.image, (x, y) => {
    const cx = x - W / 2; const cy = y - H / 2;
    const sx = Math.round(cx * cos - cy * sin + W / 2);
    const sy = Math.round(cx * sin + cy * cos + H / 2);
    return [Math.min(W - 1, Math.max(0, sx)), Math.min(H - 1, Math.max(0, sy))];
  }, W, H);
  const result = readFilmEdge(tilted);
  assert.equal(result.found, true, 'tilted: perforations found');
  assert.ok(result.dx && result.dx.dxNumber === '95-7', 'tilted: dx decoded');
  assert.ok(Math.abs(Math.abs(result.geometry.angleDeg) - 1.0) < 0.3, `tilted: angle ${result.geometry.angleDeg}`);
  assert.ok(result.dx.frames.length >= strip.codes.length - 1, 'tilted: nearly all codes decoded');
}

// Older 15-bit codes without frame numbers.
{
  const old = makeStrip({ dx: { dx1: 40, dx2: 9 } });
  // Re-encode without frame numbers by drawing our own short codes.
  const result = readFilmEdge(old.image);
  assert.equal(result.dx.dxNumber, '40-9');
}

// Positive (slide) film: black rebate with clear marks.
{
  const slide = makeStrip({ base: [14, 12, 12], frameDark: [40, 60, 90], polarity: 'light', noise: 2 });
  const result = readFilmEdge(slide.image);
  assert.equal(result.found, true, 'slide: perforations found');
  assert.ok(result.dx, 'slide: dx decoded');
  assert.equal(result.dx.dxNumber, '95-7');
  assert.equal(result.polarity, 'light');
  assert.equal(result.filmBase, null, 'no film base for a positive rebate');
  assert.deepEqual(result.dx.frames.map(frameLabel).sort(), slide.codes.map(frameLabel).sort());
}

// Negative controls: no perforations means no claim.
{
  const flat = new ImageData(new Uint8ClampedArray(600 * 400 * 4).fill(180), 600, 400);
  for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255;
  const result = readFilmEdge(flat);
  assert.equal(result.found, false);
  assert.equal(result.dx, null);
  assert.equal(detectPerforationLanes(flat), null);

  // A framed negative in a holder: orange interior, black surround, no holes.
  const holder = new ImageData(new Uint8ClampedArray(900 * 600 * 4), 900, 600);
  for (let y = 0; y < 600; y++) for (let x = 0; x < 900; x++) {
    const i = (y * 900 + x) * 4;
    const inside = x > 80 && x < 820 && y > 60 && y < 540;
    holder.data[i] = inside ? 200 + ((x * 7 + y * 3) % 40) : 8;
    holder.data[i + 1] = inside ? 130 + ((x * 5) % 30) : 8;
    holder.data[i + 2] = inside ? 80 + ((y * 5) % 30) : 8;
    holder.data[i + 3] = 255;
  }
  assert.equal(readFilmEdge(holder).found, false);
}

// Majority vote across codes.
{
  const codes = [
    { dxNumber: '95-7', dx1: 95, dx2: 7, hasFrameNumber: true, frameNumber: 3, halfFrame: false, x: 1, y: 1 },
    { dxNumber: '95-7', dx1: 95, dx2: 7, hasFrameNumber: true, frameNumber: 3, halfFrame: true, x: 2, y: 1 },
    { dxNumber: '12-3', dx1: 12, dx2: 3, hasFrameNumber: true, frameNumber: 9, halfFrame: false, x: 3, y: 1 }
  ];
  const summary = summarizeDxCodes(codes);
  assert.equal(summary.dxNumber, '95-7');
  assert.equal(summary.votes, 2);
  assert.equal(summary.total, 3);
  assert.equal(summary.frames.length, 2);
  assert.equal(summarizeDxCodes([]), null);
}

console.log('filmEdgeReader.test.mjs passed');
