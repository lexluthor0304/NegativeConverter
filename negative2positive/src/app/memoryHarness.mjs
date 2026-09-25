// Test helper for the vm harnesses that run main.js functions (#258): the
// memory budget's helpers from main.js, with a real budget (memoryBudget.js)
// that is large enough never to hold anything back unless a test asks for a
// smaller one. Spread `memoryGlobals()` into the vm context and add
// MEMORY_FUNCTIONS to the functions it evaluates.
import { createMemoryBudget, createMemoryClaim, DECODED_BYTES_PER_PIXEL } from './memoryBudget.js';
import { LANE_BYTES_PER_PIXEL } from './batchExportScheduler.js';
import { estimateRawDecodeBytes } from './rawDecodeEstimate.js';
import { isRawLikeFileName } from './imageFileLoaders.js';

export const MEMORY_FUNCTIONS = [
  'decodePeakBytes', 'decodeReservationBytes', 'frameReservationBytes', 'laneReservationBytes', 'fileDecodeKind',
  'pixelsForMemory', 'createFrameClaim', 'coveredMemoryClaim', 'reserveFrameClaim', 'admitJobItem',
  'claimForActivation', 'releaseActivationClaim', 'activationSettled', 'settleActivationClaim'
];

/**
 * @param {object} [options]
 * @param {number} [options.budgetBytes]
 * @param {number} [options.pixels] every file's header size
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 */
export function memoryGlobals({ budgetBytes = 1e15, pixels = 1e6, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
  const events = [];
  const memoryBudget = createMemoryBudget({ budgetBytes, setTimer, clearTimer, onEvent: event => events.push(event) });
  return {
    memoryBudget,
    memoryEvents: events,
    memoryRuntime: { ramBytes: null, source: 'unknown', engine: 'chromium', desktop: null },
    liveSampleStores: new Set(),
    heldJobFrames: new Set(),
    activationClaim: null,
    ACTIVATION_SETTLE_POLL_MS: 250,
    ACTIVATION_CLAIM_MAX_MS: 30_000,
    createMemoryClaim,
    estimateRawDecodeBytes,
    isRawLikeFileName,
    DECODED_BYTES_PER_PIXEL,
    LANE_BYTES_PER_PIXEL,
    imagePixelsWithSiblings: async () => pixels
  };
}
