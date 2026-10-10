import { createExportWorkerBridge } from '../workers/workerBridge.js';

// Small thumbnails cost less than a worker round trip. The editor normally
// draws 1–4 MP: keep those pixel loops off the input/compositor thread.
export const CPU_PREVIEW_WORKER_MIN_PIXELS = 65_536;

/** One independent worker, one running frame and only the newest waiting frame.
 * A running frame may present during a drag: dropping it on every input would
 * starve the display when a pass takes longer than one animation frame. Source,
 * mode and brush ownership are checked by the caller, and cancel() invalidates
 * both frames when an exact frame or another display owner takes over.
 */
export function createCpuPreviewRenderer({ workers = createExportWorkerBridge() } = {}) {
  let active = null;
  let queued = null;
  let generation = 0;
  const diagnostics = { requested: 0, coalesced: 0, worker: 0, presented: 0, discarded: 0, failed: 0 };

  async function drain() {
    if (active || !queued) return;
    const job = queued;
    queued = null;
    active = job;
    const token = generation;
    const current = () => token === generation && job.current();
    try {
      if (!current()) { diagnostics.discarded++; return; }
      diagnostics.worker++;
      const adjusted = await workers.workerApplyPreviewAdjustments(job.source, job.settings, job.revision);
      if (!current()) { diagnostics.discarded++; return; }
      if (adjusted) {
        job.present(adjusted);
        diagnostics.presented++;
      } else {
        diagnostics.failed++;
        job.fallback();
      }
    } catch (error) {
      // Memory shedding cancels rather than doing the same work on main.
      if (error?.name !== 'AbortError' && current()) {
        diagnostics.failed++;
        job.fallback();
      }
    } finally {
      active = null;
      void drain();
    }
  }

  function cancel() {
    generation++;
    queued = null;
  }

  return {
    request(job) {
      if (job.source.width * job.source.height < CPU_PREVIEW_WORKER_MIN_PIXELS
        || !workers.isWorkerAvailable()) return false;
      diagnostics.requested++;
      if (queued) diagnostics.coalesced++;
      queued = job;
      void drain();
      return true;
    },
    cancel,
    release() {
      cancel();
      workers.cancelWorkerRequests('CPU preview released');
    },
    get busy() { return Boolean(active || queued); },
    get alive() { return workers.workerAlive; },
    get residentBytes() {
      // Count retained input wrappers too, until a cancelled pass returns.
      const sources = new Set([active?.source, queued?.source]);
      let bytes = workers.residentBytes;
      for (const source of sources) bytes += (source?.data?.byteLength || 0) + (source?.__image16?.data?.byteLength || 0);
      return bytes;
    },
    diagnostics
  };
}
