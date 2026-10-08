import assert from 'node:assert/strict';
import { evictPlane, listEvictablePlanes, registerEvictablePlane } from './evictablePlanes.js';

let held = 725;
let busy = false;
const unregister = registerEvictablePlane('processedImageData', {
  bytes: () => held,
  canEvict: () => !busy && held > 0,
  evict: () => { const freed = held; held = 0; return freed; }
});
assert.deepEqual(listEvictablePlanes(), [{ name: 'processedImageData', bytes: 725, evictable: true }]);
busy = true;
assert.equal(evictPlane('processedImageData'), 0, 'refused while something needs the plane');
assert.equal(held, 725);
busy = false;
assert.equal(evictPlane('processedImageData'), 725);
assert.deepEqual(listEvictablePlanes(), [{ name: 'processedImageData', bytes: 0, evictable: false }]);
assert.equal(evictPlane('unknown'), 0);
unregister();
assert.deepEqual(listEvictablePlanes(), []);
assert.throws(() => registerEvictablePlane('x', {}));
console.log('evictablePlanes.test.mjs passed');
