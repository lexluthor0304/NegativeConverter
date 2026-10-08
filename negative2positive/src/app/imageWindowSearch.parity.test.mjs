// The #251 window-search rewrites (typed medians, early rejection, no
// per-step arrays, tilt check first, duplicate planes skipped) against the
// frozen HEAD search: every median, evidence score, quad list and window must
// be identical.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sampleMedian, lineEvidence, findWindowLineQuads } from './imageWindowLines.js';
import { boundaryEvidence, detectImageWindow } from './imageWindowDetector.js';
import * as reference from './imageWindowSearch.reference.mjs';
import { AUTO_FRAME_FORMAT_RATIOS } from './autoFrameFormats.js';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};

let seed = 251;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));

// Medians of the lengths the search uses, on integers and integer sums.
for (const length of [19, 31, 41, 76]) {
  for (let trial = 0; trial < 400; trial++) {
    const spread = [3, 30, 255, 765][trial % 4];
    const values = Array.from({ length }, () => randomInt(-spread, spread));
    assert.equal(sampleMedian(values), reference.median(values), `median of ${length}`);
  }
}

const make = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([...pixel(x, y), 255], (y * width + x) * 4);
  return new ImageData(data, width, height);
};
const base = [238, 160, 100], dark = [95, 55, 30];
const grain = (x, y, amount) => ((x * 13 + y * 7) % amount);
const images = {
  // A colour strip without closed contours: frames, holes, adjacent frames.
  strip: make(800, 540, (x, y) => {
    if (y < 80 || y > 460) return [245, 245, 245];
    if ((y > 105 && y < 133 || y > 409 && y < 437) && x % 48 < 18) return [245, 245, 245];
    if (y >= 150 && y <= 390 && (x >= 215 && x <= 575 || x < 195 || x > 595)) return dark.map(c => c + grain(x, y, 35));
    return base;
  }),
  // A black holder with a thin reflective rim.
  holder: make(800, 540, (x, y) => {
    if (x >= 200 && x <= 600 && y >= 130 && y <= 410) return [80 + grain(x, y, 20), 120, 180];
    if (x >= 195 && x <= 198 && y >= 130 && y <= 410) return [5, 15, 80];
    return [3, 3, 3];
  }),
  // A tilted greyscale frame (R = G = B) with a weak lower edge.
  grey: make(480, 320, (x, y) => {
    const u = x - 240 + (y - 160) * 0.05, v = y - 160 - (x - 240) * 0.05;
    const inside = Math.abs(u) < 166 && Math.abs(v) < 110;
    const value = inside ? 60 + grain(x, y, 40) : (v > 100 ? 150 : 205);
    return [value, value, value];
  }),
  // Noise only.
  noise: make(400, 300, () => [randomInt(0, 255), randomInt(0, 255), randomInt(0, 255)]),
};
const windows = { strip: [215, 150, 575, 390], holder: [200, 130, 600, 410], grey: [74, 50, 406, 270], noise: [60, 40, 340, 260] };

// lineEvidence on >= 1,000 segments: along real borders, near them, across
// them and partly outside the image.
let accepted = 0;
for (const [name, image] of Object.entries(images)) {
  const [l, t, r, b] = windows[name];
  for (let i = 0; i < 400; i++) {
    const kind = i % 4;
    const jitter = kind === 0 ? 2 : kind === 1 ? 12 : 60;
    const horizontal = random() < 0.5;
    let p, q;
    if (kind === 3) {
      p = { x: randomInt(-40, image.width + 40), y: randomInt(-40, image.height + 40) };
      q = { x: randomInt(-40, image.width + 40), y: randomInt(-40, image.height + 40) };
    } else if (horizontal) {
      const y = (random() < 0.5 ? t : b) + randomInt(-jitter, jitter);
      p = { x: l + randomInt(-jitter, jitter), y: y + random() * 4 - 2 };
      q = { x: r + randomInt(-jitter, jitter), y: y + random() * 4 - 2 };
    } else {
      const x = (random() < 0.5 ? l : r) + randomInt(-jitter, jitter);
      p = { x: x + random() * 4 - 2, y: t + randomInt(-jitter, jitter) };
      q = { x: x + random() * 4 - 2, y: b + randomInt(-jitter, jitter) };
    }
    const expected = reference.lineEvidence(image, p, q);
    if (expected > 0) accepted++;
    assert.equal(lineEvidence(image, p, q), expected, `${name} line ${JSON.stringify([p, q])}`);
  }
}
assert.ok(accepted > 50, `the comparison includes accepted borders (${accepted})`);
// The early rejection at its thresholds: a border whose 31 deltas hold
// exactly `unsupported` values below 10 and `low` below 12, in random order
// (sample j sits on column 10 j, 3 px either side of row 50).
{
  let boundary = 0;
  for (let unsupported = 8; unsupported <= 12; unsupported++) {
    for (let low = unsupported; low <= 18; low++) {
      const deltas = Array.from({ length: 31 }, (_, j) => (j < unsupported ? 9 : j < low ? 11 : 14));
      for (let i = deltas.length - 1; i > 0; i--) { const k = randomInt(0, i); [deltas[i], deltas[k]] = [deltas[k], deltas[i]]; }
      const image = make(330, 100, (x, y) => {
        const j = x / 10;
        const value = y === 53 && Number.isInteger(j) && j >= 1 && j <= 31 ? 100 + deltas[j - 1] : 100;
        return [value, value, 90];
      });
      const p = { x: 0, y: 50 }, q = { x: 320, y: 50 };
      const expected = reference.lineEvidence(image, p, q);
      if (expected > 0) boundary++;
      assert.equal(lineEvidence(image, p, q), expected, `threshold case unsupported ${unsupported}, low ${low}`);
    }
  }
  assert.ok(boundary > 5, 'threshold cases include accepted borders');
}
// A zero-length segment keeps the HEAD arithmetic (NaN normal).
assert.equal(lineEvidence(images.strip, { x: 300, y: 200 }, { x: 300, y: 200 }), reference.lineEvidence(images.strip, { x: 300, y: 200 }, { x: 300, y: 200 }));

// boundaryEvidence on >= 1,000 quads, targeted and not, with the plain,
// consistent-base and dark-holder options.
const optionSets = [{}, { consistentBase: true }, { consistentBase: true, gapRatio: .012, darkHolder: true }];
let quads = 0, found = 0;
for (const [name, image] of Object.entries(images)) {
  const [l, t, r, b] = windows[name];
  for (let i = 0; i < 250; i++) {
    const jitter = [1, 4, 15, 80][i % 4];
    const corner = (x, y) => ({ x: x + randomInt(-jitter, jitter) + random(), y: y + randomInt(-jitter, jitter) + random() });
    const points = [corner(l, t), corner(r, t), corner(r, b), corner(l, b)];
    for (const targeted of [false, true]) {
      for (const options of optionSets) {
        quads++;
        const expected = reference.boundaryEvidence(image, points, targeted, options);
        if (expected) found++;
        assert.deepEqual(boundaryEvidence(image, points, targeted, options), expected, `${name} quad ${JSON.stringify(points)}`);
      }
    }
  }
}
assert.ok(quads >= 1000 && found > 100, `boundary comparison covers accepted quads (${found} of ${quads})`);

// The whole line search and the window detector, targeted and not.
const targets = Object.entries(AUTO_FRAME_FORMAT_RATIOS).map(([key, ratio]) => ({ key, ratio }));
const findContours = cv.findContours;
try {
  // Without closed contours every image reaches the line search.
  cv.findContours = () => {};
  for (const name of ['strip', 'holder']) {
    const image = images[name];
    const src = cv.matFromImageData(image);
    try {
      assert.deepEqual(findWindowLineQuads(image, src), reference.findWindowLineQuads(image, src), `${name}: quads`);
    } finally { src.delete(); }
  }
  assert.deepEqual(detectImageWindow(images.strip, targets), reference.detectImageWindow(images.strip, targets), 'strip: window');
} finally { cv.findContours = findContours; }
for (const [name, targeted] of [['holder', false], ['holder', true], ['noise', true]]) {
  assert.deepEqual(detectImageWindow(images[name], targets, { targeted }), reference.detectImageWindow(images[name], targets, { targeted }), `${name}: window with contours (targeted ${targeted})`);
}

// R = G = B: the grey plane equals R, G and B, so one plane is searched (two
// Hough calls instead of eight) and the result is unchanged.
{
  const image = images.grey;
  const src = cv.matFromImageData(image);
  const hough = cv.HoughLines;
  let calls = 0;
  cv.HoughLines = new Proxy(hough, { apply(target, receiver, args) { calls++; return Reflect.apply(target, receiver, args); } });
  try {
    const debug = {};
    const actual = findWindowLineQuads(image, src, debug);
    assert.equal(calls, 2, 'the duplicate R, G and B planes are not searched again');
    assert.deepEqual(debug.channels, [-1]);
    calls = 0;
    const expected = reference.findWindowLineQuads(image, src);
    assert.equal(calls, 8);
    assert.deepEqual(actual, expected);
    assert.ok(expected.quads.length > 0, 'the greyscale frame yields quads');
    calls = 0;
    findWindowLineQuads(images.strip, cv.matFromImageData(images.strip), debug);
    assert.equal(calls, 8, 'colour planes are all searched');
    assert.deepEqual(debug.channels, [-1, 0, 1, 2]);
    calls = 0;
    findWindowLineQuads(images.strip, cv.matFromImageData(images.strip), debug, { channels: [-1] });
    assert.equal(calls, 2, 'an explicit channel list is honoured');
  } finally { cv.HoughLines = hough; src.delete(); }
}

console.log(`imageWindowSearch parity: medians, ${accepted} accepted of 1600 line evidences, ${found} of ${quads} boundary evidences, quads and windows equal HEAD; R=G=B searches one plane`);
