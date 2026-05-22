// Standalone Node test for filmBaseDetection.js - run with:
// node negative2positive/src/app/filmBaseDetection.test.mjs

import assert from 'node:assert/strict';
import {
  autoDetectFilmBase,
  sampleFilmBase,
  sanitizeFilmBaseForSettings
} from './filmBaseDetection.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

function makeImageData(width, height, fill8, fill16 = null) {
  const data = new Uint8ClampedArray(width * height * 4);
  const data16 = fill16 ? new Uint16Array(width * height * 4) : null;

  for (let i = 0; i < width * height; i++) {
    const dst = i * 4;
    data[dst] = fill8.r;
    data[dst + 1] = fill8.g;
    data[dst + 2] = fill8.b;
    data[dst + 3] = 255;
    if (data16) {
      data16[dst] = fill16.r;
      data16[dst + 1] = fill16.g;
      data16[dst + 2] = fill16.b;
      data16[dst + 3] = 65535;
    }
  }

  const imageData = new ImageData(data, width, height);
  if (data16) imageData.__image16 = { width, height, data: data16 };
  return imageData;
}

function setPixel(imageData, x, y, color8, color16 = null) {
  const i = (y * imageData.width + x) * 4;
  imageData.data[i] = color8.r;
  imageData.data[i + 1] = color8.g;
  imageData.data[i + 2] = color8.b;
  imageData.data[i + 3] = 255;
  if (imageData.__image16 && color16) {
    imageData.__image16.data[i] = color16.r;
    imageData.__image16.data[i + 1] = color16.g;
    imageData.__image16.data[i + 2] = color16.b;
    imageData.__image16.data[i + 3] = 65535;
  }
}

const base = { r: 210, g: 140, b: 90 };
const sampleSource = makeImageData(25, 25, base);
for (let y = 10; y <= 14; y++) {
  for (let x = 10; x <= 14; x++) {
    setPixel(sampleSource, x, y, base);
  }
}
setPixel(sampleSource, 12, 12, { r: 255, g: 255, b: 255 });

const manual = sampleFilmBase(sampleSource, 12, 12, 4);
assert.ok(Math.abs(manual.r - base.r) <= 2);
assert.ok(Math.abs(manual.g - base.g) <= 2);
assert.ok(Math.abs(manual.b - base.b) <= 2);
assert.equal(manual.method, 'manual');
assert.ok(manual.confidence > 0.4);

const precise16 = { r: 50123, g: 31777, b: 18222 };
const precise = makeImageData(12, 12, { r: 195, g: 124, b: 71 }, precise16);
const preciseSample = sampleFilmBase(precise, 6, 6, 3);
assert.equal(preciseSample.r16, precise16.r);
assert.equal(preciseSample.g16, precise16.g);
assert.equal(preciseSample.b16, precise16.b);

const autoSource = makeImageData(120, 90, base);
for (let y = 12; y < 78; y++) {
  for (let x = 18; x < 102; x++) {
    const color = ((x + y) % 2 === 0)
      ? { r: 60, g: 95, b: 160 }
      : { r: 180, g: 70, b: 45 };
    setPixel(autoSource, x, y, color);
  }
}

for (let y = 0; y < 20; y++) {
  for (let x = 0; x < 20; x++) {
    setPixel(autoSource, x, y, { r: 255, g: 255, b: 255 });
  }
}

const detected = autoDetectFilmBase(autoSource, 10);
assert.ok(Math.abs(detected.r - base.r) <= 3, `r=${detected.r}`);
assert.ok(Math.abs(detected.g - base.g) <= 3, `g=${detected.g}`);
assert.ok(Math.abs(detected.b - base.b) <= 3, `b=${detected.b}`);
assert.equal(detected.method, 'auto');
assert.ok(detected.selected >= 3);
assert.ok(detected.confidence > 0.45);

const sanitized = sanitizeFilmBaseForSettings({ r: 210, g: 140, b: 90, confidence: 2, r16: 54000, g16: 36000, b16: 23000 });
assert.equal(sanitized.confidence, 1);
assert.equal(sanitized.r16, 54000);
assert.equal(sanitized.g16, 36000);
assert.equal(sanitized.b16, 23000);

console.log('filmBaseDetection.test.mjs passed');
