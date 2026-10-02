import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ブラウザー用 CSS import だけを除き、翻訳データを同じモジュールから検証する。
const source = readFileSync(new URL('./studioWorkspace.js', import.meta.url), 'utf8');
const moduleSource = source.replace(/from '(\.\/(?:panelRelevance|fileListOrder)\.js)'/g, (_, relative) => `from '${new URL(relative, import.meta.url).href}'`).replace(/import '\.\.\/styles\/[^']+\.css';/g, '');
const { studioText, syncPhotoSwitchFeedback, createPhotoSortControl, createPhotoSwitchPresentation, createCoalescedFlush, createDiffedWriter } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
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
  const font = readFileSync(new URL(`../assets/fonts/fusion-pixel/fusion-pixel-12px-proportional-${locale}.otf.woff2`, import.meta.url));
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

// Presentation surfaces in the veil: one target, one visible surface, released
// with the veil. The live-region message is unchanged; the chip suffix is
// presentational (aria-hidden in the markup).
{
  const surface = (kind, extra = {}) => ({ hidden: true, width: 0, height: 0, dataset: {}, attributes: {}, ...extra,
    setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
    removeAttribute(name) { delete this.attributes[name]; delete this.src; } });
  const drawn = [], transfers = [];
  const image = surface('image', { getContext: () => ({ putImageData: (data, x, y) => drawn.push([data, x, y]) }) });
  const thumb = surface('thumbnail');
  Object.defineProperty(thumb, 'src', { set(value) { this.attributes.src = value; }, get() { return this.attributes.src; }, configurable: true });
  const bitmap = surface('bitmap', { getContext: kind => (kind === 'bitmaprenderer' ? { transferFromImageBitmap: value => transfers.push(value) } : null) });
  const chip = { textContent: '' };
  const veil = { dataset: {}, querySelector: selector => ({
    '[data-surface="image"]': image, '[data-surface="thumbnail"]': thumb, '[data-surface="bitmap"]': bitmap,
    '.studio-photo-switch-provisional': chip })[selector] };
  let lang = 'en';
  const presentation = createPhotoSwitchPresentation(veil, { label: () => ' · ' + studioText[lang].provisionalPreview });
  const [a, b] = [{ file: { name: 'a.dng' } }, { file: { name: 'b.dng' } }];
  const pixels = { width: 1200, height: 797, data: new Uint8ClampedArray(4) };
  assert.equal(presentation.showImageData(a, pixels), true);
  assert.deepEqual([veil.dataset.provisional, image.hidden, thumb.hidden, bitmap.hidden, image.width, image.height],
    ['cached', false, true, true, 1200, 797]);
  assert.equal(drawn[0][0], pixels, 'the retained copy is drawn once, synchronously');
  assert.equal(chip.textContent, ' · preview');
  lang = 'ja'; presentation.relabel();
  assert.equal(chip.textContent, ' · ' + studioText.ja.provisionalPreview);
  assert.equal(presentation.showUrl(a, 'data:image/jpeg;base64,AAAA'), true);
  assert.deepEqual([veil.dataset.provisional, image.hidden, thumb.hidden, thumb.src], ['thumbnail', true, false, 'data:image/jpeg;base64,AAAA']);
  let closed = 0;
  const frame = { width: 2112, height: 1408, close: () => { closed++; } };
  assert.equal(presentation.showBitmap(a, frame), true);
  assert.deepEqual([veil.dataset.provisional, bitmap.hidden, thumb.hidden, bitmap.width, transfers[0]], ['embedded', false, true, 2112, frame]);
  assert.equal(presentation.target, a);
  // A different target (or a hidden veil) releases every surface.
  document.body.dataset.photoSwitching = 'true';
  const presentationNodes = new Map([...nodes]);
  const queue = { fileQueue: [a, b], photoSwitchTarget: b, photoSwitchPhase: 'loading', currentFileIndex: 0 };
  syncPhotoSwitchFeedback({ state: queue, document, text: key => studioText.en[key], presentation });
  assert.equal(presentation.target, null);
  assert.equal(veil.dataset.provisional, undefined);
  assert.deepEqual([image.hidden, thumb.hidden, bitmap.hidden, image.width, thumb.src], [true, true, true, 0, undefined]);
  assert.equal(transfers.at(-1), null, 'the bitmap is released with transferFromImageBitmap(null)');
  assert.equal(chip.textContent, '');
  assert.equal(nodes.get('studioPhotoSwitchMessage').textContent, studioText.en.openingPhoto.replace('{name}', 'b.dng'),
    'the announced message never carries the chip suffix');
  presentation.showUrl(b, 'data:b');
  syncPhotoSwitchFeedback({ state: queue, document, text: key => studioText.en[key], presentation });
  assert.equal(presentation.target, b, 'the same target keeps its presentation across syncs');
  delete document.body.dataset.photoSwitching;
  syncPhotoSwitchFeedback({ state: queue, document, text: key => studioText.en[key], presentation });
  assert.equal(presentation.target, null, 'hiding the veil ends the presentation');
  assert.equal(closed, 0, 'ownership moved to the canvas; it is released by the null transfer, not closed twice');
  assert.equal(presentation.showImageData(a, null), false);
  assert.ok(presentationNodes.size > 0);
  console.log('studioWorkspace: veil presentation surfaces, target binding and release passed');
}

// Execute the same select adapter used by the mounted strip and light table.
// State synchronization must not emit a user sort or activate any photo.
const sortHandlers = new Map();
const select = { value: '', disabled: false, addEventListener(type, handler) {
  assert.ok(!sortHandlers.has(type), 'only one listener per event');
  sortHandlers.set(type, handler);
} };
const sorted = [];
const sort = createPhotoSortControl({ select, onSortFiles: mode => sorted.push(mode) });
const sortState = { fileQueue: [{ file: { name: 'frame-2.png' } }], fileListSort: 'modified-desc', cropping: false };
assert.equal(select.value, 'modified-desc', 'the initial control uses modification date, newest first');
assert.deepEqual([...sortHandlers.keys()], ['change']);
const sortModes = ['modified-desc', 'modified-asc', 'name-asc', 'name-desc'];
for (const mode of sortModes) {
  sortState.fileListSort = mode;
  sort.sync({ state: sortState, busy: false, photoSwitching: false, exportLocked: false });
  assert.equal(select.value, mode);
  assert.equal(select.disabled, false);
}
assert.deepEqual(sorted, [], 'normal UI and language updates do not call the sort handler');
for (const mode of sortModes) {
  select.value = mode;
  sortHandlers.get('change')();
}
assert.deepEqual(sorted, sortModes, 'each user change calls the handler exactly once');
sortState.fileListSort = 'invalid';
sort.sync({ state: sortState });
assert.equal(select.value, 'modified-desc', 'invalid persisted state uses the default mode');
select.value = 'invalid';
sortHandlers.get('change')();
assert.equal(sorted.at(-1), 'modified-desc', 'an invalid DOM value is normalized before callback');
for (const [label, override, expected] of [
  ['cold photo switch', { busy: true, photoSwitching: true }, false],
  ['other processing', { busy: true, photoSwitching: false }, true],
  ['export during photo switch', { busy: true, photoSwitching: true, exportLocked: true }, true],
  ['empty queue', { state: { ...sortState, fileQueue: [] } }, true],
  ['cropping', { state: { ...sortState, cropping: true } }, true],
  ['ready', {}, false],
]) {
  sort.sync({ state: sortState, busy: false, photoSwitching: false, exportLocked: false, ...override });
  assert.equal(select.disabled, expected, label);
  if (expected) {
    const before = sorted.length;
    sortHandlers.get('change')();
    assert.equal(sorted.length, before, label + ': even a synthetic change cannot call the sort handler');
  }
}
const sortMarkup = source.match(/<label class="studio-photo-sort"[\s\S]*?<\/label>/)?.[0];
assert.ok(sortMarkup, 'the shared header has one visible sort control');
assert.equal((source.match(/id="studioPhotoSort"/g) || []).length, 1, 'strip and light table share the same control');
assert.match(sortMarkup, /for="studioPhotoSort"/);
assert.match(sortMarkup, /<span data-studio="photoSort"><\/span><select id="studioPhotoSort">/,
  'a visible localized label names the native keyboard-accessible select');
assert.deepEqual([...sortMarkup.matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), sortModes);
for (const lang of ['en', 'zh', 'ja']) {
  const messages = studioText[lang];
  assert.ok(messages.photoSort.trim());
  const labels = ['sortModifiedDesc', 'sortModifiedAsc', 'sortNameAsc', 'sortNameDesc'].map(key => messages[key]);
  assert.equal(new Set(labels).size, 4, lang + ': every direction has an explicit distinct label');
  assert.match(messages.sortNameAsc, /A–Z/);
  assert.match(messages.sortNameDesc, /Z–A/);
}
assert.equal(studioText.en.sortModifiedDesc, 'Modified: newest first');
assert.equal(studioText.zh.sortModifiedDesc, '修改日期：新到旧');
assert.equal(studioText.ja.sortModifiedDesc, '更新日時：新しい順');
assert.match(source, /const photoSort = createPhotoSortControl\(\{ select: \$\('studioPhotoSort'\), onSortFiles \}\)/);
assert.match(source, /photoSort\.sync\(\{ state, busy, photoSwitching: navigable, exportLocked: isExportLocked\(\) \}\)/);
// A cold switch and the detection tail of a provisional photo lock editing,
// not navigation (#236): the strip stays usable while the panel is inert.
assert.match(source, /const navigable = body\.dataset\.photoSwitching === 'true' \|\| Boolean\(detecting\);\n\s+set\(strip, 'inert', busy && !navigable\);/);
assert.match(source, /set\(panel, 'inert', busy\);/);
// The rest of editing is locked with the panel (R1-034): the toolbar's
// rotate, mirror and crop, and the brushes and samplers on the photo (its
// container keeps zoom, pan and drops).
assert.match(source, /set\(panel, 'inert', busy\);\n(?:\s+\/\/.*\n)*\s+set\(node\.previewToolbar, 'inert', busy\);\n\s+set\(node\.canvasTransformWrapper, 'inert', busy\);/);
assert.match(source, /const STUDIO_SYNC_IDS = \[[^\]]*'previewToolbar', 'canvasTransformWrapper',/);
assert.match(source, /t\(preparing \? 'preparingOriginal' : detecting === 'frame' \? 'detectingFrame' :/, 'the frame notice reports the running detection, or the original being prepared (#249)');
console.log('studioWorkspace: shared localized sort select, callback ownership and navigation locks passed');

// #261: every sync() in one synchronous burst is one flush at the next
// microtask checkpoint, before the next task; flush() runs it in the same turn.
{
  let runs = 0;
  const scheduler = createCoalescedFlush(() => { runs++; });
  for (let i = 0; i < 10; i++) scheduler.sync();
  assert.equal(runs, 0, 'the calling turn writes nothing');
  await Promise.resolve();
  assert.equal(runs, 1, 'ten syncs in one burst flush once');
  assert.deepEqual(scheduler.counters, { syncs: 10, flushes: 1 });
  scheduler.sync();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runs, 2, 'a pending flush runs before the next task');
  scheduler.sync(); scheduler.sync();
  scheduler.flush();
  assert.equal(runs, 3, 'flush() writes in the same turn');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(runs, 3, 'and the queued microtask then has nothing left to do');
  scheduler.flush();
  assert.equal(runs, 3, 'flush() without a pending sync is a no-op');
  await (async () => { scheduler.sync(); await null; scheduler.sync(); })();
  await Promise.resolve();
  assert.equal(runs, 5, 'syncs on either side of an await flush once each');
  // A caller that starts busy work, syncs, then awaits: the flush lands before
  // the continuation, which was queued later.
  const order = [];
  const busy = createCoalescedFlush(() => order.push('flush'));
  await (async () => { busy.sync(); await null; order.push('continuation'); })();
  assert.deepEqual(order, ['flush', 'continuation']);
  // A flush that throws does not wedge the scheduler.
  let fail = true;
  const fragile = createCoalescedFlush(() => { if (fail) throw new Error('flush failed'); order.push('recovered'); });
  fragile.sync();
  assert.throws(() => fragile.flush(), /flush failed/);
  fail = false;
  fragile.sync(); fragile.flush();
  assert.equal(order.at(-1), 'recovered');
}
console.log('studioWorkspace: coalesced sync flushes once per burst, before the next task, and on demand');

// #261: the flush writes only what differs from the live DOM.
{
  const fake = () => {
    const attributes = new Map();
    const classes = new Set();
    return {
      textContent: '', title: '', disabled: false, hidden: false, inert: false, checked: false,
      style: { display: '' }, dataset: {},
      getAttribute: name => attributes.has(name) ? attributes.get(name) : null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: name => attributes.delete(name),
      classList: { contains: name => classes.has(name), toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); } },
    };
  };
  const { set, counters } = createDiffedWriter();
  const el = fake();
  const apply = () => [
    set(el, 'textContent', 'Export'), set(el, 'title', 'Hint'), set(el, 'disabled', 1), set(el, 'hidden', undefined),
    set(el, 'inert', true), set(el, 'checked', false), set(el, 'style.display', 'inline-flex'),
    set(el, '@aria-pressed', true), set(el, '@aria-current', null), set(el, '.active', 'yes'),
    set(el, 'dataset.status', ''), set(el, 'dataset.photoSwitchTarget', undefined), set(null, 'hidden', true),
  ];
  assert.deepEqual(apply(), [true, true, true, false, true, false, true, true, false, true, true, false, false]);
  assert.equal(counters.writes, 8);
  assert.equal(el.disabled, true, 'boolean properties are written as booleans');
  assert.equal(el.getAttribute('aria-pressed'), 'true');
  assert.equal(el.dataset.status, '');
  assert.ok(apply().every(written => !written), 'an unchanged flush writes nothing');
  assert.equal(counters.writes, 8);
  el.textContent = 'changed behind the flush';
  el.classList.toggle('active', false);
  set(el, '@aria-current', 'true');
  assert.equal(apply().filter(Boolean).length, 3, 'live values, not remembered writes, decide');
  assert.equal(el.textContent, 'Export');
  assert.equal(el.getAttribute('aria-current'), null);

  // The feedback renderer through the diffed writer: a repeat makes no writes,
  // and rows: false leaves the rows alone.
  const writer = createDiffedWriter();
  const nodes = new Map(['studioPhotoSwitchFeedback', 'studioPhotoSwitchMessage', 'studioPhotoSwitchHint', 'canvasContainer'].map(id => [id, fake()]));
  const rows = [0, 1].map(index => {
    const button = fake();
    button.dataset = { index: String(index), previewState: 'ready' };
    const item = fake();
    button.closest = () => item;
    button.querySelector = () => null;
    button.append = () => assert.fail('only a switch target gets a badge');
    return button;
  });
  let walks = 0;
  const doc = { body: { dataset: {} }, getElementById: id => nodes.get(id), querySelectorAll: () => { walks++; return rows; } };
  const feedbackState = { currentFileIndex: 1, fileQueue: [{ file: { name: 'a.png' } }, { file: { name: 'b.png' } }] };
  const render = (rowsFlag = true) => syncPhotoSwitchFeedback({ state: feedbackState, document: doc, text: key => studioText.en[key], rows: rowsFlag, set: writer.set });
  render();
  assert.equal(rows[1].closest().classList.contains('active'), true);
  assert.equal(rows[1].getAttribute('aria-current'), 'true');
  const written = writer.counters.writes;
  render();
  assert.equal(writer.counters.writes, written, 'an unchanged reconcile makes no DOM writes');
  feedbackState.currentFileIndex = 0;
  render(false);
  assert.equal(walks, 2, 'rows: false does not query the rows');
  assert.equal(rows[1].getAttribute('aria-current'), 'true', 'nor touch them');
  render();
  assert.equal(rows[0].getAttribute('aria-current'), 'true');
  assert.equal(rows[1].getAttribute('aria-current'), null);
}
console.log('studioWorkspace: diffed writes compare with the live DOM and skip unchanged filmstrip rows');

// #261: Studio fires no synthetic window resize (ResizeObservers in main.js
// follow the viewer, histogram and curve), and one flush owns these fields.
assert.doesNotMatch(source, /new Event\('resize'\)/);
assert.doesNotMatch(mainSource, /new Event\('resize'\)/);
assert.match(source, /for \(const id of \['exportBtn', 'exportSprocketBtn', 'exportSingleBtn'\]\) \$\(id\)\?\.removeAttribute\('data-i18n'\)/);
const functionBody = name => {
  const start = mainSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return mainSource.slice(start, mainSource.indexOf('\n    }\n', start));
};
assert.doesNotMatch(functionBody('syncBatchUIState'), /getElementById\('(saveSettingsBtn|applyToSelectedBtn)'\)/, 'sync owns their display');
assert.doesNotMatch(functionBody('updateExportUI'), /getElementById\('export(Btn|SprocketBtn|SingleBtn)'\)/, 'sync owns the export labels');
assert.doesNotMatch(functionBody('updateExportButtons'), /(exportBtn|exportSprocketBtn)\.disabled =|getElementById\('export(Btn|SprocketBtn)'\)/, 'sync owns their disabled state');
assert.match(functionBody('updateExportButtons'), /exportSingleBtn\.disabled = exportLocked/, 'sync does not own exportSingleBtn.disabled');
console.log('studioWorkspace: no synthetic resize, and single writers for the export labels and batch buttons');
