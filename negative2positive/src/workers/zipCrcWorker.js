// ZIP CRC worker (#293): the CRC-32 of each archive entry's Blob, streamed
// here instead of on the page's main thread. A Blob is posted by reference
// (no copy of its bytes), and only the 32-bit value goes back. The writer
// (app/zipStoreWriter.js) writes the payload whole in the meantime and
// computes the CRC itself when this worker cannot run.
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { crc32OfBlob } from './blobCrc32.js';

self.onmessage = async ({ data }) => {
  if (data?.type !== 'zip-crc32') return;
  try {
    const blob = data.blob;
    if (!blob || typeof blob.size !== 'number') throw new Error('ZIP entry payload is not a Blob.');
    const crc = await crc32OfBlob(blob);
    self.postMessage({ id: data.id, crc, size: blob.size });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error?.message || error) });
  }
};
