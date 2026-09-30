import { defineConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiFontsPlugin } from '../scripts/build-ui-fonts.mjs';
import { displayProxyBuildHashes } from '../scripts/display-proxy-hashes.mjs';
import { opencvAssetsPlugin } from '../scripts/opencv-assets.mjs';
import { CROSS_ORIGIN_ISOLATION_HEADERS } from '../scripts/cross-origin-isolation.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Test-only (#264): LIBRAW_WASM_DIST=/abs/libraw-wasm/dist makes the dev
// server resolve `libraw-wasm` to a locally built package instead of the
// installed release, so the smoke steps (the RGB16 gate above all) can run an
// unreleased decoder build. Never applied to `vite build` or `vite preview`.
const localLibRawDist = process.env.LIBRAW_WASM_DIST ? realpathSync(resolve(process.env.LIBRAW_WASM_DIST)) : null;
function localLibRawPlugin(dist) {
  return {
    name: 'nc-local-libraw-wasm',
    apply: 'serve',
    enforce: 'pre',
    // Stored display proxies (#249) name the decoder that actually runs.
    config() {
      return { define: { __NC_DISPLAY_PROXY_HASHES__: JSON.stringify(displayProxyBuildHashes(__dirname, { librawDist: dist })) } };
    },
    configureServer() {
      console.warn(`[vite] libraw-wasm resolves to ${dist} (LIBRAW_WASM_DIST, test only)`);
    },
    resolveId(source) {
      return source === 'libraw-wasm' ? join(dist, 'index.js') : null;
    }
  };
}

// Stamped into the bundle so the debug badge and the diagnostics dump identify
// the build that is actually running, instead of a string edited by hand.
const buildId = new Date().toISOString().replace(/[:.]/g, '-');

export default defineConfig({
  root: __dirname,
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
    // Stored display proxies (#249) miss when the decoder or the code that
    // shapes their pixels changes.
    __NC_DISPLAY_PROXY_HASHES__: JSON.stringify(displayProxyBuildHashes(__dirname)),
  },
  // Per-locale UI font subsets, cut from the Fusion Pixel faces at dev and
  // build start (scripts/build-ui-fonts.mjs, #262).
  // OpenCV as one compiled-once wasm file plus a small glue (#252 part 5),
  // for the page and for the worker bundles that import it.
  plugins: [uiFontsPlugin(), opencvAssetsPlugin(), ...(localLibRawDist ? [localLibRawPlugin(localLibRawDist)] : [])],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    // Cross-origin isolation (#264): on every response, including worker
    // scripts, which need COEP on their own. `tauri dev` loads this server, so
    // the desktop app's own headers (tauri.conf.json) do not apply there.
    headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS },
    // Isolated worktrees may share node_modules via a symlink. LibRaw's
    // nested workers and the bundled lensfun assets (`?url` imports, which
    // the app loads before its CDN fallback) need their real package paths in
    // the dev-server allowlist.
    fs: { allow: [
      resolve(__dirname, '..'),
      realpathSync(resolve(__dirname, '../node_modules/libraw-wasm')),
      realpathSync(resolve(__dirname, '../node_modules/@neoanaloglabkk/lensfun-wasm')),
      ...(localLibRawDist ? [localLibRawDist] : [])
    ] },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS },
  },
  // libraw-wasm ships a Web Worker that itself uses `new Worker(new URL(...))`.
  // Vite's dev-mode dep optimizer rewrites the entry but can't follow the
  // nested worker import, leading to "worker.js?worker_file&type=module not found"
  // and a hung RAW decode. Skipping optimization keeps the worker chain intact.
  optimizeDeps: {
    exclude: ['libraw-wasm'],
  },
  // conversionWorker pulls in the pipeline, which lazy-loads FilmPresets via
  // dynamic import — the default iife worker format cannot code-split.
  worker: {
    format: 'es',
    plugins: () => [opencvAssetsPlugin()],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        guide: resolve(__dirname, 'guide.html'),
        positiveGuide: resolve(__dirname, 'slide-film-correction.html'),
        aiRepairGuide: resolve(__dirname, 'ai-film-photo-repair.html'),
        typeGuide: resolve(__dirname, 'film-type-detection.html'),
        about: resolve(__dirname, 'about.html'),
        chinese: resolve(__dirname, 'zh/index.html'),
        japanese: resolve(__dirname, 'ja/index.html'),
        rawNegativeConverter: resolve(__dirname, 'raw-negative-converter.html'),
        iphoneProrawNegativeConverter: resolve(__dirname, 'iphone-proraw-negative-converter.html'),
        negativeLabProAlternative: resolve(__dirname, 'negative-lab-pro-alternative.html'),
        batchFilmNegativeConverter: resolve(__dirname, 'batch-film-negative-converter.html'),
        filmOrangeMask: resolve(__dirname, 'film-orange-mask.html'),
        filmBorderSprocketHoles: resolve(__dirname, '35mm-film-border-sprocket-holes.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        download: resolve(__dirname, 'download.html'),
      },
    },
  },
});
