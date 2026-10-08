// setLanguage's hooks for text it cannot re-apply from data-i18n keys
// (R2-069): the Studio menu's photo-cache line (#displayCacheCount, #249)
// and learned-defaults line (#learnedDefaultsCount, #231) interpolate their
// values, so a language switch builds them again. main.js's own functions
// run in a vm over a DOM-free document of those two lines, with the real
// dictionaries; every other update the switch runs is a no-op here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { i18n } from './i18n.js';
import { interpolateText } from './textUtils.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}

const lines = new Map(['displayCacheCount', 'learnedDefaultsCount'].map(id => [id, { id, textContent: '' }]));
const GiB = 1024 ** 3;
const target = {
  document: { documentElement: {}, title: '', getElementById: id => lines.get(id) || null, querySelectorAll: () => [] },
  i18n, interpolateText, currentLang: 'en', stateReady: false,
  state: { sprocketPreviewEnabled: false },
  displayProxyStore: { budget: async () => 2 * GiB, bytes: 1.2 * GiB },
  learnedRecords: new Map([['kodak-portra-400', {}], ['fuji-c200', {}], ['ilford-hp5', {}]]),
  isTauriDesktop: () => false, studioWorkspace: { sync() {} }
};
const context = vm.createContext(new Proxy(target, {
  has: () => true,
  get(t, key) {
    if (key in t) return t[key];
    if (key in globalThis) return globalThis[key];
    if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
    return undefined;
  }
}));
vm.runInContext(['getLocalizedText', 'getInterpolatedText', 'setLanguage', 'formatCacheBytes', 'updateDisplayCacheUI', 'updateLearningUI']
  .map(functionSource).join('\n'), context);

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const switchTo = async lang => { context.setLanguage(lang); await settle(); };
const cache = () => lines.get('displayCacheCount').textContent;
const learned = () => lines.get('learnedDefaultsCount').textContent;
const sizeLine = lang => interpolateText(i18n[lang].displayCacheSize, { size: '1.2 GB', limit: '2.0 GB' });
const learnedLine = lang => interpolateText(i18n[lang].learnedDefaultsCount, { count: 3 });

// The boot's own call runs before the state is ready: the lines are mounted
// (and filled) later, by mountDisplayCacheUI and mountLearningUI.
await switchTo('en');
assert.equal(cache(), '', 'nothing is built before the state is ready');
target.stateReady = true;

await switchTo('en');
assert.equal(cache(), 'Photo cache: 1.2 GB of 2.0 GB');
assert.equal(learned(), 'Learned defaults: 3 stocks');
// The Studio menu stays open while its language buttons switch: both lines
// follow at once (before, they kept the previous language until the menu
// was opened again or the next learning write).
await switchTo('ja');
assert.equal(cache(), sizeLine('ja'), 'switching to Japanese re-renders the photo-cache line in Japanese');
assert.match(cache(), /写真キャッシュ/);
assert.equal(learned(), learnedLine('ja'), 'and the learned-defaults line');
await switchTo('zh');
assert.equal(cache(), sizeLine('zh'));
assert.equal(learned(), learnedLine('zh'));
// Its other forms follow too: the cache off, and no store at all.
target.displayProxyStore = { budget: async () => 0, bytes: 0 };
await switchTo('ja');
assert.equal(cache(), interpolateText(i18n.ja.displayCacheOff, { size: '0 MB' }));
target.displayProxyStore = null;
await switchTo('en');
assert.equal(cache(), i18n.en.displayCacheUnavailable);

console.log('languageHooks: the photo-cache and learned-defaults lines follow a language switch');
