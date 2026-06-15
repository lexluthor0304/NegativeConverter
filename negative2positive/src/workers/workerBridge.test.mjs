// Standalone Node test for workerBridge.js - run with:
// node negative2positive/src/workers/workerBridge.test.mjs
import assert from 'node:assert/strict';

let lastPost = null;

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
  }

  postMessage(message, transfers = []) {
    lastPost = { message, transfers };
    structuredClone(message, { transfer: transfers });
    queueMicrotask(() => {
      this.onmessage({
        data: {
          type: 'blobResult',
          id: message.id,
          blob: new Blob(['ok'])
        }
      });
    });
  }

  terminate() {}
}

globalThis.Worker = FakeWorker;
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const {
  terminateWorker,
  workerEncodePng16,
  workerEncodeTiff
} = await import('./workerBridge.js');

function createImageData() {
  return new ImageData(
    new Uint8ClampedArray([
      0, 64, 128, 255,
      255, 128, 64, 255
    ]),
    2,
    1
  );
}

async function assertEncodePreservesImageDataBuffer(encode) {
  terminateWorker();
  lastPost = null;
  const imageData = createImageData();
  const originalBuffer = imageData.data.buffer;
  const originalLength = imageData.data.byteLength;

  const blob = await encode(imageData);

  assert.equal(blob.size, 2);
  assert.ok(lastPost, 'expected worker postMessage to be called');
  assert.equal(lastPost.transfers.length, 1);
  assert.notEqual(lastPost.transfers[0], originalBuffer);
  assert.equal(lastPost.transfers[0].byteLength, 0);
  assert.equal(originalBuffer.byteLength, originalLength);
  assert.equal(imageData.data.byteLength, originalLength);
  assert.doesNotThrow(() => new Uint8ClampedArray(originalBuffer));
}

await assertEncodePreservesImageDataBuffer((imageData) => workerEncodePng16(imageData));
await assertEncodePreservesImageDataBuffer((imageData) => workerEncodeTiff(imageData, 16));
terminateWorker();

console.log('workerBridge.test.mjs passed');
