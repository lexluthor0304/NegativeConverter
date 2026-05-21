import UPNGImport from 'upng-js';

const UPNG = (UPNGImport && typeof UPNGImport.decode === 'function')
  ? UPNGImport
  : (UPNGImport && UPNGImport.default && typeof UPNGImport.default.decode === 'function'
    ? UPNGImport.default
    : UPNGImport);

export function loadPngFile(buffer) {
  const decoded = UPNG.decode(buffer);
  const { width, height, ctype, depth, data } = decoded;

  const channelCount = (ctype & 2 ? 3 : 1) + (ctype & 4 ? 1 : 0);
  const pixelCount = width * height;

  const raw16 = new Uint16Array(pixelCount * channelCount);
  if (depth <= 8) {
    for (let i = 0; i < raw16.length; i++) raw16[i] = data[i] * 257;
  } else {
    for (let i = 0; i < raw16.length; i++) raw16[i] = (data[2 * i] << 8) | data[2 * i + 1];
  }

  const rgba16 = new Uint16Array(pixelCount * 4);
  const final8 = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const idx16 = i * channelCount;
    const dst = i * 4;

    const r16 = raw16[idx16];
    const g16 = channelCount >= 3 ? raw16[idx16 + 1] : r16;
    const b16 = channelCount >= 3 ? raw16[idx16 + 2] : r16;
    const a16 = channelCount === 4 ? raw16[idx16 + 3]
      : channelCount === 2 ? raw16[idx16 + 1]
        : 65535;

    rgba16[dst] = r16;
    rgba16[dst + 1] = g16;
    rgba16[dst + 2] = b16;
    rgba16[dst + 3] = a16;

    final8[dst] = r16 >>> 8;
    final8[dst + 1] = g16 >>> 8;
    final8[dst + 2] = b16 >>> 8;
    final8[dst + 3] = a16 >>> 8;
  }

  const imageData = new ImageData(final8, width, height);
  imageData.__image16 = { width, height, data: rgba16 };
  return imageData;
}
