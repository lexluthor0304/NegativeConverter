// The files a photo import takes, in one place (#268, #321). Every picker's
// `accept`, the drop and queue filter, RAW routing and the panel rules read
// these lists; addFilesToQueue in main.js, index.html's inputs and the
// desktop watch folder (src-tauri/src/import_folder.rs) repeat them, and
// importFormats.test.mjs holds those copies to these.

// Camera RAW containers LibRaw 0.22 decodes (the libraw-wasm build and the
// desktop's native LibRaw). LibRaw identifies a file by its content; the
// extension only decides that it goes to LibRaw at all. `.nefx` is a Nikon
// pixel-shift merge from NX Studio (Z8, Zf, Z6III), a 3-colour NEF.
export const CAMERA_RAW_EXTENSIONS = Object.freeze([
  '.3fr', '.arw', '.cr2', '.cr3', '.crw', '.dcr', '.dng', '.erf', '.fff', '.iiq',
  '.kdc', '.mef', '.mos', '.mrw', '.nef', '.nefx', '.nrw', '.orf', '.pef', '.raf',
  '.raw', '.rw2', '.rwl', '.sr2', '.srf', '.srw', '.x3f'
]);

// Routed like RAW: TIFF goes through UTIF first, LibRaw after.
export const RAW_LIKE_EXTENSIONS = Object.freeze([...CAMERA_RAW_EXTENSIONS, '.tif', '.tiff']);

// Decoded by the browser, or by libheif when it cannot (HEIC/HEIF).
const BROWSER_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.heif', '.hif'];

export const IMAGE_IMPORT_EXTENSIONS = Object.freeze([...RAW_LIKE_EXTENSIONS, ...BROWSER_IMAGE_EXTENSIONS]);

// A picker filters by `accept`: the RAW and HEIC extensions are named because
// no platform types them all as image/*.
export const IMAGE_IMPORT_ACCEPT = [...RAW_LIKE_EXTENSIONS, '.heic', '.heif', '.hif', 'image/*'].join(',');

function extensionOf(name) {
  const normalized = String(name || '').toLowerCase();
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 ? normalized.slice(dot) : '';
}

export function isCameraRawFileName(name) {
  return CAMERA_RAW_EXTENSIONS.includes(extensionOf(name));
}

export function isRawLikeFileName(name) {
  return RAW_LIKE_EXTENSIONS.includes(extensionOf(name));
}
