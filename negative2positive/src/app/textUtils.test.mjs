// Standalone Node test for textUtils.js - run with:
// node negative2positive/src/app/textUtils.test.mjs
import assert from 'node:assert/strict';
import { interpolateText, summarizePathForUi } from './textUtils.js';

// interpolateText
assert.equal(interpolateText('Exporting {current} / {total}', { current: 3, total: 9 }), 'Exporting 3 / 9');
assert.equal(interpolateText('{a}{a}', { a: 'x' }), 'xx');
assert.equal(interpolateText('no placeholders', {}), 'no placeholders');
assert.equal(interpolateText('{missing}', {}), '{missing}');
assert.equal(interpolateText(null, { a: 1 }), '');
assert.equal(interpolateText('v={v}', { v: null }), 'v=');
assert.equal(interpolateText('v={v}', { v: 0 }), 'v=0');

// summarizePathForUi
assert.equal(summarizePathForUi('/Users/lex/Pictures/roll42'), 'roll42');
assert.equal(summarizePathForUi('/Users/lex/Pictures/roll42/'), 'roll42');
assert.equal(summarizePathForUi('C:\\scans\\batch\\'), 'batch');
assert.equal(summarizePathForUi('single'), 'single');
assert.equal(summarizePathForUi(''), '');
assert.equal(summarizePathForUi(null), '');
assert.equal(summarizePathForUi('///'), '');

console.log('textUtils tests: all passed');
