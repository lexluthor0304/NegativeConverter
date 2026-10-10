// The CRC-32 of a Blob, streamed in bounded chunks (#293). The ZIP writer
// (app/zipStoreWriter.js) computes it in its worker (zipCrcWorker.js) while
// the payload is written whole, and runs the same functions on the main
// thread when no worker can: the register, the table and the chunking are
// one implementation, so the value is the same wherever it is computed.
import { updateCrc32 } from './crc32.js';

export const BLOB_CHUNK_BYTES = 256 * 1024;

export function toUint8Array(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new Error('Unsupported ZIP stream chunk type.');
}

/** The Blob's bytes in pieces of at most BLOB_CHUNK_BYTES, read once. */
export async function* readBlobChunks(blob) {
  if (blob && typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const bytes = toUint8Array(value);
          for (let offset = 0; offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
            yield bytes.subarray(offset, offset + BLOB_CHUNK_BYTES);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }

  if (blob && typeof blob.slice === 'function' && typeof blob.arrayBuffer === 'function') {
    for (let offset = 0; offset < blob.size; offset += BLOB_CHUNK_BYTES) {
      yield new Uint8Array(await blob.slice(offset, offset + BLOB_CHUNK_BYTES).arrayBuffer());
    }
    return;
  }

  throw new Error('ZIP entry payload is not a Blob.');
}

/**
 * CRC-32 of the Blob's bytes. `onChunk(bytes)` runs after each chunk's
 * register update (the main-thread writer writes and yields there).
 * @returns {Promise<number>} the final CRC (unsigned)
 */
export async function crc32OfBlob(blob, onChunk = null) {
  let crc = 0xFFFFFFFF;
  for await (const chunk of readBlobChunks(blob)) {
    crc = updateCrc32(crc, chunk);
    if (onChunk) await onChunk(chunk);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
