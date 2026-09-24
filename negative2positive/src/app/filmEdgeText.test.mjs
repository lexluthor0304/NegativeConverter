import assert from 'node:assert/strict';
import { bandMedian, edgeTextTemplate, normalizedCorrelation, readEdgeTextLine, readTextInBands } from './filmEdgeText.js';
const template = edgeTextTemplate('KODAK PORTRA   12A');
assert.equal(normalizedCorrelation(template.data, template.data), 1);
const result = readEdgeTextLine(template);
assert.equal(result.filmName, 'KODAK PORTRA');
assert.equal(result.frameNumber, '12A');
assert.equal(readEdgeTextLine(edgeTextTemplate('UNKNOWN 12')), null);
assert.equal(readEdgeTextLine(edgeTextTemplate('18    KODAK PORTRA 160')).frameNumber, '18', 'do not read the last digit or ISO as a frame');
assert.equal(readEdgeTextLine(edgeTextTemplate('KODAK PORTRA 160')).frameNumber, null);
assert.equal(readEdgeTextLine(edgeTextTemplate('KODAK PORTRA 160')).filmName, 'KODAK PORTRA 160');
const width = template.width + 20, rows = 15, values = new Float32Array(width * rows).fill(180);
for (let y = 0; y < 7; y++) for (let x = 0; x < template.width; x++) values[(y + 4) * width + x + 10] = template.data[y * template.width + x] ? 30 : 180;
assert.equal(readTextInBands([{ cols: width, rows, values }]).mirrorDetected, false);
const mirrored = new Float32Array(values.length);
for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) mirrored[y * width + x] = values[y * width + width - x - 1];
assert.equal(readTextInBands([{ cols: width, rows, values: mirrored }]).mirrorDetected, true);

// The typed-array median must equal the comparator sort it replaced (HEAD
// 1703835), including NaN-filled rectified lanes and plain-array callers.
const referenceMedian = values => {
  const finite = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  return finite.length ? finite[Math.floor(finite.length * 0.5)] : null;
};
let seed = 236;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
for (let trial = 0; trial < 400; trial++) {
  const length = trial < 6 ? trial : Math.floor(random() * 4000);
  const band = new Float32Array(length);
  const nanShare = trial % 5 === 0 ? 1 : random() * 0.6;
  for (let i = 0; i < length; i++) {
    const roll = random();
    band[i] = roll < nanShare ? NaN : roll > 0.995 ? Infinity : trial % 3 ? Math.round(random() * 255) : random() * 255;
  }
  assert.equal(bandMedian(band), referenceMedian(band), `Float32 band median, trial ${trial}`);
  const plain = Array.from(band, v => v === Infinity ? '12' : v);
  if (trial % 7 === 0) plain.push(null, undefined, 0.1 + 0.2, -Infinity);
  assert.equal(bandMedian(plain), referenceMedian(plain), `plain-array median keeps its exact doubles, trial ${trial}`);
}
// The reader still finds text in a band whose rectified rows are NaN.
const lane = new Float32Array(width * (rows + 6)).fill(NaN);
lane.set(values, width * 3);
const laneHit = readTextInBands([{ cols: width, rows: rows + 6, values: lane }]);
assert.equal(laneHit.filmName, 'KODAK PORTRA');
assert.equal(laneHit.frameNumber, '12A');
console.log('film edge text: shared templates, vocabulary, frames, mirrored reading and the typed median passed');
