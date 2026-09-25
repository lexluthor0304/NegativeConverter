// Display proxy worker (#249): packs, checksums and writes the display
// proxies the photo sessions spill and the persistent store keeps, and reads
// and unpacks them again, off the main thread. The per-tab spill database is
// opened (and closed tabs' databases reclaimed) on the first request that
// needs it; the persistent records live in the origin-private file system
// (sync access handles), or IndexedDB where those are missing.
import { createDisplayProxyWorkerCore, createDisplayProxySpillBackend, createWorkerRecords } from '../app/displayProxyStore.js';

const core = createDisplayProxyWorkerCore({ backend: createDisplayProxySpillBackend(), records: () => createWorkerRecords() });

self.onmessage = async ({ data }) => {
  const id = data?.id;
  try {
    const { reply, transfer = [] } = await core.handle(data);
    self.postMessage({ id, reply }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
