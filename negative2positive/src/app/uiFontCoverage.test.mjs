import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FALLBACK_CODE_POINTS, FULL_FACE_GAP, LATIN_SUBSET_RANGES, UI_FACES,
  collectUiText, cssContentText, formatCodePoint, htmlText, inRanges, parseFontFaces, planUiFaces, scriptText,
} from '../../../scripts/ui-font-glyphs.mjs';
import { nativePixelFontCoverage } from './nativePixelFontCoverage.js';

// Text-only check of the UI font plan (#262): every character the UI sources
// can draw is in the bundled faces' shared cmap or on the explicit fallback
// list, and no face claims a character that none of them has. It reads the
// sources with the generator's own extraction module; it parses no font.
const hasGlyph = code => inRanges(nativePixelFontCoverage, code);
const inGap = code => code >= FULL_FACE_GAP[0] && code <= FULL_FACE_GAP[1];
const overlapsGap = ([first, last]) => first <= FULL_FACE_GAP[1] && last >= FULL_FACE_GAP[0];
const css = readFileSync(new URL('../styles/pixel-fonts.css', import.meta.url), 'utf8');

function problemsFor(entries, cssFaces) {
  const problems = [];
  const plan = planUiFaces(entries, hasGlyph);
  for (const { code, sources } of plan.unexpected) {
    problems.push(`${formatCodePoint(code)} is in no Fusion Pixel face and not on the fallback list (${sources.join(', ')})`);
  }
  const faces = [
    ...cssFaces.filter(face => face.unicodeRange).map(face => ({ family: face.family, ranges: face.unicodeRange })),
    ...plan.faces.map(face => ({ family: face.family, ranges: face.ranges })),
  ];
  for (const face of faces) {
    for (const code of FALLBACK_CODE_POINTS) {
      if (inRanges(face.ranges, code)) problems.push(`${face.family}: unicode-range claims fallback ${formatCodePoint(code)}`);
    }
    if (face.ranges.some(overlapsGap)) problems.push(`${face.family}: unicode-range reaches into U+2200-230B`);
  }
  return { plan, problems };
}

// ---- the real sources ----
const entries = collectUiText();
const cssFaces = parseFontFaces(css);
const { plan, problems } = problemsFor(entries, cssFaces);
assert.deepEqual(problems, []);
assert.deepEqual([...plan.missing.keys()], FALLBACK_CODE_POINTS,
  'every fallback code point is still used; drop one from FALLBACK_CODE_POINTS when the UI stops drawing it');

// The cmap itself: a font update that adds glyphs in the gap or for a fallback
// character must revisit the ranges instead of silently hiding those glyphs.
for (const code of FALLBACK_CODE_POINTS) assert.equal(hasGlyph(code), false, `${formatCodePoint(code)} is now in the faces`);
assert.equal(nativePixelFontCoverage.some(overlapsGap), false, 'the faces now have glyphs in U+2200-230B');

// The full faces skip only the gap, so every other code point keeps its face.
for (const family of ['Fusion Pixel SC', 'Fusion Pixel TC', 'Fusion Pixel JP', 'Fusion Pixel KR']) {
  const face = cssFaces.find(entry => entry.family === family);
  assert.ok(face, family);
  assert.deepEqual(face.unicodeRange, [[0, FULL_FACE_GAP[0] - 1], [FULL_FACE_GAP[1] + 1, 0x10ffff]], family);
}
// NC Studio Latin, its generator and the extraction module agree on its coverage.
const latin = cssFaces.find(face => face.family === 'NC Studio Latin');
assert.deepEqual(latin.unicodeRange, LATIN_SUBSET_RANGES);
const populate = readFileSync(new URL('../../../scripts/subset-studio-font.py', import.meta.url), 'utf8')
  .match(/^subsetter\.populate\(unicodes=(.+)\)$/m)[1];
const populated = new Set();
for (const [, first, end] of populate.matchAll(/range\((0x[0-9a-f]+),\s*(0x[0-9a-f]+)\)/gi)) {
  for (let code = Number(first); code < Number(end); code++) populated.add(code);
}
for (const [, list] of populate.matchAll(/\[([^\]]*)\]/g)) for (const code of list.split(',')) populated.add(Number(code));
for (const code of populated) assert.ok(inRanges(LATIN_SUBSET_RANGES, code), `subset-studio-font.py: ${formatCodePoint(code)}`);
for (const [first, last] of LATIN_SUBSET_RANGES) {
  for (let code = first; code <= last; code++) assert.ok(populated.has(code), `subset-studio-font.py misses ${formatCodePoint(code)}`);
}

// The stacks: UI subsets in front of their full faces, and no SC behind JP.
assert.match(css, /body\.studio \{\s*--font-pixel: 'NC Studio Latin', 'Fusion Pixel SC UI', 'Fusion Pixel SC', monospace;/);
assert.match(css, /:lang\(ja\) \{ --font-pixel: 'Fusion Pixel JP UI', 'Fusion Pixel JP', monospace; \}/);
assert.match(css, /@import '\.\.\/assets\/fonts\/ui\/ui-fonts\.css';/);
// Each UI face covers its locale and the menu's language buttons; SC leaves Latin to NC Studio Latin.
const [sc, jp] = UI_FACES.map(face => plan.faces.find(entry => entry.id === face.id));
for (const char of '中文日本語') {
  assert.ok(sc.codePoints.includes(char.codePointAt(0)) && jp.codePoints.includes(char.codePointAt(0)), char);
}
assert.ok(sc.codePoints.every(code => !inRanges(LATIN_SUBSET_RANGES, code)));
assert.ok([0x20, 0x41, 0xb7, 0x2018, 0x201c].every(code => jp.codePoints.includes(code)), 'JP UI draws its own Latin');
assert.ok(sc.required.length > 400 && jp.required.length > 400, 'the extraction found the locale dictionaries');
console.log(`uiFontCoverage: ${entries.length} sources; SC UI ${sc.codePoints.length}, JP UI ${jp.codePoints.length} characters;`
  + ` fallback ${FALLBACK_CODE_POINTS.map(formatCodePoint).join(' ')}`);

// ---- the check fails on each kind of mistake ----
const missingChar = '\u{2A6A5}'; // a CJK Extension B ideograph that no bundled face has
assert.equal(hasGlyph(missingChar.codePointAt(0)), false);
const failsWith = (label, mutatedEntries, mutatedFaces = cssFaces) => {
  const result = problemsFor(mutatedEntries, mutatedFaces).problems;
  assert.ok(result.length > 0, `${label} must fail the coverage check`);
  return result;
};
const i18nSource = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8');
const mutatedI18n = i18nSource.replace(/(ja: \{\s*title: ")/, `$1${missingChar}`);
assert.notEqual(mutatedI18n, i18nSource);
assert.match(failsWith('an i18n.js string', [...entries.filter(entry => entry.source !== 'src/app/i18n.js'),
  ...Object.entries(scriptText(mutatedI18n, 'i18n.js')).map(([locale, text]) => ({ source: 'src/app/i18n.js', locale, text }))]).join(), /U\+2A6A5.*i18n\.js \(ja\)/);
const studioSource = readFileSync(new URL('./studioWorkspace.js', import.meta.url), 'utf8');
const mutatedStudio = studioSource.replace("preview: '本地胶片暗房'", `preview: '本地${missingChar}'`);
assert.notEqual(mutatedStudio, studioSource);
assert.match(failsWith('a studioText string', [...entries.filter(entry => entry.source !== 'src/app/studioWorkspace.js'),
  ...Object.entries(scriptText(mutatedStudio, 'studioWorkspace.js')).map(([locale, text]) => ({ source: 'src/app/studioWorkspace.js', locale, text }))]).join(), /studioWorkspace\.js \(zh\)/);
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const mutatedHtml = html.replace('>日本語</button>', `>日本語${missingChar}</button>`);
assert.notEqual(mutatedHtml, html);
failsWith('index.html text', [...entries, { source: 'index.html', locale: 'common', text: htmlText(mutatedHtml, 'index.html').common }]);
failsWith('index.html entity', [...entries, { source: 'index.html', locale: 'common', text: htmlText('<p>&#x2A6A5;</p>', 'index.html').common }]);
failsWith('a CSS content string', [...entries, { source: 'app.css', locale: 'common', text: cssContentText('.x::after { content: "\\2A6A5"; }') }]);
assert.equal(cssContentText('a::before { content: "\\25B8 "; } b::after { content: \'▾\' }'), '▸\n▾',
  'one whitespace ends a CSS hex escape');
const withNotEqual = cssFaces.map(face => face.family === 'Fusion Pixel JP'
  ? { ...face, unicodeRange: [[0, 0x21ff], [0x2260, 0x2260], [0x230c, 0x10ffff]] } : face);
assert.match(failsWith('U+2260 in a face range', entries, withNotEqual).join(), /Fusion Pixel JP: unicode-range claims fallback U\+2260/);
const latinWithMinus = cssFaces.map(face => face.family === 'NC Studio Latin'
  ? { ...face, unicodeRange: [...face.unicodeRange, [0x2212, 0x2212]] } : face);
failsWith('U+2212 in the Latin range', entries, latinWithMinus);
console.log('uiFontCoverage: missing characters and fallback characters inside a unicode-range fail the check');
