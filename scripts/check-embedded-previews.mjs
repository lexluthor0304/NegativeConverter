// Walk a folder of TIFF-container RAWs with the embedded-preview locator and
// report which previews the viewer and the tiles would use, and how many bytes
// each path reads. Header slices only: nothing is decoded.
//
//   node scripts/check-embedded-previews.mjs /path/to/roll [--viewer 2200] [--expect-m11]
//
// --expect-m11 fails unless every file picks 2112x1408 for the viewer and
// 720x480 for tiles within the #235 read budget (tile <= 200 KB, IFD data
// <= 32 KB), which is the acceptance check for the Leica M11 roll.
import { openAsBlob, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isTiffContainerRawName, locateEmbeddedPreviews, pickForTile, pickForViewer } from '../negative2positive/src/app/rawEmbeddedPreview.js';

const args = process.argv.slice(2);
const dir = args.find(arg => !arg.startsWith('--'));
if (!dir) {
  console.error('usage: node scripts/check-embedded-previews.mjs <dir> [--viewer <device px>] [--expect-m11]');
  process.exit(2);
}
const viewerIndex = args.indexOf('--viewer');
const viewerPx = viewerIndex >= 0 ? Number(args[viewerIndex + 1]) : 2200;
const expectM11 = args.includes('--expect-m11');

const files = readdirSync(dir).filter(name => isTiffContainerRawName(name) && statSync(join(dir, name)).isFile()).sort();
const rows = [];
const failures = [];
for (const name of files) {
  const started = performance.now();
  const found = await locateEmbeddedPreviews(await openAsBlob(join(dir, name)));
  const ms = performance.now() - started;
  const viewer = found && pickForViewer(found.previews, viewerPx);
  const tile = found && pickForTile(found.previews, 288);
  const row = {
    name, ms: Number(ms.toFixed(2)), ifdBytes: found?.bytesRead ?? null,
    viewer: viewer ? `${viewer.width}x${viewer.height}` : null, viewerBytes: viewer ? found.bytesRead + viewer.length : null,
    tile: tile ? `${tile.width}x${tile.height}` : null, tileBytes: tile ? found.bytesRead + tile.length : null,
    previews: found?.previews.map(p => `${p.width}x${p.height}`) ?? [],
  };
  rows.push(row);
  if (expectM11 && (row.viewer !== '2112x1408' || row.tile !== '720x480' || row.tileBytes > 200 * 1024 || row.ifdBytes > 32 * 1024)) {
    failures.push(row);
  }
}
for (const row of rows) console.log(JSON.stringify(row));
const tileBytes = rows.map(row => row.tileBytes).filter(Number.isFinite).sort((a, b) => a - b);
console.log(JSON.stringify({
  files: rows.length, located: rows.filter(row => row.viewer).length,
  tileBytesMedian: tileBytes[Math.floor(tileBytes.length / 2)] ?? null, tileBytesMax: tileBytes.at(-1) ?? null,
  tileBytesTotal: tileBytes.reduce((sum, value) => sum + value, 0),
}));
if (failures.length) {
  console.error(`FAIL: ${failures.length} file(s) do not meet the M11 picks/budget`);
  process.exit(1);
}
