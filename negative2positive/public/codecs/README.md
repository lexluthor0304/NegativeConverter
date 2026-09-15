# Local HEIF decoder

libheif-js **1.19.8**, from https://github.com/catdad-experiments/libheif-js
(npm tarball at https://registry.npmjs.org/libheif-js/-/libheif-js-1.19.8.tgz).
The unmodified `libheif.js` and `libheif.wasm` are separately loaded, replaceable
LGPL-3.0 components. The full licence and upstream notices are in
`libheif-LICENSE.txt`. Source and build scripts: the upstream repository, tag
v1.19.8. Replace these two assets together to relink the application with a
modified decoder; no application bundle change is needed.

`heif-worker.js` decodes the primary image only, in a disposable worker. Browser
native decoding is attempted first. All runtime requests are to local assets;
there is no CDN or image upload.
