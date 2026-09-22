import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getAnalyzerContext, detectFrameCandidatesWithCv } from './autoFrameAnalyzer.js';
import { lineEvidence } from './imageWindowLines.js';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
const width = 640, height = 480;
const data = new Uint8ClampedArray(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const inside = x > 115 && x < 525 && y > 95 && y < 375;
  const grain = (x * 13 + y * 23) % 27;
  data.set(inside ? [90 + grain, 50 + grain, 30 + grain, 255] : [238, 160, 100, 255], (y * width + x) * 4);
}
const image = { width, height, data };
const context = getAnalyzerContext({ settings: { formatPreference: '135', filmType: 'color' } });
context.reusablePreview = image;
detectFrameCandidatesWithCv(image, context, { minAreaRatio: .04 });
assert.equal(context.previewEdges.length, width * height, 'only one byte per preview pixel is cached');
const density = context.previewDensityCandidates;
assert.ok(Array.isArray(density));
let preparations = 0;
const morphology = cv.morphologyEx;
cv.morphologyEx = new Proxy(morphology, { apply(target, receiver, args) { preparations++; return Reflect.apply(target, receiver, args); } });
let reused, fresh;
try {
  reused = detectFrameCandidatesWithCv(image, context, { minAreaRatio: .04, retrievalMode: 'external' });
  assert.equal(preparations, 0, 'zero-angle pass skips repeated morphological preparation');
  assert.equal(context.previewDensityCandidates, density, 'completed density candidates reused');
  fresh = detectFrameCandidatesWithCv(image, getAnalyzerContext({ settings: { formatPreference: '135', filmType: 'color' } }), { minAreaRatio: .04, retrievalMode: 'external' });
  assert.equal(preparations, 2, 'uncached comparison executes both morphology passes');
  assert.deepEqual(reused, fresh, 'external contours, scores, order and density results remain exact');
  const rotated = { ...image, data: data.slice() };
  detectFrameCandidatesWithCv(rotated, context, { minAreaRatio: .04, retrievalMode: 'external' });
  assert.equal(preparations, 4, 'another image cannot reuse the zero-angle pixels');
  assert.equal(context.previewDensityCandidates, density, 'rotation candidates do not grow the cache');
} finally { cv.morphologyEx = morphology; }

// Independent pre-optimization evidence formula. Every successful score and
// every rejection must remain identical after moving cheap rejection earlier.
function referenceEvidence(image, p, q) {
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const sample = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    return Array.from(image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));
  };
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  const nx = -(q.y - p.y) / length, ny = (q.x - p.x) / length;
  const gap = Math.max(3, Math.min(image.width, image.height) * .004);
  const a = [], b = [], deltas = [];
  for (let j = 1; j < 32; j++) {
    const t = j / 32, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    const inside = sample(x + nx * gap, y + ny * gap), outside = sample(x - nx * gap, y - ny * gap);
    if (!inside || !outside) return 0;
    a.push(inside); b.push(outside);
    deltas.push(Math.max(...inside.map((v, c) => Math.abs(v - outside[c]))));
  }
  const variation = pixels => {
    const color = [0, 1, 2].map(c => median(pixels.map(p => p[c])));
    return median(pixels.map(p => Math.max(...p.map((v, c) => Math.abs(v - color[c])))));
  };
  const contrast = median(deltas), support = deltas.filter(d => d >= 10).length / deltas.length;
  const clean = Math.min(variation(a), variation(b));
  if (contrast < 12 || support < .65 || clean > 18) return 0;
  return support * .5 + Math.min(contrast / 80, 1) * .25 + (1 - clean / 24) * .25;
}
let positive = 0;
for (let i = 0; i < 600; i++) {
  const p = { x: 110 + i % 21, y: 90 + i % 11 }, q = { x: 510 + i % 31, y: 90 + i % 11 };
  const expected = referenceEvidence(image, p, q);
  if (expected > 0) positive++;
  assert.equal(lineEvidence(image, p, q), expected);
}
assert.ok(positive > 0, 'comparison includes accepted borders');
let sorts = 0;
const sort = Array.prototype.sort;
Array.prototype.sort = function (...args) { sorts++; return sort.apply(this, args); };
try {
  assert.equal(lineEvidence(image, { x: 100, y: 35 }, { x: 530, y: 35 }), 0);
  assert.equal(sorts, 1, 'flat non-border skips the eight base-variation sorts');
} finally { Array.prototype.sort = sort; }
console.log('autoFrame performance: exact cached candidates, bounded reuse, no cross-image reuse and equivalent early rejection passed');
