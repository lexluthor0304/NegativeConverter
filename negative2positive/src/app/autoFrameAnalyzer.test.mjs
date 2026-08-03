// Standalone Node test for autoFrameAnalyzer.js aspect-target selection - run with:
// node negative2positive/src/app/autoFrameAnalyzer.test.mjs

import assert from 'node:assert/strict';
import { getAutoFrameAspectTargets } from './autoFrameAnalyzer.js';

const RATIOS = { '135': 1.5, '120-6x4.5': 1.33, '120-6x6': 1, '120-6x7': 1.17, '120-6x9': 1.5 };
const FORMATS_120 = ['6x4.5', '6x6', '6x7', '6x9'];

function context(settings) {
  return { settings, default120Formats: FORMATS_120, formatRatios: RATIOS };
}
const keys = (targets) => targets.map(t => t.key).sort();

// '135' is exclusive: no 120 targets at all (#112)
{
  const targets = getAutoFrameAspectTargets(context({ formatPreference: '135' }));
  assert.deepEqual(keys(targets), ['135']);
}

// '120' is exclusive: no 135 target
{
  const targets = getAutoFrameAspectTargets(context({ formatPreference: '120' }));
  assert.deepEqual(keys(targets), ['120-6x4.5', '120-6x6', '120-6x7', '120-6x9']);
}

// '120' respects the sub-format checkboxes
{
  const targets = getAutoFrameAspectTargets(context({
    formatPreference: '120',
    allowed120Formats: { '6x4.5': false, '6x6': true, '6x7': false, '6x9': false }
  }));
  assert.deepEqual(keys(targets), ['120-6x6']);
}

// '120' with every sub-format disabled still falls back to 6x6 (an empty
// family would silently re-enable 135)
{
  const targets = getAutoFrameAspectTargets(context({
    formatPreference: '120',
    allowed120Formats: { '6x4.5': false, '6x6': false, '6x7': false, '6x9': false }
  }));
  assert.deepEqual(keys(targets), ['120-6x6']);
}

// auto keeps both families
{
  const targets = getAutoFrameAspectTargets(context({ formatPreference: 'auto' }));
  assert.deepEqual(keys(targets), ['120-6x4.5', '120-6x6', '120-6x7', '120-6x9', '135']);
}

// auto with every 120 sub-format disabled is 135-only
// (previously safe120 forced 6x6 back in, so 120 could never be turned off)
{
  const targets = getAutoFrameAspectTargets(context({
    formatPreference: 'auto',
    allowed120Formats: { '6x4.5': false, '6x6': false, '6x7': false, '6x9': false }
  }));
  assert.deepEqual(keys(targets), ['135']);
}

// missing settings default to auto behavior
{
  const targets = getAutoFrameAspectTargets(context(undefined));
  assert.ok(keys(targets).includes('135'));
  assert.ok(keys(targets).includes('120-6x6'));
}

console.log('autoFrameAnalyzer aspect-target tests passed');
