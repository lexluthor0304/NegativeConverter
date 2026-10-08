import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fontverter from 'fontverter';
import { buildUiFonts, readCmap, renameFamily, uiFontsPlugin } from '../../../scripts/build-ui-fonts.mjs';
import { UI_FACES, parseFontFaces } from '../../../scripts/ui-font-glyphs.mjs';

// Runs the real build-time subsetter (#262) into a scratch directory and reads
// its output back: the sfnt it writes is valid, renamed, and covers exactly the
// unicode-range its @font-face declares.
function tables(sfnt) {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const out = new Map();
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16;
    out.set(String.fromCharCode(...sfnt.subarray(at, at + 4)), { checksum: view.getUint32(at + 4), offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return out;
}
const checksum = bytes => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) sum = (sum + ((bytes[i] << 24) | ((bytes[i + 1] ?? 0) << 16) | ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0))) >>> 0;
  return sum;
};
function names(sfnt) {
  const name = tables(sfnt).get('name');
  const view = new DataView(sfnt.buffer, sfnt.byteOffset + name.offset, name.length);
  const storage = view.getUint16(4);
  const out = {};
  for (let i = 0; i < view.getUint16(2); i++) {
    const [platform, , , id, length, offset] = [0, 2, 4, 6, 8, 10].map(k => view.getUint16(6 + i * 12 + k));
    const bytes = sfnt.subarray(name.offset + storage + offset, name.offset + storage + offset + length);
    out[id] = platform === 1 ? String.fromCharCode(...bytes) : String.fromCharCode(...Array.from({ length: length / 2 }, (_, k) => (bytes[k * 2] << 8) | bytes[k * 2 + 1]));
  }
  return out;
}

const outputDir = mkdtempSync(join(tmpdir(), 'nc-ui-fonts-'));
try {
  const first = await buildUiFonts({ outputDir });
  assert.equal(first.changed, true);
  const css = readFileSync(join(outputDir, 'ui-fonts.css'), 'utf8');
  const declared = parseFontFaces(css);
  assert.deepEqual(declared.map(face => face.family), UI_FACES.map(face => face.family));
  for (const face of UI_FACES) {
    const file = first.faces.find(entry => entry.id === face.id).file;
    const woff2 = readFileSync(join(outputDir, file));
    assert.equal(woff2.subarray(0, 4).toString(), 'wOF2', file);
    assert.ok(woff2.length < 40 * 1024, `${file}: ${woff2.length} bytes`);
    const sfnt = new Uint8Array(await fontverter.convert(woff2, 'sfnt'));
    // The declared unicode-range is exactly the subset's cmap.
    const range = declared.find(entry => entry.family === face.family).unicodeRange;
    const cmap = [...readCmap(sfnt)].sort((a, b) => a - b);
    assert.deepEqual(range.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)), cmap, face.family);
    assert.match(css, new RegExp(`src: url\\('\\./${file}'\\) format\\('woff2'\\)`));
    // Renamed like subset-studio-font.py: the page and CDP can tell the subset from the full face.
    const named = names(sfnt);
    assert.equal(named[1], face.family);
    assert.equal(named[4], face.family);
    assert.equal(named[6], face.postScriptName);
    assert.ok(tables(sfnt).has('GPOS') && tables(sfnt).has('CFF '), 'layout and outlines kept');
  }
  // The rewritten sfnt carries valid table checksums and head.checkSumAdjustment.
  const source = new Uint8Array(await fontverter.convert(readFileSync(join(outputDir, first.faces[0].file)), 'sfnt'));
  const renamed = renameFamily(source, 'Test Family', 'TestPS');
  for (const [tag, entry] of tables(renamed)) {
    const data = Uint8Array.from(renamed.subarray(entry.offset, entry.offset + entry.length));
    if (tag === 'head') data.fill(0, 8, 12);
    assert.equal(checksum(data), entry.checksum, tag);
  }
  assert.equal(checksum(renamed), 0xb1b0afba);
  assert.equal(names(renamed)[6], 'TestPS');
  assert.deepEqual([...readCmap(renamed)], [...readCmap(source)]);
  // Unchanged sources skip the HarfBuzz work.
  assert.equal((await buildUiFonts({ outputDir })).changed, false);

  const plugin = uiFontsPlugin();
  assert.equal(plugin.name, 'nc-ui-fonts');
  assert.equal(typeof plugin.buildStart, 'function');
  assert.equal(typeof plugin.configureServer, 'function');
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
console.log('uiFontBuild: valid renamed WOFF2 subsets whose cmap matches the declared unicode-range');
