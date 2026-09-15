// Ultra HDR v1.0 container. SDR entropy-coded bytes are copied, never re-encoded.
// https://developer.android.com/media/platform/hdr-image-format
import { jpegApp1Xmp } from '../workers/exifWriter.js';
import { buildTiff, bytesEntry, longEntry } from '../workers/tiffWriter.js';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const luminance = (data, i, scale) => 0.2126 * linear(data[i] / scale) + 0.7152 * linear(data[i + 1] / scale) + 0.0722 * linear(data[i + 2] / scale);

// The 16-bit plane uses the same sRGB transfer function as the SDR pixels.
// A quantisation-only difference produces a near-identity map. Never invent
// highlight headroom just because the source has 16-bit precision.
export function computeGainMap(sdr, plane16, { step = 4 } = {}) {
  const width = Math.ceil(sdr.width / step), height = Math.ceil(sdr.height / step);
  if (!plane16 || plane16.width !== sdr.width || plane16.height !== sdr.height || plane16.data.length !== sdr.data.length) return null;
  const gains = new Float32Array(width * height);
  let max = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let a = 0, b = 0, count = 0;
    for (let yy = y * step; yy < Math.min((y + 1) * step, sdr.height); yy++) for (let xx = x * step; xx < Math.min((x + 1) * step, sdr.width); xx++) {
      const i = (yy * sdr.width + xx) * 4;
      a += luminance(sdr.data, i, 255); b += luminance(plane16.data, i, 65535); count++;
    }
    const gain = clamp(Math.log2((b / count + 1 / 64) / (a / count + 1 / 64)), 0, 3);
    gains[y * width + x] = gain; max = Math.max(max, gain);
  }
  const gainMax = Math.max(max, 0.001);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gains.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(gains[i] / gainMax * 255); data[i * 4 + 3] = 255;
  }
  return { width, height, data, gainMax, gainMin: 0 };
}

const packet = body => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${body}</rdf:RDF></x:xmpmeta>`;
function description(attrs) { return `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ${attrs}/>`; }
function app2(payload) {
  const result = new Uint8Array(payload.length + 4);
  result.set([255, 226, (payload.length + 2) >> 8, (payload.length + 2) & 255]); result.set(payload, 4); return result;
}

export async function packGainMapJpeg(base, gainJpeg, { gainMax, gainMin = 0 }) {
  if (!Number.isFinite(gainMax) || gainMax <= gainMin || gainMax > 3) throw new Error('Invalid gain map range');
  const gainXmp = jpegApp1Xmp(packet(description(`hdrgm:Version="1.0" hdrgm:GainMapMin="${gainMin}" hdrgm:GainMapMax="${gainMax}" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="${gainMax}" hdrgm:BaseRenditionIsHDR="False"`)));
  const secondary = new Blob([gainJpeg.slice(0, 2), gainXmp, gainJpeg.slice(2)], { type: 'image/jpeg' });
  const container = `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${secondary.size}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`;
  const prefix = 'http://ns.adobe.com/xap/1.0/\0';
  let existing = '', cursor = 2;
  const segments = [];
  while (cursor + 4 < base.size) {
    const head = new Uint8Array(await base.slice(cursor, cursor + 4).arrayBuffer());
    if (head[0] !== 255 || head[1] === 218 || head[1] === 217) break;
    const size = ((head[2] << 8) | head[3]) + 2;
    if (size < 4 || cursor + size > base.size) throw new Error('Invalid JPEG segment');
    const segment = base.slice(cursor, cursor + size);
    let isXmp = false;
    if (head[1] === 225) {
      const bytes = new Uint8Array(await segment.arrayBuffer());
      isXmp = new TextDecoder().decode(bytes.subarray(4, 4 + prefix.length)) === prefix;
      if (isXmp) existing = new TextDecoder().decode(bytes.subarray(4 + prefix.length));
    }
    if (!isXmp) segments.push(segment);
    cursor += size;
  }
  const xmp = jpegApp1Xmp(existing.includes('</rdf:RDF>') ? existing.replace('</rdf:RDF>', container + '</rdf:RDF>') : packet(container));
  const body = new Blob([...segments, base.slice(cursor)]);
  const makeMpf = primarySize => {
    const entries = new Uint8Array(32), view = new DataView(entries.buffer);
    view.setUint32(0, 0x20030000, true); view.setUint32(4, primarySize, true);
    view.setUint32(16, 0, true); view.setUint32(20, secondary.size, true);
    // TIFF begins at SOI(2) + APP2 marker/length(4) + MPF signature(4).
    view.setUint32(24, primarySize - 10, true);
    const tiff = buildTiff({ entries: [bytesEntry(0xb000, new TextEncoder().encode('0100')), longEntry(0xb001, 2), bytesEntry(0xb002, entries)] });
    const payload = new Uint8Array(4 + tiff.length); payload.set([77, 80, 70, 0]); payload.set(tiff, 4); return app2(payload);
  };
  const primarySize = 2 + makeMpf(0).length + xmp.length + body.size;
  return new Blob([base.slice(0, 2), makeMpf(primarySize), xmp, body, secondary], { type: 'image/jpeg' });
}
