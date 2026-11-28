// node negative2positive/src/app/edgeMarkingStyles.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  EDGE_MARKING_STYLES, EDGE_STYLE_IDS, EDGE_STYLE_MENU, EDGE_STYLE_LABEL_KEYS, LEFT_OUT_BRANDS,
  applyEdgeMarkingStyle, edgeMarkingStyle, edgeStyleForFilmName, edgeTextForFilmName, edgeTextForFrame,
  normalizeEdgeStyleId, resolveAutoEdgeStyle
} from './edgeMarkingStyles.js';
import { EDGE_GLYPH_SETS, hasEdgeGlyphs, rasterizeEdgeGlyph, edgeGlyphText } from './edgeGlyphs.js';

const here = new URL('.', import.meta.url).pathname;

// Every style is complete, and ids are unique.
const ids = EDGE_MARKING_STYLES.map((style) => style.id);
assert.equal(new Set(ids).size, ids.length, 'ids are unique');
assert.equal(new Set(EDGE_STYLE_IDS).size, EDGE_STYLE_IDS.length);
assert.deepEqual([...EDGE_STYLE_MENU].sort(), [...EDGE_STYLE_IDS].sort(), 'the dropdown lists every id');
for (const style of EDGE_MARKING_STYLES) {
  for (const field of ['id', 'labelKey', 'text', 'stocks', 'letteringColor', 'dx', 'anchorPerf', 'dxGeometry', 'elements', 'alternates']) {
    assert.ok(style[field] !== undefined, `${style.id}.${field}`);
  }
  assert.match(style.letteringColor, /^#[0-9a-f]{6}$/);
  assert.ok(style.dx[0] >= 0 && style.dx[0] <= 126 && style.dx[1] >= 0 && style.dx[1] <= 15);
  assert.ok(style.elements.length > 0);
  for (const element of style.elements) {
    assert.ok(['number', 'halfNumber', 'label', 'code', 'text', 'dx', 'arrow', 'triangle', 'outlineArrow', 'stripes', 'keyNumber', 'barcode', 'dash'].includes(element.kind), element.kind);
    if (element.kind === 'stripes') {
      // Stripes are per stock: each listed stock has one, with sane geometry.
      for (const stripe of Object.values(style.stripes).flat()) {
        assert.ok(stripe.period > 0 && stripe.on[1] > stripe.on[0] && stripe.widthMm > 0 && Math.abs(stripe.offsetMm) < 1.4, style.id);
        assert.match(stripe.color, /^#[0-9a-f]{6}$/);
      }
      continue;
    }
    assert.ok(['top', 'bottom'].includes(element.edge));
    assert.ok(Number.isFinite(element.at));
    if (element.from) {
      // Every marking lies in the 5.49 mm band between the film edge and the picture.
      assert.ok(element.from[0] >= 0 && element.from[1] > element.from[0] && element.from[1] < 5.49, `${style.id} ${element.kind}`);
    }
    if (element.glyphs) assert.ok(EDGE_GLYPH_SETS[element.glyphs], element.glyphs);
  }
  // The style's own texts and suggestions are drawable in its letters.
  const textElement = style.elements.find((element) => element.kind === 'text' || element.kind === 'keyNumber');
  for (const text of [style.text, ...style.stocks, ...Object.values(style.alternates)].filter(Boolean)) {
    assert.ok(hasEdgeGlyphs(textElement.glyphs, text), `${style.id}: "${text}"`);
  }
}
assert.ok(EDGE_STYLE_LABEL_KEYS.auto && EDGE_STYLE_LABEL_KEYS.custom);

// Unknown ids are custom; the stored ids keep their names.
assert.equal(normalizeEdgeStyleId('kodakColor'), 'kodakColor');
assert.equal(normalizeEdgeStyleId('auto'), 'auto');
assert.equal(normalizeEdgeStyleId(undefined), 'custom');
assert.equal(normalizeEdgeStyleId('agfa'), 'custom');
assert.equal(normalizeEdgeStyleId('nonsense'), 'custom');
assert.equal(edgeMarkingStyle('custom'), null);
assert.equal(edgeMarkingStyle('auto'), null);

// Every stock the edge-text reader knows has an answer: a style, or one of the
// brands left out for want of evidence (they draw the border as before).
const readerSource = fs.readFileSync(`${here}filmEdgeText.js`, 'utf8');
const stocks = JSON.parse(readerSource.match(/const STOCKS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
assert.ok(stocks.length > 20);
const unbranded = [];
for (const stock of stocks) {
  const id = edgeStyleForFilmName(stock);
  if (id) assert.ok(edgeMarkingStyle(id), stock);
  else unbranded.push(stock);
}
assert.deepEqual(unbranded.sort(), [
  'KENTMERE', 'LOMOGRAPHY', 'SUPERIA', 'SUPERIA 400', 'EKTACHROME'
].sort(), 'stocks without a style are exactly the brands left out');
assert.ok(LEFT_OUT_BRANDS.includes('KENTMERE') && !LEFT_OUT_BRANDS.includes('KODAK VISION3'));
assert.ok(!LEFT_OUT_BRANDS.includes('FOMAPAN'));
assert.equal(edgeStyleForFilmName('Kodak ULTRA MAX 400 Film GC400'), 'kodakColor');
assert.equal(edgeStyleForFilmName('Kodak EKTAR 100'), 'kodakColor');
assert.equal(edgeStyleForFilmName('KODAK PORTRA 400'), 'kodakColor');
assert.equal(edgeStyleForFilmName('Kodak Tri-X 400'), 'kodakBw');
assert.equal(edgeStyleForFilmName('Kodak T-Max 400'), 'kodakBw');
assert.equal(edgeStyleForFilmName('Kodak Ektachrome E100'), 'kodakSlide');
assert.equal(edgeStyleForFilmName('Fujicolor Superia 200'), 'fujiColor');
assert.equal(edgeStyleForFilmName('Fujicolor Pro 400H'), 'fujiColor');
// C200 prints "200", Superia X-TRA 400 "S-400", each with its own stripes.
assert.equal(edgeStyleForFilmName('Fujifilm Superia X-TRA 400'), 'fujiColor');
assert.equal(edgeTextForFilmName('FUJICOLOR SUPERIA X-TRA 400 CH 4th color layer X-TRA400'), 'S-400');
assert.equal(edgeTextForFilmName('Fujicolor C200 135'), '200');
assert.equal(edgeStyleForFilmName('Fujicolor Superia X-tra 800'), null, 'X-TRA 800 was not seen');
assert.equal(edgeStyleForFilmName('AGFA AGFACOLOR HDC200'), null);
assert.equal(edgeStyleForFilmName('Kodak C200'), null);
for (const stock of ['200', 'S-400']) {
  const stripes = edgeMarkingStyle('fujiColor').stripes[stock];
  // One continuous line and lines on for four perforations of eight.
  assert.ok(stripes.some((stripe) => stripe.on[1] - stripe.on[0] === stripe.period), stock);
  assert.ok(stripes.some((stripe) => stripe.period === 8 && Math.abs(stripe.on[1] - stripe.on[0] - 4) < 1e-9), stock);
}
assert.equal(edgeTextForFilmName('Fujicolor Pro 400H'), 'PRO400H');
assert.deepEqual(Object.keys(edgeMarkingStyle('fujiColor').stripes).sort(), ['200', 'PRO400H', 'S-200', 'S-400']);
assert.equal(edgeTextForFilmName('Kodak Tri-X 400'), 'KODAK 400TX');
assert.equal(edgeTextForFilmName('Kodak T-Max 400'), 'KODAK 400-2TMY');
assert.equal(edgeTextForFilmName('Kodak Portra 800'), 'KODAK PORTRA 800-3');
assert.equal(edgeTextForFilmName('Kodak Gold 200'), 'KODAK GB 200-7');
assert.equal(edgeTextForFilmName('Kodak ColorPlus 200'), 'KODAK 200-8');
assert.equal(edgeTextForFrame(edgeMarkingStyle('kodakColor'), 'KODAK GB 200-7', 17), 'GB 200-7 KODAK');
assert.equal(edgeTextForFrame(edgeMarkingStyle('kodakColor'), 'KODAK PORTRA 400', 17), 'KODAK PORTRA 400');
assert.equal(edgeStyleForFilmName('Kodak Vision3 500T'), 'kodakVision3');
assert.equal(edgeStyleForFilmName('Ilford HP5 PLUS 400 HP5+ (black box)'), 'ilford');
assert.equal(edgeStyleForFilmName('Kentmere 400'), null);
assert.equal(edgeStyleForFilmName('FUJICHROME PROVIA 100F RDP III Professional RDPIII'), 'fujiSlide');
assert.equal(edgeStyleForFilmName(''), null);

// What each film prints, where the references show it.
assert.equal(edgeTextForFilmName('Kodak ULTRA MAX 400 Film GC400'), 'KODAK GC 400');
assert.equal(edgeTextForFilmName('Kodak EKTAR 100'), 'KODAK EKTAR 100');
assert.equal(edgeTextForFilmName('FUJICHROME PROVIA 100F RDP III Professional RDPIII'), 'FUJI RDPIII');
assert.equal(edgeTextForFilmName('Ilford HP5 PLUS 400 HP5+ (white box)'), 'ILFORD HP5 PLUS');
// Delta 400 Pro's own layout rests on one image: not a verified edge print,
// so a Delta film gets the HP5 Plus layout with its trade name.
assert.equal(edgeTextForFilmName('Ilford Delta 400 Pro D400'), 'ILFORD DELTA 400 PRO D400');
assert.ok(!edgeMarkingStyle('ilford').stocks.some((stock) => stock.includes('DELTA')));
// Ilford current production: DX code, a wedge before "nA", the emulsion code after the text.
const ilford = edgeMarkingStyle('ilford');
assert.equal(ilford.dxEnabled, true);
assert.ok(ilford.elements.some((element) => element.kind === 'dx') && ilford.elements.some((element) => element.kind === 'triangle'));
assert.equal(ilford.codes['ILFORD HP5 PLUS'], '5051-11');
assert.equal(ilford.letteringColor, '#ffffff');
// Kodak black-and-white and slide films print no DX code.
for (const id of ['kodakBw', 'kodakSlide']) assert.ok(!edgeMarkingStyle(id).elements.some((element) => element.kind === 'dx'), id);
// A 5 is open on its left between the stem and the bowl (it must not read as
// a 6 at a dozen pixels): somewhere in the left column between 0.45 and 0.75
// of the height a 5 shows film where a 6 is solid ink, in every set.
for (const set of ['grotesk', 'grid']) {
  const leftColumnMin = (char) => {
    const g = rasterizeEdgeGlyph(set, char, { capPx: 40, stroke: 0.28 });
    const x = g.originX + Math.round(g.advance * 0.1);
    let min = 1;
    for (let y = Math.round(40 * 0.45); y <= Math.round(40 * 0.75); y++) min = Math.min(min, g.mask[(g.originY + y) * g.width + x]);
    return min;
  };
  assert.ok(leftColumnMin('6') > 0.5 && leftColumnMin('5') < 0.2, `${set}: 5 and 6 differ on the left (${leftColumnMin('5')} vs ${leftColumnMin('6')})`);
}
assert.equal(edgeTextForFilmName('Kodak Portra 400'), 'KODAK PORTRA 400');
assert.equal(edgeTextForFilmName('Ilford FP4 Plus'), 'ILFORD FP4 PLUS');
assert.equal(edgeTextForFilmName('Kodak Gold Ultra 400 Film, GC135-36C-5'), 'KODAK GOLD ULTRA 400');

// Ultra Max turns its text round on odd frames (frames 21, 31 and 35 of the
// reference strips print "GC 400 KODAK", 30 and 36 "KODAK GC 400"); Ektar does not.
const kodak = edgeMarkingStyle('kodakColor');
assert.equal(edgeTextForFrame(kodak, 'KODAK GC 400', 31), 'GC 400 KODAK');
assert.equal(edgeTextForFrame(kodak, 'KODAK GC 400', 36), 'KODAK GC 400');
assert.equal(edgeTextForFrame(kodak, 'KODAK EKTAR 100', 31), 'KODAK EKTAR 100');
// Provia: "FUJI RDPⅢ" after frames 9, 11 and 35, "RDPⅢ-043" after 10 and 34.
const fuji = edgeMarkingStyle('fujiSlide');
assert.equal(edgeTextForFrame(fuji, 'FUJI RDPIII', 9), 'FUJI RDPIII');
assert.equal(edgeTextForFrame(fuji, 'FUJI RDPIII', 10), 'RDPIII-043');
assert.equal(edgeGlyphText('grid', 'FUJI RDPIII-043'), 'FUJI RDPⅢ-043');

// Fomapan (current print): a number every four perforations, no DX, no
// "A"; the name, speed and batch number once every 24 numbers, each from
// the number that leaves 3, the speed and batch digits at a fixed pitch.
const foma = edgeMarkingStyle('fomapan');
assert.equal(edgeStyleForFilmName('Foma Fomapan 400 ProfiLine Action T400'), 'fomapan');
assert.equal(edgeStyleForFilmName('Fomapan 100 Classic'), 'fomapan');
assert.equal(edgeStyleForFilmName('Foma Retropan 320'), null);
assert.equal(edgeTextForFilmName('Foma Fomapan 400 ProfiLine Action T400'), 'FOMAPAN 400');
assert.equal(edgeTextForFilmName('Fomapan 100 Classic'), 'FOMAPAN 100');
assert.equal(resolveAutoEdgeStyle({ filmNames: ['FOMAPAN'] }).style, 'fomapan');
assert.equal(foma.numberEvery, 4);
assert.equal(foma.dxEnabled, false);
assert.ok(!foma.elements.some((element) => ['dx', 'halfNumber', 'arrow', 'triangle'].includes(element.kind)));
for (const element of foma.elements.filter((e) => e.edge === 'top')) assert.deepEqual([element.every, element.onNumber], [24, 3]);
assert.deepEqual(foma.elements.filter((e) => e.pitchPerf).map((e) => e.pitchPerf), [1.04, 1.65]);
assert.equal(foma.codes['FOMAPAN 100'], '0216');
assert.equal(applyEdgeMarkingStyle({}, 'fomapan').dxEnabled, false);

// AgfaPhoto APX (Harman's print): the number on both edges, the name and
// the emulsion code taking turns, a wedge with a needle before "nA", no DX.
const apx = edgeMarkingStyle('agfaApx');
assert.equal(edgeStyleForFilmName('AgfaPhoto APX 100 (New)'), 'agfaApx');
assert.equal(edgeTextForFilmName('AgfaPhoto APX 400 (New Emulsion on box)'), 'AGFAPHOTO APX 400');
assert.equal(edgeStyleForFilmName('AGFA APX 100 Professional AGFAPAN'), null, 'the old Agfa APX print is not this one');
assert.equal(apx.dxEnabled, false);
assert.ok(!apx.elements.some((element) => element.kind === 'dx'));
assert.deepEqual(apx.elements.filter((e) => e.kind === 'number').map((e) => e.edge).sort(), ['bottom', 'top']);
assert.equal(apx.elements.find((e) => e.kind === 'text').parity, 'odd');
assert.equal(apx.elements.find((e) => e.kind === 'code').parity, 'even');
assert.ok(apx.elements.find((e) => e.kind === 'triangle').needleMm > 0);
// The same printer as Ilford's: the same wedge and "nA" places.
for (const kind of ['triangle', 'halfNumber']) {
  assert.ok(Math.abs(apx.elements.find((e) => e.kind === kind).at - ilford.elements.find((e) => e.kind === kind).at) < 0.05, kind);
}

// Fujifilm 200/400 (made in the USA): Kodak's numbering, "FUJI 200"/"FUJI 400" in light letters.
const fujiUs = edgeMarkingStyle('fujifilmUs');
assert.equal(edgeStyleForFilmName('Fujifilm 400'), 'fujifilmUs');
assert.equal(edgeTextForFilmName('Fujifilm 200'), 'FUJI 200');
assert.equal(edgeStyleForFilmName('Fujicolor Pro 400H'), 'fujiColor', 'Pro 400H is not the US-made film');
assert.equal(edgeStyleForFilmName('FUJIFILM 400H'), null);
assert.ok(!fujiUs.stripes);
for (const element of fujiUs.elements.filter((e) => ['dx', 'arrow', 'halfNumber'].includes(e.kind))) {
  assert.ok(edgeMarkingStyle('kodakColor').elements.some((k) => k.kind === element.kind && k.at === element.at && k.edge === element.edge), `${element.kind} at Kodak's place`);
}

// Kodak Vision3: one edge, a 64-perforation KeyKode cycle placed by the
// frame number, the key number with its count, the mid-foot "+32", the
// manufacturing line, bar codes and hyphens; no still-frame numbers.
const vision = edgeMarkingStyle('kodakVision3');
assert.equal(vision.numberEvery, 64);
assert.equal(vision.framePosition, true);
assert.ok(vision.elements.every((element) => element.edge === 'bottom'));
assert.ok(!vision.elements.some((element) => ['number', 'halfNumber', 'dx'].includes(element.kind)));
assert.deepEqual(vision.elements.filter((e) => e.kind === 'keyNumber').map((e) => [e.at, e.suffix]), [[0, '•'], [34.28, '+32 •']]);
// The two bar codes are 32 perforations apart, as Kodak's diagram has them.
assert.deepEqual(vision.elements.filter((e) => e.kind === 'barcode').map((e) => e.at), [6.04, 38.04]);
// The hyphens keep a four-perforation pitch.
for (const dash of vision.elements.filter((e) => e.kind === 'dash')) assert.ok(Math.abs(((dash.at - 1.35) % 4)) < 1e-9, dash.at);
assert.equal(edgeTextForFilmName('Kodak Vision3 500T 5219'), 'EJ 07 7020');
assert.equal(edgeTextForFilmName('Kodak Vision3 250D'), 'EN 18 1402');
assert.equal(edgeTextForFilmName('Kodak Vision3 50D'), 'ER 04 8812');
// CineStill's later rolls print their own edge (Harman's layout), not Vision3's.
assert.equal(edgeStyleForFilmName('CineStill 800T'), 'cineStill');
assert.equal(edgeStyleForFilmName('CineStill BWXX'), null);
assert.equal(edgeTextForFilmName('CineStill 50D'), 'CINESTILL 50D');
assert.equal(edgeTextForFilmName('CineStill 400D'), 'CINESTILL 400D');
const cine = edgeMarkingStyle('cineStill');
assert.equal(cine.dxEnabled, false);
assert.equal(cine.codes['CINESTILL 800T'], '8034-11');
assert.deepEqual(cine.elements.map((e) => `${e.edge}:${e.kind}`), ['top:text', 'top:code', 'bottom:number', 'bottom:triangle', 'bottom:halfNumber']);
assert.ok(hasEdgeGlyphs('grid', 'EJ 07 7020 4499+32 •'));

// Choosing a style fills its values; custom keeps them.
const before = { text: 'MY ROLL', letteringColor: '#123456', textEnabled: false, frameNumberEnabled: false, dxEnabled: false, dx1: 1, dx2: 2, style: 'custom' };
const kodakSettings = applyEdgeMarkingStyle(before, 'kodakColor');
assert.equal(kodakSettings.style, 'kodakColor');
assert.equal(kodakSettings.text, 'KODAK GC 400');
assert.equal(kodakSettings.letteringColor, kodak.letteringColor);
assert.equal(kodakSettings.textEnabled, true);
assert.equal(kodakSettings.frameNumberEnabled, true);
assert.equal(kodakSettings.dxEnabled, true);
assert.deepEqual([kodakSettings.dx1, kodakSettings.dx2], [95, 7]);
assert.equal(applyEdgeMarkingStyle(before, 'fujiSlide').dxEnabled, false, 'the Provia strips carry no DX code');
assert.deepEqual(applyEdgeMarkingStyle(before, 'custom'), { ...before, style: 'custom' });
assert.equal(before.style, 'custom', 'the input is not changed');

// Auto: the first name that has a style wins, with the read DX number.
assert.deepEqual(resolveAutoEdgeStyle({ filmNames: ['Kodak ULTRA MAX 400 Film GC400'], dxNumber: '95-7' }), {
  style: 'kodakColor', text: 'KODAK GC 400', letteringColor: kodak.letteringColor, dx: [95, 7], filmName: 'Kodak ULTRA MAX 400 Film GC400'
});
assert.equal(resolveAutoEdgeStyle({ filmNames: ['Kentmere 400', 'Ilford HP5 PLUS'] }).style, 'ilford');
assert.equal(resolveAutoEdgeStyle({ filmNames: ['Kentmere 400'] }), null, 'a brand without a style draws as before');
assert.equal(resolveAutoEdgeStyle({}), null);
assert.equal(resolveAutoEdgeStyle({ filmNames: ['Kodak Gold 200'], dxNumber: 'garbage' }).dx, null);

// Glyphs: every letter, digit and mark of both sets rasterises inside its box.
for (const [set, glyphs] of Object.entries(EDGE_GLYPH_SETS)) {
  for (const char of Object.keys(glyphs)) {
    const glyph = rasterizeEdgeGlyph(set, char, { capPx: 24, stroke: 0.2 });
    assert.ok(glyph && glyph.mask.length === glyph.width * glyph.height, `${set} ${char}`);
    const ink = glyph.mask.reduce((sum, v) => sum + v, 0);
    if (char === ' ') assert.equal(ink, 0);
    else assert.ok(ink > 3, `${set} ${char} draws something`);
    assert.ok(glyph.mask.every((v) => v >= 0 && v <= 1));
  }
  assert.equal(hasEdgeGlyphs(set, '中文'), false, 'CJK falls back to the pixel font');
}

console.log('edgeMarkingStyles.test.mjs passed');
