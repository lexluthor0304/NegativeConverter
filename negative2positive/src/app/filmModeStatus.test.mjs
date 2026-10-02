// The Conversion panel's film-type status line, from main.js's real
// updateFilmModeUI. #229 review R1-019: since #231 the monochrome line says
// the photo is treated as a B&W negative, so it is shown for a B&W photo
// only. A recipe saved before #231 (a project or a recovery copy keeps its
// film type) restores a monochrome frame as a positive with the same
// low-confidence reason: its line is the uncertain one, which says the
// positive orientation was kept. 5f23eb0 chose the line from the confidence
// and reason alone and showed the B&W one.
// Run with: node negative2positive/src/app/filmModeStatus.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { i18n } from './i18n.js';
import { ROLL_MONOCHROME } from './rollFilmType.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}

const elements = new Map();
const element = id => {
  if (!elements.has(id)) elements.set(id, { id, style: {}, dataset: {}, hidden: false, value: '', textContent: '' });
  return elements.get(id);
};
const state = { filmType: 'positive', positiveMode: 'correct', step2Mode: 'border', samplingMode: null };
const target = {
  state, ROLL_MONOCHROME, i18n, currentLang: 'en',
  document: { getElementById: element },
  requiresFilmBase: () => state.filmType !== 'positive',
  usesSilverCoreConversion: () => true
};
// The panel helpers it calls (lower-case names not listed here) do nothing.
const context = vm.createContext(new Proxy(target, {
  has: () => true,
  get(t, key) {
    if (key in t) return t[key];
    if (key in globalThis) return globalThis[key];
    if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
    return undefined;
  }
}));
vm.runInContext(functionSource('updateFilmModeUI'), context);

const status = ([filmType, filmTypeSource, filmTypeConfidence, filmTypeReason], lang = 'en') => {
  Object.assign(state, { filmType, filmTypeSource, filmTypeConfidence, filmTypeReason });
  target.currentLang = lang;
  context.updateFilmModeUI();
  const line = element('filmTypeDetectionStatus');
  return { key: line.dataset.i18n, text: line.textContent, confidence: line.dataset.confidence };
};

// A restored pre-#231 recipe: positive, low, monochrome.
for (const lang of ['en', 'zh', 'ja']) {
  const restored = status(['positive', 'auto', 'low', 'monochrome'], lang);
  assert.equal(restored.key, 'filmTypeUncertain', `${lang}: a monochrome positive is not called a B&W negative`);
  assert.equal(restored.text, i18n[lang].filmTypeUncertain);
  assert.equal(restored.confidence, 'low');
}
assert.match(i18n.en.filmTypeUncertain, /positive orientation/);
assert.match(i18n.en.filmTypeMonochrome, /treated as a B&W negative/);

// Every other line is chosen as before.
const lines = [
  [['bw', 'auto', 'low', 'monochrome'], 'filmTypeMonochrome'],
  [['bw', 'auto', 'medium', 'rollMonochrome'], 'filmTypeRollMonochrome'],
  [['positive', 'auto', 'low', 'warmScene'], 'filmTypeUncertain'],
  [['positive', 'auto', 'low', 'empty'], 'filmTypeUncertain'],
  [['positive', 'auto', 'medium', 'noMask'], 'filmTypeSuggested'],
  [['bw', 'auto', 'medium', 'clearRebate'], 'filmTypeSuggested'],
  [['color', 'auto', 'medium', 'orangeMask'], 'filmTypeSuggested'],
  [['color', 'auto', 'high', 'dx'], 'filmTypeDetected'],
  [['bw', 'manual', null, null], 'filmTypeManual'],
  [['positive', 'manual', null, null], 'filmTypeManual']
];
for (const [fields, key] of lines) {
  const shown = status(fields);
  assert.equal(shown.key, key, fields.join('/'));
  assert.equal(shown.text, i18n.en[key]);
  assert.equal(shown.confidence, fields[1] === 'auto' ? fields[2] : 'manual');
}
console.log('filmModeStatus: the monochrome line only for B&W photos; a restored monochrome positive shows the uncertain line');
