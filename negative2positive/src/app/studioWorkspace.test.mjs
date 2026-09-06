import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ブラウザー用 CSS import だけを除き、翻訳データを同じモジュールから検証する。
const source = readFileSync(new URL('./studioWorkspace.js', import.meta.url), 'utf8');
const moduleSource = source.replace(/import '\.\.\/styles\/[^']+\.css';/g, '');
const { studioText } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
const keys = Object.keys(studioText.en).sort();
for (const [lang, messages] of Object.entries(studioText)) {
  assert.deepEqual(Object.keys(messages).sort(), keys, lang);
  for (const [key, value] of Object.entries(messages)) assert.ok(value.trim(), lang + ':' + key);
}
for (const match of source.matchAll(/data-studio="([a-zA-Z]+)"/g)) {
  assert.ok(keys.includes(match[1]), '翻訳キー: ' + match[1]);
}
console.log('studioWorkspace: 3言語のキーと UI 文言を検証');

assert.match(source, /<span class="studio-mark">NeoAnalogLab<\/span>/, 'ブランド名を省略せず表示');
const mainSource = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
assert.doesNotMatch(mainSource, /STUDIO_MODE|studioPreviewLink/, '旧画面への分岐を復活させない');
for (const locale of ['zh_hans', 'zh_hant', 'ja', 'ko']) {
  const font = readFileSync(new URL(`../../public/fonts/fusion-pixel/fusion-pixel-12px-proportional-${locale}.otf.woff2`, import.meta.url));
  assert.equal(font.subarray(0, 4).toString(), 'wOF2', locale + ': 同梱フォントの形式');
}
assert.match(readFileSync(new URL('../../public/fonts/fusion-pixel/OFL.txt', import.meta.url), 'utf8'), /SIL OPEN FONT LICENSE/);
