// Build-derived hashes in every display proxy's store key (#249): the LibRaw
// WebAssembly decoder, and the code that shapes a proxy's pixels (the RAW and
// scan decoders with the sensor-defect pass, the 16-bit packing, the geometry
// chain and its pool, the lens remap and the display resize). A build that
// changes any of them misses every stored proxy instead of converting pixels
// a cold open would no longer produce. Stamped by vite.config.js.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// Relative to negative2positive/src.
export const DISPLAY_PROXY_CODE_FILES = [
  'app/rawFileLoader.js', 'app/rawPostDecode.js', 'app/rawPostDecodeClient.js', 'workers/rawPostDecodeWorker.js',
  'app/rawResultToRgb16.js', 'silvercore/util/image16.js', 'silvercore/util/sensorDefects.js',
  'app/tiffFileLoader.js', 'app/imageFileLoaders.js', 'workers/scanDecodeWorker.js',
  'app/imageGeometry.js', 'app/imageDataOps.js', 'app/geometryPool.js', 'workers/geometryWorker.js',
  'app/lensfunLoader.js', 'app/displayPreview.js', 'app/displayProxy.js'
];

// The decoder package's files, relative to node_modules/libraw-wasm/dist.
export const DISPLAY_PROXY_DECODER_FILES = ['libraw.wasm', 'libraw.js', 'worker.js'];

// The names (relative to `root`) and contents of `files`, so the hash does
// not depend on where the checkout lives.
function hashFiles(root, files) {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = join(root, file);
    hash.update(file);
    hash.update('\0');
    hash.update(existsSync(path) ? readFileSync(path) : 'missing');
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** `{ decoder, code }` for the app rooted at `appRoot` (negative2positive). */
export function displayProxyBuildHashes(appRoot) {
  const src = join(appRoot, 'src');
  const code = hashFiles(src, DISPLAY_PROXY_CODE_FILES);
  let dist = join(appRoot, '..', 'node_modules', 'libraw-wasm', 'dist');
  try { dist = realpathSync(dist); } catch { /* hashed as missing */ }
  const decoder = hashFiles(dist, DISPLAY_PROXY_DECODER_FILES);
  return { decoder, code };
}
