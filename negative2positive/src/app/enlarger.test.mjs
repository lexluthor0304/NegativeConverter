// Standalone Node test for enlarger.js - run with:
// node negative2positive/src/app/enlarger.test.mjs

import assert from 'node:assert/strict';
import {
  REFERENCE_FILTER_PACK,
  PAPER_GRADE_CONTRAST,
  filtrationFromSliders,
  slidersFromFiltration,
  snapFiltration,
  stopsFromExposureUnits,
  exposureUnitsFromStops,
  contrastForGradeValue,
  gradeValueForContrast,
  gradeLabelForValue,
  TEST_STRIP_AXES,
  formatAxisValue,
  testStripValues
} from './enlarger.js';
import { generateCurves } from '../silvercore/engine/CurveEngine.js';

// Filtration round trip and direction: +10 M on the head = -10 tint (greener).
{
  const pack = filtrationFromSliders({ cyan: 0, tint: 0, temperature: 0 });
  assert.deepEqual(pack, { cyan: 20, magenta: 50, yellow: 40 });
  const greener = filtrationFromSliders({ tint: -10 });
  assert.equal(greener.magenta, 60);
  const warmer = filtrationFromSliders({ temperature: 15 });
  assert.equal(warmer.yellow, 25, 'warm print needs less yellow filtration');
  for (const sliders of [{ cyan: 0, tint: 0, temperature: 0 }, { cyan: -30, tint: 25, temperature: -40 }, { cyan: 12, tint: -7, temperature: 33 }]) {
    const back = slidersFromFiltration(filtrationFromSliders(sliders));
    assert.deepEqual(back, sliders, `round trip ${JSON.stringify(sliders)}`);
  }
  // The head clamps at 0 and 200; the slider clamps at ±100.
  assert.equal(filtrationFromSliders({ tint: 90 }).magenta, 0);
  assert.equal(slidersFromFiltration({ magenta: 200 }).tint, -100);
  assert.equal(snapFiltration(52), 50);
  assert.equal(snapFiltration(-3), 0);
  assert.equal(snapFiltration(999), 200);
  assert.equal(REFERENCE_FILTER_PACK.magenta, 50);
  assert.equal(filtrationFromSliders({ cyan: 60 }).cyan, 0, 'the head cannot go below 0C');
}

// Exposure in stops round-trips through the curve engine's mid-grey response.
{
  for (const stops of [-1.5, -1, -0.5, 0, 0.3, 0.8]) {
    const units = exposureUnitsFromStops(stops);
    const back = stopsFromExposureUnits(units);
    assert.ok(Math.abs(back - stops) < 0.07, `${stops} -> ${units} -> ${back}`);
  }
  assert.equal(stopsFromExposureUnits(0), 0);
}

// Paper grades: monotone contrast table, half grades interpolate, inverse snaps.
{
  for (let i = 1; i < PAPER_GRADE_CONTRAST.length; i++) {
    assert.ok(PAPER_GRADE_CONTRAST[i].contrast > PAPER_GRADE_CONTRAST[i - 1].contrast, 'grades increase contrast');
    assert.ok(PAPER_GRADE_CONTRAST[i].isoR < PAPER_GRADE_CONTRAST[i - 1].isoR, 'ISO(R) shrinks with grade');
  }
  assert.equal(contrastForGradeValue(3), 0, 'grade 2 is the paper normal');
  assert.equal(contrastForGradeValue(0), -45);
  assert.equal(contrastForGradeValue(6), 44);
  assert.equal(contrastForGradeValue(3.5), 6, 'grade 2½ sits between 2 and 3');
  assert.equal(gradeValueForContrast(0), 3);
  assert.equal(gradeValueForContrast(44), 6);
  assert.equal(gradeValueForContrast(-45), 0);
  assert.equal(gradeValueForContrast(6), 3.5);
  assert.equal(gradeValueForContrast(-100), 0);
  assert.equal(gradeValueForContrast(100), 6);
  assert.equal(gradeLabelForValue(0), '00');
  assert.equal(gradeLabelForValue(3), '2');
  assert.equal(gradeLabelForValue(3.5), '2½');
  assert.equal(gradeLabelForValue(6), '5');

  // The calibration claim: the grade contrasts reproduce the ISO(R) mid-slope
  // ratios in the real curve engine within 5 %.
  const channelData = [0, 1, 2].map((ch) => ({ whitePointOrigin: 3000, blackPointOrigin: 60000, meanPoint: 0.5, settingName: `c${ch}` }));
  const base = { toneProfile: 'base', imageType: 'negative', wbMethod: 'linearFixed', colorModel: 'standard', autoToneLevel: 1 };
  const midSlope = (contrast) => {
    const lut = generateCurves(channelData, { ...base, contrast }).g;
    let idx = 0;
    for (let i = 0; i < 65536; i++) { if (lut[i] <= 32768) { idx = i; break; } }
    const d = 400;
    return Math.abs(lut[idx + d] - lut[idx - d]) / (2 * d);
  };
  const normal = midSlope(0);
  for (const row of PAPER_GRADE_CONTRAST) {
    const ratio = midSlope(row.contrast) / normal;
    const target = 110 / row.isoR;
    assert.ok(Math.abs(ratio - target) / target < 0.05, `grade ${row.grade}: slope ratio ${ratio.toFixed(3)} vs ${target.toFixed(3)}`);
  }
}

// Test strip axes and value formatting.
{
  const exposure = TEST_STRIP_AXES.enlarger.find((a) => a.key === 'coreExposure');
  assert.equal(formatAxisValue(exposure, 0), '0.0');
  assert.match(formatAxisValue(exposure, 50), /^\+0\.[4-6]$/);
  const yellow = TEST_STRIP_AXES.enlarger.find((a) => a.key === 'coreTemperature');
  assert.equal(formatAxisValue(yellow, 0), '40Y');
  assert.equal(formatAxisValue(yellow, 10), '30Y');
  const grade = TEST_STRIP_AXES.enlarger.find((a) => a.key === 'coreContrast');
  assert.equal(formatAxisValue(grade, 0), 'G2');
  assert.equal(formatAxisValue(grade, 44), 'G5');
  const digitalExposure = TEST_STRIP_AXES.digital.find((a) => a.key === 'coreExposure');
  assert.equal(formatAxisValue(digitalExposure, 20), '+20');
  assert.deepEqual(testStripValues(digitalExposure, 0, 20, 5), [-40, -20, 0, 20, 40]);
  assert.deepEqual(testStripValues(digitalExposure, 280, 20, 5), [240, 260, 280, 300], 'clamped values collapse');
  assert.equal(testStripValues(digitalExposure, 0, 10, 7).length, 7);
  assert.equal(testStripValues(digitalExposure, 0, 10, 99).length, 9, 'count is capped');
  for (const axes of Object.values(TEST_STRIP_AXES)) {
    for (const axis of axes) assert.ok(axis.key && axis.label && axis.step > 0 && axis.min < axis.max);
  }
}

console.log('enlarger.test.mjs passed');
