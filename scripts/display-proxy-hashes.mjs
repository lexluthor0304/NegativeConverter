// Build-derived hashes in every display proxy's store key (#249): the
// decoders (LibRaw's WebAssembly, the pinned scan decoders and the HEIF codec
// the app serves) with the lens database and runtime (lensfun-wasm, whose
// maps a lens-corrected proxy is remapped with, #278), and the code that
// shapes a proxy's pixels and the colour-analysis sample stored with them
// (the RAW and scan decoders with the sensor-defect pass, the 16-bit packing,
// the geometry chain and its pool, the lens loader and remap, the display
// level, the record's packing and the sample). A build that changes any of
// them misses every stored proxy instead of converting pixels a cold open
// would no longer produce. Stamped by vite.config.js.
//
// The RAW decoders include #264's: the decoder choice (librawRuntime.js), the
// desktop's native LibRaw plane and its transfer, and libraw-wasm's threaded
// build where the package ships one (hashed as missing until then). All of
// them decode the pixels of the pinned libraw-wasm release (the native gate
// names that release), so its files stand for the native decoder too.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

// What main.js calls to shape a stored proxy, relative to negative2positive/src:
// the decode (RAW, PNG, scans and HEIF), the geometry chain and the pool that
// renders fills, the display level, the record's packing, the lens loader and
// remap (with the map step and request) and the colour-analysis sample.
export const DISPLAY_PROXY_ENTRY_FILES = [
  'app/imageFileLoaders.js', 'app/imageGeometry.js', 'app/geometryPool.js', 'app/displayPreview.js',
  'app/displayProxy.js', 'app/lensfunLoader.js', 'app/lensMaps.js', 'app/analysisRegion.js'
];

// The entry files and their whole relative-import closure (static, dynamic
// and worker imports): displayProxyHashes.test.mjs computes it and fails on
// a module missing here. Relative to negative2positive/src.
export const DISPLAY_PROXY_CODE_FILES = [
  'app/rawFileLoader.js', 'app/rawPostDecode.js', 'app/rawPostDecodeClient.js', 'workers/rawPostDecodeWorker.js',
  'app/rawResultToRgb16.js', 'silvercore/util/image16.js', 'silvercore/util/sensorDefects.js',
  'app/tiffFileLoader.js', 'app/imageFileLoaders.js', 'workers/scanDecodeWorker.js',
  'app/imageGeometry.js', 'app/imageDataOps.js', 'app/geometryPool.js', 'workers/geometryWorker.js',
  'app/lensfunLoader.js', 'app/lensMaps.js', 'app/displayPreview.js', 'app/displayProxy.js',
  'app/librawRuntime.js', 'app/nativeRawDecoder.js', 'app/nativeRawTransfer.js', 'workers/nativeRawFetchWorker.js',
  'app/analysisRegion.js', 'app/pngFileLoader.js', 'app/heifLoader.js', 'app/scanDecodeClient.js',
  'app/embeddedPreviewRender.js', 'app/rawEmbeddedPreview.js', 'app/jpegHeader.js', 'app/nefJpegPreview.js',
  'app/crossOriginIsolation.js', 'workers/isolationProbe.js', 'app/imageDimensions.js', 'app/rawDecodeEstimate.js',
  'app/filmStatsCache.js', 'app/filmBaseDetection.js', 'app/filmTypeDetection.js', 'app/orderStatistics.js',
  'silvercore/util/garbledCheck.js'
];

// The decoder package's files, relative to node_modules/libraw-wasm/dist
// (the threaded build's are absent from 1.6.0).
export const DISPLAY_PROXY_DECODER_FILES = [
  'libraw.wasm', 'libraw.js', 'worker.js',
  'libraw-threaded.wasm', 'libraw-threaded.js', 'worker-threaded.js'
];

// The pinned scan decoders, relative to each package: UTIF decodes TIFF scans
// (and DNGs LibRaw cannot), UPNG 16-bit PNGs. Both require pako, which only
// inflates: lossless, so no pako release changes their pixels.
export const DISPLAY_PROXY_SCAN_DECODER_FILES = {
  utif: ['package.json', 'UTIF.js'],
  'upng-js': ['package.json', 'UPNG.js']
};

// The HEIF codec the app serves (libheif-js, copied into public/codecs),
// relative to negative2positive/public.
export const DISPLAY_PROXY_CODEC_FILES = ['codecs/heif-worker.js', 'codecs/libheif.js', 'codecs/libheif.wasm'];

// The lens database and runtime (#278), relative to the package: the module
// lensfunLoader.js imports, the core it starts with its wasm and data, and
// the release main.js's CDN fallback loads (the same version, its IIFE).
export const DISPLAY_PROXY_LENS_PACKAGE = '@neoanaloglabkk/lensfun-wasm';
export const DISPLAY_PROXY_LENS_FILES = [
  'package.json', 'dist/esm/index.js', 'dist/umd/index.iife.js',
  'dist/assets/lensfun-core.js', 'dist/assets/lensfun-core.wasm', 'dist/assets/lensfun-core.data'
];

// The names (relative to `root`, after `prefix`) and contents of `files`, so
// the hash does not depend on where the checkout lives.
function hashFiles(hash, root, files, prefix = '') {
  for (const file of files) {
    const path = join(root, file);
    hash.update(prefix + file);
    hash.update('\0');
    hash.update(existsSync(path) ? readFileSync(path) : 'missing');
    hash.update('\0');
  }
  return hash;
}

function realDirectory(path) {
  try { return realpathSync(path); } catch { return path; /* hashed as missing */ }
}

/**
 * `{ decoder, code }` for the app rooted at `appRoot` (negative2positive).
 * `librawDist`: the libraw-wasm dist the app resolves instead of the
 * installed one (the dev server's test-only LIBRAW_WASM_DIST, #264).
 */
export function displayProxyBuildHashes(appRoot, { librawDist = null } = {}) {
  const code = hashFiles(createHash('sha256'), join(appRoot, 'src'), DISPLAY_PROXY_CODE_FILES).digest('hex');
  const modules = join(appRoot, '..', 'node_modules');
  const decoder = hashFiles(createHash('sha256'), realDirectory(librawDist || join(modules, 'libraw-wasm', 'dist')), DISPLAY_PROXY_DECODER_FILES);
  for (const [name, files] of Object.entries(DISPLAY_PROXY_SCAN_DECODER_FILES)) {
    hashFiles(decoder, realDirectory(join(modules, name)), files, `${name}/`);
  }
  hashFiles(decoder, join(appRoot, 'public'), DISPLAY_PROXY_CODEC_FILES);
  hashFiles(decoder, realDirectory(join(modules, DISPLAY_PROXY_LENS_PACKAGE)), DISPLAY_PROXY_LENS_FILES, `${DISPLAY_PROXY_LENS_PACKAGE}/`);
  return { decoder: decoder.digest('hex'), code };
}
