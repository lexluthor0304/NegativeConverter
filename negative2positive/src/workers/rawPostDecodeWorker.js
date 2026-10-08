/**
 * RAW post-decode worker (#232) — one disposable instance per decode.
 *
 * LibRaw's result buffer is transferred in; the RGB16 → RGBA16 packing, the
 * garbled check, the sensor-defect pass, the 8-bit mirror and (on request)
 * the film statistics run here, and both planes are transferred back. The
 * loader spawns it before LibRaw starts decoding so the module fetch and the
 * ping overlap the decode, and terminates it on every exit, so a foreground
 * decode never queues behind anyone else's pass.
 */
import './isolationProbe.js'; // first: answers the page's isolation probe (#264)
import { handleRawPostDecodeMessage } from '../app/rawPostDecode.js';

self.onmessage = (event) => {
  handleRawPostDecodeMessage(event.data, (message, transfer) => self.postMessage(message, transfer || []));
};
