import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pictureBetweenPerforations } from './perforationRows.js';
import { detectImageWindow, projectWindowCrop } from './imageWindowDetector.js';
import { AUTO_FRAME_FORMAT_RATIOS } from './autoFrameFormats.js';

// A 35 mm strip in a dark holder at 20 px/mm: the film 700 px wide, a pitch of
// 95 px, holes 40 × 56 px whose inner edges lie 96 px inside the film, the
// 24 × 36 mm picture between them and 2 mm of clear film at each end.
const WIDTH = 1000, HEIGHT = 800;
const FILM = { left: 100, right: 900, top: 50, bottom: 750 };
const PICTURE = { left: 140, right: 860, top: 160, bottom: 640 };
const noise = (x, y, span) => ((x * 73 + y * 151 + ((x * y) % 17) * 29) % (span * 2 + 1)) - span;

function strip({ base = 215, lowerBase = base, hole = 255, fog = null, rows = [true, true], picture = PICTURE, content = null } = {}) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    let value = 6;
    if (x >= FILM.left && x < FILM.right && y >= FILM.top && y < FILM.bottom) {
      value = base + (lowerBase - base) * (y - FILM.top) / (FILM.bottom - FILM.top) + noise(x, y, 2);
      if (fog && x < fog.right && y < fog.bottom) value -= fog.depth * (1 - (x - FILM.left) / (fog.right - FILM.left));
      const inHole = (x - FILM.left - 10) % 95 < 40 && x - FILM.left >= 10;
      if (inHole && ((rows[0] && y >= 90 && y < 146) || (rows[1] && y >= 654 && y < 710))) value = hole;
      if (x >= picture.left && x < picture.right && y >= picture.top && y < picture.bottom) {
        value = content ? content(x, y) : 60 + ((x * 7 + y * 3) % 90) + noise(x, y, 6);
      }
    }
    data.set([value, value, value, 255], (y * WIDTH + x) * 4);
  }
  return { data, width: WIDTH, height: HEIGHT };
}
const window = [{ x: FILM.left, y: FILM.top }, { x: FILM.right, y: FILM.top }, { x: FILM.right, y: FILM.bottom }, { x: FILM.left, y: FILM.bottom }];
const bounds = (points) => ({
  left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
  top: Math.min(...points.map(p => p.y)), bottom: Math.max(...points.map(p => p.y))
});
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} against ${expected}`);
const assertPicture = (result, label, { ends = true } = {}) => {
  assert.ok(result, `${label}: the two rows are recognised`);
  const box = bounds(result.points);
  near(box.top, PICTURE.top, 4, `${label}: top`);
  near(box.bottom, PICTURE.bottom, 4, `${label}: bottom`);
  near(box.left, ends ? PICTURE.left : FILM.left, 4, `${label}: left`);
  near(box.right, ends ? PICTURE.right : FILM.right, 4, `${label}: right`);
  near(result.pitch, 95, 1.5, `${label}: pitch`);
};

// The picture between the rows, with the gap at both ends trimmed.
assertPicture(pictureBetweenPerforations(strip(), window), 'clear strip');

// The corners in another order and winding, as a contour gives them.
assertPicture(pictureBetweenPerforations(strip(), [window[2], window[1], window[0], window[3]]), 'corner order');

// A row whose film is almost as bright as the holes does not pass lane by
// lane; it is placed by the other row and confirmed by its faint holes.
assertPicture(pictureBetweenPerforations(strip({ lowerBase: 254 }), window), 'faint lower row');

// Film fogged at one end of a row (a light leak): the holes are still the
// brightest part of the lane and the row still counts.
assertPicture(pictureBetweenPerforations(strip({ fog: { right: 420, bottom: 400, depth: 90 } }), window), 'fogged end', { ends: false });

// A picture as thin as the base at its ends: the gap cannot be told from it,
// so the ends stay where the window has them.
assertPicture(pictureBetweenPerforations(strip({ content: (x, y) => (x < 300 || x > 700 ? 213 : 120) + noise(x, y, 2) }), window),
  'thin picture ends', { ends: false });

// One row alone (the other side has no holes at all) is not a 35 mm strip.
assert.equal(pictureBetweenPerforations(strip({ rows: [true, false] }), window), null, 'one row is not enough');

// No perforations: a window is returned as it is.
assert.equal(pictureBetweenPerforations(strip({ rows: [false, false] }), window), null, 'no rows');

// A row of bright rectangles inside a picture (windows of a facade on a
// negative) has no partner at the film's distance.
const facade = strip({ rows: [false, false], picture: { left: 100, right: 900, top: 50, bottom: 750 },
  content: (x, y) => ((x - 110) % 95 < 40 && x >= 110 && y >= 120 && y < 176 ? 230 : 90) + noise(x, y, 4) });
assert.equal(pictureBetweenPerforations(facade, window), null, 'a row of windows in the picture');

// A texture that repeats at a regular pitch is not a row of holes: its bright
// parts are ramps, not one flat light (the crop-apply smoke's fixture, whose
// 6 px blocks repeat every 90 px and were first taken for perforations).
{
  const data = new Uint8ClampedArray(1500 * 1000 * 4);
  const put = (x0, y0, w, h, c) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...c, 255], (y * 1500 + x) * 4); };
  put(0, 0, 1500, 1000, [232, 158, 92]); put(150, 120, 1200, 760, [34, 22, 12]);
  for (let y = 124; y < 876; y += 6) for (let x = 154; x < 1346; x += 6) {
    const n = (x * 13 + y * 29) % 90;
    put(x, y, 6, 6, [40 + n, Math.round(22 + n / 2), Math.round(14 + n / 3)]);
  }
  const textured = { data, width: 1500, height: 1000 };
  assert.equal(pictureBetweenPerforations(textured, [{ x: 150, y: 120 }, { x: 1350, y: 120 }, { x: 1350, y: 880 }, { x: 150, y: 880 }]), null,
    'a periodic texture is not perforations');
}

// Flat bright bars that drift from lane to lane (diagonal stripes) are not
// holes either: the holes of a row stay where they are.
const stripes = strip({ rows: [false, false], picture: { left: 100, right: 900, top: 50, bottom: 750 },
  content: (x, y) => ((x + y) % 95 < 40 ? 230 : 90) + noise(x, y, 2) });
assert.equal(pictureBetweenPerforations(stripes, window), null, 'diagonal stripes');

// The film running down the image instead of across it.
const upright = (() => {
  const source = strip();
  const data = new Uint8ClampedArray(source.data.length);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    data.set(source.data.subarray((y * WIDTH + x) * 4, (y * WIDTH + x) * 4 + 4), (x * HEIGHT + y) * 4);
  }
  return { data, width: HEIGHT, height: WIDTH };
})();
{
  const result = pictureBetweenPerforations(upright, window.map(p => ({ x: p.y, y: p.x })));
  assert.ok(result, 'upright strip: the two rows are recognised');
  const box = bounds(result.points);
  near(box.left, PICTURE.top, 4, 'upright: left'); near(box.right, PICTURE.bottom, 4, 'upright: right');
  near(box.top, PICTURE.left, 4, 'upright: top'); near(box.bottom, PICTURE.right, 4, 'upright: bottom');
}

// Through the window search: the bright rectangle in the holder is the film,
// and the window it returns is the picture, named 135.
globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const targets = Object.entries(AUTO_FRAME_FORMAT_RATIOS).map(([key, ratio]) => ({ key, ratio }));
{
  const image = strip();
  const result = detectImageWindow(new ImageData(image.data, image.width, image.height), targets);
  assert.ok(result?.points, 'the strip gives a window');
  assert.equal(result.detectedFormat, '135');
  near(result.evidence.perforationPitch, 95, 1.5, 'the pitch is recorded');
  const crop = projectWindowCrop(result, image, image, image);
  near(crop.top, PICTURE.top, 6, 'crop top'); near(crop.top + crop.height, PICTURE.bottom, 6, 'crop bottom');
  near(crop.left, PICTURE.left, 6, 'crop left'); near(crop.left + crop.width, PICTURE.right, 6, 'crop right');
}
{
  // The same holder window without perforations keeps its four sides.
  const image = strip({ rows: [false, false], picture: { left: 100, right: 900, top: 50, bottom: 750 } });
  const result = detectImageWindow(new ImageData(image.data, image.width, image.height), targets);
  assert.ok(result?.points, 'a window without perforations');
  assert.equal(result.evidence.perforationPitch, undefined);
  const crop = projectWindowCrop(result, image, image, image);
  near(crop.top, FILM.top, 6, 'unchanged top'); near(crop.height, FILM.bottom - FILM.top, 10, 'unchanged height');
}

console.log('perforationRows: ok');
