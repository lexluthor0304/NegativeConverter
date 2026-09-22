import { createInpaintWorkerProcessor } from './aiInpaintWorkerProcessor.js';
const process = createInpaintWorkerProcessor();
self.onmessage = async ({ data }) => {
  try {
    const { payload, transfers } = await process(data);
    self.postMessage(payload, transfers);
  } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
};
