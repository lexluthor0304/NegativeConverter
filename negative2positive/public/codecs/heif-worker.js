/* libheif 1.19.8 is a separate, replaceable LGPL library; see README.md. */
importScripts('./libheif.js');
self.onmessage = async ({ data: { file } }) => {
  try {
    const heif = await libheif({ locateFile: name => new URL(name, self.location.href).href });
    const decoder = new heif.HeifDecoder();
    const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
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
