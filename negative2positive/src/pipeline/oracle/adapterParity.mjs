// Shared harness for the #238 adapter parity checks: runs the same request sequence
// through the live adapter and the frozen 1703835 adapter (each with its own caches)
// and compares SHA-256 of the 16-bit plane, the 8-bit data and the analysis preview.
// Used by silverAdapter.parity.test.mjs and scripts/silvercore-parity-real.mjs.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (!globalThis.ImageData) {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };
}
// Enhanced profiles load their .bin through fetch(file: URL), which Node lacks.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const href = String(url);
  if (!href.startsWith('file:')) return nodeFetch(url, ...rest);
  const buf = await readFile(new URL(href));
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

export const live = await import('../silverAdapter.js');
export const oracle = await import('./silverAdapter.oracle.js');

const CONVERT = { color: 'convertColorWithSilverCore', bw: 'convertBwWithSilverCore', positive: 'convertPositiveWithSilverCore' };

export function sha(typed) {
  return createHash('sha256').update(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).digest('hex').slice(0, 16);
}

export function digest(result) {
  return {
    width: result.width,
    height: result.height,
    image16: sha(result.__image16.data),
    image8: sha(result.data),
    analysisPreview: result.__analysisPreview ? sha(result.__analysisPreview.data) : null,
  };
}

export function resetBoth() {
  live.invalidateSilverCoreCache();
  oracle.invalidateSilverCoreCache();
}

// One request through both adapters. Returns both digests.
export async function convertBoth(mode, imageData, settings, options = {}) {
  const a = await live[CONVERT[mode]](imageData, settings, { ...options });
  const b = await oracle[CONVERT[mode]](imageData, settings, { ...options });
  return { live: digest(a), oracle: digest(b), result: a };
}
