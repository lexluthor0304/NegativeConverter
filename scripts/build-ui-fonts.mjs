// Per-locale UI font subsets, generated at build time (#262).
//
// The Studio used to draw its zh or ja UI from a whole 36k-glyph Fusion Pixel
// face (0.66 MB) for about 700 distinct characters. This cuts, from each
// locale face, only the characters the UI sources contain (ui-font-glyphs.mjs)
// with HarfBuzz hb-subset, keeping every layout feature and the hinting,
// renames the family the way subset-studio-font.py does, and writes WOFF2 plus
// an @font-face partial with the matching unicode-range into the git-ignored
// src/assets/fonts/ui/. pixel-fonts.css imports that partial and keeps the full
// faces behind the subsets, so a character outside them (a CJK file name)
// costs a download, never a wrong glyph.
//
// Runs as a Vite plugin at buildStart for dev and build, so dev:web,
// build:web, tauri:dev and the smoke tests always have fresh output. Also:
//   node scripts/build-ui-fonts.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fontverter from 'fontverter';
import subsetFont from 'subset-font';
import {
  APP_ROOT, FALLBACK_CODE_POINTS, LATIN_SUBSET_RANGES, UI_FACES, collectUiText, formatCodePoint, formatUnicodeRange,
  inRanges, isGlyphSource, planUiFaces,
} from './ui-font-glyphs.mjs';

export const OUTPUT_CSS = 'ui-fonts.css';
const sourceFontDir = root => join(root, 'src/assets/fonts/fusion-pixel');
const sourceFontPath = (root, source) => join(sourceFontDir(root), `fusion-pixel-12px-proportional-${source}.otf.woff2`);
const outputFontName = face => `fusion-pixel-${face.id}-ui.woff2`;

// ---- minimal sfnt reading and writing (name and cmap tables only) ----

function readSfnt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map();
  for (let i = 0, count = view.getUint16(4); i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8);
    tables.set(tag, bytes.subarray(offset, offset + view.getUint32(at + 12)));
  }
  return { version: view.getUint32(0), tables };
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    sum = (sum + ((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  }
  return sum;
}

function writeSfnt({ version, tables }) {
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const count = entries.length;
  const selector = Math.floor(Math.log2(count));
  let size = 12 + count * 16;
  const offsets = entries.map(([, data]) => { const offset = size; size += (data.length + 3) & ~3; return offset; });
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, version);
  view.setUint16(4, count);
  view.setUint16(6, 16 * 2 ** selector);
  view.setUint16(8, selector);
  view.setUint16(10, count * 16 - 16 * 2 ** selector);
  let headOffset = -1;
  entries.forEach(([tag, data], index) => {
    const at = 12 + index * 16;
    for (let k = 0; k < 4; k++) out[at + k] = tag.charCodeAt(k);
    out.set(data, offsets[index]);
    // head.checkSumAdjustment counts as zero in every checksum.
    if (tag === 'head') { headOffset = offsets[index]; view.setUint32(headOffset + 8, 0); }
    view.setUint32(at + 4, checksum(out.subarray(offsets[index], offsets[index] + data.length)));
    view.setUint32(at + 8, offsets[index]);
    view.setUint32(at + 12, data.length);
  });
  if (headOffset >= 0) view.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** Rewrites name IDs 1, 4, 16 (family) and 6 (PostScript), as subset-studio-font.py does. */
export function renameFamily(sfnt, family, postScriptName) {
  const font = readSfnt(sfnt);
  const name = font.tables.get('name');
  const view = new DataView(name.buffer, name.byteOffset, name.byteLength);
  if (view.getUint16(0) !== 0) throw new Error('Only name table format 0 is supported');
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  const encode = (text, platform) => platform === 1
    ? Uint8Array.from(text, char => char.charCodeAt(0))
    : Uint8Array.from([...text].flatMap(char => [char.charCodeAt(0) >> 8, char.charCodeAt(0) & 255]));
  const records = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map(k => view.getUint16(at + k));
    const replacement = id === 6 ? postScriptName : [1, 4, 16].includes(id) ? family : null;
    records.push({ platform, encoding, language, id,
      bytes: replacement === null ? name.subarray(storage + offset, storage + offset + length) : encode(replacement, platform) });
  }
  const header = 6 + count * 12;
  const table = new Uint8Array(header + records.reduce((sum, record) => sum + record.bytes.length, 0));
  const out = new DataView(table.buffer);
  out.setUint16(2, count);
  out.setUint16(4, header);
  let offset = 0;
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, offset]
      .forEach((value, k) => out.setUint16(at + k * 2, value));
    table.set(record.bytes, header + offset);
    offset += record.bytes.length;
  });
  font.tables.set('name', table);
  return writeSfnt(font);
}

/** Code points mapped to a glyph, from a format 12 (or else format 4) cmap subtable. */
export function readCmap(sfnt) {
  const cmap = readSfnt(sfnt).tables.get('cmap');
  const view = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const subtables = [];
  for (let i = 0, count = view.getUint16(2); i < count; i++) {
    const offset = view.getUint32(4 + i * 8 + 4);
    subtables.push({ offset, format: view.getUint16(offset) });
  }
  const codes = new Set();
  const full = subtables.find(table => table.format === 12);
  if (full) {
    for (let i = 0, groups = view.getUint32(full.offset + 12); i < groups; i++) {
      const at = full.offset + 16 + i * 12;
      const first = view.getUint32(at), last = view.getUint32(at + 4), glyph = view.getUint32(at + 8);
      for (let code = first; code <= last; code++) if (glyph + code - first) codes.add(code);
    }
    return codes;
  }
  const bmp = subtables.find(table => table.format === 4);
  if (!bmp) throw new Error('No format 12 or format 4 cmap subtable');
  const segments = view.getUint16(bmp.offset + 6) / 2;
  const ends = bmp.offset + 14, starts = ends + segments * 2 + 2, deltas = starts + segments * 2, ranges = deltas + segments * 2;
  for (let s = 0; s < segments; s++) {
    const end = view.getUint16(ends + s * 2), start = view.getUint16(starts + s * 2);
    const delta = view.getUint16(deltas + s * 2), rangeOffset = view.getUint16(ranges + s * 2);
    for (let code = start; code <= end && code !== 0xffff; code++) {
      let glyph = 0;
      if (!rangeOffset) glyph = (code + delta) & 0xffff;
      else {
        const index = view.getUint16(ranges + s * 2 + rangeOffset + (code - start) * 2);
        glyph = index ? (index + delta) & 0xffff : 0;
      }
      if (glyph) codes.add(code);
    }
  }
  return codes;
}

// ---- generation ----

function fontFaceCss(face) {
  return [
    '@font-face {',
    `  font-family: '${face.family}';`,
    `  src: url('./${outputFontName(face)}') format('woff2');`,
    '  font-style: normal;',
    '  font-weight: 400;',
    '  font-display: swap;',
    `  unicode-range: ${formatUnicodeRange(face.ranges)};`,
    '}',
  ].join('\n');
}

function writeIfChanged(path, content) {
  if (existsSync(path) && Buffer.compare(readFileSync(path), Buffer.from(content)) === 0) return false;
  writeFileSync(path, content);
  return true;
}

function describeUnexpected(unexpected) {
  return unexpected.map(({ code, sources }) => `${formatCodePoint(code)} ${String.fromCodePoint(code)} (${sources.join(', ')})`).join('; ');
}

/**
 * Cuts the UI subsets and their CSS. Returns a summary per face. Skips the
 * HarfBuzz work when neither the characters, the source faces nor this
 * generator changed since the last run.
 */
export async function buildUiFonts({ root = APP_ROOT, outputDir = join(root, 'src/assets/fonts/ui'), log = () => {} } = {}) {
  const entries = collectUiText(root);
  const draft = planUiFaces(entries);
  const sources = new Map(draft.faces.map(face => [face.id, readFileSync(sourceFontPath(root, face.source))]));
  const stamp = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .update(readFileSync(fileURLToPath(new URL('./ui-font-glyphs.mjs', import.meta.url))))
    .update(JSON.stringify(entries));
  for (const bytes of sources.values()) stamp.update(bytes);
  const latinFont = readFileSync(join(sourceFontDir(root), 'nc-studio-latin.woff2'));
  stamp.update(latinFont);
  const digest = stamp.digest('hex');
  const stampPath = join(outputDir, '.stamp');
  const cssPath = join(outputDir, OUTPUT_CSS);
  if (existsSync(stampPath) && readFileSync(stampPath, 'utf8') === digest && existsSync(cssPath)
      && draft.faces.every(face => existsSync(join(outputDir, outputFontName(face))))) {
    return { changed: false, faces: [] };
  }

  const subsets = new Map();
  const cmaps = new Map();
  for (const face of draft.faces) {
    const text = String.fromCodePoint(...face.codePoints);
    const sfnt = new Uint8Array(await subsetFont(sources.get(face.id), text, { targetFormat: 'sfnt' }));
    subsets.set(face.id, sfnt);
    cmaps.set(face.id, readCmap(sfnt));
  }
  // A UI character the face drawing it lacks is allowed only on the explicit
  // fallback list, which the full faces' unicode-range also leaves out. In the
  // SC stack, Latin-range characters are drawn by the committed NC Studio Latin.
  const latinCmap = readCmap(new Uint8Array(await fontverter.convert(latinFont, 'sfnt')));
  const leavesLatin = new Set(UI_FACES.filter(face => !face.includeLatin).map(face => face.id));
  const plan = planUiFaces(entries, (code, id) => (leavesLatin.has(id) && inRanges(LATIN_SUBSET_RANGES, code)
    ? latinCmap : cmaps.get(id)).has(code));
  if (plan.unexpected.length) {
    throw new Error(`UI characters missing from the Fusion Pixel faces: ${describeUnexpected(plan.unexpected)}. `
      + `Use a character the faces have, or add it to FALLBACK_CODE_POINTS in scripts/ui-font-glyphs.mjs `
      + `(it then renders in monospace, and must stay outside every face's unicode-range).`);
  }
  mkdirSync(outputDir, { recursive: true });
  const summary = [];
  const css = [
    '/* Generated by scripts/build-ui-fonts.mjs at dev/build start: do not edit or commit. */',
    `/* Characters no face has, left to monospace: ${FALLBACK_CODE_POINTS.map(formatCodePoint).join(', ')}. */`,
  ];
  for (const face of plan.faces) {
    const present = [...cmaps.get(face.id)].sort((a, b) => a - b);
    if (present.join() !== face.codePoints.join()) throw new Error(`${face.family}: subset cmap differs from the plan`);
    const renamed = renameFamily(subsets.get(face.id), face.family, face.postScriptName);
    const woff2 = await fontverter.convert(Buffer.from(renamed), 'woff2', 'sfnt');
    writeIfChanged(join(outputDir, outputFontName(face)), woff2);
    css.push(fontFaceCss(face));
    summary.push({ id: face.id, family: face.family, file: outputFontName(face), bytes: woff2.length, codePoints: face.codePoints.length });
    log(`${face.family}: ${face.codePoints.length} characters, ${woff2.length} bytes`);
  }
  writeIfChanged(cssPath, `${css.join('\n')}\n`);
  writeFileSync(stampPath, digest);
  return { changed: true, faces: summary };
}

/** Vite plugin: fresh subsets before any module is served or bundled. */
export function uiFontsPlugin() {
  let running = Promise.resolve();
  const run = logger => {
    // One run at a time; a failed run must not block the next one.
    running = running.catch(() => {}).then(() => buildUiFonts({ log: message => logger?.info(`[ui-fonts] ${message}`) }));
    return running;
  };
  return {
    name: 'nc-ui-fonts',
    async buildStart() {
      await run(this.environment?.logger);
    },
    configureServer(server) {
      // A new UI string in dev regenerates the subsets; the rewritten partial
      // then reaches the page through normal CSS hot reload.
      let timer = null;
      server.watcher.on('change', file => {
        if (!isGlyphSource(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          run(server.config.logger).catch(error => server.config.logger.error(`[ui-fonts] ${error.message}`));
        }, 200);
      });
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await buildUiFonts({ log: console.log });
  if (!result.changed) console.log('UI font subsets are up to date');
}
