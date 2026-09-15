import assert from 'node:assert/strict';
import { decodeKodakYear } from './kodakYearCodes.js';
assert.deepEqual(decodeKodakYear('●▲').candidates, [1923,1943,1963]);
assert.equal(decodeKodakYear('●▲').year, null);
assert.equal(decodeKodakYear('●▲', { earliest: 1960 }).year, 1963);
assert.equal(decodeKodakYear('●■×').year, 1982);
assert.equal(decodeKodakYear('++').year, 1968);
assert.equal(decodeKodakYear('nonsense').year, null);
console.log('Kodak US year symbols: repeated decades and unique third symbols passed');
