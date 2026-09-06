// Standalone Node test for rollProject.js - run with:
// node negative2positive/src/app/rollProject.test.mjs

import assert from 'node:assert/strict';
import {
  PROJECT_VERSION, buildRollProject, serializeRollProject, parseRollProject, migrateRollProject,
  matchProjectFiles, hashFileForProject, projectFileName, isProjectFileName
} from './rollProject.js';

const settingsA = { coreExposure: 12, curves: { r: Uint8Array.from({ length: 256 }, (_, i) => i), g: null, b: null }, frameMetadata: { frameNumber: '3', notes: '' }, localExposure: { strokes: [{ x: 0.2, y: 0.3, r: 0.1, stops: 0.5 }] } };
const files = [
  { name: 'DSC_0001.NEF', size: 30_000_000, lastModified: 1000, hash: 'aaa', settings: settingsA, selected: true },
  { name: 'DSC_0002.NEF', size: 30_000_001, lastModified: 1001, hash: 'bbb', settings: null, studioColors: { coreContrast: 5 }, selected: false }
];

// Round trip: build, serialise, parse; typed arrays become arrays, everything else is intact.
{
  const project = buildRollProject({ files, rollMetadata: { stock: 'Portra 400', iso: '400' }, rollReference: { enabled: true, settingsSnapshot: { coreExposure: 1 } }, lensCorrection: { enabled: false } });
  assert.equal(project.version, PROJECT_VERSION);
  const text = serializeRollProject(project);
  const back = parseRollProject(text);
  assert.equal(back.files.length, 2);
  assert.deepEqual(back.roll.metadata, { stock: 'Portra 400', iso: '400' });
  assert.equal(back.files[0].settings.coreExposure, 12);
  assert.equal(back.files[0].settings.curves.r.length, 256);
  assert.equal(back.files[0].settings.curves.r[200], 200, 'the LUT survives as a plain array');
  assert.deepEqual(back.files[0].settings.localExposure.strokes[0], { x: 0.2, y: 0.3, r: 0.1, stops: 0.5 });
  assert.equal(back.files[1].selected, false);
  assert.deepEqual(back.files[1].studioColors, { coreContrast: 5 });
  assert.equal(back.roll.reference.settingsSnapshot.coreExposure, 1);
  assert.deepEqual(back.files.map((f) => f.order), [0, 1]);
  // Order is restored even when the entries are shuffled on disk.
  const shuffled = JSON.parse(text); shuffled.files.reverse();
  assert.deepEqual(parseRollProject(JSON.stringify(shuffled)).files.map((f) => f.name), ['DSC_0001.NEF', 'DSC_0002.NEF']);
}

// Malformed input and newer versions fail with a reason, never silently.
{
  assert.throws(() => parseRollProject('{'), /not-json/);
  assert.throws(() => parseRollProject('[]'), /not-a-project/);
  assert.throws(() => parseRollProject('{"kind":"something-else","files":[]}'), /not-a-project/);
  assert.throws(() => parseRollProject(JSON.stringify({ kind: 'neoanaloglab-roll', version: PROJECT_VERSION + 1, files: [] })), /newer-version/);
  const parsed = parseRollProject(JSON.stringify({ kind: 'neoanaloglab-roll', version: 1, files: [{ name: 'a.png', size: 1 }, null, { size: 2 }] }));
  assert.equal(parsed.files.length, 1, 'entries without a name are dropped');
}

// The unversioned prototype layout migrates to version 1.
{
  const legacy = { frames: [{ name: 'x.png', size: 3, settings: { coreExposure: 2 } }], metadata: { stock: 'HP5' }, rollReference: { enabled: false } };
  const migrated = migrateRollProject(legacy);
  assert.equal(migrated.version, 1);
  assert.equal(migrated.files[0].name, 'x.png');
  assert.equal(migrated.files[0].selected, true);
  assert.deepEqual(migrated.roll.metadata, { stock: 'HP5' });
  const parsed = parseRollProject(JSON.stringify(legacy));
  assert.equal(parsed.version, PROJECT_VERSION);
}

// Matching: hash first, then name + size, then name alone as "changed"; the rest is missing or extra.
{
  const project = buildRollProject({ files: [
    { name: 'a.nef', size: 10, hash: 'h-a' }, { name: 'b.nef', size: 20, hash: 'h-b' }, { name: 'c.nef', size: 30, hash: 'h-c' }, { name: 'd.nef', size: 40, hash: '' }
  ] });
  const renamedA = { name: 'renamed.nef', size: 10 };
  const sameB = { name: 'b.nef', size: 20 };
  const editedC = { name: 'c.nef', size: 31 };
  const plainD = { name: 'd.nef', size: 40 };
  const stranger = { name: 'z.nef', size: 1 };
  const hashes = new Map([[renamedA, 'h-a'], [sameB, 'h-b'], [editedC, 'h-c-changed'], [plainD, ''], [stranger, 'zzz']]);
  const result = matchProjectFiles(project, [renamedA, sameB, editedC, plainD, stranger], hashes);
  assert.deepEqual(result.matched.map((m) => [m.entry.name, m.file.name]), [['a.nef', 'renamed.nef'], ['b.nef', 'b.nef'], ['d.nef', 'd.nef']]);
  assert.deepEqual(result.changed.map((m) => m.entry.name), ['c.nef'], 'same name but different content is reported as changed');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.extra.map((f) => f.name), ['z.nef']);
  const partial = matchProjectFiles(project, [sameB], hashes);
  assert.deepEqual(partial.missing.map((e) => e.name), ['a.nef', 'c.nef', 'd.nef']);
}

// Hashing covers the first megabyte plus the size, so a size change alone changes the hash.
{
  const file = new File([new Uint8Array(2000).fill(1)], 'x.bin');
  const longer = new File([new Uint8Array(2001).fill(1)], 'x.bin');
  const h1 = await hashFileForProject(file); const h2 = await hashFileForProject(file); const h3 = await hashFileForProject(longer);
  assert.equal(h1.length, 64);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
  assert.equal(projectFileName({ rollName: 'Roll 12 / test' }), 'Roll-12-test.ncroll.json');
  assert.equal(projectFileName({}), 'roll.ncroll.json');
  assert.equal(isProjectFileName('Roll-12.ncroll.json'), true);
  assert.equal(isProjectFileName('photo.json'), false);
}

console.log('rollProject.test.mjs passed');
