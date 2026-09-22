import assert from 'node:assert/strict';
import { parseImageDimensions, imagePixelsForBatch, rememberImageDimensions, UNKNOWN_IMAGE_PIXELS } from './imageDimensions.js';
import { planBatchParallelism } from './batchExportScheduler.js';
const png = new Uint8Array(24);
const pv = new DataView(png.buffer);
pv.setUint32(0, 0x89504e47); pv.setUint32(4, 0x0d0a1a0a);
pv.setUint32(16, 12000); pv.setUint32(20, 8000);
const file = new File([png], 'compressed.png');
assert.equal(await imagePixelsForBatch(file), 96_000_000);
assert.equal(planBatchParallelism({ hardwareConcurrency: 16, deviceMemory: 16, pixelsPerFile: await imagePixelsForBatch(file), fileCount: 36 }), 1);
const jpeg = Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,7,8,0x1f,0x40,0x2e,0xe0]);
assert.deepEqual(parseImageDimensions(jpeg.buffer), { width: 12000, height: 8000 });
for (const little of [true, false]) {
  const tiff = new ArrayBuffer(50), v = new DataView(tiff);
  v.setUint16(0, little ? 0x4949 : 0x4d4d); v.setUint16(2,42,little); v.setUint32(4,8,little); v.setUint16(8,3,little);
  [[256,12000],[257,8000],[262,32803]].forEach(([tag,value],i) => {
    const at = 10 + i * 12; v.setUint16(at,tag,little); v.setUint16(at+2,4,little); v.setUint32(at+4,1,little); v.setUint32(at+8,value,little);
  });
  assert.deepEqual(parseImageDimensions(tiff, {raw:true}), {width:12000,height:8000});
  v.setUint32(42,2,little);
  assert.equal(parseImageDimensions(tiff, {raw:true}), null, 'RAW embedded preview is not sensor dimensions');
  assert.deepEqual(parseImageDimensions(tiff), {width:12000,height:8000});
}
for (let n = 0; n < 24; n++) assert.equal(parseImageDimensions(png.buffer.slice(0,n)), null);
const unknown = new File(['invalid'], 'unknown.heic');
assert.equal(await imagePixelsForBatch(unknown), UNKNOWN_IMAGE_PIXELS);
rememberImageDimensions(unknown, {width:4000,height:3000});
assert.equal(await imagePixelsForBatch(unknown), 12_000_000);
let bytesRead = 0;
await imagePixelsForBatch({name:'large.png', slice(start,end) { bytesRead += end-start; return new Blob([png]); }});
assert.equal(bytesRead, 256*1024);
console.log('Batch dimensions: compressed images, TIFF endianness/RAW previews, truncated headers and bounded IO passed');
