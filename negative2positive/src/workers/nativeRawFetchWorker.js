/**
 * Native RAW plane transfer (#264 part C) — one disposable instance per
 * decode. Streams the desktop shell's packed RGBA16 plane from its
 * `rawdecode://` scheme into one buffer and transfers it back, so the page's
 * thread never copies the pixels (nativeRawTransfer.js).
 */
import { handleNativePlaneMessage } from '../app/nativeRawTransfer.js';

self.onmessage = (event) => {
  handleNativePlaneMessage(event.data, (message, transfer) => self.postMessage(message, transfer || []));
};
