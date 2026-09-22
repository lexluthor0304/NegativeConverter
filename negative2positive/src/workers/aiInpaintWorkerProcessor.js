import { createInpaintSession } from '../app/aiInpaint.js';

export function createInpaintWorkerProcessor({ createSession = createInpaintSession } = {}) {
  let session, pending = Promise.resolve();
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
    if (type !== 'run' || !session) throw new Error('AI repair session is not ready');
    const output = await session.run(message.image, message.mask, message.size);
    return { payload: { id, output }, transfers: [output.buffer] };
  }
  return (message) => {
    const task = pending.then(() => process(message));
    pending = task.catch(() => {});
    return task;
  };
}
