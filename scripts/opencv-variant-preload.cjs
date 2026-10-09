// `node -r ./scripts/opencv-variant-preload.cjs some.test.mjs` with
// NC_OPENCV_VARIANT=simd: every `require('@techstark/opencv-js')` (also
// through createRequire) of an unchanged test or bench resolves to the
// committed SIMD build (scripts/opencv-node.mjs), so the recorded sets run on
// it without edits. The export is what the package exports: a promise of the
// ready `cv`. Without the variable (or with `scalar`) nothing changes.
'use strict';
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const variant = process.env.NC_OPENCV_VARIANT || 'scalar';
if (variant === 'simd') {
  const loaderUrl = pathToFileURL(path.join(__dirname, 'opencv-node.mjs')).href;
  let promise = null;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@techstark/opencv-js' || request === '@techstark/opencv-js/dist/opencv.js') {
      promise ||= import(loaderUrl).then(m => m.loadOpenCvSimd());
      return promise;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
} else if (variant !== 'scalar') {
  throw new Error(`NC_OPENCV_VARIANT must be simd or scalar, not ${variant}`);
}
