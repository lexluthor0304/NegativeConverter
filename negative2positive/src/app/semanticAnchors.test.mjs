import assert from 'node:assert/strict';
import { sanitizeSemanticMap, semanticNeutralWeight } from './semanticAnchors.js';
import { estimateAutoWhiteBalance } from './autoWhiteBalance.js';
const image = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
const labels = [];
for (let i = 0; i < 4096; i++) { const neutral = i % 64 < 24; labels.push(neutral ? 11 : 4); image.data.set(neutral ? [100, 120, 100, 255] : [75, 150, 70, 255], i * 4); }
const map = { width: 64, height: 64, labels, confidence: 0.9 };
const result = estimateAutoWhiteBalance(image, { anchors: map });
assert.equal(result.anchored, true);
const statistical = estimateAutoWhiteBalance(image);
assert.ok(Math.abs(100 * result.wbR - 120) < Math.abs(100 * statistical.wbR - 120), 'anchoring should improve the known neutral instead of damping back toward the cast');
assert.ok(result.wbR > 1.1 && result.wbR < 1.3);
assert.equal(semanticNeutralWeight(4), 0);
assert.equal(semanticNeutralWeight(12), 0);
assert.equal(semanticNeutralWeight(11), 3);
assert.equal(sanitizeSemanticMap({ ...map, width: 65 }), null);
assert.equal(sanitizeSemanticMap({ ...map, labels: [4] }), null);
assert.deepEqual(estimateAutoWhiteBalance(image, { anchors: { invalid: true } }), estimateAutoWhiteBalance(image));
console.log('semantic anchors: class exclusion, conservative neutral correction and fallback passed');
