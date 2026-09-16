// Standalone Node test for autoFrameAnalyzer.js aspect-target selection - run with:
// node negative2positive/src/app/autoFrameAnalyzer.test.mjs

import assert from 'node:assert/strict';
import { getAutoFrameAspectTargets, getDensityTemplateReliability, inferAutoFrameConfidenceLevel } from './autoFrameAnalyzer.js';

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

// 比率テンプレートは生成経路名だけで信頼度を上げない。
{
  const candidate = {
    detectedFormat: '135',
    scoreBreakdown: {
      boundaryCompleteness: 0.9, borderContrast: 0.5,
      outsideClean: 0.3, contentTexture: 0.1, sprocketLane: 0,
    },
  };
  const validation = { aspectScore: 0.9, areaRatio: 0.8 };
  const plain = getDensityTemplateReliability({ ...candidate, method: 'density-template' }, validation);
  const sprocket = getDensityTemplateReliability({ ...candidate, method: 'density-sprocket-template' }, validation);
  assert.deepEqual(sprocket, plain);
  assert.equal(sprocket.usable, true);
  assert.equal(inferAutoFrameConfidenceLevel(sprocket.confidenceCap), 'medium');
  const supported = getDensityTemplateReliability({
    ...candidate, method: 'density-sprocket-template',
    scoreBreakdown: { ...candidate.scoreBreakdown, sprocketLane: 0.3 },
  }, validation);
  assert.equal(inferAutoFrameConfidenceLevel(supported.confidenceCap), 'high');
  assert.deepEqual(getDensityTemplateReliability({
    ...candidate, method: 'density-template',
    scoreBreakdown: { ...candidate.scoreBreakdown, sprocketLane: 0.3 },
  }, validation), supported);
  assert.deepEqual(getDensityTemplateReliability({ method: 'density-template' }, validation),
    { usable: false, confidenceCap: 0 });
  const moderate = getDensityTemplateReliability({ ...candidate,
    method: 'density-template', scoreBreakdown: { ...candidate.scoreBreakdown, borderContrast: 0.35 }
  }, validation);
  assert.equal(inferAutoFrameConfidenceLevel(moderate.confidenceCap), 'medium');
}

// ---- fallback guards: straightening angles only, no boxes on the image edges ----
{
  const { buildRotationCandidates, countCropEdgeContacts } = await import('./autoFrameAnalyzer.js');
  // Axis-aligned rectangles reported as ±90° by minAreaRect are 0° tilts;
  // a 1.5° tilt reported as -88.5° is 1.5°; nothing ever rotates by a right angle.
  const angles = buildRotationCandidates([
    { minRect: { angle: -90, width: 300, height: 200 } },
    { minRect: { angle: 90, width: 200, height: 300 } },
    { minRect: { angle: -88.5, width: 300, height: 200 } },
    { minRect: { angle: 3.2, width: 300, height: 200 } },
    { minRect: { angle: 180, width: 300, height: 200 } }
  ]);
  assert.ok(angles.includes(0));
  assert.ok(angles.every(angle => Math.abs(angle) <= 45), `fallback angles stay within ±45°: ${angles}`);
  assert.ok(angles.includes(1.5) && angles.includes(-1.5), `sign ambiguity keeps both tilts: ${angles}`);
  assert.ok(angles.includes(3.2) && angles.includes(-3.2));
  assert.ok(!angles.some(angle => Math.abs(Math.abs(angle) - 90) < 1), 'no right-angle candidates');

  const image = { width: 1600, height: 1066 };
  assert.equal(countCropEdgeContacts({ left: 100, top: 90, width: 1200, height: 800 }, image), 0);
  assert.equal(countCropEdgeContacts({ left: 0, top: 90, width: 1200, height: 800 }, image), 1, 'left edge');
  assert.equal(countCropEdgeContacts({ left: 0, top: 0, width: 1262, height: 809 }, image), 2, 'left and top');
  assert.equal(countCropEdgeContacts({ left: 0, top: 40, width: 1600, height: 1026 }, image), 3, 'three sides (a whole-capture box)');
  assert.equal(countCropEdgeContacts({ left: 5, top: 5, width: 1590, height: 1056 }, image), 4, 'within the 0.6 % tolerance counts as touching');
  assert.equal(countCropEdgeContacts({ left: 12, top: 12, width: 1576, height: 1042 }, image), 0, 'a 12 px rebate is inside');
  assert.equal(countCropEdgeContacts(null, image), 0);
  assert.equal(countCropEdgeContacts({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 }), 0);
  console.log('autoFrameAnalyzer fallback guard tests passed');
}
