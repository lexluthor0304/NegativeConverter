import assert from 'node:assert/strict';
import { DEFAULT_FILE_LIST_SORT, normalizeFileListSort, orderedFileIndices, selectionRangeIndices } from './fileListOrder.js';

const item = (name, lastModified) => ({ file: { name, lastModified } });

assert.equal(DEFAULT_FILE_LIST_SORT, 'modified-desc');
for (const mode of ['modified-desc', 'modified-asc', 'name-asc', 'name-desc']) {
  assert.equal(normalizeFileListSort(mode), mode);
}
for (const invalid of [undefined, null, '', 'name', 'MODIFIED-DESC', 0, {}, ['name-asc']]) {
  assert.equal(normalizeFileListSort(invalid), DEFAULT_FILE_LIST_SORT);
}

const dates = [item('z', 200), item('a', 100), item('b', 200), item('c', 300)];
assert.deepEqual(orderedFileIndices(dates), [3, 0, 2, 1]);
assert.deepEqual(orderedFileIndices(dates, 'invalid'), [3, 0, 2, 1]);
assert.deepEqual(orderedFileIndices(dates, 'modified-asc'), [1, 0, 2, 3]);
assert.deepEqual(orderedFileIndices([item('z', 200), item('a', 200)]), [0, 1],
  'equal dates retain import order rather than falling back to filename order');

const unknownDates = [undefined, null, 0, -1, NaN, Infinity, -Infinity, '100', 8.64e15 + 1];
const mixed = [item('first-valid', 100), ...unknownDates.map((date, index) => item(`unknown-${index}`, date)), item('last-valid', 300)];
const unknownIndices = unknownDates.map((_, index) => index + 1);
assert.deepEqual(orderedFileIndices(mixed, 'modified-desc'), [10, 0, ...unknownIndices]);
assert.deepEqual(orderedFileIndices(mixed, 'modified-asc'), [0, 10, ...unknownIndices]);
assert.deepEqual(orderedFileIndices([item('latest-valid-date', 8.64e15), item('first', 1)]), [0, 1]);

const names = [item('IMG10.DNG'), item('img2.dng'), item('IMG1.dng'), item('Img2.DNG'), item('IMG02.dng')];
assert.deepEqual(orderedFileIndices(names, 'name-asc'), [2, 1, 3, 4, 0]);
assert.deepEqual(orderedFileIndices(names, 'name-desc'), [0, 1, 3, 4, 2],
  'descending names retain original order for case-insensitive and numeric ties');
const nonAscii = [item('照片10.DNG'), item('照片2.DNG'), item('写真10.DNG'), item('写真2.DNG')];
const nonAsciiAsc = orderedFileIndices(nonAscii, 'name-asc');
const nonAsciiDesc = orderedFileIndices(nonAscii, 'name-desc');
assert.ok(nonAsciiAsc.indexOf(1) < nonAsciiAsc.indexOf(0));
assert.ok(nonAsciiAsc.indexOf(3) < nonAsciiAsc.indexOf(2));
assert.deepEqual(nonAsciiDesc, [...nonAsciiAsc].reverse());
assert.deepEqual(orderedFileIndices([item('zebra'), item('Älbum'), item('album')], 'name-asc'), [2, 1, 0],
  'fixed English collation is independent of the current UI locale');

const frozen = Object.freeze([
  Object.freeze({ file: Object.freeze({ name: 'photo10', lastModified: 1 }), selected: true }),
  Object.freeze({ file: Object.freeze({ name: 'photo2', lastModified: 2 }), settings: Object.freeze({ exposure: 1 }) }),
]);
const snapshot = JSON.stringify(frozen);
for (const mode of ['modified-desc', 'modified-asc', 'name-asc', 'name-desc']) {
  const order = orderedFileIndices(frozen, mode);
  order.reverse();
  assert.equal(JSON.stringify(frozen), snapshot, 'sorting and modifying the result never mutates source items');
}
assert.deepEqual(orderedFileIndices([], 'name-asc'), []);
assert.deepEqual(orderedFileIndices([item('only')]), [0]);

const order = Object.freeze([3, 1, 4, 0, 2]);
assert.deepEqual(selectionRangeIndices(order, 1, 0), [1, 4, 0]);
assert.deepEqual(selectionRangeIndices(order, 0, 1), [1, 4, 0], 'reverse selection follows visual order');
assert.deepEqual(selectionRangeIndices(order, 4, 4), [4]);
assert.deepEqual(selectionRangeIndices(order, -1, 0), [0], 'missing anchor selects only the visible target');
assert.deepEqual(selectionRangeIndices(order, 1, 99), [], 'missing target does not select an unrelated range');
assert.deepEqual(selectionRangeIndices([], 0, 1), []);
assert.deepEqual(order, [3, 1, 4, 0, 2]);

console.log('fileListOrder: stable modification/name sorting preserves source identity and visual selection ranges');
