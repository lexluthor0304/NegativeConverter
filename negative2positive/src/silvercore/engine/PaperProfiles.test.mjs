// Standalone Node test for PaperProfiles.js - run with:
// node negative2positive/src/silvercore/engine/PaperProfiles.test.mjs

import assert from 'node:assert/strict';
import {
  paperProfiles,
  paperTonings,
  PAPER_IDS,
  paperCurve,
  paperBlackLevel,
  buildPaperLuts,
  applyPaperLuts,
  paperIdsForFilmKind,
  normalizePaperId,
  normalizeToningId
} from './PaperProfiles.js';

// Every paper is well formed and its curve is monotone within [0, 1].
for (const id of PAPER_IDS) {
  const paper = paperProfiles[id];
  assert.equal(paper.id, id);
  if (paper.kind === 'none') continue;
  assert.ok(paper.dmax > paper.dmin && paper.isoR > 0 && paper.label);
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const y = paperCurve(paper, i / 100);
    assert.ok(y >= 0 && y <= 1, `${id} curve in range`);
    assert.ok(y >= previous - 1e-9, `${id} curve monotone at ${i}`);
    previous = y;
  }
  assert.ok(paperCurve(paper, 0) < 0.02 && paperCurve(paper, 1) > 0.98, `${id} curve spans the range`);
}

// Density limits: glossy blacks are deeper than matte blacks; selenium deepens Dmax.
{
  const glossy = paperBlackLevel(paperProfiles['multigrade-rc']);
  const matte = paperBlackLevel(paperProfiles['matte-fibre']);
  assert.ok(glossy < matte, `glossy black ${glossy} < matte black ${matte}`);
  assert.ok(matte > 0.02 && matte < 0.05, 'matte paper black is about 2-3 % of white');
  assert.ok(paperBlackLevel(paperProfiles['multigrade-rc'], paperTonings.selenium) < glossy, 'selenium deepens the black');
}

// LUTs: identity for "none", monotone, black lifted on matte paper, warm whites on warmtone.
{
  assert.equal(buildPaperLuts('none'), null);
  assert.equal(buildPaperLuts('does-not-exist'), null);
  const glossy = buildPaperLuts('multigrade-rc');
  const matte = buildPaperLuts('matte-fibre');
  for (const luts of [glossy, matte]) {
    for (const ch of ['r', 'g', 'b']) {
      assert.equal(luts[ch].length, 65536);
      for (let i = 1; i < 65536; i += 97) assert.ok(luts[ch][i] >= luts[ch][i - 1], 'paper LUT monotone');
    }
  }
  assert.ok(matte.g[0] > glossy.g[0], `matte black ${matte.g[0]} lifted above glossy ${glossy.g[0]}`);
  assert.ok(matte.g[0] > 65535 * 0.06, 'matte black is visibly grey');
  const warm = buildPaperLuts('multigrade-fb-warmtone');
  assert.ok(warm.r[65535] > warm.b[65535], 'warmtone paper white is yellowish');
  const cool = buildPaperLuts('multigrade-fb-cooltone');
  assert.ok(cool.b[65535] >= cool.r[65535], 'cooltone paper white is not yellow');
  // Contrast: a harder paper (Endura, ISO(R) 105) has a steeper mid-slope than a softer one (Fomatone, 120).
  const slope = (luts) => (luts.g[36000] - luts.g[30000]) / 6000;
  assert.ok(slope(buildPaperLuts('endura')) > slope(buildPaperLuts('fomatone')), 'shorter exposure range means more contrast');
  // Strength 0 is identity.
  const off = buildPaperLuts('endura', { strength: 0 });
  for (let i = 0; i < 65536; i += 4111) assert.equal(off.g[i], i);
}

// Toning tints the shadows and highlights the way the darkroom does.
{
  const plain = buildPaperLuts('multigrade-rc');
  const sepia = buildPaperLuts('multigrade-rc', { toning: 'sepia' });
  const selenium = buildPaperLuts('multigrade-rc', { toning: 'selenium' });
  const mid = 32768;
  assert.ok(sepia.r[mid] > sepia.b[mid], 'sepia mid-tones are warm');
  assert.ok(sepia.r[mid] - sepia.b[mid] > plain.r[mid] - plain.b[mid]);
  const shadow = 9000;
  assert.ok(selenium.b[shadow] >= selenium.r[shadow], 'selenium shadows are cool');
  const half = buildPaperLuts('multigrade-rc', { toning: 'sepia', toningStrength: 0.5 });
  assert.ok(half.r[mid] - half.b[mid] < sepia.r[mid] - sepia.b[mid], 'toning strength scales the tint');
  // Toning is a B&W thing: RA-4 paper ignores it.
  const colour = buildPaperLuts('crystal-archive', { toning: 'sepia' });
  assert.equal(colour.toning, 'none');
}

// Applying to an image: in place, all channels through their LUT.
{
  const image = { width: 2, height: 1, data: new Uint16Array([0, 32768, 65535, 65535, 1000, 2000, 3000, 65535]) };
  const luts = buildPaperLuts('matte-fibre');
  applyPaperLuts(image, luts);
  assert.equal(image.data[0], luts.r[0]);
  assert.equal(image.data[1], luts.g[32768]);
  assert.equal(image.data[2], luts.b[65535]);
  assert.equal(image.data[3], 65535, 'alpha untouched');
  assert.equal(image.data[4], luts.r[1000]);
  assert.equal(applyPaperLuts(image, null), image);
}

// Film kind gating and normalisation.
{
  assert.deepEqual(paperIdsForFilmKind('color'), ['none', 'crystal-archive', 'crystal-archive-matte', 'endura']);
  assert.ok(paperIdsForFilmKind('bw').includes('multigrade-rc') && !paperIdsForFilmKind('bw').includes('endura'));
  assert.deepEqual(paperIdsForFilmKind('positive'), ['none']);
  assert.equal(normalizePaperId('endura', 'bw'), 'none', 'RA-4 paper is not offered for B&W');
  assert.equal(normalizePaperId('endura', 'color'), 'endura');
  assert.equal(normalizePaperId('endura'), 'endura');
  assert.equal(normalizePaperId('nope'), 'none');
  assert.equal(normalizeToningId('sepia'), 'sepia');
  assert.equal(normalizeToningId('gold'), 'none');
}

console.log('PaperProfiles.test.mjs passed');
