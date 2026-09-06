import assert from 'node:assert/strict';
import { applyRotationToImageData, mirrorImageDataHorizontal, normalizeAngleDegrees } from './imageGeometry.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = new ImageData(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), 2, 1);
source.__image16 = { width: 2, height: 1, data: new Uint16Array([123, 456, 789, 65535, 1001, 2002, 3003, 65535]) };
assert.equal(applyRotationToImageData(source, 360), source);
assert.equal(normalizeAngleDegrees(-270), 90);
const rotated = applyRotationToImageData(source, 90);
assert.deepEqual([rotated.width, rotated.height], [1, 2]);
assert.deepEqual(rotated.__image16.data, source.__image16.data);
const restored = applyRotationToImageData(rotated, -90);
assert.deepEqual(restored.data, source.data);
assert.deepEqual(restored.__image16.data, source.__image16.data);
const mirrored = mirrorImageDataHorizontal(source);
assert.deepEqual([...mirrored.__image16.data], [1001, 2002, 3003, 65535, 123, 456, 789, 65535]);
const angled = applyRotationToImageData(source, 12);
assert.ok(angled.__image16.data.some(value => value % 257 !== 0));
assert.ok(angled.data.length === angled.width * angled.height * 4);
assert.deepEqual(source.__image16.data, new Uint16Array([123, 456, 789, 65535, 1001, 2002, 3003, 65535]));
console.log('imageGeometry tests passed');
