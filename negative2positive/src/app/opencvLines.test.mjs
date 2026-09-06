import assert from 'node:assert/strict';
import { houghLineCount } from './opencvLines.js';

const data32S = new Int32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
for (const [rows, cols] of [[3, 1], [1, 3]]) {
  assert.equal(houghLineCount({ rows, cols, data32S }), 3, '格納方向によらず全線分を処理する');
}
assert.equal(houghLineCount({ data32S: new Int32Array() }), 0);
assert.equal(houghLineCount(null), 0);
console.log('opencvLines: OpenCV 4/5 の線分配列形式を検証');
