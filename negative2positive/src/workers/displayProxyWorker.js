// Display proxy worker (#249): packs, checksums and writes the display
// proxies the photo sessions spill, and reads and unpacks them again, off the
// main thread. The per-tab database is opened (and closed tabs' databases
// reclaimed) on the first request that needs it.
import { createDisplayProxyWorkerCore, createDisplayProxySpillBackend } from '../app/displayProxyStore.js';

const core = createDisplayProxyWorkerCore({ backend: createDisplayProxySpillBackend() });

self.onmessage = async ({ data }) => {
  const id = data?.id;
  try {
    const { reply, transfer = [] } = await core.handle(data);
    self.postMessage({ id, reply }, transfer);
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
};
