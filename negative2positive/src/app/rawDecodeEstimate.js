// Pure RAW decode footprint, split out of rawFileLoader.js so callers that
// must not load LibRaw (main.js's hidden-job gate, #241) can use it.

// The LibRaw worker starts with a 256 MB WASM heap and grows while it holds the
// packed sensor data plus the demosaiced output.
export const RAW_WASM_BASE_BYTES = 256 * 1024 * 1024;
export const RAW_WASM_BYTES_PER_PIXEL = 8;
// rgb16 (6 B/px) + the packed RGBA16 plane (8 B/px) + the 8-bit mirror (4 B/px).
export const RAW_JS_BYTES_PER_PIXEL = 18;

/**
 * Peak bytes a full-resolution RAW decode needs across the WASM heap and the
 * JS copies it produces. Pure, so it can be checked before anything is
 * allocated.
 */
export function estimateRawDecodeBytes(width, height) {
  const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
  return RAW_WASM_BASE_BYTES
    + pixels * RAW_WASM_BYTES_PER_PIXEL
    + pixels * RAW_JS_BYTES_PER_PIXEL;
}
