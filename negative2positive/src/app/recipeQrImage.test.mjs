import assert from 'node:assert/strict';
import test from 'node:test';
import qrcode from 'qrcode-generator';
import { encodeRecipe, decodeRecipe } from './recipes.js';
import { readRecipeQrPixels } from './recipeQrImage.js';

function pixels(text, inverted = false) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const scale = 5, margin = 40;
  const width = qr.getModuleCount() * scale + margin * 2;
  const height = width + 100; // A screenshot with surrounding whitespace.
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const row = Math.floor((y - margin) / scale), col = Math.floor((x - margin) / scale);
    const dark = row >= 0 && col >= 0 && row < qr.getModuleCount() && col < qr.getModuleCount() && qr.isDark(row, col);
    const value = dark !== inverted ? 0 : 255;
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = value;
  }
  return { data, width, height };
}
for (const inverted of [false, true]) test(`reads a shared recipe screenshot (inverted=${inverted})`, () => {
  const code = encodeRecipe({ coreExposure: 20, filmType: 'negative' }, { note: '朋友の配方' });
  const found = readRecipeQrPixels(pixels(code, inverted));
  assert.equal(found, code);
  assert.equal(decodeRecipe(found).settings.coreExposure, 20);
});
test('rejects an unrelated QR and an image without a QR', () => {
  assert.equal(readRecipeQrPixels(pixels('https://example.com')), '');
  assert.equal(readRecipeQrPixels({ data: new Uint8ClampedArray(100 * 100 * 4).fill(255), width: 100, height: 100 }), '');
});
