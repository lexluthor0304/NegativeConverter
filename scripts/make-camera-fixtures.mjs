// Writes the camera-scanning fixtures used by scripts/camera-smoke.mjs:
//   test-fixtures/lightpad-blank.png      a blank shot of a light pad with
//                                          30 % radial falloff and a colour drift
//   test-fixtures/negative-vignetted.png  a uniform orange-mask negative with a
//                                          dark subject, shot on the same pad
//   test-fixtures/negative-textured.png   a textured orange-mask negative for
//                                          feature matching (lab match)
//   test-fixtures/shot-{a,b,c}.png        three noisy, slightly shifted and
//                                          rotated camera shots of that negative
//   test-fixtures/shot-dark.png           the same frame one stop darker
// Usage: node scripts/make-camera-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const UPNG = createRequire(join(here, '..', 'package.json'))('upng-js');
const W = 900; const H = 600;

function pad(x, y) {
  const nx = (x / W - 0.5) * 2; const ny = (y / H - 0.5) * 2;
  const falloff = 1 - 0.3 * ((nx * nx + ny * ny) / 2);
  const drift = 1 + 0.06 * (x / W - 0.5);
  return [0.82 * falloff * drift, 0.82 * falloff, 0.82 * falloff / drift];
}
const encode = (linear) => Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 255);

function write(name, pixel) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = pixel(x, y);
    const i = (y * W + x) * 4;
    data[i] = encode(r); data[i + 1] = encode(g); data[i + 2] = encode(b); data[i + 3] = 255;
  }
  const out = join(here, '..', 'negative2positive', 'test-fixtures', name);
  writeFileSync(out, Buffer.from(UPNG.encode([data.buffer], W, H, 0)));
  console.log(`wrote ${out}`);
}

write('lightpad-blank.png', (x, y) => pad(x, y));
// A textured scene (for feature matching): tiled blocks of varying tone, a
// few discs and diagonal lines, as an orange-mask negative without falloff.
let seed = 4242;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const blocks = [];
for (let by = 0; by < 6; by++) for (let bx = 0; bx < 9; bx++) blocks.push(0.15 + 0.75 * rnd());
const discs = Array.from({ length: 14 }, () => [rnd() * W, rnd() * H, 15 + rnd() * 40, 0.1 + 0.8 * rnd()]);
function texturedRgb(x, y) {
  let t = blocks[Math.floor(y / (H / 6)) * 9 + Math.floor(x / (W / 9))];
  for (const [cx, cy, r, v] of discs) if (Math.hypot(x - cx, y - cy) < r) t = v;
  if ((x + y) % 97 < 4 || (x - y + 3000) % 131 < 3) t = 0.95;
  return [0.62 * (0.25 + 0.75 * (1 - t)), 0.42 * (0.25 + 0.75 * (1 - t)), 0.28 * (0.25 + 0.75 * (1 - t))];
}
write('negative-textured.png', texturedRgb);

// A camera shot of the textured negative: shifted by (dx, dy) pixels and
// rotated by `degrees` about the centre, with multiplicative noise and an
// exposure gain; `speck` adds a dust particle present only in that shot.
function shot(name, { dx = 0, dy = 0, degrees = 0, gain = 1, noise = 0.08, seedValue = 1, speck = null }) {
  const angle = (degrees * Math.PI) / 180;
  const c = Math.cos(angle); const s = Math.sin(angle);
  let n = seedValue;
  const rn = () => { n = (n * 1103515245 + 12345) & 0x7fffffff; return n / 0x7fffffff - 0.5; };
  write(name, (x, y) => {
    const ox = x - W / 2 - dx; const oy = y - H / 2 - dy;
    const sx = ox * c + oy * s + W / 2; const sy = -ox * s + oy * c + H / 2;
    let rgb = sx < 0 || sy < 0 || sx >= W || sy >= H ? [0.04, 0.03, 0.02] : texturedRgb(sx, sy);
    if (speck && Math.hypot(x - speck[0], y - speck[1]) < speck[2]) rgb = [0.03, 0.03, 0.03];
    return rgb.map((v) => v * gain * (1 + noise * rn()));
  });
}
shot('shot-a.png', { seedValue: 11 });
shot('shot-b.png', { dx: 14, dy: -9, degrees: 1.2, seedValue: 22 });
shot('shot-c.png', { dx: -10, dy: 7, degrees: -0.8, seedValue: 33, speck: [300, 200, 6] });
shot('shot-dark.png', { dx: 6, dy: 4, degrees: 0.4, gain: 0.5, seedValue: 44 });

write('negative-vignetted.png', (x, y) => {
  const [r, g, b] = pad(x, y);
  // Uniform orange-mask negative (a mid-grey scene) with a dark subject in the
  // middle and a lighter strip, so the histogram analysis has a range.
  const subject = Math.abs(x - W / 2) < W * 0.15 && Math.abs(y - H / 2) < H * 0.15;
  const strip = Math.abs(y - H * 0.5) < H * 0.04 && !subject;
  const t = subject ? 0.9 : strip ? 0.25 : 0.5;
  return [r * 0.62 * t, g * 0.42 * t, b * 0.28 * t];
});
