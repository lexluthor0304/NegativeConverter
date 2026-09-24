// Normalises LibRaw's imageData() result into 16-bit samples. Kept free of
// any libraw-wasm import so the RAW post-decode worker can load it (#232);
// rawFileLoader.js re-exports it.

/**
 * Normalise whatever `LibRaw.imageData()` returned into 16-bit samples.
 *
 * The shape depends on the requested `outputBps`: 8 gives a Uint8Array of
 * width*height*colors bytes, 16 gives a Uint16Array of the same sample count.
 * Reading an 8-bit result as little-endian byte pairs (the old fallback) fuses
 * neighbouring samples into nonsense and runs off the end of the buffer.
 *
 * @returns {{ rgb16: Uint16Array, channels: number }}
 */
export function rawResultToRgb16(result) {
  const width = result?.width | 0;
  const height = result?.height | 0;
  const data = result?.data;
  const pixelCount = width * height;
  if (pixelCount <= 0 || !data || typeof data.length !== 'number') {
    const err = new Error('RAW decode returned no pixels');
    err.code = 'RAW_DECODE_GARBLED';
    throw err;
  }

  const bytesPerPixel = data.length / pixelCount;
  let sixteenBit;
  if (data instanceof Uint16Array) sixteenBit = true;
  else if (result.bits === 16) sixteenBit = true;
  else if (result.bits === 8) sixteenBit = false;
  // 8-bit output is 1/3/4 bytes per pixel, 16-bit output 2/6/8 — no overlap.
  else sixteenBit = bytesPerPixel === 2 || bytesPerPixel === 6 || bytesPerPixel === 8;

  const totalSamples = data instanceof Uint16Array
    ? data.length
    : Math.floor(data.length / (sixteenBit ? 2 : 1));

  let channels = Number.isInteger(result.colors) ? result.colors : 0;
  if (channels * pixelCount !== totalSamples) channels = Math.round(totalSamples / pixelCount);
  if ((channels !== 1 && channels !== 3 && channels !== 4) || channels * pixelCount > totalSamples) {
    const err = new Error(`Unexpected RAW sample layout: ${data.length} values for ${width}x${height}`);
    err.code = 'RAW_DECODE_GARBLED';
    throw err;
  }

  const sampleCount = pixelCount * channels;
  let rgb16;
  if (data instanceof Uint16Array) {
    rgb16 = data.length === sampleCount ? data : data.subarray(0, sampleCount);
  } else if (sixteenBit) {
    rgb16 = (data.byteOffset % 2 === 0 && data.buffer)
      ? new Uint16Array(data.buffer, data.byteOffset, sampleCount)
      : Uint16Array.from({ length: sampleCount }, (_, i) => data[i * 2] | (data[i * 2 + 1] << 8));
  } else {
    rgb16 = new Uint16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) rgb16[i] = data[i] * 257;
  }

  // packRGBToImage16 wraps a 4-channel plane without copying; make sure that
  // plane is ours and not a view into the (soon disposed) WASM heap.
  if (channels === 4 && rgb16.buffer !== undefined && !(rgb16.buffer instanceof ArrayBuffer)) {
    rgb16 = new Uint16Array(rgb16);
  }

  return { rgb16, channels };
}
