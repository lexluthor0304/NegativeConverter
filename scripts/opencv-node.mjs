// OpenCV.js in Node, either variant (#292): the scalar package as the tests
// require it, or the committed SIMD build (public/codecs/opencv-simd-glue.js
// + opencv-simd.wasm) loaded through the same instantiateWasm hook the app
// installs. Both variants can live in one process (each has its own heap), so
// a parity harness can run one stage on both and compare.
//
//   import { loadOpenCv } from '../scripts/opencv-node.mjs';
//   const cv = await loadOpenCv('simd');      // or 'scalar'
//
// NC_OPENCV_VARIANT=simd with `node -r ./scripts/opencv-variant-preload.cjs`
// makes every `require('@techstark/opencv-js')` of an unchanged test file
// resolve to the SIMD build instead (scripts/opencv-variant-preload.cjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';
import { openCvSimdPaths } from './opencv-assets.mjs';

const require = createRequire(import.meta.url);
const loaded = new Map();

/**
 * Runs the SIMD glue as CommonJS with a hook that instantiates `module`
 * (compiled here or elsewhere). Resolves the ready `cv`.
 */
export async function instantiateOpenCvGlue(glue, module, { filename = 'opencv-simd-glue.js' } = {}) {
  const previous = globalThis.__opencvModuleArg;
  globalThis.__opencvModuleArg = {
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then(instance => done(instance, module));
      return {};
    }
  };
  try {
    const glueModule = { exports: {} };
    vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${glue}\n})`, { filename })(
      require, glueModule, glueModule.exports, filename, dirname(filename));
    const cv = await glueModule.exports;
    if (!cv?.Mat) throw new Error('OpenCV initialised without the Mat API');
    return cv;
  } finally {
    if (previous === undefined) delete globalThis.__opencvModuleArg; else globalThis.__opencvModuleArg = previous;
  }
}

/** Loads the committed SIMD build once per process. */
export async function loadOpenCvSimd({ publicDir } = {}) {
  if (!loaded.has('simd')) {
    loaded.set('simd', (async () => {
      const paths = publicDir ? openCvSimdPaths(publicDir) : openCvSimdPaths();
      const wasm = new Uint8Array(readFileSync(paths.wasm));
      if (!WebAssembly.validate(wasm)) throw new Error('this Node cannot run the SIMD build (WebAssembly.validate refused it)');
      const module = await WebAssembly.compile(wasm);
      return instantiateOpenCvGlue(readFileSync(paths.glue, 'utf8'), module, { filename: paths.glue });
    })());
  }
  return loaded.get('simd');
}

/** Loads the package's scalar module once per process. */
export async function loadOpenCvScalar() {
  if (!loaded.has('scalar')) {
    loaded.set('scalar', (async () => {
      let cv = require('@techstark/opencv-js');
      if (cv && typeof cv.then === 'function') cv = await cv;
      if (cv && !cv.Mat && cv.default) cv = cv.default;
      if (!cv?.Mat) throw new Error('opencv-js did not initialise');
      return cv;
    })());
  }
  return loaded.get('scalar');
}

/** `variant`: 'simd' | 'scalar' (default: NC_OPENCV_VARIANT, else scalar). */
export function loadOpenCv(variant = process.env.NC_OPENCV_VARIANT || 'scalar', options = {}) {
  if (variant === 'simd') return loadOpenCvSimd(options);
  if (variant === 'scalar') return loadOpenCvScalar();
  throw new Error(`unknown OpenCV variant: ${variant}`);
}
