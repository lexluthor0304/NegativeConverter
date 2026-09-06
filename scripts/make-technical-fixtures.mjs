// Writes the fixture used by scripts/technical-depth-smoke.mjs:
//   test-fixtures/negative-gradient-16.png  a 16-bit orange-mask negative with
//                                            smooth gradients (thousands of levels
//                                            per channel) and a few shapes
// Usage: node scripts/make-technical-fixtures.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pako = createRequire(join(here, '..', 'package.json'))('pako');
const { encodePng16Blob } = await import('../negative2positive/src/workers/imageEncoders.js');
const W = 900; const H = 600;
const encode16 = (linear) => Math.round(Math.pow(Math.max(0, Math.min(1, linear)), 1 / 2.2) * 65535);

const rgba = new Uint16Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    // Scene luminance: a diagonal gradient plus a soft disc and a bar.
    let t = 0.08 + 0.84 * (0.6 * x / W + 0.4 * y / H);
    const d = Math.hypot(x - 300, y - 300);
    if (d < 120) t = 0.15 + 0.5 * (d / 120);
    if (x > 600 && x < 760 && y > 120 && y < 180) t = 0.92;
    const density = 1 - t; // dense negative where the scene is bright
    const i = (y * W + x) * 4;
    rgba[i] = encode16(0.62 * (0.22 + 0.78 * density));
    rgba[i + 1] = encode16(0.42 * (0.22 + 0.78 * density));
    rgba[i + 2] = encode16(0.28 * (0.22 + 0.78 * density));
    rgba[i + 3] = 65535;
  }
}
// The app's own 16-bit PNG encoder writes genuine 16-bit samples.
const out = join(here, '..', 'negative2positive', 'test-fixtures', 'negative-gradient-16.png');
writeFileSync(out, Buffer.from(await encodePng16Blob(rgba, W, H, pako.deflate).arrayBuffer()));
console.log(`wrote ${out}`);
