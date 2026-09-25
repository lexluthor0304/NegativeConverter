import { defineConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uiFontsPlugin } from '../scripts/build-ui-fonts.mjs';
import { displayProxyBuildHashes } from '../scripts/display-proxy-hashes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  plugins: [uiFontsPlugin()],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    // Isolated worktrees may share node_modules via a symlink. LibRaw's
    // nested workers need their real package path in the dev-server allowlist.
    fs: { allow: [resolve(__dirname, '..'), realpathSync(resolve(__dirname, '../node_modules/libraw-wasm'))] },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
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
