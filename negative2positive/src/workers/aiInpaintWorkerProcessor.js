import { createInpaintSession } from '../app/aiInpaint.js';

// `heapBytes()`: the realm's WASM heap, added to each reply for the page's
// memory ledger (#258).
export function createInpaintWorkerProcessor({ createSession = createInpaintSession, heapBytes = null } = {}) {
  let session, pending = Promise.resolve();
  const withHeap = (result) => {
    if (typeof heapBytes === 'function') result.payload.heapBytes = heapBytes();
    return result;
  };
  async function process(message) {
    const { id, type } = message;
    if (type === 'initialize') {
      await session?.release();
      session = await createSession(message.modelBytes, message.options);
      return { payload: { id, provider: session.provider, inputNames: session.inputNames, outputNames: session.outputNames }, transfers: [] };
    }
    if (type === 'release') {
      await session?.release();
      session = null;
      return { payload: { id, released: true }, transfers: [] };
    }
    if (type === 'trim') {
      // Shrinks the tile memo to `bytes` and reports what it holds (#258).
      const memo = session?.trim ? session.trim(message.bytes) : null;
      return { payload: { id, memo }, transfers: [] };
    }
    if (type !== 'run' || !session) throw new Error('AI repair session is not ready');
    // Batch lanes look tiles up without evicting the open photo's (`insert: false`).
    const output = await session.run(message.image, message.mask, message.size, { insert: message.insert !== false });
    return { payload: { id, output }, transfers: [output.buffer] };
  }
  return (message) => {
    const task = pending.then(() => process(message)).then(withHeap);
    pending = task.catch(() => {});
    return task;
  };
}
