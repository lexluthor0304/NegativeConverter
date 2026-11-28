// Brand styles of the simulated film edge markings ("边字风格").
//
// A style is data: where each marking sits on the 35 mm rebate, in
// perforations along the film (one perforation pitch is 4.75 mm, a frame is
// eight) and in millimetres in from the film's outer edge, which letters it
// uses (edgeGlyphs.js), how big they are, and the colour the print takes in a
// positive of that kind of film. The renderer (sprocketFrame.js) reads these
// numbers; it has no branch per brand.
//
// Every number comes from real film, measured on the references in
// docs/film-edge-rendering.md ("Edge marking styles"). A brand is listed only
// when scans or photographs of its rebate showed its edge print; brands whose
// look could not be confirmed are left out (LEFT_OUT_BRANDS) and their films
// resolve to the unbranded style under "auto".
//
// The ids are stored in settings, projects and batch jobs: never rename one.

export const EDGE_STYLE_AUTO = 'auto';
export const EDGE_STYLE_CUSTOM = 'custom';
export const EDGE_STYLE_PLAIN = 'plain';

// Positions along the film are perforations from the frame's anchor: the
// main frame number. `anchorPerf` places that number relative to the first
// perforation of the photo's frame. Its fraction is the film's: the printer
// sets the numbers at a fixed phase to the perforations (Kodak half a
// perforation past a hole's left edge, Ilford 0.92, Fujichrome 0.65). Which
// hole of the frame it falls on depends on the camera; the whole part is the
// one closest to what the reference cameras produced (Kodak's number 1.55
// perforations after the picture's left edge).
//
// `from: [a, b]` is the band a marking occupies, a to b mm in from the film's
// outer edge; b - a is the cap height of letters.

const KODAK_NUMBERING = Object.freeze([
  // Top (text) edge: the frame number, the same height as the brand text.
  { kind: 'number', edge: 'top', at: 0, from: [0.42, 1.58], glyphs: 'grotesk', stroke: 0.24, digitWidth: 1.0 },
  // DX edge: a larger number, then the code; half a frame on, "nA" over an arrow, then the code again.
  { kind: 'number', edge: 'bottom', at: -0.2, from: [0.40, 1.74], glyphs: 'grotesk', stroke: 0.24, digitWidth: 1.03 },
  { kind: 'dx', edge: 'bottom', at: 0.65, half: false },
  { kind: 'halfNumber', edge: 'bottom', at: 3.9, from: [0.88, 1.75], glyphs: 'grotesk', stroke: 0.24, digitWidth: 1.0 },
  { kind: 'arrow', edge: 'bottom', at: 3.68, from: [0.09, 0.56], lengthMm: 3.6, shaftMm: 0.13, headMm: 0.67 },
  { kind: 'dx', edge: 'bottom', at: 4.6, half: true }
]);

export const EDGE_MARKING_STYLES = Object.freeze([
  Object.freeze({
    id: 'kodakColor',
    labelKey: 'filmEdgeStyleKodakColor',
    brand: 'KODAK',
    filmKind: 'color',
    // Verified edge prints: Ultra Max 400 prints "GC 400" (DSC_8800/8798/8806),
    // Ektar 100 "KODAK EKTAR 100" (Commons, LoMit 2018).
    text: 'KODAK GC 400',
    stocks: ['KODAK GC 400', 'KODAK EKTAR 100'],
    // Ultra Max turns its text round on every other frame: "KODAK GC 400"
    // after an even number, "GC 400 KODAK" after an odd one (frames 21, 30,
    // 31, 35, 36 of the reference strips). Ektar does not.
    alternates: { 'KODAK GC 400': 'GC 400 KODAK' },
    alternateOn: 'odd',
    // A corrected positive of Kodak colour negative rebate shows the print
    // pale gold on black (Ektar 100, Commons "Color print film strip 03").
    letteringColor: '#ecd18b',
    dx: [95, 7],
    dxEnabled: true,
    anchorPerf: 1.5,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      ...KODAK_NUMBERING,
      // The brand text follows the number by 1.37 perforations of space.
      { kind: 'text', edge: 'top', at: 1.78, from: [0.42, 1.58], glyphs: 'grotesk', stroke: 0.24, tracking: 0.21, wordSpace: 0.65, brandGap: 1.1, digitWidth: 0.72 }
    ])
  }),
  Object.freeze({
    id: 'ilford',
    labelKey: 'filmEdgeStyleIlford',
    brand: 'ILFORD',
    filmKind: 'bw',
    // HP5 Plus, from two references that agree: a 2008 strip (Commons,
    // "ILFORD HP5 PLUS SAFETY FILM") and a 2018 scan (Fil Nenna). The text
    // edge carries "ILFORD HP5 PLUS" once a frame and no numbers; the other
    // edge the frame number and "nA", both large and heavy, and nothing else:
    // no DX code, no triangle.
    text: 'ILFORD HP5 PLUS',
    stocks: ['ILFORD HP5 PLUS'],
    alternates: {},
    // A black-and-white negative's print is dense silver: white in a positive.
    letteringColor: '#ececec',
    dx: [109, 9],
    dxEnabled: false,
    anchorPerf: 0.66,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      // The line starts two perforations before a number (1.93 and 2.05 on the
      // references) and comes every other frame: the 2008 strip prints it
      // before frame 8 and not before 9 (where it prints "SAFETY" past the
      // number instead, seen on that strip only and not drawn).
      { kind: 'text', edge: 'top', at: -2.0, from: [0.55, 1.75], glyphs: 'grotesk', stroke: 0.28, letterWidth: 1.08, tracking: 0.14, wordSpace: 0.62, digitWidth: 0.75, parity: 'even' },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.28, 1.72], glyphs: 'grotesk', stroke: 0.28, tracking: 0.1, digitWidth: 0.75 },
      // "nA" as large as the number, 2.79 and 2.88 perforations after it.
      { kind: 'halfNumber', edge: 'bottom', at: 2.83, from: [0.28, 1.72], glyphs: 'grotesk', stroke: 0.28, tracking: 0.1, digitWidth: 0.75 }
    ])
  }),
  Object.freeze({
    id: 'fujiSlide',
    labelKey: 'filmEdgeStyleFujiSlide',
    brand: 'FUJI',
    filmKind: 'positive',
    // Provia 100F prints "FUJI RDPⅢ" and, on the next frame, "RDPⅢ-043"
    // (stock code and emulsion number; John Elson's strips on Commons, 2009).
    text: 'FUJI RDPIII',
    stocks: ['FUJI RDPIII'],
    alternates: { 'FUJI RDPIII': 'RDPIII-043' },
    alternateOn: 'even',
    // Slide film: the rebate is black and the print amber (mean of the three strips).
    letteringColor: '#caa23c',
    dx: [34, 13],
    // No DX barcode on the rebate of these strips.
    dxEnabled: false,
    anchorPerf: 0.65,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      // The same bold number on both edges, at the same place.
      { kind: 'number', edge: 'top', at: 0, from: [0.06, 1.74], glyphs: 'grid', stroke: 0.28, digitWidth: 0.95, tracking: 0.12 },
      { kind: 'text', edge: 'top', at: 3.2, from: [0.77, 1.70], glyphs: 'grid', stroke: 0.14, tracking: 0.2, wordSpace: 1.8, digitWidth: 0.9 },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.26, 1.87], glyphs: 'grid', stroke: 0.28, digitWidth: 0.95, tracking: 0.12 },
      // Half a frame on: a small "36" (the roll length), an outlined arrow, "nA".
      { kind: 'label', edge: 'bottom', at: 3.02, from: [0.39, 0.90], glyphs: 'grid', stroke: 0.2, value: '36', digitWidth: 0.9, tracking: 0.12 },
      { kind: 'outlineArrow', edge: 'bottom', at: 3.31, from: [0.45, 1.61], lengthMm: 2.57, stroke: 0.14 },
      { kind: 'halfNumber', edge: 'bottom', at: 3.9, from: [0.45, 1.67], glyphs: 'grid', stroke: 0.28, digitWidth: 0.95, tracking: 0.12 }
    ])
  }),
  Object.freeze({
    id: EDGE_STYLE_PLAIN,
    labelKey: 'filmEdgeStylePlain',
    brand: '',
    filmKind: null,
    // Frame numbers and half-frame arrows as Kodak prints them, no brand text
    // and no DX code: for re-spooled and rebranded rolls.
    text: '',
    stocks: [],
    alternates: {},
    letteringColor: '#ecd18b',
    dx: [95, 7],
    dxEnabled: false,
    anchorPerf: 1.5,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: KODAK_NUMBERING
  })
].map((style) => Object.freeze({ ...style, stocks: Object.freeze([...style.stocks]), alternates: Object.freeze({ ...style.alternates }) })));

// Brands whose edge print could not be confirmed from images of real film:
// not offered. A film of theirs resolves to the unbranded style under "auto".
export const LEFT_OUT_BRANDS = Object.freeze([
  'KODAK TRI-X', 'KODAK T-MAX', 'KODAK BW400CN', 'KODAK VISION3', 'CINESTILL', 'KODAK EKTACHROME',
  'FUJICOLOR', 'FUJIFILM SUPERIA', 'KENTMERE', 'FOMAPAN', 'AGFA', 'LOMOGRAPHY'
]);

const STYLE_BY_ID = new Map(EDGE_MARKING_STYLES.map((style) => [style.id, style]));

// Every id a setting may hold.
export const EDGE_STYLE_IDS = Object.freeze([EDGE_STYLE_AUTO, ...EDGE_MARKING_STYLES.map((style) => style.id), EDGE_STYLE_CUSTOM]);
// The ids the dropdown lists, in order.
export const EDGE_STYLE_MENU = Object.freeze([EDGE_STYLE_AUTO, 'kodakColor', 'ilford', 'fujiSlide', EDGE_STYLE_PLAIN, EDGE_STYLE_CUSTOM]);
export const EDGE_STYLE_LABEL_KEYS = Object.freeze({
  [EDGE_STYLE_AUTO]: 'filmEdgeStyleAuto',
  [EDGE_STYLE_CUSTOM]: 'filmEdgeStyleCustom',
  ...Object.fromEntries(EDGE_MARKING_STYLES.map((style) => [style.id, style.labelKey]))
});

export function normalizeEdgeStyleId(id) {
  return EDGE_STYLE_IDS.includes(id) ? id : EDGE_STYLE_CUSTOM;
}

// The style record for a drawable id, or null for auto, custom and unknown ids.
export function edgeMarkingStyle(id) {
  return STYLE_BY_ID.get(id) || null;
}

// The text of a frame: some films alternate their line from frame to frame.
export function edgeTextForFrame(style, text, frameNumber) {
  const alternate = style?.alternates?.[String(text).trim().toUpperCase()];
  if (!alternate) return text;
  const odd = Math.abs(Math.round(Number(frameNumber) || 0)) % 2 === 1;
  return (style.alternateOn === 'odd') === odd ? alternate : text;
}

// Edge prints seen on real rolls, by the words of a trade name.
const KNOWN_EDGE_PRINTS = [
  { words: ['ULTRA MAX', 'ULTRAMAX', 'GC400', 'GC 400'], text: 'KODAK GC 400' },
  { words: ['EKTAR'], text: 'KODAK EKTAR 100' },
  { words: ['HP5'], text: 'ILFORD HP5 PLUS' },
  { words: ['PROVIA 100F', 'RDP III', 'RDPIII'], text: 'FUJI RDPIII' }
];

const STYLE_RULES = [
  // Kodak's colour negative films; its B&W, chromogenic B&W, slide and cine films are not confirmed.
  { id: 'kodakColor', words: ['ULTRA MAX', 'ULTRAMAX', 'PORTRA', 'EKTAR', 'GOLD', 'COLORPLUS', 'COLOR PLUS', 'PRO IMAGE', 'KODACOLOR', 'VERICOLOR', 'GC400', 'GC 400', 'KODAK 200', 'KODAK 400'], not: ['TRI-X', 'TRI X', 'T-MAX', 'TMAX', 'BW400', 'T400CN', 'VISION', 'CHROME', 'CINESTILL', 'LOMOGRAPHY'] },
  { id: 'ilford', words: ['ILFORD', 'HP5', 'FP4', 'DELTA', 'PAN F', 'XP2', 'SFX', 'ORTHO PLUS'], not: ['KENTMERE'] },
  { id: 'fujiSlide', words: ['FUJICHROME', 'VELVIA', 'PROVIA', 'ASTIA', 'SENSIA', 'RDP', 'RVP', 'RXP'], not: [] }
];

/** The style of a film by its name ("Kodak ULTRA MAX 400 Film GC400"), or null. */
export function edgeStyleForFilmName(name) {
  if (!name || typeof name !== 'string') return null;
  const upper = ` ${name.toUpperCase()} `;
  const rule = STYLE_RULES.find((r) => r.words.some((w) => upper.includes(w)) && !r.not.some((w) => upper.includes(w)));
  return rule ? rule.id : null;
}

/** The edge text a film prints, as far as the references show; otherwise its name in capitals. */
export function edgeTextForFilmName(name, styleId = edgeStyleForFilmName(name)) {
  if (!name) return '';
  const upper = ` ${name.toUpperCase()} `;
  const known = KNOWN_EDGE_PRINTS.find((entry) => entry.words.some((w) => upper.includes(w)));
  if (known) return known.text;
  const style = edgeMarkingStyle(styleId);
  // The trade name, without the catalogue code a database adds after a comma.
  const words = name.split(',')[0].toUpperCase()
    .replace(/\((?:[^)]*)\)/g, ' ')
    .replace(/\b(FILM|PROFESSIONAL|COLOR NEGATIVE|COLOUR NEGATIVE|NEGATIVE)\b/g, ' ')
    .replace(/[^A-Z0-9 +\-/.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!style?.brand || words.startsWith(style.brand)) return words.slice(0, 48);
  return `${style.brand} ${words.replace(/^(KODAK|ILFORD|FUJIFILM|FUJI)\s+/, '')}`.slice(0, 48);
}

/**
 * A copy of `settings` (a sprocketEdge object) with `styleId`'s values put in:
 * the text, the marking colour, the DX number and switches. Custom keeps
 * every value; auto puts in the unbranded defaults and leaves the text empty,
 * which composes as the film the photo was found to be.
 */
export function applyEdgeMarkingStyle(settings = {}, styleId) {
  const id = normalizeEdgeStyleId(styleId);
  const next = { ...settings, style: id };
  if (id === EDGE_STYLE_CUSTOM) return next;
  const style = edgeMarkingStyle(id === EDGE_STYLE_AUTO ? EDGE_STYLE_PLAIN : id);
  next.text = id === EDGE_STYLE_AUTO ? '' : style.text;
  next.letteringColor = style.letteringColor;
  next.textEnabled = id !== EDGE_STYLE_PLAIN;
  next.frameNumberEnabled = true;
  next.halfFrameMarksEnabled = true;
  next.dxEnabled = id === EDGE_STYLE_AUTO ? true : style.dxEnabled;
  next.dx1 = style.dx[0];
  next.dx2 = style.dx[1];
  next.fontStyle = 'edgePixel';
  return next;
}

// The marking colours the styles put in: a setting that still holds one of
// them was not chosen by hand, so "auto" may replace it with the colour of
// the style it resolves to.
export const EDGE_STYLE_COLORS = Object.freeze([...new Set(EDGE_MARKING_STYLES.map((style) => style.letteringColor))]);

/**
 * What "auto" draws for one photo: the style of the first film name (the
 * film edge read, then the roll's stock) whose brand has a style, with that
 * film's edge text and the DX number read from the film. Null when none has
 * one: the border is then drawn as it was before styles existed. Returns
 * { style, text, letteringColor, dx: [dx1, dx2] | null, filmName }.
 */
export function resolveAutoEdgeStyle({ filmNames = [], dxNumber = null } = {}) {
  const dx = typeof dxNumber === 'string' && /^\d{1,3}-\d{1,2}$/.test(dxNumber) ? dxNumber.split('-').map(Number) : null;
  for (const name of filmNames) {
    const id = edgeStyleForFilmName(name);
    if (!id) continue;
    const style = edgeMarkingStyle(id);
    return { style: id, text: edgeTextForFilmName(name, id), letteringColor: style.letteringColor, dx, filmName: name };
  }
  return null;
}
