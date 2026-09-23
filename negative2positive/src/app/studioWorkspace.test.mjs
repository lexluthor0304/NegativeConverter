import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ブラウザー用 CSS import だけを除き、翻訳データを同じモジュールから検証する。
const source = readFileSync(new URL('./studioWorkspace.js', import.meta.url), 'utf8');
const moduleSource = source.replace("from './panelRelevance.js'", `from '${new URL('./panelRelevance.js', import.meta.url).href}'`).replace(/import '\.\.\/styles\/[^']+\.css';/g, '');
const { studioText, syncPhotoSwitchFeedback } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
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

// Execute the real feedback renderer without mounting unrelated Studio controls.
const element = () => ({
  dataset: {}, attributes: {}, children: [], textContent: '', hidden: false,
  setAttribute(name, value) { this.attributes[name] = value; },
  removeAttribute(name) { delete this.attributes[name]; },
  append(child) { this.children.push(child); },
  querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); },
});
const nodes = new Map(['studioPhotoSwitchFeedback', 'studioPhotoSwitchMessage', 'studioPhotoSwitchHint', 'canvasContainer']
  .map(id => [id, element()]));
const buttons = ['ready', 'pending', 'error'].map((previewState, index) => {
  const button = element();
  button.dataset = { index: String(index), previewState };
  const parent = { active: false, classList: { toggle(name, value) { parent[name] = value; } } };
  button.closest = () => parent;
  return button;
});
const document = {
  body: { dataset: {} }, getElementById: id => nodes.get(id),
  querySelectorAll: () => buttons, createElement: element,
};
const state = { currentFileIndex: 0, fileQueue: [{ file: { name: '<photo & name>.dng' } }, { file: { name: 'second.png' } }, { file: { name: 'broken.png' } }] };
let text = key => studioText.en[key];
const sync = () => syncPhotoSwitchFeedback({ state, document, text });
assert.equal(sync(), null);
assert.equal(nodes.get('studioPhotoSwitchFeedback').hidden, true);
assert.deepEqual(buttons.map(button => button.attributes['aria-busy']), ['false', 'true', 'false'],
  'background canonical-preview busy state survives without editor switching');
document.body.dataset.photoSwitching = 'true';
state.photoSwitchTarget = state.fileQueue[0];
state.photoSwitchPhase = 'loading';
for (const lang of ['en', 'zh', 'ja']) {
  text = key => studioText[lang][key];
  assert.equal(sync().item, state.fileQueue[0]);
  assert.equal(nodes.get('studioPhotoSwitchFeedback').hidden, false);
  assert.equal(nodes.get('studioPhotoSwitchMessage').textContent,
    studioText[lang].openingPhoto.replace('{name}', '<photo & name>.dng'));
  assert.equal(buttons[0].dataset.photoSwitchTarget, 'true');
  assert.equal(buttons[0].attributes['aria-current'], 'true');
  assert.equal(buttons[0].attributes['aria-busy'], 'true', 'editor loading also marks a ready thumbnail busy');
  assert.equal(buttons[0].querySelector('.file-list-switch-state').textContent, studioText[lang].photoSwitchTile);
}
state.photoSwitchTarget = state.fileQueue[2];
state.photoSwitchPhase = 'preparing';
assert.equal(sync().message, studioText.ja.preparingPhoto.replace('{name}', 'broken.png'));
assert.equal(buttons[0].dataset.photoSwitchTarget, undefined);
assert.equal(buttons[0].attributes['aria-current'], undefined);
assert.equal(buttons[0].querySelector('.file-list-switch-state').hidden, true);
assert.equal(buttons[2].closest().active, true);
assert.equal(buttons[2].attributes['aria-busy'], 'true');
// A cancelled/error cold activation can return to the same outgoing index
// cached by renderFileList, so feedback cleanup itself must reconcile the DOM.
state.photoSwitchTarget = null;
assert.equal(sync(), null);
assert.equal(buttons[0].closest().active, true);
assert.equal(buttons[0].attributes['aria-current'], 'true');
assert.equal(buttons[2].closest().active, false);
assert.equal(buttons[2].attributes['aria-current'], undefined);
state.photoSwitchTarget = state.fileQueue[2];
sync();
state.fileQueue.pop();
assert.equal(sync(), null, 'a removed target cannot leave a visible stale busy surface');
assert.equal(nodes.get('canvasContainer').attributes['aria-busy'], 'false');
assert.equal(nodes.get('studioPhotoSwitchMessage').textContent, '');
assert.equal(nodes.get('studioPhotoSwitchFeedback').hidden, true);
assert.deepEqual(buttons.map(button => button.attributes['aria-busy']), ['false', 'true', 'false']);
assert.ok(buttons.every(button => button.dataset.photoSwitchTarget === undefined));
console.log('studioWorkspace: localized cold-switch identity, target ownership and independent thumbnail state passed');
