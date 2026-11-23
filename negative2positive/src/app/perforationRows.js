// A scan that shows the whole width of a 35 mm film has two rows of
// perforations inside the bright rectangle the window search finds: the film,
// not the picture. The holes are bare light source, brighter than any film,
// so levels measured over that rectangle take them for the black point and
// the picture turns grey. This module recognises the two rows by their
// geometry and returns the picture between them. Pure JS on the preview.

// 35 mm still film (ISO 1007, KS perforations), in millimetres.
const PITCH = 4.75;        // one perforation to the next, along the film
const ROW_SPAN = 25.37;    // between the inner edges of the two rows
const HOLE_ACROSS = 2.794; // a perforation across the film
const PICTURE = 24;        // the picture across the film, centred
const FRAME = 36;          // the picture along the film

const MAX_SAMPLES = 800;
const MIN_STEP = 10;       // 8-bit levels between a hole and the film beside it

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const medianOf = (values) => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  return sorted.length ? sorted[sorted.length >> 1] : 0;
};

// Top-left, top-right, bottom-right, bottom-left, whatever order and winding
// the contour gave.
function orderCorners(points) {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  const upper = sorted.slice(0, 2).sort((a, b) => a.x - b.x), lower = sorted.slice(2).sort((a, b) => a.x - b.x);
  return [upper[0], upper[1], lower[1], lower[0]];
}

// The quadrilateral as an `along` × `across` grid of each pixel's darkest
// channel: a hole is white in all three, an orange base is not.
function sampleQuad(image, [tl, tr, br, bl], along, across) {
  const grid = new Uint8Array(along * across);
  const { data, width, height } = image;
  for (let j = 0; j < across; j++) {
    const v = (j + .5) / across, left = lerp(tl, bl, v), right = lerp(tr, br, v);
    for (let i = 0; i < along; i++) {
      const u = (i + .5) / along;
      const x = Math.min(width - 1, Math.max(0, Math.round(left.x + (right.x - left.x) * u)));
      const y = Math.min(height - 1, Math.max(0, Math.round(left.y + (right.y - left.y) * u)));
      const o = (y * width + x) * 4;
      grid[j * along + i] = Math.min(data[o], data[o + 1], data[o + 2]);
    }
  }
  return grid;
}

// The level that separates the holes of a lane from the film between them and
// the level of the holes themselves, or null when the lane has no such step. The holes are its brightest 20 to 60 %,
// so the level a tenth of the way down is a hole and the level 55 % down is
// the brightest film. The darker film is not consulted: it may be fogged
// along the lane, and a mean or Otsu split then divides fogged film from
// clear film instead.
function holeThreshold(values) {
  const counts = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) counts[values[i]]++;
  let seen = 0, level = 255, hole = -1;
  for (; level > 0; level--) {
    seen += counts[level];
    if (hole < 0 && seen >= values.length * .1) hole = level;
    if (seen >= values.length * .55) break;
  }
  return hole - level >= MIN_STEP ? { threshold: (hole + level) / 2, hole } : null;
}

// The holes of a lane: where each bright run starts and how long it is, and
// `flat`, the share of their pixels in the upper half between threshold and
// hole level. A hole cut by the window's end has no length to measure and is
// left out.
function holeRuns(grid, along, lane) {
  const values = grid.subarray(lane * along, (lane + 1) * along);
  const levels = holeThreshold(values);
  const starts = [], lengths = [];
  if (!levels) return { starts, lengths, flat: 0 };
  const { threshold, hole } = levels, upper = (threshold + hole) / 2;
  let start = -1, bright = 0, top = 0;
  for (let i = 0; i < along; i++) {
    const isBright = values[i] > threshold;
    if (isBright) { bright++; if (values[i] >= upper) top++; }
    if (isBright && start < 0) start = i;
    else if (!isBright && start >= 0) {
      if (start > 0) { starts.push(start); lengths.push(i - start); }
      start = -1;
    }
  }
  return { starts, lengths, flat: bright ? top / bright : 0 };
}

// A lane through a row of perforations alternates between hole and film at
// one pitch, the holes about 0.42 of it. Returns `{ pitch, phase, flat }` in
// samples, or null: the phase is where the middle of the holes lies within
// one pitch, and `flat` says the holes are one flat light, which a texture
// that rises and falls at a regular pitch is not (nor is a lane through the
// blurred upper or lower edge of real holes).
function perforationLane(grid, along, lane) {
  const { starts, lengths, flat } = holeRuns(grid, along, lane);
  if (starts.length < 4) return null;
  const pitches = starts.slice(1).map((value, i) => value - starts[i]);
  const pitch = medianOf(pitches);
  if (pitches.some(value => Math.abs(value - pitch) > pitch * .15)) return null;
  const duty = medianOf(lengths) / pitch;
  // A hole a few samples long is grain or a fine texture, not a hole.
  if (duty < .2 || duty > .6 || medianOf(lengths) < 4) return null;
  // The middle of the holes, so a hole narrowed by its round corners keeps its phase.
  // A circular mean: holes just before and just after a whole pitch agree.
  let sin = 0, cos = 0;
  for (let i = 0; i < starts.length; i++) {
    const angle = (starts[i] + lengths[i] / 2) / pitch * 2 * Math.PI;
    sin += Math.sin(angle); cos += Math.cos(angle);
  }
  return { pitch, phase: ((Math.atan2(sin, cos) / (2 * Math.PI) * pitch) + pitch) % pitch, flat: flat >= .75 };
}

// Runs of perforation lanes among `lanes` (in the order given), a lane or two
// of dust forgiven: { first, last, pitch } with first <= last. A run counts
// when most of its lanes show flat holes, and those lanes have their holes at
// the same places: real holes have straight sides, a pattern that drifts from
// lane to lane does not. The lanes through the holes' blurred, rounded upper
// and lower edges are neither flat nor steady in phase; they belong to the
// run by their pitch, so the run ends where the holes end.
function perforationBands(grid, along, lanes) {
  const bands = [];
  let band = null, missed = 0;
  const close = () => {
    if (band && band.flat * 2 >= band.pitches.length) {
      bands.push({ first: Math.min(band.from, band.to), last: Math.max(band.from, band.to), pitch: medianOf(band.pitches) });
    }
    band = null;
  };
  const fits = (found) => {
    const pitch = medianOf(band.pitches);
    if (Math.abs(found.pitch - pitch) > found.pitch * .1) return false;
    if (!found.flat || band.phase === null) return true;
    const shift = Math.abs(found.phase - band.phase) % pitch;
    return Math.min(shift, pitch - shift) <= Math.max(2, pitch * .25);
  };
  for (const lane of lanes) {
    const found = perforationLane(grid, along, lane);
    if (found && band && fits(found)) {
      band.to = lane; band.pitches.push(found.pitch); missed = 0;
    } else if (found) {
      close();
      band = { from: lane, to: lane, pitches: [found.pitch], phase: null, flat: 0 }; missed = 0;
    } else if (band && ++missed > 2) close();
    if (found && found.flat && band.to === lane) {
      band.flat++;
      if (band.phase === null) band.phase = found.phase;
    }
  }
  close();
  return bands;
}

// How much brighter the lanes `from`..`to` are where the row of `lane` has
// its holes than where it has film. The two rows of a film are punched
// together, so the other row repeats this one's holes at the same places.
function holeContrast(grid, along, lane, from, to) {
  const { starts, lengths } = holeRuns(grid, along, lane);
  let holeSum = 0, holes = 0, filmSum = 0, film = 0;
  for (let j = Math.max(0, from); j <= to && j * along < grid.length; j++) {
    for (let k = 0; k < starts.length; k++) {
      // The middle 60 % of each hole, and of the film up to the next one.
      for (let i = Math.round(starts[k] + lengths[k] * .2); i < starts[k] + lengths[k] * .8; i++) { holeSum += grid[j * along + i]; holes++; }
      if (k + 1 === starts.length) break;
      const gap = starts[k + 1] - starts[k] - lengths[k];
      for (let i = Math.round(starts[k] + lengths[k] + gap * .2); i < starts[k] + lengths[k] + gap * .8; i++) { filmSum += grid[j * along + i]; film++; }
    }
  }
  return holes && film ? holeSum / holes - filmSum / film : 0;
}

// The lanes between the two rows of perforations, `{ inner, outer, pitch }`
// (the first lane under the upper row, the first lane of the lower row, the
// pitch in samples), or null. Two rows are taken by their pitch, distance and
// hole size, which are those of 35 mm film. Where the film base is almost as
// bright as the light source on one side, that row's lanes do not pass on
// their own: the row is then placed by the other one, and counted only if
// its lanes are brighter at the other row's holes. `scale` is the length of
// an across-lane over the length of an along-sample.
function findRows(grid, along, across, scale) {
  const reach = Math.floor(across * .42);
  // A window that holds both rows is at most a film and a half wide, so one
  // pitch is at least a fourteenth of it: a finer rhythm belongs to a picture.
  const coarse = band => band.pitch / scale >= across / 14;
  const near = perforationBands(grid, along, Array.from({ length: reach }, (_, j) => j)).filter(coarse);
  const far = perforationBands(grid, along, Array.from({ length: reach }, (_, j) => across - 1 - j)).filter(coarse);
  const nominal = HOLE_ACROSS / PITCH;
  const height = (band, pitch) => (band.last - band.first + 1) * scale / pitch;
  let best = null;
  for (const top of near) for (const bottom of far) {
    const pitch = (top.pitch + bottom.pitch) / 2;
    if (Math.abs(top.pitch - bottom.pitch) > pitch * .08) continue;
    const span = (bottom.first - top.last - 1) * scale / pitch;
    if (Math.abs(span / (ROW_SPAN / PITCH) - 1) > .08) continue;
    // A row the window's own edge cuts through shows only part of its holes.
    if (height(top, pitch) > nominal * 1.3 || height(top, pitch) < (top.first <= 2 ? .08 : nominal * .65)) continue;
    if (height(bottom, pitch) > nominal * 1.3 || height(bottom, pitch) < (bottom.last >= across - 3 ? .08 : nominal * .65)) continue;
    const lanes = top.last - top.first + bottom.last - bottom.first;
    if (!best || lanes > best.lanes) best = { inner: top.last + 1, outer: bottom.first, pitch, lanes };
  }
  if (best) return best;
  const single = [...near.map(band => ({ band, upper: true })), ...far.map(band => ({ band, upper: false }))]
    .sort((a, b) => (b.band.last - b.band.first) - (a.band.last - a.band.first));
  for (const { band, upper } of single) {
    if (height(band, band.pitch) > nominal * 1.3 || height(band, band.pitch) < nominal * .65) continue;
    const lane = band.pitch / scale, span = Math.round(lane * ROW_SPAN / PITCH), hole = lane * nominal;
    const inner = upper ? band.last + 1 : band.first - span, outer = inner + span;
    // The other row's holes, as far as the window shows them.
    const from = upper ? Math.round(outer + hole * .15) : Math.round(inner - hole * .85);
    const to = upper ? Math.round(outer + hole * .85) : Math.round(inner - hole * .15);
    if (from < 0 || to >= across) continue;
    if (holeContrast(grid, along, (band.first + band.last) >> 1, from, to) < 3) continue;
    return { inner, outer, pitch: band.pitch };
  }
  return null;
}

// Where the picture ends along the film: columns that are film base from one
// strip beside the perforations to the other belong to the gap between
// frames. Each column is compared with the base measured in that column, so a
// fogged or flared end still reads as base. A thin picture is as bright as
// the base at its ends, and its gap cannot be told from it: the ends are
// trimmed only when both gaps are found and a whole frame lies between them.
function trimEnds(grid, along, rows, pictureFirst, pictureLast) {
  const stripLanes = (from, to) => {
    const lanes = [];
    for (let j = from + 2; j < to - 1; j++) lanes.push(j);
    return lanes;
  };
  const upper = stripLanes(rows.inner - 1, pictureFirst), lower = stripLanes(pictureLast, rows.outer);
  if (upper.length < 2 || lower.length < 2) return [0, along];
  const step = Math.max(1, Math.floor((pictureLast - pictureFirst) / 48));
  const isGap = (i) => {
    const a = medianOf(upper.map(j => grid[j * along + i])), b = medianOf(lower.map(j => grid[j * along + i]));
    const off = [];
    for (let j = pictureFirst + 2; j < pictureLast - 1; j += step) {
      const t = (j - pictureFirst) / (pictureLast - pictureFirst);
      off.push(Math.abs(grid[j * along + i] - (a + (b - a) * t)));
    }
    off.sort((x, y) => x - y);
    return off[off.length >> 1] <= 6 && off[Math.floor(off.length * .9)] <= 12;
  };
  const limit = Math.floor(along * .15), least = Math.max(3, Math.round(rows.pitch * .03));
  // The number of columns before the picture seen from one end, or null: up
  // to the inner end of the first gap that is wide enough and ends before
  // the search does (a gap that does not end is a picture as thin as base).
  const edgeFrom = (column) => {
    let run = 0, holes = 0;
    for (let k = 0; k < limit; k++) {
      if (isGap(column(k))) { run++; holes = 0; continue; }
      if (run && ++holes <= 1) continue;
      if (run >= least) return k - holes + 1;
      run = 0; holes = 0;
    }
    return null;
  };
  const left = edgeFrom(k => k), right = edgeFrom(k => along - 1 - k);
  if (left === null || right === null) return [0, along];
  return along - right - left >= rows.pitch * FRAME / PITCH * .985 ? [left, along - right] : [0, along];
}

function trimAlong(image, corners) {
  const [tl, tr, br, bl] = corners;
  const length = (distance(tl, tr) + distance(bl, br)) / 2, breadth = (distance(tl, bl) + distance(tr, br)) / 2;
  const along = Math.min(MAX_SAMPLES, Math.round(length)), across = Math.min(MAX_SAMPLES, Math.round(breadth));
  if (along < 80 || across < 80) return null;
  const grid = sampleQuad(image, corners, along, across);
  const rows = findRows(grid, along, across, (breadth / across) / (length / along));
  if (!rows) return null;
  const span = rows.outer - rows.inner;
  const centre = rows.inner + span / 2, half = span * PICTURE / ROW_SPAN / 2;
  const first = centre - half, last = centre + half;
  const [from, to] = trimEnds(grid, along, rows, Math.ceil(first), Math.floor(last));
  const at = (i, j) => lerp(lerp(tl, tr, i / along), lerp(bl, br, i / along), j / across);
  return { points: [at(from, first), at(to, first), at(to, last), at(from, last)], pitch: rows.pitch * length / along };
}

/**
 * The picture inside a window that shows a 35 mm film with both rows of
 * perforations: `{ points, pitch }` (four corners in image pixels, the
 * perforation pitch in pixels), or null when the window holds no such rows.
 * `image` is 8-bit RGBA, `points` the window's four corners in any order.
 */
export function pictureBetweenPerforations(image, points) {
  if (!image?.data || points?.length !== 4) return null;
  const [tl, tr, br, bl] = orderCorners(points);
  // The film runs along the window's width, or along its height.
  return trimAlong(image, [tl, tr, br, bl]) || trimAlong(image, [tl, bl, br, tr]);
}
