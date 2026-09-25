// Which characters the Studio UI can draw, and which pixel-font subset draws
// them. Shared by the build-time subsetter (build-ui-fonts.mjs) and by
// negative2positive/src/app/uiFontCoverage.test.mjs, so the test checks
// exactly what the build cuts. Text only: nothing here parses a font.
//
// Glyph sources:
// - i18n.js and every other locale map ({ zh, en, ja } object literals, such as
//   studioText in studioWorkspace.js), per locale;
// - every other string literal in the UI modules under src/app and src/ui,
//   including getLocalizedText fallbacks, and in index.html's inline scripts;
// - index.html text and attribute values, including the labels of the Chinese
//   and Japanese language buttons in the menu;
// - CSS `content` strings in src/styles.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';

export const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'negative2positive');
export const UI_LOCALES = ['zh', 'en', 'ja'];

// No bundled Fusion Pixel face has a glyph for these (nativePixelFontCoverage.js
// has nothing in U+2200–U+230B). They render in the system monospace fallback,
// as they always have, so no subset or face may claim them.
export const FALLBACK_CODE_POINTS = [0x2212, 0x2260];
// The span every full face's unicode-range leaves out, so those characters
// reach monospace without downloading a 0.7 MB face that cannot draw them.
export const FULL_FACE_GAP = [0x2200, 0x230b];

// What the committed NC Studio Latin subset covers: must match the populate()
// list in scripts/subset-studio-font.py and its unicode-range in pixel-fonts.css.
export const LATIN_SUBSET_RANGES = [
  [0x20, 0x24f], [0x2000, 0x206f], [0x2190, 0x21ff],
  [0x25b6, 0x25b6], [0x25b8, 0x25b8], [0x25bc, 0x25bc], [0x25be, 0x25be], [0x25cf, 0x25cf],
];

// Modules whose string literals never reach the screen.
const NON_UI_MODULES = new Set([
  'src/app/analogMetadata.js', // XMP packet (byte-order mark), written into exported files
  'src/app/nativePixelFontCoverage.js',
]);

// The UI subsets, each cut from its own locale face. SC is used by the default
// and zh stacks behind NC Studio Latin, so it leaves Latin to that face. The ja
// stack has no Latin face in front of it: JP draws U+00B7 and the curly quotes
// differently from SC, so JP carries its own Latin.
export const UI_FACES = [
  { id: 'sc', family: 'Fusion Pixel SC UI', postScriptName: 'FusionPixelSCUI', source: 'zh_hans', locales: ['zh', 'en'], includeLatin: false },
  { id: 'jp', family: 'Fusion Pixel JP UI', postScriptName: 'FusionPixelJPUI', source: 'ja', locales: ['ja', 'en'], includeLatin: true },
];

export const inRanges = (ranges, code) => ranges.some(([first, last]) => code >= first && code <= last);

/** Sorted code points collapsed to inclusive [first, last] ranges. */
export function toRanges(codePoints) {
  const ranges = [];
  for (const code of [...new Set(codePoints)].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && code === last[1] + 1) last[1] = code;
    else ranges.push([code, code]);
  }
  return ranges;
}

const hex = code => code.toString(16).toUpperCase().padStart(4, '0');
export const formatCodePoint = code => `U+${hex(code)}`;
export function formatUnicodeRange(ranges) {
  return ranges.map(([first, last]) => first === last ? `U+${hex(first)}` : `U+${hex(first)}-${hex(last)}`).join(', ');
}

/** Parses a CSS unicode-range value ("U+0-21FF, U+230C-10FFFF", "U+4??") into ranges. */
export function parseUnicodeRange(value) {
  return value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(part);
    if (!match) throw new Error(`Invalid unicode-range part: ${part}`);
    if (match[1].includes('?')) {
      return [parseInt(match[1].replace(/\?/g, '0'), 16), parseInt(match[1].replace(/\?/g, 'F'), 16)];
    }
    const first = parseInt(match[1], 16);
    return [first, match[2] ? parseInt(match[2], 16) : first];
  });
}

/** Every @font-face in a stylesheet: family, src and unicode-range (if any). */
export function parseFontFaces(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
    const descriptor = name => new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i').exec(body)?.[1].trim() ?? null;
    const range = descriptor('unicode-range');
    return {
      family: descriptor('font-family')?.replace(/^['"]|['"]$/g, ''),
      src: descriptor('src'),
      unicodeRange: range ? parseUnicodeRange(range) : null,
    };
  });
}

// ---- extraction ----

function walkFiles(dir, predicate, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkFiles(path, predicate, out);
    else if (predicate(name)) out.push(path);
  }
  return out;
}

function propertyName(property) {
  if (property.type !== 'Property' || property.computed) return null;
  if (property.key.type === 'Identifier') return property.key.name;
  if (property.key.type === 'Literal') return String(property.key.value);
  return null;
}

// A locale map is an object literal keyed only by UI locales (at least two).
function localeMapEntries(node) {
  if (node.type !== 'ObjectExpression' || node.properties.length < 2) return null;
  const names = node.properties.map(propertyName);
  if (names.some(name => !UI_LOCALES.includes(name))) return null;
  return node.properties.map((property, index) => [names[index], property.value]);
}

/**
 * String literals and template text of a JS source, split by locale: text
 * inside a { zh, en, ja } map goes to that locale, the rest to 'common'.
 */
export function scriptText(source, label) {
  const text = { common: [] };
  for (const locale of UI_LOCALES) text[locale] = [];
  let ast;
  try { ast = parseAst(source); } catch (error) { throw new Error(`${label}: ${error.message}`); }
  const visit = (node, locale) => {
    if (!node || typeof node.type !== 'string') return;
    const map = localeMapEntries(node);
    if (map) {
      for (const [name, value] of map) visit(value, name);
      return;
    }
    if (node.type === 'Literal' && typeof node.value === 'string') text[locale].push(node.value);
    else if (node.type === 'TemplateElement') text[locale].push(node.value.cooked ?? node.value.raw);
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) for (const child of value) visit(child, locale);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, locale);
    }
  };
  visit(ast, 'common');
  return Object.fromEntries(Object.entries(text).map(([locale, parts]) => [locale, parts.join('\n')]));
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
function decodeEntities(text, label) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (entity, body) => {
    if (body[0] === '#') return String.fromCodePoint(body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1)));
    const named = NAMED_ENTITIES[body.toLowerCase()];
    // An unknown entity would silently drop its character from the subsets.
    if (named === undefined) throw new Error(`${label}: add the HTML entity ${entity} to ui-font-glyphs.mjs`);
    return named;
  });
}

/** Rendered text of an HTML page: text nodes, attribute values and inline-script literals. */
export function htmlText(html, label) {
  const scripts = [];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_, attributes, code) => {
      // JSON-LD and other data blocks are never drawn; inline scripts may set text.
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1].toLowerCase();
      if (!type || type === 'module' || type === 'text/javascript') scripts.push(code);
      return ' ';
    })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  const parts = [];
  for (const [, tag] of body.matchAll(/<([^>]*)>/g)) {
    for (const [, , double, single, bare] of tag.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      parts.push(double ?? single ?? bare);
    }
  }
  parts.push(body.replace(/<[^>]*>/g, ' '));
  const text = { common: decodeEntities(parts.join('\n'), label) };
  for (const code of scripts) {
    const inline = scriptText(code, `${label} inline script`);
    for (const [locale, value] of Object.entries(inline)) text[locale] = [text[locale], value].filter(Boolean).join('\n');
  }
  return text;
}

/** Strings of every CSS `content` declaration, with CSS escapes resolved. */
export function cssContentText(css) {
  const strings = [];
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, value] of source.matchAll(/(?:^|[;{\s])content\s*:\s*([^;}]+)/g)) {
    for (const [, double, single] of value.matchAll(/"((?:[^"\\]|\\[\s\S])*)"|'((?:[^'\\]|\\[\s\S])*)'/g)) {
      strings.push((double ?? single).replace(/\\([0-9a-f]{1,6})\s?|\\([\s\S])/gi,
        (_, code, char) => code ? String.fromCodePoint(parseInt(code, 16)) : char === '\n' ? '' : char));
    }
  }
  return strings.join('\n');
}

/**
 * Every glyph source, as { source, locale, text } with locale 'common' for text
 * that any UI language can show.
 */
export function collectUiText(root = APP_ROOT) {
  const entries = [];
  const add = (source, texts) => {
    for (const [locale, text] of Object.entries(texts)) if (text) entries.push({ source, locale, text });
  };
  const rel = path => relative(root, path).split('\\').join('/');
  for (const dir of ['src/app', 'src/ui']) {
    for (const path of walkFiles(join(root, dir), name => name.endsWith('.js') && !name.includes('.test.'))) {
      if (NON_UI_MODULES.has(rel(path))) continue;
      add(rel(path), scriptText(readFileSync(path, 'utf8'), rel(path)));
    }
  }
  add('index.html', htmlText(readFileSync(join(root, 'index.html'), 'utf8'), 'index.html'));
  for (const path of walkFiles(join(root, 'src/styles'), name => name.endsWith('.css'))) {
    add(rel(path), { common: cssContentText(readFileSync(path, 'utf8')) });
  }
  return entries;
}

/** The source files collectUiText reads, for dev-server regeneration. */
export function isGlyphSource(file, root = APP_ROOT) {
  const path = relative(root, file).split('\\').join('/');
  if (path === 'index.html') return true;
  if (/^src\/styles\/.+\.css$/.test(path)) return true;
  return /^src\/(app|ui)\/.+\.js$/.test(path) && !path.includes('.test.') && !NON_UI_MODULES.has(path);
}

/** Drawable code points of a text: controls and line breaks are never glyphs. */
export function codePointsOf(text) {
  const codes = new Set();
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) continue;
    codes.add(code);
  }
  return codes;
}

/**
 * What each UI face covers. `hasGlyph(code, faceId)` answers from that face's
 * source cmap; the default assumes every glyph exists, which is how the build
 * asks HarfBuzz for a draft before reading back what the face really has.
 *
 * Per face: `required` are the UI code points it must draw, `codePoints` what
 * it will contain (required plus JP's Latin fill, both limited to the face),
 * and `ranges` those collapsed for its unicode-range. `missing` maps every UI
 * code point no face has to the sources that use it; `unexpected` is the part
 * of it that is not on the fallback list, which fails the build and the test.
 */
export function planUiFaces(entries, hasGlyph = () => true) {
  const missing = new Map();
  const faces = UI_FACES.map(face => {
    const required = new Set();
    const codes = new Set();
    for (const entry of entries) {
      if (entry.locale !== 'common' && !face.locales.includes(entry.locale)) continue;
      for (const code of codePointsOf(entry.text)) {
        if (!face.includeLatin && inRanges(LATIN_SUBSET_RANGES, code)) continue;
        if (!hasGlyph(code, face.id)) {
          if (!missing.has(code)) missing.set(code, new Set());
          missing.get(code).add(`${entry.source}${entry.locale === 'common' ? '' : ` (${entry.locale})`}`);
          continue;
        }
        required.add(code);
        codes.add(code);
      }
    }
    if (face.includeLatin) {
      for (const [first, last] of LATIN_SUBSET_RANGES) {
        for (let code = first; code <= last; code++) {
          if (!FALLBACK_CODE_POINTS.includes(code) && hasGlyph(code, face.id)) codes.add(code);
        }
      }
    }
    const sorted = [...codes].sort((a, b) => a - b);
    return { ...face, required: [...required].sort((a, b) => a - b), codePoints: sorted, ranges: toRanges(sorted) };
  });
  const unexpected = [...missing].filter(([code]) => !FALLBACK_CODE_POINTS.includes(code))
    .map(([code, sources]) => ({ code, sources: [...sources].sort() }))
    .sort((a, b) => a.code - b.code);
  return { faces, missing: new Map([...missing].sort(([a], [b]) => a - b)), unexpected };
}
