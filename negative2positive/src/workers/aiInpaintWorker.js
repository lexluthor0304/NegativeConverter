import { createInpaintWorkerProcessor } from './aiInpaintWorkerProcessor.js';
const process = createInpaintWorkerProcessor();
self.onmessage = async ({ data }) => {
  try {
    const { payload, transfers } = await process(data);
    self.postMessage(payload, transfers);
  } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
};
// Bootstrap failures before this handshake can safely use main-thread inference.
// Model creation and inference start only after the client receives readiness.
self.postMessage({ ready: true });
