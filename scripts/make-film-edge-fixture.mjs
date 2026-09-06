// Writes negative2positive/test-fixtures/negative-strip-dx.png: a synthetic
// 35mm strip with perforations and DX edge barcodes (95-7, frames 30-32A),
// used by scripts/film-edge-smoke.mjs.
//
// Usage: node scripts/make-film-edge-fixture.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeStrip } from '../negative2positive/test-fixtures/syntheticFilmStrip.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const UPNG = createRequire(join(here, '..', 'package.json'))('upng-js');
const strip = makeStrip({ widthMm: 100, pxPerMm: 14, noise: 0 });
const png = UPNG.encode([strip.image.data.buffer], strip.image.width, strip.image.height, 0);
const out = join(here, '..', 'negative2positive', 'test-fixtures', 'negative-strip-dx.png');
writeFileSync(out, Buffer.from(png));
console.log(`wrote ${out} ${strip.image.width}x${strip.image.height}, codes ${strip.codes.map((c) => `${c.frameNumber}${c.halfFrame ? 'A' : ''}`).join(' ')}`);

// A negative control: one orange-masked frame in a dark holder, no
// perforations and no edge print, so the reader must report nothing.
const plainW = 900; const plainH = 600;
const plain = new Uint8ClampedArray(plainW * plainH * 4);
for (let y = 0; y < plainH; y++) for (let x = 0; x < plainW; x++) {
  const i = (y * plainW + x) * 4;
  const inside = x > 70 && x < plainW - 70 && y > 50 && y < plainH - 50;
  const t = inside ? ((x - 70) / (plainW - 140) + (y - 50) / (plainH - 100)) / 2 : 0;
  plain[i] = inside ? 225 - 90 * t : 10;
  plain[i + 1] = inside ? 155 - 70 * t : 10;
  plain[i + 2] = inside ? 100 - 50 * t : 10;
  plain[i + 3] = 255;
}
const plainOut = join(here, '..', 'negative2positive', 'test-fixtures', 'negative-plain.png');
writeFileSync(plainOut, Buffer.from(UPNG.encode([plain.buffer], plainW, plainH, 0)));
console.log(`wrote ${plainOut} ${plainW}x${plainH}`);
