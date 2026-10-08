// Synthetic fixtures at small sizes: structure, determinism, 12-bit packing,
// embedded previews found by the app's own extractor, and bounded memory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sceneSample, writeSyntheticTiff, writeSyntheticDng, ensureFixtures, syntheticFixtureSpecs, stubJpegEncoder, stubJpeg,
  pack12, unpack12, cfaValue, cfaStripBytes, estimateDngBytes, previewSizes, SIZE_60MP, HEAVY_RAW_BYTES, CFA_TAGS, previewRenderSource
} from './fixtures.mjs';
import { parseTiff } from '../../negative2positive/src/workers/tiffWriter.js';
import { extractNefPreviewJpeg } from '../../negative2positive/src/app/nefJpegPreview.js';

const UTIF = createRequire(import.meta.url)('utif');
const dir = mkdtempSync(join(tmpdir(), 'nc-perf-fixtures-'));

try {
  // 12-bit packing round trip (MSB first, two samples in three bytes).
  const samples = Uint16Array.from([0, 4095, 1234, 2048, 7, 4000]);
  const packed = new Uint8Array(9);
  assert.equal(pack12(samples, packed), 9);
  assert.deepEqual([...packed.subarray(0, 3)], [0x00, 0x0F, 0xFF]);
  assert.deepEqual([...unpack12(packed, 6)], [...samples]);

  // Scene: rebate, sprocket holes (light source) and image area differ.
  const out = new Float64Array(3);
  const W = 600, H = 400;
  const holes = [];
  for (let x = 0; x < W; x++) { sceneSample(out, x, 0.04 * H, W, H, 1, 'color', 0); if (out[0] > 0.98) holes.push(x); }
  assert.ok(holes.length > 20, 'sprocket holes show the light source');
  sceneSample(out, 0.005 * W, 0.5 * H, W, H, 1, 'color', 0);
  assert.ok(out[0] > out[1] && out[1] > out[2], 'the clear base has an orange mask');
  sceneSample(out, 0.005 * W, 0.5 * H, W, H, 1, 'bw', 0);
  assert.ok(Math.abs(out[0] - out[1]) < 0.01, 'the B&W base is neutral');
  sceneSample(out, 0.5 * W, 0.5 * H, W, H, 1, 'color', 0);
  assert.ok(out[0] < 0.93 && out[0] > 0, 'the image area is denser than the base');

  // TIFF: 16-bit RGB, decodable by the app's UTIF, deterministic.
  const spec = { name: 't.tif', format: 'tiff', kind: 'color', seed: 5, width: 600, height: 400 };
  const a = writeSyntheticTiff(join(dir, 'a.tif'), spec);
  const b = writeSyntheticTiff(join(dir, 'b.tif'), spec);
  assert.equal(a.sha256, b.sha256, 'same seed, same bytes');
  assert.notEqual(writeSyntheticTiff(join(dir, 'c.tif'), { ...spec, seed: 6 }).sha256, a.sha256);
  assert.equal(statSync(join(dir, 'a.tif')).size, a.bytes);
  const tiffBytes = readFileSync(join(dir, 'a.tif'));
  const { ifd0 } = parseTiff(new Uint8Array(tiffBytes.buffer, tiffBytes.byteOffset, tiffBytes.byteLength));
  assert.deepEqual(ifd0[258].values, [16, 16, 16]);
  const ifds = UTIF.decode(tiffBytes.buffer.slice(tiffBytes.byteOffset, tiffBytes.byteOffset + tiffBytes.byteLength));
  UTIF.decodeImage(tiffBytes.buffer.slice(tiffBytes.byteOffset, tiffBytes.byteOffset + tiffBytes.byteLength), ifds[0]);
  assert.equal(ifds[0].width, 600);
  assert.equal(ifds[0].height, 400);
  const pixel = new DataView(tiffBytes.buffer, tiffBytes.byteOffset + ifd0[273].values[0]);
  sceneSample(out, 0, 0, 600, 400, 5, 'color', 0.03);
  assert.equal(pixel.getUint16(0, true), Math.round(Math.pow(out[0], 1 / 2.2) * 65535), 'little-endian gamma-encoded samples');

  // DNG: CFA IFD0 from buildTiffParts, 12-bit strip, three previews in SubIFDs.
  const dngSpec = { name: 'd.dng', format: 'dng', kind: 'color', seed: 9, width: 640, height: 426 };
  const previews = [];
  for (const size of previewSizes(dngSpec)) previews.push({ ...size, jpeg: await stubJpegEncoder({ ...size }) });
  const dng = writeSyntheticDng(join(dir, 'd.dng'), dngSpec, previews);
  assert.equal(writeSyntheticDng(join(dir, 'e.dng'), dngSpec, previews).sha256, dng.sha256);
  const bytes = new Uint8Array(readFileSync(join(dir, 'd.dng')));
  assert.equal(bytes.length, dng.bytes);
  assert.ok(!new TextDecoder().decode(bytes.subarray(0, 1000)).includes('iPhone'), 'the loader must not route it to UTIF');
  const parsed = parseTiff(bytes).ifd0;
  assert.equal(parsed[262].values[0], 32803, 'CFA photometric');
  assert.equal(parsed[258].values[0], 12);
  assert.deepEqual(parsed[CFA_TAGS.CFARepeatPatternDim].values, [2, 2]);
  assert.deepEqual([...parsed[CFA_TAGS.CFAPattern].values], [0, 1, 1, 2], 'RGGB');
  assert.equal(parsed[279].values[0], cfaStripBytes(dngSpec));
  const strip = parsed[273].values[0];
  const row0 = unpack12(bytes, 4, strip);
  for (let x = 0; x < 4; x++) {
    sceneSample(out, x, 0, 640, 426, 9, 'color', 0.03);
    assert.equal(row0[x], cfaValue(out, x, 0), `photosite ${x} holds the scene's CFA channel`);
  }
  const lastRow = unpack12(bytes, 2, strip + (425 * 640 * 3) / 2);
  sceneSample(out, 1, 425, 640, 426, 9, 'color', 0.03);
  assert.equal(lastRow[1], cfaValue(out, 1, 425), 'odd row, odd column is blue');
  const subIfds = parsed[CFA_TAGS.SubIFDs].values;
  assert.equal(subIfds.length, 3);
  const view = new DataView(bytes.buffer);
  const previewInfo = subIfds.map(offset => {
    const count = view.getUint16(offset, true);
    const tags = {};
    for (let i = 0; i < count; i++) {
      const e = offset + 2 + i * 12;
      tags[view.getUint16(e, true)] = view.getUint32(e + 8, true);
    }
    return tags;
  });
  previewInfo.forEach((tags, i) => {
    assert.equal(tags[254], 1, 'previews are reduced-resolution subfiles');
    assert.equal(tags[259], 7, 'JPEG compressed');
    assert.equal(tags[256], previews[i].width);
    assert.deepEqual([...bytes.subarray(tags[273], tags[273] + tags[279])], [...previews[i].jpeg], 'StripOffsets point at the JPEG');
  });
  // The app's own embedded-preview extractor finds the largest preview (at
  // 60 MP the full-size one; in this small file the fixed 2112×1408 one).
  const extracted = extractNefPreviewJpeg(bytes.buffer.slice(0));
  assert.deepEqual([extracted.width, extracted.height], [2112, 1408]);

  // 60 MP DNG size: under 100 MiB even with generous preview sizes.
  assert.ok(estimateDngBytes(SIZE_60MP) < HEAVY_RAW_BYTES, `60 MP DNG estimate ${estimateDngBytes(SIZE_60MP)}`);
  assert.equal(cfaStripBytes(SIZE_60MP), 90_630_144, "86.4 MiB of 12-bit samples");
  assert.deepEqual(previewSizes(SIZE_60MP).map(size => [size.width, size.height]), [[9504, 6320], [2112, 1408], [720, 480]], 'the M11 preview sizes');

  // Manifest-driven generation skips fixtures that are already current.
  const small = syntheticFixtureSpecs({ rollSize: 2 }).map(entry => ({ ...entry, width: 320, height: 214 }));
  const logs = [];
  const first = await ensureFixtures({ dir: join(dir, 'set'), specs: small, encodeJpeg: stubJpegEncoder, encoderLabel: 'stub', log: line => logs.push(line), checkDisk: false });
  assert.equal(logs.length, small.length);
  assert.equal(Object.keys(first).length, small.length);
  const second = await ensureFixtures({ dir: join(dir, 'set'), specs: small, encodeJpeg: stubJpegEncoder, encoderLabel: 'stub', log: line => logs.push(line), checkDisk: false });
  assert.equal(logs.length, small.length, 'nothing is regenerated');
  assert.equal(second['synthetic-roll-02.dng'].sha256, first['synthetic-roll-02.dng'].sha256);
  assert.notEqual(first['synthetic-roll-01.dng'].sha256, first['synthetic-roll-02.dng'].sha256, 'roll frames differ by seed');
  assert.equal(first['synthetic-60mp-cfa.dng'].previews.length, 3);
  // The refusal must not depend on the machine's free disk: with a large one
  // (CI runners) the check passed and the 60000 x 60000 DNG was generated.
  await assert.rejects(ensureFixtures({ dir: join(dir, 'huge'), specs: [{ ...small[0], width: 60000, height: 60000 }], checkDisk: true,
    readDisk: () => 21 * 1024 ** 3 }), /free disk/);

  // Bounded memory: a 6 MP DNG in a fresh process peaks well under 300 MB RSS
  // (rows are generated in bands, so the peak does not grow with size).
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeSyntheticDng, stubJpeg } from ${JSON.stringify(new URL('./fixtures.mjs', import.meta.url).href)};
    writeSyntheticDng(${JSON.stringify(join(dir, 'rss.dng'))}, { width: 3000, height: 2000, seed: 3, kind: 'color' },
      [{ width: 2968, height: 1984, jpeg: stubJpeg(2968, 1984) }]);
    process.stdout.write(String(process.resourceUsage().maxRSS));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const maxRssKiB = Number(child.stdout);
  assert.ok(maxRssKiB * 1024 < 300 * 1024 * 1024, `generator peak RSS ${(maxRssKiB / 1024).toFixed(0)} MB`);

  // The preview renderer shipped to Chrome is self-contained source.
  assert.doesNotThrow(() => new Function(`return ${previewRenderSource()}`)());
  assert.deepEqual([...stubJpeg(0x1234, 0x0567).subarray(7, 11)], [0x05, 0x67, 0x12, 0x34]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('fixtures: scene, TIFF, 12-bit CFA DNG with previews, determinism, manifest and memory tests passed');
