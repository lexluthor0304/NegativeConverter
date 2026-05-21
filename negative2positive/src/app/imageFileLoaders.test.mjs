import assert from 'node:assert/strict';

import { isRawLikeFileName, RAW_LIKE_EXTENSIONS } from './imageFileLoaders.js';

assert.equal(isRawLikeFileName('scan.NEF'), true);
assert.equal(isRawLikeFileName('/tmp/roll_01.TIFF'), true);
assert.equal(isRawLikeFileName('converted.png'), false);
assert.equal(isRawLikeFileName('archive.nef.zip'), false);
assert.ok(RAW_LIKE_EXTENSIONS.includes('.dng'));

console.log('imageFileLoaders tests passed');
