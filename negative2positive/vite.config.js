import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  base: './',
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
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
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        download: resolve(__dirname, 'download.html'),
      },
    },
  },
});
