// 不完全な画像セットで既存のストア画像を削除しないための公開前検証。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const UPNG = createRequire(import.meta.url)('upng-js');
const folder = new URL('../fastlane/screenshots/en-US/', import.meta.url);
const names = ['01-color-workspace.png', '02-curves.png', '03-film-conversion.png', '04-import.png'];
assert.deepEqual(readdirSync(folder).sort(), names);
for (const name of names) {
  const bytes = readFileSync(new URL(name, folder));
  const png = UPNG.decode(bytes);
  assert.equal(png.width, 2880, name);
  assert.equal(png.height, 1800, name);
  assert.equal(png.depth, 8, name);
  assert.equal(png.ctype, 2, `${name}: RGB PNG without alpha required`);
  const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
  let low = 255, high = 0;
  for (let i = 0; i < rgba.length; i += 4) { low = Math.min(low, rgba[i]); high = Math.max(high, rgba[i]); }
  assert.ok(high - low > 100, `${name}: blank screenshot`);
}
console.log(`App Store screenshots: ${names.length} opaque 2880x1800 RGB PNGs OK (${fileURLToPath(folder)})`);
