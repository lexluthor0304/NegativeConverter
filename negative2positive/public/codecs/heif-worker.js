/* libheif 1.19.8 is a separate, replaceable LGPL library; see README.md. */
// Answers the page's isolation probe (#264) before the decode handler sees it;
// the classic-worker twin of src/workers/isolationProbe.js.
self.addEventListener('message', event => {
  if (event.data?.type !== 'nc-isolation-probe') return;
  event.stopImmediatePropagation();
  self.postMessage({ type: 'nc-isolation-probe', id: event.data.id, crossOriginIsolated: self.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function', secureContext: self.isSecureContext === true });
});
importScripts('./libheif.js');
// libheif-js returns its module, not a promise; in a worker it compiles the
// WASM synchronously. The runtime's start is the ready signal: the page
// transfers the file only after it.
let initializedHeif = null;
let startFailed = false;
const announce = heif => {
  if (initializedHeif || startFailed) return;
  initializedHeif = heif;
  self.postMessage({ ready: true });
};
const failStart = reason => {
  if (initializedHeif || startFailed) return;
  startFailed = true;
  self.postMessage({ error: reason?.message || String(reason || 'HEIF decoder could not start') });
};
try {
  const heif = libheif({
    locateFile: name => new URL(name, self.location.href).href,
    onRuntimeInitialized() { announce(this); },
    onAbort: failStart
  });
  if (heif?.calledRun) announce(heif);
} catch (error) { failStart(error); }
self.onmessage = async ({ data: { buffer } }) => {
  try {
    const heif = initializedHeif;
    if (!heif) throw new Error('HEIF decoder is not ready');
    const decoder = new heif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(buffer));
    const primary = images.find(image => heif.heif_image_handle_is_primary_image(image.handle));
    if (!primary) throw new Error('No primary HEIF image');
    // libheif applies irot/imir by default during decode; handle dimensions
    // include these transforms. Never apply EXIF rotation for a second time.
    const width = primary.get_width(), height = primary.get_height();
    if (width <= 0 || height <= 0 || width > 32767 || height > 32767 || width * height > 268435456) {
      throw Object.assign(new Error('HEIF dimensions exceed canvas limits'), { code: 'IMAGE_TOO_LARGE' });
    }
    const rgba = await new Promise((resolve, reject) => primary.display(
      { width, height, data: new Uint8ClampedArray(width * height * 4) },
      value => value ? resolve(value) : reject(new Error('HEIF primary image decode failed'))
    ));
    self.postMessage(rgba, [rgba.data.buffer]);
  } catch (error) { self.postMessage({ error: error.message, code: error.code }); }
};
