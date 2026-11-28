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
    // Read on the rebates: Portra prints its name (800 with "-3"), Gold 200
    // "GB 200-7", ColorPlus "200-8" (two references each, Flickr).
    stocks: ['KODAK GC 400', 'KODAK PORTRA 160', 'KODAK PORTRA 400', 'KODAK PORTRA 800-3', 'KODAK GB 200-7', 'KODAK 200-8', 'KODAK EKTAR 100'],
    // Ultra Max, Gold 200 and ColorPlus turn their text round on every other
    // frame: "KODAK GC 400" after an even number, "GC 400 KODAK" after an
    // odd one (frames 21, 30, 31, 35, 36 of the Ultra Max strips; 17/18 of
    // Gold 200, 5/12 of ColorPlus). Ektar and Portra do not.
    alternates: { 'KODAK GC 400': 'GC 400 KODAK', 'KODAK GB 200-7': 'GB 200-7 KODAK', 'KODAK 200-8': '200-8 KODAK' },
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
    // Current production, measured on HP5 Plus scans of 2021 and 2026 (Flickr,
    // Mi Wo; Jack Landau) and read on FP4 Plus (2016, 2022): the text edge
    // carries "ILFORD HP5 PLUS" once every eight perforations, starting 1.27
    // perforations before the frame number on the other edge, with an
    // emulsion code ("5051-11") 3.66 perforations after the number; the
    // other edge a two-row DX code, the frame number, a small wedge and the
    // smaller "nA". Square, stepped capitals. Older rolls (a 1998 expiry,
    // 2004, 2008 and 2018 scans) print heavier round letters and no DX code;
    // that print is not drawn.
    text: 'ILFORD HP5 PLUS',
    stocks: ['ILFORD HP5 PLUS', 'ILFORD FP4 PLUS'],
    alternates: {},
    // The emulsion code printed after the text (read on the references).
    codes: { 'ILFORD HP5 PLUS': '5051-11', 'ILFORD FP4 PLUS': '3803-11' },
    // A black-and-white negative's print is dense silver: white in a positive.
    letteringColor: '#ffffff',
    inkDensity: 1,
    dx: [109, 9],
    dxEnabled: true,
    // The number sits 0.41 of a pitch past a hole's left edge.
    anchorPerf: 1.41,
    // HP5's bars stand apart (thin bars with gaps), unlike Kodak's solid blocks.
    dxGeometry: { moduleMm: 0.405, rowMm: 1.15, barFill: 0.9 },
    elements: Object.freeze([
      { kind: 'text', edge: 'top', at: -1.27, from: [0.66, 1.91], glyphs: 'grid', stroke: 0.17, tracking: 0.22, wordSpace: 1.0 },
      { kind: 'code', edge: 'top', at: 3.66, from: [0.95, 1.91], glyphs: 'grid', stroke: 0.17, tracking: 0.18 },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.46, 1.91], glyphs: 'grid', stroke: 0.22, tracking: 0.14, digitWidth: 0.95 },
      { kind: 'dx', edge: 'bottom', at: 0.84, half: false },
      { kind: 'triangle', edge: 'bottom', at: 3.83, from: [0.72, 1.6], lengthMm: 0.65 },
      { kind: 'halfNumber', edge: 'bottom', at: 4.21, from: [0.68, 1.68], glyphs: 'grid', stroke: 0.2, tracking: 0.14, digitWidth: 0.95 },
      { kind: 'dx', edge: 'bottom', at: 4.94, half: true }
    ])
  }),
  Object.freeze({
    id: 'kodakBw',
    labelKey: 'filmEdgeStyleKodakBw',
    brand: 'KODAK',
    filmKind: 'bw',
    // Tri-X (Flickr, Vtumane 2017; Johan 2021) and T-Max (100TMX, Flickr
    // mark_snaps 2018; 400-2TMY, Flickr 2021): Kodak's numbering, text 1.76
    // perforations after the number, "nA" over an arrow, and no DX code.
    text: 'KODAK 400TX',
    stocks: ['KODAK 400TX', 'KODAK 100TMX', 'KODAK 400-2TMY'],
    alternates: {},
    letteringColor: '#ffffff',
    inkDensity: 1,
    dx: [95, 7],
    dxEnabled: false,
    // On the Tri-X strip the number starts at a hole's left edge.
    anchorPerf: 2.0,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      ...KODAK_NUMBERING.filter((element) => element.kind !== 'dx'),
      { kind: 'text', edge: 'top', at: 1.76, from: [0.42, 1.58], glyphs: 'grotesk', stroke: 0.24, tracking: 0.21, wordSpace: 0.65, brandGap: 1.1, digitWidth: 0.72 }
    ])
  }),
  Object.freeze({
    id: 'kodakSlide',
    labelKey: 'filmEdgeStyleKodakSlide',
    brand: 'KODAK',
    filmKind: 'positive',
    // Ektachrome E100 (Flickr, eddi_monsoon 2021; Tony Webster 2023): "KODAK
    // E100" after the number, "nA" over an arrow, no DX code; cream print on
    // the black rebate of a slide.
    text: 'KODAK E100',
    // Elite Chrome 100 (discontinued 2012) prints "KODAK EB-3" in the same
    // places (Flickr 29871209888, benbenbenbenben; 8727226118, aprilpo).
    stocks: ['KODAK E100', 'KODAK EB-3'],
    alternates: {},
    letteringColor: '#efd9a4',
    dx: [95, 7],
    dxEnabled: false,
    anchorPerf: 1.35,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      ...KODAK_NUMBERING.filter((element) => element.kind !== 'dx'),
      { kind: 'text', edge: 'top', at: 1.84, from: [0.42, 1.58], glyphs: 'grotesk', stroke: 0.24, tracking: 0.21, wordSpace: 0.65, brandGap: 1.1, digitWidth: 0.72 }
    ])
  }),
  Object.freeze({
    id: 'fujifilmUs',
    labelKey: 'filmEdgeStyleFujifilmUs',
    brand: 'FUJI',
    filmKind: 'color',
    // Fujifilm 200 and 400 as sold since 2021 (made in the USA): Kodak's
    // layout and printer (Mark Frey's negatives on EMULSIVE, 2023, beside a
    // Kodak GC 400 strip), with "FUJI 200"/"FUJI 400" in lighter, narrower
    // letters than Kodak's, the top number narrow too, no stripes. Fujifilm
    // 200: Flickr 55666870630 (2026); Fujifilm 400: Flickr 54095652528 (2024).
    text: 'FUJI 200',
    stocks: ['FUJI 200', 'FUJI 400'],
    alternates: {},
    letteringColor: '#ecd18b',
    // The database's FUJICOLOR 200 code; not read off these films' bars.
    dx: [8, 1],
    dxEnabled: true,
    // 0.13 and 0.45 of a pitch past a hole on the two scans.
    anchorPerf: 1.3,
    // Solid blocks as Kodak's (the Fujifilm 400 scan; the 200 one is too faint to tell).
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      // Kodak's places; the numbers in the narrow, light digits of these films.
      ...KODAK_NUMBERING.map((element) => (element.kind === 'number' || element.kind === 'halfNumber'
        ? { ...element, stroke: 0.17, digitWidth: 0.6, tracking: 0.15 }
        : element)),
      { kind: 'text', edge: 'top', at: 1.68, from: [0.42, 1.58], glyphs: 'grotesk', stroke: 0.17, letterWidth: 0.8, tracking: 0.12, wordSpace: 0.65, brandGap: 1.1, digitWidth: 0.6 }
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
    id: 'fujiColor',
    labelKey: 'filmEdgeStyleFujiColor',
    brand: 'FUJI',
    filmKind: 'color',
    // Fujicolor made by Fujifilm: Superia 200 (Flickr 8439023084, 2013;
    // 16641180517, 2015; c't Digital Photography 22/2016) and Pro 400H
    // (Flickr 9283150390, 2013; 49692716807, 2020). One edge: the number,
    // the stock code ("S-200", "PRO400H"), "nA" and "FUJI"; the other: a DX
    // code with the number and "→nA" between. Coloured stripes run along
    // the perforation rows, different for each stock (stripes below).
    text: 'S-200',
    // C200 prints "200", Superia X-TRA 400 "S-400" (C200: Flickr 23297380040,
    // 2015; 32503911854, Ruud Welten; 12210026456, 2013. X-TRA 400: Flickr
    // 7849873466, 2012; 52220527040, 2022; Mark Frey on EMULSIVE, 2023).
    stocks: ['S-200', 'PRO400H', '200', 'S-400'],
    alternates: {},
    letteringColor: '#f0d75a',
    dx: [24, 3],
    dxEnabled: true,
    anchorPerf: 1.35,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    // Stripes by stock: across the film relative to the middle of the
    // perforation row (positive toward the picture), along it on `on` of
    // every `period` perforations from the frame number.
    stripes: {
      'S-200': [
        { rows: ['top', 'bottom'], offsetMm: 0, widthMm: 0.14, color: '#e8829f', period: 8, on: [-1, 7] },
        { rows: ['top', 'bottom'], offsetMm: -0.68, widthMm: 0.14, color: '#5fd27e', period: 8, on: [-0.6, 3.4] },
        { rows: ['top', 'bottom'], offsetMm: 0.64, widthMm: 0.14, color: '#5fd27e', period: 8, on: [-0.6, 3.4] }
      ],
      'PRO400H': [
        { rows: ['top', 'bottom'], offsetMm: -0.1, widthMm: 0.9, color: '#dc5a55', period: 4, on: [0.45, 2.45] }
      ],
      // C200: a red line through the middle of the row, continuous, and two
      // green lines 0.7 mm either side of it, on four perforations of eight
      // (Welten and Joelsson rolls; Welten's phase is drawn).
      '200': [
        { rows: ['top', 'bottom'], offsetMm: 0, widthMm: 0.3, color: '#ec2c3c', period: 8, on: [-1, 7] },
        { rows: ['top', 'bottom'], offsetMm: -0.69, widthMm: 0.25, color: '#5fae1e', period: 8, on: [-3.4, 0.6] },
        { rows: ['top', 'bottom'], offsetMm: 0.71, widthMm: 0.25, color: '#5fae1e', period: 8, on: [-3.4, 0.6] }
      ],
      // Superia X-TRA 400: a thin green line 0.6 mm toward the film edge,
      // continuous, and a red band 0.75 mm wide just toward the picture, on
      // four perforations of eight (Donato and Frey rolls; Donato's phase).
      'S-400': [
        { rows: ['top', 'bottom'], offsetMm: -0.6, widthMm: 0.2, color: '#6cb82e', period: 8, on: [-1, 7] },
        { rows: ['top', 'bottom'], offsetMm: 0.27, widthMm: 0.75, color: '#f0412f', period: 8, on: [-0.97, 3.03] }
      ]
    },
    elements: Object.freeze([
      { kind: 'stripes' },
      { kind: 'number', edge: 'top', at: 0, from: [0.65, 1.68], glyphs: 'grid', stroke: 0.26, tracking: 0.12, digitWidth: 0.95 },
      { kind: 'text', edge: 'top', at: 1.75, from: [0.92, 1.68], glyphs: 'grid', stroke: 0.15, tracking: 0.16, wordSpace: 0.8 },
      { kind: 'halfNumber', edge: 'top', at: 4.06, from: [0.65, 1.68], glyphs: 'grid', stroke: 0.26, tracking: 0.12, digitWidth: 0.95 },
      { kind: 'label', edge: 'top', at: 6.0, from: [0.92, 1.68], glyphs: 'grid', stroke: 0.15, value: 'FUJI', tracking: 0.16, always: true },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.5, 1.6], glyphs: 'grid', stroke: 0.26, tracking: 0.12, digitWidth: 0.95 },
      { kind: 'dx', edge: 'bottom', at: 0.59, half: false },
      { kind: 'arrow', edge: 'bottom', at: 3.68, from: [0.85, 1.25], lengthMm: 1.0, shaftMm: 0.12, headMm: 0.4 },
      { kind: 'halfNumber', edge: 'bottom', at: 3.92, from: [0.6, 1.5], glyphs: 'grid', stroke: 0.24, tracking: 0.12, digitWidth: 0.95 },
      { kind: 'dx', edge: 'bottom', at: 4.7, half: true }
    ])
  }),
  Object.freeze({
    id: 'kentmere',
    labelKey: 'filmEdgeStyleKentmere',
    brand: 'K',
    filmKind: 'bw',
    // Kentmere 400 as Harman prints it today (Flickr 50147214998, Meredith,
    // 2020; 54516734427, Jan de Jong, 2024): Ilford's
    // current layout to a hundredth of a perforation, with "K 400" every
    // frame and no DX code. The emulsion code ("4552-11", "5601…") comes
    // after some numbers only, in a rhythm not seen: not drawn.
    text: 'K 400',
    stocks: ['K 400'],
    alternates: {},
    letteringColor: '#ffffff',
    inkDensity: 1,
    dx: [109, 9],
    dxEnabled: false,
    // 0.40 and 0.36 of a pitch past a hole's left edge.
    anchorPerf: 1.38,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.15, barFill: 0.9 },
    elements: Object.freeze([
      { kind: 'text', edge: 'top', at: -1.35, from: [0.66, 1.91], glyphs: 'grid', stroke: 0.17, tracking: 0.35, wordSpace: 0.56 },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.46, 1.91], glyphs: 'grid', stroke: 0.22, tracking: 0.14, digitWidth: 0.95 },
      // Harman's longer wedge with a needle, as on AgfaPhoto APX.
      { kind: 'triangle', edge: 'bottom', at: 3.83, from: [0.72, 1.6], lengthMm: 1.0, needleMm: 0.45, needleWidthMm: 0.1 },
      { kind: 'halfNumber', edge: 'bottom', at: 4.21, from: [0.68, 1.68], glyphs: 'grid', stroke: 0.2, tracking: 0.14, digitWidth: 0.95 }
    ])
  }),
  Object.freeze({
    id: 'agfaApx',
    labelKey: 'filmEdgeStyleAgfaApx',
    brand: 'AGFAPHOTO',
    filmKind: 'bw',
    // AgfaPhoto APX 100 and 400 as made today (Flickr: APX 400 2023, Moritz
    // Kartheuser; APX 100 2025, Jan de Jong; APX 100 2021, senpatientulo;
    // APX 100 2026, Neal Wellons). Harman's layout, as on Ilford's current
    // print: the same phase to the holes, wedge and "nA" at the same places,
    // the emulsion code 3.65 perforations on; but the number on both edges,
    // the name after the top one on every other frame, and no DX code.
    text: 'AGFAPHOTO APX 100',
    stocks: ['AGFAPHOTO APX 100', 'AGFAPHOTO APX 400'],
    alternates: {},
    // The emulsion code of the 2025 APX 100 roll ("5518-11"; the 2021 roll
    // reads "4135-11"); no APX 400 code was readable.
    codes: { 'AGFAPHOTO APX 100': '5518-11' },
    letteringColor: '#ffffff',
    inkDensity: 1,
    dx: [110, 11],
    dxEnabled: false,
    // The numbers start 0.43 of a pitch past a hole's left edge (0.34 on the 2023 roll).
    anchorPerf: 1.43,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      { kind: 'number', edge: 'top', at: 0, from: [0.40, 1.86], glyphs: 'grid', stroke: 0.16, tracking: 0.14, digitWidth: 0.93 },
      // The name and the emulsion code take turns: the name after odd
      // numbers, the code after even ones (27 and 26 on the 2025 roll, 27 on
      // the 2023 one; the 2021 roll has them the other way round).
      { kind: 'text', edge: 'top', at: 1.80, parity: 'odd', from: [0.53, 1.78], glyphs: 'grid', stroke: 0.14, letterWidth: 0.89, tracking: 0.34, wordSpace: 0.8, brandGap: 1.9, digitWidth: 0.8 },
      { kind: 'code', edge: 'top', at: 3.65, parity: 'even', from: [0.82, 1.78], glyphs: 'grid', stroke: 0.15, tracking: 0.18, digitWidth: 0.8 },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.40, 1.86], glyphs: 'grid', stroke: 0.16, tracking: 0.14, digitWidth: 0.93 },
      { kind: 'triangle', edge: 'bottom', at: 3.83, from: [0.42, 1.41], lengthMm: 1.0, needleMm: 0.35, needleWidthMm: 0.1 },
      { kind: 'halfNumber', edge: 'bottom', at: 4.20, from: [0.42, 1.41], glyphs: 'grid', stroke: 0.18, tracking: 0.12, digitWidth: 0.79 }
    ])
  }),
  Object.freeze({
    id: 'fomapan',
    labelKey: 'filmEdgeStyleFomapan',
    brand: 'FOMAPAN',
    filmKind: 'bw',
    // Foma's current print (from 2021; Flickr georgsfoto 2021, a Pentax 17
    // roll on Reddit 2025, Fat Films Lab 2026): a number every four
    // perforations on one edge, counting on along the roll, no "A", arrow or
    // DX code; on the other edge, once every 24 numbers, the name in widely
    // set capitals, the speed one digit per perforation and a batch number
    // one digit per 1.65 perforations. Rolls of 2012-2020 print thinner,
    // narrower numbers and set the name twice as wide: not drawn.
    text: 'FOMAPAN 100',
    stocks: ['FOMAPAN 100', 'FOMAPAN 200', 'FOMAPAN 400'],
    alternates: {},
    // The batch numbers of the two reference rolls (100: Fat Films Lab,
    // 400: the Pentax 17 roll); Fomapan 200's current print was not seen.
    codes: { 'FOMAPAN 100': '0216', 'FOMAPAN 400': '0116' },
    letteringColor: '#ffffff',
    inkDensity: 1,
    dx: [87, 3],
    dxEnabled: false,
    numberEvery: 4,
    // The numbers start 0.70 of a pitch past a hole's left edge (all three rolls).
    anchorPerf: 1.7,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      { kind: 'number', edge: 'bottom', at: 0, from: [0.70, 1.86], glyphs: 'grotesk', stroke: 0.22, digitWidth: 0.8, tracking: 0.15 },
      // From the number that leaves 3 over 24: the name 1.25 perforations
      // after it, the speed at 13.65, the batch number at 26.1 (Fat Films Lab roll).
      { kind: 'text', edge: 'top', at: 1.25, every: 24, onNumber: 3, words: [0, 1], from: [0.52, 1.82], glyphs: 'grotesk', stroke: 0.17, letterWidth: 0.82, tracking: 0.51, digitWidth: 0.7 },
      { kind: 'text', edge: 'top', at: 13.65, every: 24, onNumber: 3, words: [1], from: [0.52, 1.82], glyphs: 'grotesk', stroke: 0.19, digitWidth: 0.7, pitchPerf: 1.04 },
      { kind: 'code', edge: 'top', at: 26.1, every: 24, onNumber: 3, from: [0.52, 1.82], glyphs: 'grotesk', stroke: 0.19, digitWidth: 0.7, pitchPerf: 1.65 }
    ])
  }),
  Object.freeze({
    id: 'kodakVision3',
    labelKey: 'filmEdgeStyleKodakVision3',
    brand: 'EASTMAN',
    filmKind: 'color',
    // Kodak's motion-picture negatives (Vision3 5219 500T, 5207 250D, 5203
    // 50D), as respooled for still cameras: one edge only, Kodak's KeyKode
    // cycle of 64 perforations (one foot): the key number (film code, roll
    // prefix, a count that goes up by one a foot) with its dot and bar code,
    // the manufacturing line ("EASTMAN 5219 ..."), the mid-foot key number
    // "+32" with its bar code, and a frame-index hyphen every four
    // perforations where nothing else is printed. No still-frame numbers.
    // Measured on a 5203 roll laid out on a light table (Aram Hăvărneanu,
    // 2016, CC BY-SA 3.0) and Kodak's 35 mm KeyKode diagram (2022); the
    // manufacturing line and hyphens on 5219 (Flickr 14083695025, 2014), the
    // hyphens before an EJ key number (Flickr 30078776796, 2016).
    text: 'EJ 07 7020',
    stocks: ['EJ 07 7020', 'EN 18 1402', 'ER 04 8812'],
    alternates: {},
    // The key-number counts and manufacturing lines of the reference rolls.
    keyCounts: { 'EJ 07 7020': 4499, 'EN 18 1402': 6869, 'ER 04 8812': 8829 },
    codes: { 'EJ 07 7020': 'EASTMAN 5219 304 02201 18 173 2013', 'ER 04 8812': 'EASTMAN 5203 014 01201 14 177 2012' },
    // The print is exposed on the film: pale cream in a positive (5219, 5207 scans).
    letteringColor: '#f5efdf',
    dx: [0, 0],
    // The bar codes are drawn with the DX switch.
    dxEnabled: true,
    numberEvery: 64,
    framePosition: true,
    // The key number starts 0.2 of a pitch past a hole's left edge (0.17 and 0.20).
    anchorPerf: 0.2,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      { kind: 'keyNumber', edge: 'bottom', at: 0, suffix: '•', from: [0.26, 1.86], glyphs: 'grid', stroke: 0.17, letterWidth: 0.83, digitWidth: 0.72, tracking: 0.25, wordSpace: 1.25 },
      { kind: 'barcode', edge: 'bottom', at: 6.04, lengthPerf: 4.93, from: [0.32, 1.95] },
      { kind: 'code', edge: 'bottom', at: 15.47, from: [0.6, 1.55], glyphs: 'grid', stroke: 0.2, letterWidth: 0.72, digitWidth: 0.65, tracking: 0.08, wordSpace: 1.05 },
      { kind: 'keyNumber', edge: 'bottom', at: 34.28, suffix: '+32 •', from: [0.52, 1.49], glyphs: 'grid', stroke: 0.17, letterWidth: 0.8, digitWidth: 0.68, tracking: 0.14, wordSpace: 0.55 },
      { kind: 'barcode', edge: 'bottom', at: 38.04, lengthPerf: 4.93, from: [0.32, 1.95] },
      // The hyphens every four perforations, left out where they would run
      // into the key numbers, bar codes or the manufacturing line.
      ...[13.35, 21.35, 25.35, 29.35, 33.35, 45.35, 49.35, 53.35, 57.35, 61.35].map((at) => ({ kind: 'dash', edge: 'bottom', at, from: [0.9, 1.15], lengthMm: 1.2 }))
    ])
  }),
  Object.freeze({
    id: 'cineStill',
    labelKey: 'filmEdgeStyleCineStill',
    brand: 'CINESTILL',
    filmKind: 'color',
    // CineStill's own print on its later rolls (800T: Flickr 54284730212,
    // Jay Smith 2025, and 52713899704, Tom Hart 2023; 400D: 54881331048,
    // 2025, and 53998201851, 2024): the name every frame on the top edge with
    // an emulsion code ("8034-11"); the number on the bottom edge with a
    // wedge and needle before the smaller "nA", the layout Harman prints for
    // Ilford and AgfaPhoto. No DX code, no cine KeyKode. Early rolls (2014-
    // 2016) carry Kodak's Vision3 print instead (the Vision3 style).
    text: 'CINESTILL 800T',
    stocks: ['CINESTILL 800T', 'CINESTILL 400D', 'CINESTILL 50D'],
    alternates: {},
    codes: { 'CINESTILL 800T': '8034-11' },
    // Yellow in a positive (800T and 400D scans).
    letteringColor: '#f8e65a',
    dx: [0, 0],
    dxEnabled: false,
    // The number starts 0.58 of a pitch past a hole's left edge (0.57, 0.59).
    anchorPerf: 1.58,
    dxGeometry: { moduleMm: 0.405, rowMm: 1.08 },
    elements: Object.freeze([
      { kind: 'text', edge: 'top', at: -1.56, from: [0.31, 1.71], glyphs: 'grid', stroke: 0.16, letterWidth: 0.83, digitWidth: 0.83, tracking: 0.3, wordSpace: 1.0 },
      { kind: 'code', edge: 'top', at: 3.47, from: [0.47, 1.47], glyphs: 'grid', stroke: 0.16, digitWidth: 0.83, tracking: 0.25 },
      { kind: 'number', edge: 'bottom', at: 0, from: [0.09, 1.75], glyphs: 'grid', stroke: 0.24, tracking: 0.14, digitWidth: 0.92 },
      { kind: 'triangle', edge: 'bottom', at: 3.76, from: [0.31, 1.12], lengthMm: 1.1, needleMm: 0.55, needleWidthMm: 0.1 },
      { kind: 'halfNumber', edge: 'bottom', at: 4.14, from: [0.31, 1.12], glyphs: 'grid', stroke: 0.2, tracking: 0.12, digitWidth: 0.79 }
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
  'KODAK BW400CN', 'CINESTILL BWXX',
  'KENTMERE 100', 'KENTMERE 200', 'AGFA VISTA', 'LOMOGRAPHY'
]);

const STYLE_BY_ID = new Map(EDGE_MARKING_STYLES.map((style) => [style.id, style]));

// Every id a setting may hold.
export const EDGE_STYLE_IDS = Object.freeze([EDGE_STYLE_AUTO, ...EDGE_MARKING_STYLES.map((style) => style.id), EDGE_STYLE_CUSTOM]);
// The ids the dropdown lists, in order.
export const EDGE_STYLE_MENU = Object.freeze([EDGE_STYLE_AUTO, 'kodakColor', 'kodakBw', 'kodakSlide', 'ilford', 'kentmere', 'agfaApx', 'fomapan', 'fujiColor', 'fujifilmUs', 'fujiSlide', 'kodakVision3', 'cineStill', EDGE_STYLE_PLAIN, EDGE_STYLE_CUSTOM]);
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
  { words: ['PORTRA 160'], text: 'KODAK PORTRA 160' },
  { words: ['PORTRA 400'], text: 'KODAK PORTRA 400' },
  { words: ['PORTRA 800'], text: 'KODAK PORTRA 800-3' },
  { words: ['GOLD 200', 'GB 200', 'GB200'], text: 'KODAK GB 200-7' },
  { words: ['COLORPLUS', 'COLOR PLUS'], text: 'KODAK 200-8' },
  { words: ['TRI-X', 'TRI X', '400TX'], text: 'KODAK 400TX' },
  { words: ['T-MAX 100', 'TMAX 100', '100TMX', 'T-MAX 100'], text: 'KODAK 100TMX' },
  { words: ['T-MAX 400', 'TMAX 400', '400TMY', 'T-MAX 400'], text: 'KODAK 400-2TMY' },
  { words: ['E100', 'EKTACHROME 100'], text: 'KODAK E100' },
  { words: ['ELITE CHROME 100', 'EB-3', 'EB100'], text: 'KODAK EB-3' },
  { words: ['FP4'], text: 'ILFORD FP4 PLUS' },
  { words: ['SUPERIA 200', 'S-200'], text: 'S-200' },
  { words: ['PRO 400H', 'PRO400H'], text: 'PRO400H' },
  { words: ['FUJICOLOR C200', 'FUJICOLOR C 200', ' C200 ', ' C200,', 'C200 135'], text: '200' },
  { words: ['X-TRA 400', 'XTRA 400', 'X-TRA400', 'XTRA400'], text: 'S-400' },
  { words: ['HP5'], text: 'ILFORD HP5 PLUS' },
  { words: ['PROVIA 100F', 'RDP III', 'RDPIII'], text: 'FUJI RDPIII' },
  { words: ['KENTMERE 400', 'KENTMERE PAN 400'], text: 'K 400' },
  { words: ['FUJIFILM 200', 'FUJI 200'], text: 'FUJI 200' },
  { words: ['FUJIFILM 400', 'FUJI 400'], text: 'FUJI 400' },
  { words: ['APX 100', 'APX100'], text: 'AGFAPHOTO APX 100' },
  { words: ['APX 400', 'APX400'], text: 'AGFAPHOTO APX 400' },
  { words: ['CINESTILL 800T', 'CINESTILL 800 T'], text: 'CINESTILL 800T' },
  { words: ['CINESTILL 400D'], text: 'CINESTILL 400D' },
  { words: ['CINESTILL 50D'], text: 'CINESTILL 50D' },
  { words: ['VISION3 500T', 'VISION 3 500T', '5219'], text: 'EJ 07 7020' },
  { words: ['VISION3 250D', 'VISION 3 250D', '5207'], text: 'EN 18 1402' },
  { words: ['VISION3 50D', 'VISION 3 50D', '5203'], text: 'ER 04 8812' },
  { words: ['FOMAPAN 100'], text: 'FOMAPAN 100' },
  { words: ['FOMAPAN 200'], text: 'FOMAPAN 200' },
  { words: ['FOMAPAN 400', 'ACTION 400'], text: 'FOMAPAN 400' }
];

const STYLE_RULES = [
  // Kodak's colour negative films; its B&W, chromogenic B&W, slide and cine films are not confirmed.
  { id: 'kodakBw', words: ['TRI-X', 'TRI X', '400TX', 'T-MAX', 'TMAX', 'TMX', 'TMY'], not: [] },
  { id: 'kodakSlide', words: ['EKTACHROME E100', 'KODAK E100', 'EKTACHROME 100', 'ELITE CHROME'], not: [] },
  { id: 'kodakColor', words: ['ULTRA MAX', 'ULTRAMAX', 'PORTRA', 'EKTAR', 'GOLD', 'COLORPLUS', 'COLOR PLUS', 'PRO IMAGE', 'KODACOLOR', 'VERICOLOR', 'GC400', 'GC 400', 'KODAK 200', 'KODAK 400'], not: ['TRI-X', 'TRI X', 'T-MAX', 'TMAX', 'BW400', 'T400CN', 'VISION', 'CHROME', 'CINESTILL', 'LOMOGRAPHY'] },
  { id: 'ilford', words: ['ILFORD', 'HP5', 'FP4', 'DELTA', 'PAN F', 'XP2', 'SFX', 'ORTHO PLUS'], not: ['KENTMERE'] },
  { id: 'kentmere', words: ['KENTMERE 400', 'KENTMERE PAN 400'], not: [] },
  { id: 'fujiColor', words: ['SUPERIA 200', 'S-200', 'PRO 400H', 'PRO400H', 'FUJICOLOR C200', 'FUJICOLOR C 200', ' C200 ', ' C200,', 'C200 135', 'X-TRA 400', 'XTRA 400', 'X-TRA400', 'XTRA400'], not: ['X-TRA 800', 'XTRA 800', 'X-TRA800', 'AGFA', 'HDC', 'KODAK'] },
  { id: 'cineStill', words: ['CINESTILL'], not: ['BWXX', 'DOUBLE-X'] },
  { id: 'kodakVision3', words: ['VISION3', 'VISION 3', '5219', '5207', '5203', '5213'], not: ['CINESTILL'] },
  { id: 'agfaApx', words: ['APX 100', 'APX 400', 'APX100', 'APX400', 'AGFAPHOTO APX', 'AGFA APX'], not: ['PROFESSIONAL'] },
  { id: 'fomapan', words: ['FOMAPAN', 'FOMA '], not: ['RETROPAN', 'ORTHO'] },
  { id: 'fujifilmUs', words: ['FUJIFILM 200', 'FUJIFILM 400', 'FUJI 200', 'FUJI 400'], not: ['400H', 'PRO 400', 'SUPERIA', 'X-TRA', 'XTRA', 'NATURA', 'PRESS'] },
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
