// One list of importable files (#268 Panasonic and other RAWs, #321 Nikon
// NEFX), and the copies that must follow it: index.html's pickers, the queue
// filter in main.js and the desktop watch folder in import_folder.rs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAMERA_RAW_EXTENSIONS, RAW_LIKE_EXTENSIONS, IMAGE_IMPORT_EXTENSIONS, IMAGE_IMPORT_ACCEPT,
  isCameraRawFileName, isRawLikeFileName
} from './importFormats.js';
import { isRawLikeFileName as loaderIsRawLike, RAW_LIKE_EXTENSIONS as loaderRawLike } from './imageFileLoaders.js';
import { inferSourceKind } from './panelRelevance.js';
import { isTiffContainerRawName } from './rawEmbeddedPreview.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = path => readFileSync(join(here, path), 'utf8');

for (const list of [CAMERA_RAW_EXTENSIONS, RAW_LIKE_EXTENSIONS, IMAGE_IMPORT_EXTENSIONS]) {
  assert.equal(new Set(list).size, list.length, 'no extension twice');
  for (const ext of list) assert.match(ext, /^\.[a-z0-9]+$/, `${ext} is a lower-case extension`);
}
for (const ext of ['.nef', '.nefx', '.rw2', '.raw', '.orf', '.raf', '.cr3', '.arw', '.pef', '.dng']) {
  assert.ok(CAMERA_RAW_EXTENSIONS.includes(ext), `${ext} goes to LibRaw`);
}
assert.deepEqual(RAW_LIKE_EXTENSIONS, [...CAMERA_RAW_EXTENSIONS, '.tif', '.tiff']);
assert.ok(IMAGE_IMPORT_EXTENSIONS.includes('.heic') && IMAGE_IMPORT_EXTENSIONS.includes('.jpg'));
assert.equal(loaderRawLike, RAW_LIKE_EXTENSIONS, 'imageFileLoaders.js re-exports the same list');

// #321: an NX Studio pixel-shift merge is a NEF to LibRaw.
assert.ok(isCameraRawFileName('Z8_0001.NEFX'));
assert.ok(isRawLikeFileName('Z8_0001.nefx') && loaderIsRawLike('Z8_0001.nefx'));
assert.ok(isTiffContainerRawName('Z8_0001.NEFX'), 'its embedded preview is looked for like a NEF\'s');
// #268: Panasonic Lumix RW2 (and the older .RAW) is a camera RAW.
assert.ok(isCameraRawFileName('P1000123.RW2') && isCameraRawFileName('P1000123.RAW'));
assert.equal(inferSourceKind({ name: 'P1000123.RW2' }), 'camera-raw');
assert.equal(inferSourceKind({ name: 'Z8_0001.nefx' }), 'camera-raw');
assert.ok(!isCameraRawFileName('scan.tif') && isRawLikeFileName('scan.TIFF'), 'TIFF is routed like RAW but is no camera RAW');
assert.ok(!isRawLikeFileName('photo.jpg') && !isRawLikeFileName('nef') && !isRawLikeFileName(''));

// The accept of every photo picker names each RAW and HEIC extension.
assert.equal(IMAGE_IMPORT_ACCEPT, [...RAW_LIKE_EXTENSIONS, '.heic', '.heif', '.hif', 'image/*'].join(','));
const html = read('../../index.html');
const acceptOf = id => html.match(new RegExp(`<input type="file" id="${id}"[^>]*\\saccept="([^"]*)"`))?.[1];
assert.equal(acceptOf('fileInput'), IMAGE_IMPORT_ACCEPT, 'index.html #fileInput');
assert.equal(acceptOf('folderInput'), IMAGE_IMPORT_ACCEPT, 'index.html #folderInput');
assert.equal(acceptOf('projectInput'), `.json,${IMAGE_IMPORT_ACCEPT}`, 'index.html #projectInput');

// main.js: "Add photos" uses the shared accept; the queue filter repeats the list.
const main = read('main.js');
assert.ok(main.includes('input.accept = IMAGE_IMPORT_ACCEPT;'), 'the Add photos picker');
const queueList = main.match(/const supportedExtensions = (\[[^\]]*\]);/)?.[1];
assert.ok(queueList, 'addFilesToQueue lists its extensions');
assert.deepEqual(JSON.parse(queueList.replaceAll("'", '"')), [...IMAGE_IMPORT_EXTENSIONS], 'addFilesToQueue takes what the pickers offer');

// The desktop watch folder takes every camera RAW and the scan formats.
const rust = read('../../../src-tauri/src/import_folder.rs');
const arm = rust.slice(rust.indexOf('pub fn supported'), rust.indexOf('fn fingerprint'));
const watched = new Set([...arm.matchAll(/"([a-z0-9]+)"/g)].map(match => `.${match[1]}`));
for (const ext of [...RAW_LIKE_EXTENSIONS, '.heic', '.heif', '.hif', '.jpg', '.png']) {
  assert.ok(watched.has(ext), `import_folder.rs supported() takes ${ext}`);
}

console.log('importFormats: one list for pickers, queue, RAW routing, panels and the watch folder');
