// Letterforms of the brand edge-marking styles (edgeMarkingStyles.js).
//
// Each glyph is drawn from strokes on a box one cap height tall (y grows
// downwards): straight strokes with square ends and elliptical arcs. A glyph
// is a function of its width and of half the stroke width, so the same
// letter can be drawn narrow (Kodak's digits in "GC 400") or wide (Kodak's
// frame numbers), thin (Fujichrome's stock code) or bold (its frame numbers).
// The shapes are data in the repository, never a system font: the Studio runs
// in Chrome, WebView2, WKWebView and WebKitGTK, and an edge drawn with each
// platform's fonts would differ between platforms, between preview and
// export, and could not be pinned by a hash test.
//
// The two sets follow the references listed in docs/film-edge-rendering.md:
// - `grotesk`: the bold, wide sans-serif of Kodak's and Ilford's current
//   35 mm edge print (round O/C/G/D, flat terminals).
// - `grid`: the monoline, chamfered letters of Fujifilm's edge print
//   ("FUJI RDPⅢ", the frame numbers are the same letters with a thick stroke).
//
// BITMAP_FONT in sprocketFrame.js stays as it is: the edge-text reader uses it
// as its template and the custom style's output is pinned by hashes.

const line = (x1, y1, x2, y2) => ['L', x1, y1, x2, y2];
const arc = (cx, cy, rx, ry, a0, a1) => ['A', cx, cy, Math.max(0.001, rx), Math.max(0.001, ry), a0, a1];
const path = (...points) => points.slice(1).map((point, i) => line(points[i][0], points[i][1], point[0], point[1]));

// A five: a flat top, a short stem down the left, and a bowl that starts at
// its top and ends low on the left, open between: the open left side is what
// keeps it from reading as a 6 when it is a dozen pixels tall.
function five(w, t, { stemTo = 0.38, cy = 0.665 } = {}) {
  const rx = w / 2 - t, ry = 1 - t - cy, l = t + 0.02;
  const start = 262, end = 490;
  const a = start * Math.PI / 180;
  const sx = w / 2 + rx * Math.cos(a), sy = cy + ry * Math.sin(a);
  return [line(w - t, t, l, t), line(l, t, l, stemTo), line(l, stemTo, sx, sy), arc(w / 2, cy, rx, ry, start, end)];
}

// Bold grotesque. Measured on DSC_8800 (Kodak Ultra Max 400): cap height
// 1.16 mm, G/C/K 0.90-0.93 of the cap height wide, O 1.03, A 1.09, the
// digits of "400" 0.72 and the frame-number digits 1.0; stroke about 0.2.
const GROTESK = {
  A: [1.06, (w, t) => {
    const T = t, B = 1 - t, y = 0.7;
    const at = (v) => (w / 2 - t) * (v - T) / (B - T);
    return [line(w / 2, T, t, B), line(w / 2, T, w - t, B), line(w / 2 - at(y), y, w / 2 + at(y), y)];
  }],
  B: [0.88, (w, t) => {
    const l = t, r = w - t, T = t, B = 1 - t, M = 0.5, j = w * 0.52, k = w * 0.55;
    return [line(l, T, l, B), line(l, T, j, T), line(l, M, k, M), line(l, B, k, B),
      arc(j, (T + M) / 2, r - 0.05 - j, (M - T) / 2, 270, 450), arc(k, (M + B) / 2, r - k, (B - M) / 2, 270, 450)];
  }],
  C: [0.92, (w, t) => [arc(w / 2, 0.5, w / 2 - t, 0.5 - t, 38, 322)]],
  D: [0.98, (w, t) => {
    const l = t, r = w - t, T = t, B = 1 - t, j = w * 0.42;
    return [line(l, T, l, B), line(l, T, j, T), line(l, B, j, B), arc(j, 0.5, r - j, 0.5 - t, 270, 450)];
  }],
  E: [0.8, (w, t) => [line(t, t, t, 1 - t), line(t, t, w - t, t), line(t, 0.5, w - t - 0.05, 0.5), line(t, 1 - t, w - t, 1 - t)]],
  F: [0.76, (w, t) => [line(t, t, t, 1 - t), line(t, t, w - t, t), line(t, 0.5, w - t - 0.06, 0.5)]],
  G: [0.94, (w, t) => [arc(w / 2, 0.5, w / 2 - t, 0.5 - t, 8, 322), line(w * 0.54, 0.56, w - t, 0.56), line(w - t, 0.56, w - t, 0.72)]],
  H: [0.92, (w, t) => [line(t, t, t, 1 - t), line(w - t, t, w - t, 1 - t), line(t, 0.5, w - t, 0.5)]],
  I: [0.3, (w, t) => [line(w / 2, t, w / 2, 1 - t)]],
  J: [0.72, (w, t) => [line(w - t, t, w - t, 0.66), arc(w / 2, 0.66, w / 2 - t, 0.34 - t, 0, 180)]],
  K: [0.92, (w, t) => [line(t, t, t, 1 - t), line(w - t, t, t + 0.04, 0.64), line(t + (w - 2 * t) * 0.36, 0.45, w - t, 1 - t)]],
  L: [0.74, (w, t) => [line(t, t, t, 1 - t), line(t, 1 - t, w - t, 1 - t)]],
  M: [1.08, (w, t) => [line(t, t, t, 1 - t), line(w - t, t, w - t, 1 - t), line(t, t, w / 2, 0.78), line(w / 2, 0.78, w - t, t)]],
  N: [0.94, (w, t) => [line(t, t, t, 1 - t), line(w - t, t, w - t, 1 - t), line(t, t, w - t, 1 - t)]],
  O: [1.03, (w, t) => [arc(w / 2, 0.5, w / 2 - t, 0.5 - t, 0, 360)]],
  P: [0.86, (w, t) => {
    const l = t, r = w - t, T = t, m = 0.56, j = w * 0.52;
    return [line(l, T, l, 1 - t), line(l, T, j, T), line(l, m, j, m), arc(j, (T + m) / 2, r - j, (m - T) / 2, 270, 450)];
  }],
  Q: [1.03, (w, t) => [arc(w / 2, 0.5, w / 2 - t, 0.5 - t, 0, 360), line(w * 0.6, 0.7, w - t * 0.6, 1 - t * 0.6)]],
  R: [0.9, (w, t) => {
    const l = t, r = w - t, T = t, m = 0.55, j = w * 0.5;
    return [line(l, T, l, 1 - t), line(l, T, j, T), line(l, m, j, m), arc(j, (T + m) / 2, r - j - 0.02, (m - T) / 2, 270, 450), line(j, m, r, 1 - t)];
  }],
  S: [0.86, (w, t) => {
    const c1 = 0.27, c2 = 0.73, ry1 = 0.5 - c1, ry2 = c2 - 0.5;
    return [arc(w / 2, c1, w / 2 - t - 0.02, ry1, 90, 335), arc(w / 2, c2, w / 2 - t, ry2, 270, 515)];
  }],
  T: [0.84, (w, t) => [line(t, t, w - t, t), line(w / 2, t, w / 2, 1 - t)]],
  U: [0.92, (w, t) => [line(t, t, t, 0.62), line(w - t, t, w - t, 0.62), arc(w / 2, 0.62, w / 2 - t, 0.38 - t, 0, 180)]],
  V: [1.0, (w, t) => [line(t, t, w / 2, 1 - t), line(w / 2, 1 - t, w - t, t)]],
  W: [1.32, (w, t) => [line(t, t, w * 0.27, 1 - t), line(w * 0.27, 1 - t, w / 2, t + 0.08), line(w / 2, t + 0.08, w * 0.73, 1 - t), line(w * 0.73, 1 - t, w - t, t)]],
  X: [0.96, (w, t) => [line(t, t, w - t, 1 - t), line(w - t, t, t, 1 - t)]],
  Y: [0.96, (w, t) => [line(t, t, w / 2, 0.52), line(w - t, t, w / 2, 0.52), line(w / 2, 0.52, w / 2, 1 - t)]],
  Z: [0.86, (w, t) => [line(t, t, w - t, t), line(w - t, t, t, 1 - t), line(t, 1 - t, w - t, 1 - t)]],
  0: [0.72, (w, t) => [arc(w / 2, 0.5, w / 2 - t, 0.5 - t, 0, 360)]],
  1: [0.48, (w, t) => [line(w - t - 0.04, t, w - t - 0.04, 1 - t), line(w - t - 0.04, t, t, 0.3)]],
  2: [0.72, (w, t) => {
    const cy = 0.3, rx = w / 2 - t, ry = 0.3 - t, a = 25 * Math.PI / 180;
    return [arc(w / 2, cy, rx, ry, 180, 385), line(w / 2 + rx * Math.cos(a), cy + ry * Math.sin(a), t, 1 - t), line(t, 1 - t, w - t, 1 - t)];
  }],
  3: [0.72, (w, t) => [arc(w / 2, 0.27, w / 2 - t - 0.02, 0.27 - t / 2, 200, 450), arc(w / 2, 0.735, w / 2 - t, 0.265 - t / 2, 270, 520)]],
  4: [0.76, (w, t) => [line(w * 0.68, t, w * 0.68, 1 - t), line(w * 0.68, t, t, 0.7), line(t, 0.7, w - t, 0.7)]],
  5: [0.72, (w, t) => five(w, t)],
  6: [0.72, (w, t) => [arc(w / 2, 0.66, w / 2 - t, 0.34 - t, 0, 360), arc(w / 2, 0.52, w / 2 - t, 0.52 - t, 180, 318)]],
  7: [0.7, (w, t) => [line(t, t, w - t, t), line(w - t, t, w * 0.36, 1 - t)]],
  8: [0.72, (w, t) => [arc(w / 2, 0.27, w / 2 - t - 0.03, 0.27 - t / 2, 0, 360), arc(w / 2, 0.735, w / 2 - t, 0.265 - t / 2, 0, 360)]],
  9: [0.72, (w, t) => [arc(w / 2, 0.34, w / 2 - t, 0.34 - t, 0, 360), arc(w / 2, 0.48, w / 2 - t, 0.52 - t, 0, 138)]],
  '-': [0.5, (w, t) => [line(t, 0.56, w - t, 0.56)]],
  '.': [0.3, (w, t) => [line(w / 2, 1 - t, w / 2, 1 - t)]],
  '/': [0.56, (w, t) => [line(t, 1 - t, w - t, t)]],
  '+': [0.72, (w, t) => [line(t, 0.55, w - t, 0.55), line(w / 2, 0.55 - (w / 2 - t), w / 2, 0.55 + (w / 2 - t))]],
  ':': [0.3, (w, t) => [line(w / 2, 0.36, w / 2, 0.36), line(w / 2, 1 - t, w / 2, 1 - t)]],
  ' ': [0.42, () => []]
};

// Fujifilm's monoline letters: straight strokes on a grid, corners cut at 45°.
// Measured on the Provia 100F strips: letters 0.9 of the cap height wide, the
// pitch 1.1, the I a single stroke; the thin weight is 0.13 of the cap height,
// the frame numbers about 0.24.
function chamfered(w, t, c = 0.2) {
  const l = t, r = w - t, T = t, B = 1 - t;
  return { l, r, T, B, M: 0.5, c: Math.min(c, (r - l) / 2) };
}
const GRID = {
  A: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.3); return [...path([l, B], [l, T + c], [l + c, T], [r - c, T], [r, T + c], [r, B]), line(l, 0.58, r, 0.58)]; }],
  B: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.16); return [...path([l, T], [r - c, T], [r, T + c], [r, M - c], [r - c, M], [l, M]), ...path([r - c, M], [r, M + c], [r, B - c], [r - c, B], [l, B], [l, T])]; }],
  C: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t); return path([r, T + c * 0.6], [r - c, T], [l + c, T], [l, T + c], [l, B - c], [l + c, B], [r - c, B], [r, B - c * 0.6]); }],
  D: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.26); return path([l, T], [r - c, T], [r, T + c], [r, B - c], [r - c, B], [l, B], [l, T]); }],
  E: [0.84, (w, t) => { const { l, r, T, B, M } = chamfered(w, t); return [...path([r, T], [l, T], [l, B], [r, B]), line(l, M, r - 0.08, M)]; }],
  F: [0.84, (w, t) => { const { l, r, T, B, M } = chamfered(w, t); return [...path([r, T], [l, T], [l, B]), line(l, M, r - 0.1, M)]; }],
  G: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t); return [...path([r, T + c * 0.6], [r - c, T], [l + c, T], [l, T + c], [l, B - c], [l + c, B], [r - c, B], [r, B - c], [r, 0.56], [w * 0.55, 0.56])]; }],
  H: [0.9, (w, t) => { const { l, r, T, B, M } = chamfered(w, t); return [line(l, T, l, B), line(r, T, r, B), line(l, M, r, M)]; }],
  I: [0.3, (w, t) => [line(w / 2, t, w / 2, 1 - t)]],
  J: [0.84, (w, t) => { const { l, r, T, B, c } = chamfered(w, t); return path([r, T], [r, B - c], [r - c, B], [l + c, B], [l, B - c]); }],
  K: [0.9, (w, t) => { const { l, r, T, B, M } = chamfered(w, t); return [line(l, T, l, B), line(l, M + 0.04, r, T), line(l + 0.22 * (r - l), M - 0.04, r, B)]; }],
  L: [0.84, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, T], [l, B], [r, B]); }],
  M: [1.0, (w, t) => { const { l, r, T, B } = chamfered(w, t); return [...path([l, B], [l, T], [w / 2, 0.62], [r, T], [r, B])]; }],
  N: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, B], [l, T], [r, B], [r, T]); }],
  O: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.24); return path([l + c, T], [r - c, T], [r, T + c], [r, B - c], [r - c, B], [l + c, B], [l, B - c], [l, T + c], [l + c, T]); }],
  P: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.16); return path([l, B], [l, T], [r - c, T], [r, T + c], [r, M - c + 0.04], [r - c, M + 0.04], [l, M + 0.04]); }],
  Q: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.24); return [...path([l + c, T], [r - c, T], [r, T + c], [r, B - c], [r - c, B], [l + c, B], [l, B - c], [l, T + c], [l + c, T]), line(w * 0.6, 0.7, r, B)]; }],
  R: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.16); return [...path([l, B], [l, T], [r - c, T], [r, T + c], [r, M - c + 0.04], [r - c, M + 0.04], [l, M + 0.04]), line(r - c - 0.04, M + 0.04, r, B)]; }],
  S: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.18); return path([r, T + c * 0.6], [r - c, T], [l + c, T], [l, T + c], [l, M - c * 0.6], [l + c * 0.6, M], [r - c * 0.6, M], [r, M + c * 0.6], [r, B - c], [r - c, B], [l + c, B], [l, B - c * 0.6]); }],
  T: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return [line(l, T, r, T), line(w / 2, T, w / 2, B)]; }],
  U: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t); return path([l, T], [l, B - c], [l + c, B], [r - c, B], [r, B - c], [r, T]); }],
  V: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, T], [l, 0.55], [w / 2, B], [r, 0.55], [r, T]); }],
  W: [1.0, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, T], [l, B], [w / 2, 0.5], [r, B], [r, T]); }],
  X: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return [line(l, T, r, B), line(r, T, l, B)]; }],
  Y: [0.9, (w, t) => { const { l, r, T, B, M } = chamfered(w, t); return [...path([l, T], [w / 2, M], [r, T]), line(w / 2, M, w / 2, B)]; }],
  Z: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, T], [r, T], [l, B], [r, B]); }],
  0: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.24); return path([l + c, T], [r - c, T], [r, T + c], [r, B - c], [r - c, B], [l + c, B], [l, B - c], [l, T + c], [l + c, T]); }],
  1: [0.62, (w, t) => { const x = w - t - 0.06; return [line(x, t, x, 1 - t), line(x, t, t, 0.3)]; }],
  2: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t); return path([l, T + c], [l + c, T], [r - c, T], [r, T + c], [r, 0.42], [l, B], [r, B]); }],
  3: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.18); return [...path([l, T + c * 0.7], [l + c, T], [r - c, T], [r, T + c], [r, M - c * 0.6], [r - c * 0.6, M], [r, M + c * 0.6], [r, B - c], [r - c, B], [l + c, B], [l, B - c * 0.7]), line(w * 0.36, M, r - c * 0.6, M)]; }],
  4: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); const x = w * 0.68; return [line(x, T, x, B), ...path([x, T], [l, 0.68], [r, 0.68])]; }],
  // The 5's left side stays open below its middle bar (a 6 is closed there).
  5: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.18); return path([r, T], [l, T], [l, 0.42], [r - c, 0.42], [r, 0.42 + c], [r, B - c], [r - c, B], [l + c * 0.4, B]); }],
  6: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.18); return path([r - c * 0.4, T], [l + c, T], [l, T + c], [l, B - c], [l + c, B], [r - c, B], [r, B - c], [r, 0.48 + c], [r - c, 0.48], [l, 0.48]); }],
  7: [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return path([l, T + 0.12], [l, T], [r, T], [r, 0.34], [w * 0.45, B]); }],
  8: [0.9, (w, t) => { const { l, r, T, B, M, c } = chamfered(w, t, 0.16); return [...path([l + c, T], [r - c, T], [r, T + c], [r, M - c], [r - c, M], [l + c, M], [l, M - c], [l, T + c], [l + c, T]), ...path([l + c, M], [l, M + c], [l, B - c], [l + c, B], [r - c, B], [r, B - c], [r, M + c], [r - c, M])]; }],
  9: [0.9, (w, t) => { const { l, r, T, B, c } = chamfered(w, t, 0.18); return path([l + c * 0.4, B], [r - c, B], [r, B - c], [r, T + c], [r - c, T], [l + c, T], [l, T + c], [l, 0.52 - c], [l + c, 0.52], [r, 0.52]); }],
  // Ⅲ is Fujichrome's roman three in RDPⅢ: three stems between two bars.
  'Ⅲ': [0.9, (w, t) => { const { l, r, T, B } = chamfered(w, t); return [line(l, T, r, T), line(l, B, r, B), line(l, T, l, B), line(w / 2, T, w / 2, B), line(r, T, r, B)]; }],
  '-': [0.6, (w, t) => [line(t, 0.55, w - t, 0.55)]],
  '.': [0.3, (w, t) => [line(w / 2, 1 - t, w / 2, 1 - t)]],
  // Kodak's key-number dot (the zero-frame reference mark): a filled disc.
  '•': [0.6, (w, t) => [0.14, 0.09, 0.04, 0.001].map((r) => arc(w / 2, 0.55, r, r, 0, 360))],
  '/': [0.7, (w, t) => [line(t, 1 - t, w - t, t)]],
  '+': [0.8, (w, t) => [line(t, 0.55, w - t, 0.55), line(w / 2, 0.55 - (w / 2 - t), w / 2, 0.55 + (w / 2 - t))]],
  ':': [0.3, (w, t) => [line(w / 2, 0.32, w / 2, 0.32), line(w / 2, 1 - t, w / 2, 1 - t)]],
  ' ': [0.6, () => []]
};

export const EDGE_GLYPH_SETS = Object.freeze({ grotesk: GROTESK, grid: GRID });

// The glyph set's own spelling of a text: Fujichrome writes the "III" of
// RDPIII as one roman numeral.
export function edgeGlyphText(set, text) {
  const upper = String(text || '').toUpperCase();
  return set === 'grid' ? upper.replace(/III(?=$|[^A-Z])/g, 'Ⅲ') : upper;
}

export function hasEdgeGlyphs(set, text) {
  const glyphs = EDGE_GLYPH_SETS[set];
  return Boolean(glyphs) && Array.from(edgeGlyphText(set, text)).every((char) => Boolean(glyphs[char]));
}

function strokeDistance(prims, u, v, t) {
  let best = Infinity;
  for (const p of prims) {
    let d;
    if (p[0] === 'L') {
      const x1 = p[1], y1 = p[2], dx = p[3] - x1, dy = p[4] - y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) {
        d = Math.max(Math.abs(u - x1), Math.abs(v - y1)) - t;
      } else {
        const ux = dx / len, uy = dy / len, px = u - x1, py = v - y1;
        if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9) {
          // Upright and level strokes end square, so corners close.
          const along = Math.abs(px * ux + py * uy - len / 2) - (len / 2 + t);
          const across = Math.abs(px * uy - py * ux) - t;
          d = along > 0 && across > 0 ? Math.hypot(along, across) : Math.max(along, across);
        } else {
          // Diagonals end round: a square end would poke out of the joint.
          // An end on the cap line or the baseline runs on past it instead,
          // so the clip to the cap height cuts it flat (feet of A, V, K).
          const edge = (y) => y <= t + 0.02 || y >= 1 - t - 0.02;
          const reach = 1.5 * t / Math.max(0.2, Math.abs(uy));
          const from = edge(y1) ? -reach : 0, to = edge(p[4]) ? len + reach : len;
          const s = Math.min(to, Math.max(from, px * ux + py * uy));
          d = Math.hypot(px - ux * s, py - uy * s) - t;
        }
      }
    } else {
      const cx = p[1], cy = p[2], rx = p[3], ry = p[4], a0 = p[5], a1 = p[6];
      const px = u - cx, py = v - cy;
      let angle = Math.atan2(py / ry, px / rx) * 180 / Math.PI;
      while (angle < a0) angle += 360;
      while (angle >= a0 + 360) angle -= 360;
      if (angle <= a1) {
        const q = Math.hypot(px / rx, py / ry), r = Math.hypot(px, py);
        d = (q > 1e-9 ? Math.abs(r - r / q) : Math.min(rx, ry)) - t;
      } else {
        // Beyond either end: the stroke ends in a round cap of its own width.
        const end = (deg) => { const a = deg * Math.PI / 180; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; };
        const [ex0, ey0] = end(a0), [ex1, ey1] = end(a1);
        d = Math.min(Math.hypot(u - ex0, v - ey0), Math.hypot(u - ex1, v - ey1)) - t;
      }
    }
    if (d < best) best = d;
  }
  return best;
}

/**
 * One glyph as a coverage mask: `capPx` pixels tall (the cap height),
 * `width` pixels wide including a pixel of margin on each side, and `advance`,
 * the pen movement in pixels. `stroke` is the stroke width as a fraction of
 * the cap height; `widthScale` widens or narrows the letter's box.
 */
export function rasterizeEdgeGlyph(set, char, { capPx, stroke = 0.2, widthScale = 1 } = {}) {
  const glyph = EDGE_GLYPH_SETS[set]?.[char];
  if (!glyph || !(capPx > 0)) return null;
  const w = glyph[0] * widthScale, t = stroke / 2;
  return rasterizeStrokes(glyph[1](w, t), w, t, capPx);
}

/**
 * A shape drawn from strokes on a box one unit tall and `width` units wide
 * (`draw(width, halfStroke)` returns the strokes), as a mask `capPx` tall.
 */
export function rasterizeEdgeShape(draw, width, { capPx, stroke = 0.14 } = {}) {
  if (!(capPx > 0)) return null;
  const t = stroke / 2;
  return rasterizeStrokes(draw(width, t), width, t, capPx);
}

// The outlined arrow Fujichrome prints before a half-frame number ("36▷9A"):
// a box with a pointed end, drawn with the thin stroke.
export function fujiOutlineArrow(w, t) {
  return path([t, t], [w * 0.58, t], [w - t, 0.5], [w * 0.58, 1 - t], [t, 1 - t], [t, t]);
}

function rasterizeStrokes(prims, w, t, capPx) {
  const width = Math.max(1, Math.ceil(w * capPx) + 2), height = Math.max(1, Math.ceil(capPx) + 2);
  const mask = new Float32Array(width * height);
  if (prims.length) {
    for (let y = 0; y < height; y++) {
      const v = (y - 1 + 0.5) / capPx;
      // Clip to the cap height: square ends and diagonals end flat on it.
      const clip = Math.min(1, Math.max(0, (Math.min(v, 1 - v) * capPx) + 0.5));
      if (clip <= 0) continue;
      for (let x = 0; x < width; x++) {
        const u = (x - 1 + 0.5) / capPx;
        const d = strokeDistance(prims, u, v, t);
        const coverage = Math.min(1, Math.max(0, 0.5 - d * capPx)) * clip;
        if (coverage > 0) mask[y * width + x] = coverage;
      }
    }
  }
  return { mask, width, height, advance: w * capPx, originX: 1, originY: 1 };
}

export function edgeGlyphAdvance(set, char, widthScale = 1) {
  const glyph = EDGE_GLYPH_SETS[set]?.[char];
  return glyph ? glyph[0] * widthScale : 0;
}
