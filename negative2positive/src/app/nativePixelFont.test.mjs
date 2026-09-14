import assert from 'node:assert/strict';
import { ensureNativePixelFont, isNativePixelFontReady, nativePixelFontFamily, nativePixelFontLocale, hasNativePixelGlyph } from './nativePixelFont.js';

for (const [locale, expected] of [['en', 'sc'], ['zh-CN', 'sc'], ['zh-Hant', 'tc'], ['zh-TW', 'tc'], ['ja-JP', 'ja'], ['ko-KR', 'ko']]) {
  assert.equal(nativePixelFontLocale(locale), expected);
}
for (const char of '中文繁體日本語フィルム한국어') assert.ok(hasNativePixelGlyph(char), char);
assert.equal(hasNativePixelGlyph('𠮷'), false, 'Rare characters must take the explicit missing-glyph path');
assert.equal(hasNativePixelGlyph('\u{10FFFF}'), false);
assert.equal(nativePixelFontFamily('ja'), 'NC Film Edge ja');

let finish, fail;
const requests = [], installed = [];
globalThis.document = { fonts: { add(face) { installed.push(face); } } };
globalThis.FontFace = class {
  constructor(family, url, descriptors) { Object.assign(this, { family, url, descriptors }); requests.push(this); }
  load() { return new Promise((resolve, reject) => { finish = () => resolve(this); fail = reject; }); }
};
try {
  const first = ensureNativePixelFont('ja');
  assert.equal(ensureNativePixelFont('ja-JP'), first, 'Deduplicate concurrent preview and export loads');
  assert.equal(isNativePixelFontReady('ja'), false);
  assert.equal(installed.length, 0);
  assert.match(requests[0].url, /fusion-pixel-12px-proportional-ja\.otf\.woff2/);
  assert.equal(requests[0].descriptors.weight, '400');
  finish();
  await first;
  assert.equal(isNativePixelFontReady('ja'), true);
  assert.equal(installed.length, 1);
  await ensureNativePixelFont('ja');
  assert.equal(requests.length, 1);

  const broken = ensureNativePixelFont('zh-Hant');
  fail(new Error('offline'));
  await assert.rejects(broken, /offline/);
  assert.equal(isNativePixelFontReady('zh-Hant'), false);
  const retry = ensureNativePixelFont('zh-TW');
  assert.equal(requests.length, 3, 'Failed loads can be retried');
  assert.match(requests[2].url, /zh_hant/);
  finish();
  await retry;
  assert.equal(isNativePixelFontReady('zh-Hant'), true);
} finally {
  delete globalThis.document;
  delete globalThis.FontFace;
}
console.log('nativePixelFont.test.mjs passed');
