// Translation-dictionary consistency. The three dictionaries are maintained by
// hand alongside markup that references keys by name, so they drift in both
// directions: an entry added to one language only, and a `data-i18n` attribute
// pointing at a key nobody wrote. Both fail silently at runtime — the element
// keeps whatever English text is hard-coded in the HTML — so they are checked
// here instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { i18n } from './i18n.js';

const appDir = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(appDir, '..', '..', 'index.html'), 'utf8');

const languages = Object.keys(i18n);
assert.deepEqual(languages.sort(), ['en', 'ja', 'zh'], 'expected exactly the zh/en/ja dictionaries');

// --- Every language defines the same keys -----------------------------------
const keySets = Object.fromEntries(languages.map((lang) => [lang, new Set(Object.keys(i18n[lang]))]));
const reference = keySets.en;
for (const lang of languages) {
  if (lang === 'en') continue;
  const missing = [...reference].filter((key) => !keySets[lang].has(key));
  const extra = [...keySets[lang]].filter((key) => !reference.has(key));
  assert.equal(missing.length, 0, `${lang} is missing keys present in en: ${missing.slice(0, 10).join(', ')}`);
  assert.equal(extra.length, 0, `${lang} defines keys absent from en: ${extra.slice(0, 10).join(', ')}`);
}

// --- No empty translations --------------------------------------------------
for (const lang of languages) {
  for (const [key, value] of Object.entries(i18n[lang])) {
    assert.equal(typeof value, 'string', `${lang}.${key} is not a string`);
    assert.notEqual(value.trim(), '', `${lang}.${key} is empty`);
  }
}

// --- Every key the markup asks for exists -----------------------------------
const I18N_ATTRIBUTES = [
  'data-i18n',
  'data-i18n-title',
  'data-i18n-aria-label',
  'data-i18n-placeholder',
  'data-i18n-label',
];
const usedKeys = new Set();
for (const attribute of I18N_ATTRIBUTES) {
  for (const match of indexHtml.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))) {
    usedKeys.add(match[1]);
  }
}
assert.ok(usedKeys.size > 100, `expected the app page to reference many keys, found ${usedKeys.size}`);

for (const lang of languages) {
  const undefinedKeys = [...usedKeys].filter((key) => !keySets[lang].has(key));
  assert.equal(
    undefinedKeys.length,
    0,
    `index.html references keys missing from ${lang}: ${undefinedKeys.slice(0, 10).join(', ')}`
  );
}

// --- The attribute-driven names must actually be applied --------------------
// setLanguage walks these attributes; a new one added to the markup without a
// matching loop would leave that name frozen at its English fallback.
const mainJs = readFileSync(join(appDir, 'main.js'), 'utf8');
for (const attribute of I18N_ATTRIBUTES) {
  if (!indexHtml.includes(`${attribute}="`)) continue;
  assert.ok(
    mainJs.includes(`querySelectorAll('[${attribute}]')`),
    `index.html uses ${attribute} but setLanguage never reads it`
  );
}

console.log(
  `i18n tests: all passed (${languages.length} languages x ${reference.size} keys, ${usedKeys.size} referenced by the app page)`
);
