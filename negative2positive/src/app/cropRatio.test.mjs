import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CROP_RATIO_PRESETS, DEFAULT_CROP_RATIO_CHOICE, findCropRatioPreset, parseCropRatioChoice, serializeCropRatioChoice,
  orientationForRect, flipOrientation, preferredCropOrientation, fitRectToRatio, resizeRectWithRatio, drawRectWithRatio
} from './cropRatio.js';

const bounds = { width: 3000, height: 2000 };
const minSize = { width: 40, height: 40 };
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
const aspectOf = (rect, ratio, orientation) => (orientation === 'portrait' ? 1 / ratio : ratio);
const assertRatio = (rect, ratio, orientation, message) => near(rect.width, rect.height * aspectOf(rect, ratio, orientation), 1, `${message} ratio`);
const assertInside = (rect, area, message) => {
  assert.ok(rect.left >= -1e-6 && rect.top >= -1e-6, `${message} starts inside: ${JSON.stringify(rect)}`);
  assert.ok(rect.left + rect.width <= area.width + 1e-6 && rect.top + rect.height <= area.height + 1e-6, `${message} ends inside: ${JSON.stringify(rect)}`);
};
const assertMin = (rect, message) => assert.ok(rect.width >= minSize.width - 1e-6 && rect.height >= minSize.height - 1e-6, `${message} respects minSize: ${JSON.stringify(rect)}`);

// --- presets ------------------------------------------------------------------
assert.deepEqual(CROP_RATIO_PRESETS.map(preset => preset.id), ['free', '135', '120-6x4.5', '120-6x6', '120-6x7', '120-6x9', '4x5', '5x7']);
assert.equal(CROP_RATIO_PRESETS[0].ratio, null);
for (const preset of CROP_RATIO_PRESETS.slice(1)) assert.ok(preset.ratio >= 1, `${preset.id} is long ÷ short`);
near(findCropRatioPreset('135').ratio, 1.5, 1e-9, '135');
near(findCropRatioPreset('120-6x4.5').ratio, 1.333, 1e-3, '6x4.5');
assert.equal(findCropRatioPreset('120-6x6').ratio, 1);
near(findCropRatioPreset('120-6x7').ratio, 7 / 6, 1e-9, '6x7');
near(findCropRatioPreset('120-6x9').ratio, 1.5, 1e-9, '6x9');
near(findCropRatioPreset('4x5').ratio, 1.25, 1e-9, '4x5');
near(findCropRatioPreset('5x7').ratio, 1.4, 1e-9, '5x7');
assert.equal(findCropRatioPreset('4x5').label, '4×5 / 8×10');
assert.equal(findCropRatioPreset('nope').id, 'free');
assert.equal(findCropRatioPreset(undefined).id, 'free');
assert.ok(Object.isFrozen(CROP_RATIO_PRESETS) && Object.isFrozen(CROP_RATIO_PRESETS[1]));

// The toolbar select lists the same presets in the same order.
const indexHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html'), 'utf8');
const selectMarkup = indexHtml.match(/<select id="cropRatioSelect"[^>]*>([\s\S]*?)<\/select>/)?.[1];
assert.ok(selectMarkup, 'index.html has #cropRatioSelect');
const options = [...selectMarkup.matchAll(/<option value="([^"]+)"[^>]*>([^<]*)<\/option>/g)].map(match => ({ id: match[1], label: match[2] }));
assert.deepEqual(options, CROP_RATIO_PRESETS.map(preset => ({ id: preset.id, label: preset.label })));

// --- remembered choice --------------------------------------------------------
assert.deepEqual(parseCropRatioChoice(null), DEFAULT_CROP_RATIO_CHOICE);
assert.deepEqual(parseCropRatioChoice('{not json'), DEFAULT_CROP_RATIO_CHOICE);
assert.deepEqual(parseCropRatioChoice('{"id":"6x17","orientation":"portrait"}'), { id: 'free', orientation: 'portrait' });
assert.deepEqual(parseCropRatioChoice('{"id":"4x5","orientation":"sideways"}'), { id: '4x5', orientation: 'landscape' });
assert.equal(serializeCropRatioChoice({ id: '135', orientation: 'portrait' }), '{"id":"135","orientation":"portrait"}');
assert.deepEqual(parseCropRatioChoice(serializeCropRatioChoice({ id: '5x7', orientation: 'portrait' })), { id: '5x7', orientation: 'portrait' });

// --- orientation --------------------------------------------------------------
assert.equal(orientationForRect({ width: 300, height: 200 }), 'landscape');
assert.equal(orientationForRect({ width: 200, height: 300 }), 'portrait');
assert.equal(orientationForRect({ width: 200, height: 200 }), 'landscape');
assert.equal(orientationForRect(null), 'landscape');
assert.equal(flipOrientation('landscape'), 'portrait');
assert.equal(flipOrientation('portrait'), 'landscape');
assert.equal(preferredCropOrientation({ width: 300, height: 200 }, 'portrait'), 'landscape', 'a clear frame decides');
assert.equal(preferredCropOrientation({ width: 200, height: 300 }, 'landscape'), 'portrait');
assert.equal(preferredCropOrientation({ width: 202, height: 200 }, 'portrait'), 'portrait', 'a square frame keeps the remembered orientation');
assert.equal(preferredCropOrientation({ width: 200, height: 202 }, 'landscape'), 'landscape');
assert.equal(preferredCropOrientation(null, 'portrait'), 'portrait');
assert.equal(preferredCropOrientation({ width: 0, height: 0 }, 'garbage'), 'landscape');

// --- fitRectToRatio -----------------------------------------------------------
{
  const rect = { left: 500, top: 400, width: 1200, height: 1000 };
  const fitted = fitRectToRatio(rect, 1.5, bounds, { orientation: 'landscape' });
  assertRatio(fitted, 1.5, 'landscape', 'fit landscape');
  near(fitted.left + fitted.width / 2, 1100, 1e-6, 'fit keeps centre x');
  near(fitted.top + fitted.height / 2, 900, 1e-6, 'fit keeps centre y');
  assert.ok(fitted.width <= rect.width + 1e-9 && fitted.height <= rect.height + 1e-9, 'fit only shrinks');
  near(fitted.width, 1200, 1e-9, 'wider side kept when the rect is taller than the ratio');

  const portrait = fitRectToRatio(rect, 1.5, bounds, { orientation: 'portrait' });
  assertRatio(portrait, 1.5, 'portrait', 'fit portrait');
  near(portrait.height, 1000, 1e-9, 'portrait keeps the height');
  near(portrait.left + portrait.width / 2, 1100, 1e-6, 'portrait keeps centre x');

  const square = fitRectToRatio(rect, 1, bounds);
  near(square.width, square.height, 1e-9, 'square');
  near(square.height, 1000, 1e-9, 'square keeps the short side');

  // Default orientation follows the rect.
  const tall = fitRectToRatio({ left: 100, top: 100, width: 600, height: 900 }, 1.25, bounds);
  assertRatio(tall, 1.25, 'portrait', 'fit defaults to the rect orientation');
}
{
  // Free ratio: unchanged apart from sanitising.
  const rect = { left: 10, top: 20, width: 300, height: 100 };
  assert.deepEqual(fitRectToRatio(rect, null, bounds), rect);
  assert.deepEqual(fitRectToRatio({ left: 2900, top: 1950, width: 300, height: 100 }, null, bounds), { left: 2700, top: 1900, width: 300, height: 100 });
  assert.deepEqual(fitRectToRatio({ left: 310, top: 120, width: -300, height: -100 }, null, bounds), rect);
  assert.equal(fitRectToRatio(null, 1.5, bounds), null);
  assert.equal(fitRectToRatio({ left: NaN, top: 0, width: 1, height: 1 }, 1.5, bounds), null);
}
{
  // Clamping at every edge keeps the ratio and stays inside.
  const cases = [
    ['left', { left: -200, top: 500, width: 900, height: 600 }],
    ['top', { left: 500, top: -200, width: 900, height: 600 }],
    ['right', { left: 2500, top: 500, width: 900, height: 600 }],
    ['bottom', { left: 500, top: 1700, width: 900, height: 600 }],
    ['larger than bounds', { left: -100, top: -100, width: 4000, height: 3000 }],
    ['portrait taller than bounds', { left: 1000, top: -500, width: 800, height: 3000 }]
  ];
  for (const [name, rect] of cases) {
    for (const orientation of ['landscape', 'portrait']) {
      const fitted = fitRectToRatio(rect, 1.5, bounds, { orientation, minSize });
      assertRatio(fitted, 1.5, orientation, `clamp ${name} ${orientation}`);
      assertInside(fitted, bounds, `clamp ${name} ${orientation}`);
      assertMin(fitted, `clamp ${name} ${orientation}`);
    }
  }
  const full = fitRectToRatio({ left: -100, top: -100, width: 4000, height: 3000 }, 1.5, bounds, { orientation: 'landscape' });
  assert.deepEqual(full, { left: 0, top: 0, width: 3000, height: 2000 }, 'the whole frame when it already has the ratio');
}
{
  // Tiny rects grow to the minimum size at the ratio.
  const tiny = fitRectToRatio({ left: 100, top: 100, width: 5, height: 5 }, 1.5, bounds, { orientation: 'landscape', minSize });
  assertRatio(tiny, 1.5, 'landscape', 'tiny');
  near(tiny.height, 40, 1e-9, 'tiny grows to min height');
  near(tiny.width, 60, 1e-9, 'tiny width follows');
  const tinyPortrait = fitRectToRatio({ left: 100, top: 100, width: 5, height: 5 }, 1.5, bounds, { orientation: 'portrait', minSize });
  near(tinyPortrait.width, 40, 1e-9, 'tiny portrait min width');
  near(tinyPortrait.height, 60, 1e-9, 'tiny portrait height follows');
}

// --- resizeRectWithRatio ------------------------------------------------------
const start = { left: 1000, top: 700, width: 900, height: 600 };
const corners = {
  nw: { x: start.left + start.width, y: start.top + start.height },
  ne: { x: start.left, y: start.top + start.height },
  se: { x: start.left, y: start.top },
  sw: { x: start.left + start.width, y: start.top }
};
for (const orientation of ['landscape', 'portrait']) {
  const ratio = 1.5;
  const base = fitRectToRatio(start, ratio, bounds, { orientation });
  const anchors = {
    nw: { x: base.left + base.width, y: base.top + base.height },
    ne: { x: base.left, y: base.top + base.height },
    se: { x: base.left, y: base.top },
    sw: { x: base.left + base.width, y: base.top }
  };
  for (const mode of ['nw', 'ne', 'se', 'sw']) {
    const anchor = anchors[mode];
    const outX = mode.includes('e') ? 1 : -1;
    const outY = mode.includes('s') ? 1 : -1;
    for (const [dx, dy] of [[300, 40], [40, 300], [-100, -100], [2500, 2500], [0, 0]]) {
      const position = { x: anchor.x + outX * (Math.abs(base.width) + dx), y: anchor.y + outY * (base.height + dy) };
      const rect = resizeRectWithRatio(base, mode, position, ratio, bounds, minSize, { orientation });
      const label = `corner ${mode} ${orientation} (${dx},${dy})`;
      assertRatio(rect, ratio, orientation, label);
      assertInside(rect, bounds, label);
      assertMin(rect, label);
      const rectAnchor = { x: mode.includes('e') ? rect.left : rect.left + rect.width, y: mode.includes('s') ? rect.top : rect.top + rect.height };
      near(rectAnchor.x, anchor.x, 1e-6, `${label} anchor x`);
      near(rectAnchor.y, anchor.y, 1e-6, `${label} anchor y`);
      // Dominant delta: the pointer stays inside or on the box along the
      // driving axis, and the box never overshoots it on the other one.
      const aspect = aspectOf(rect, ratio, orientation);
      const expected = Math.max(Math.abs(position.x - anchor.x), Math.abs(position.y - anchor.y) * aspect);
      const room = { width: mode.includes('e') ? bounds.width - anchor.x : anchor.x, height: mode.includes('s') ? bounds.height - anchor.y : anchor.y };
      near(rect.width, Math.max(Math.max(minSize.width, minSize.height * aspect), Math.min(expected, room.width, room.height * aspect)), 1e-6, `${label} width`);
    }
  }
  for (const mode of ['n', 's', 'e', 'w']) {
    for (const delta of [200, -200, 5000, -5000]) {
      const position = mode === 'e' ? { x: base.left + base.width + delta, y: 0 }
        : mode === 'w' ? { x: base.left - delta, y: 0 }
          : mode === 's' ? { x: 0, y: base.top + base.height + delta }
            : { x: 0, y: base.top - delta };
      const rect = resizeRectWithRatio(base, mode, position, ratio, bounds, minSize, { orientation });
      const label = `edge ${mode} ${orientation} ${delta}`;
      assertRatio(rect, ratio, orientation, label);
      assertInside(rect, bounds, label);
      assertMin(rect, label);
      if (mode === 'e') near(rect.left, base.left, 1e-6, `${label} anchors the left edge`);
      if (mode === 'w') near(rect.left + rect.width, base.left + base.width, 1e-6, `${label} anchors the right edge`);
      if (mode === 's') near(rect.top, base.top, 1e-6, `${label} anchors the top edge`);
      if (mode === 'n') near(rect.top + rect.height, base.top + base.height, 1e-6, `${label} anchors the bottom edge`);
      if (Math.abs(delta) === 200) {
        // Moderate drags keep the box centred on the perpendicular axis.
        if (mode === 'e' || mode === 'w') near(rect.top + rect.height / 2, base.top + base.height / 2, 1e-6, `${label} stays centred vertically`);
        else near(rect.left + rect.width / 2, base.left + base.width / 2, 1e-6, `${label} stays centred horizontally`);
        const grown = delta > 0;
        assert.equal(rect.width > base.width, grown, `${label} ${grown ? 'grows' : 'shrinks'}`);
      }
    }
  }
}
{
  // Edge drag near a border: the box slides rather than breaking the ratio.
  const nearTop = { left: 1000, top: 10, width: 300, height: 200 };
  const rect = resizeRectWithRatio(nearTop, 'e', { x: 2500, y: 0 }, 1.5, bounds, minSize);
  assertRatio(rect, 1.5, 'landscape', 'edge near top');
  assertInside(rect, bounds, 'edge near top');
  near(rect.left, 1000, 1e-6, 'edge near top keeps the anchor');
  near(rect.width, 1500, 1e-6, 'edge near top grows to the pointer');
  // Dragging the anchor side past the opposite edge collapses to the minimum size, anchored.
  const collapsed = resizeRectWithRatio(start, 'se', { x: 0, y: 0 }, 1.5, bounds, minSize);
  near(collapsed.width, 60, 1e-6, 'collapsed width');
  near(collapsed.height, 40, 1e-6, 'collapsed height');
  near(collapsed.left, start.left, 1e-6, 'collapsed keeps the anchor');
  near(collapsed.top, start.top, 1e-6, 'collapsed keeps the anchor y');
  // Invalid input is refused rather than guessed.
  assert.equal(resizeRectWithRatio(start, 'move', { x: 1, y: 1 }, 1.5, bounds, minSize), null);
  assert.equal(resizeRectWithRatio(start, 'se', { x: 1, y: 1 }, null, bounds, minSize), null);
  assert.equal(resizeRectWithRatio(null, 'se', { x: 1, y: 1 }, 1.5, bounds, minSize), null);
  assert.equal(resizeRectWithRatio(start, 'se', { x: 1, y: 1 }, 1.5, { width: 0, height: 0 }, minSize), null);
}

// --- drawRectWithRatio --------------------------------------------------------
for (const orientation of ['landscape', 'portrait']) {
  const origin = { x: 1200, y: 800 };
  const aspect = aspectOf(null, 1.5, orientation);
  for (const [dx, dy] of [[600, 50], [50, 600], [-600, 50], [50, -600], [-600, -600], [4000, 4000], [-4000, -4000], [0, 0]]) {
    const rect = drawRectWithRatio(origin, { x: origin.x + dx, y: origin.y + dy }, 1.5, bounds, minSize, { orientation });
    const label = `draw ${orientation} (${dx},${dy})`;
    assertRatio(rect, 1.5, orientation, label);
    assertInside(rect, bounds, label);
    assertMin(rect, label);
    near(dx < 0 ? rect.left + rect.width : rect.left, origin.x, 1e-6, `${label} anchors x at the start`);
    near(dy < 0 ? rect.top + rect.height : rect.top, origin.y, 1e-6, `${label} anchors y at the start`);
    const room = { width: dx < 0 ? origin.x : bounds.width - origin.x, height: dy < 0 ? origin.y : bounds.height - origin.y };
    const expected = Math.max(Math.max(minSize.width, minSize.height * aspect), Math.min(Math.max(Math.abs(dx), Math.abs(dy) * aspect), room.width, room.height * aspect));
    near(rect.width, expected, 1e-6, `${label} width`);
  }
}
{
  const inCorner = drawRectWithRatio({ x: 2995, y: 1995 }, { x: 3000, y: 2000 }, 1.5, bounds, minSize);
  assertInside(inCorner, bounds, 'draw in the corner');
  near(inCorner.width, 60, 1e-6, 'draw in the corner is the minimum size');
  assert.equal(drawRectWithRatio({ x: 1, y: 1 }, { x: 2, y: 2 }, null, bounds, minSize), null);
  assert.equal(drawRectWithRatio(null, { x: 2, y: 2 }, 1.5, bounds, minSize), null);
  assert.equal(drawRectWithRatio({ x: 'a', y: 1 }, { x: 2, y: 2 }, 1.5, bounds, minSize), null);
}

console.log('cropRatio: presets, fit, ratio-locked resize/draw and clamping verified');
