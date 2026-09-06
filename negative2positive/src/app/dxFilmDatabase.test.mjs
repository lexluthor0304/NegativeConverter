// Standalone Node test for dxFilmDatabase.js - run with:
// node negative2positive/src/app/dxFilmDatabase.test.mjs

import assert from 'node:assert/strict';
import {
  loadDxFilmTable,
  dxExtractFromParts,
  classifyFilmName,
  describeDxFilm,
  shortFilmName
} from './dxFilmDatabase.js';

assert.equal(dxExtractFromParts(95, 7), 1527);
assert.equal(dxExtractFromParts(112, 1), 1793);
assert.equal(dxExtractFromParts(128, 0), null);
assert.equal(dxExtractFromParts(1, 16), null);
assert.equal(dxExtractFromParts(1.5, 0), null);

const table = await loadDxFilmTable();
assert.ok(table.size > 500, `table has ${table.size} entries`);

// Kodak Ultramax 400 (edge print "GC 400") decodes to 95-7 on the real strips
// in the repository test set; the database maps it to Ultra Max.
const ultramax = describeDxFilm(95, 7, table);
assert.equal(ultramax.dxNumber, '95-7');
assert.equal(ultramax.dxExtract, 1527);
assert.match(ultramax.primaryName, /ULTRA MAX 400/i);
assert.equal(ultramax.filmKind, 'color');
assert.equal(ultramax.presetId, 'gold-warm');

// Worked examples from the public write-ups of the edge barcode.
assert.match(describeDxFilm(112, 1, table).primaryName, /Vericolor III/i);
assert.match(describeDxFilm(40, 9, table).primaryName, /Konica/i);
assert.match(describeDxFilm(79, 2, table).primaryName, /Funtime|VR ?200|Kodacolor/i);
assert.match(describeDxFilm(79, 13, table).primaryName, /Portra 400/i);

// Unknown numbers still describe the raw code without a name.
const unknown = describeDxFilm(0, 1, table);
assert.equal(unknown.dxNumber, '0-1');
assert.equal(unknown.primaryName === null || typeof unknown.primaryName === 'string', true);
assert.deepEqual(describeDxFilm(95, 7, null).names, []);
assert.equal(describeDxFilm(95, 7, null).primaryName, null);
assert.equal(describeDxFilm(200, 0, table), null);

// Classification.
assert.deepEqual(classifyFilmName('Kodak Professional PORTRA 400 Film'), { filmKind: 'color', presetId: 'portra-classic' });
assert.deepEqual(classifyFilmName('Kodak Ektar 100'), { filmKind: 'color', presetId: 'rich-depth' });
assert.deepEqual(classifyFilmName('FUJICOLOR Superia X-TRA 400'), { filmKind: 'color', presetId: 'superia-vivid' });
assert.deepEqual(classifyFilmName('Kodak Tri-X 400 TX'), { filmKind: 'bw', presetId: 'filmic-bw' });
assert.deepEqual(classifyFilmName('Ilford HP5 Plus'), { filmKind: 'bw', presetId: 'filmic-bw' });
assert.deepEqual(classifyFilmName('Ilford XP2 Super 400'), { filmKind: 'bw', presetId: 'filmic-bw' });
assert.deepEqual(classifyFilmName('FUJICHROME Provia 100F'), { filmKind: 'positive', presetId: 'slide-neutral' });
assert.deepEqual(classifyFilmName('Fujichrome Velvia 50'), { filmKind: 'positive', presetId: 'slide-rich' });
assert.deepEqual(classifyFilmName('Kodak Ektachrome E100'), { filmKind: 'positive', presetId: 'slide-neutral' });
assert.deepEqual(classifyFilmName('Harman Phoenix 200'), { filmKind: 'color', presetId: null });
assert.deepEqual(classifyFilmName('Mystery Brand 200'), { filmKind: null, presetId: null });
assert.deepEqual(classifyFilmName(''), { filmKind: null, presetId: null });

// Short labels for badges.
assert.equal(shortFilmName('Kodak ULTRA MAX 400 Film GC400'), 'Kodak ULTRA MAX 400 GC400');
assert.equal(shortFilmName('Kodak Professional PORTRA 400 Film'), 'Kodak PORTRA 400');
assert.ok(shortFilmName('Kodak Kodacolor VR400 Plus VR400-3 VR400+ vr+').length <= 28);
assert.equal(shortFilmName('Kodak Gold Ultra 400 Film, GC135-36C-5'), 'Kodak Gold Ultra 400');
assert.equal(shortFilmName(''), '');

console.log('dxFilmDatabase.test.mjs passed');
