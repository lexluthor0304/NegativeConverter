// Enlarger paradigm: the darkroom vocabulary (dichroic CMY filtration, exposure
// in stops, multigrade paper grades) expressed as a deterministic, invertible
// view of the existing core controls. Nothing here is stored separately: the
// core sliders stay the source of truth, these functions only translate.
//
// Filtration: a dichroic head is labelled 0-200 per colour. Adding filtration
// of a colour removes that colour from the light, so the print gets LESS of
// it: +10 M makes the print greener, +10 Y bluer, +10 C redder. In the core
// controls +tint is magenta, +temperature is warm (yellow), +cyan is cyan, so
// one filter unit maps to minus one slider unit around a reference pack.
//
// Exposure: stops relative to the base exposure, mapped through the curve
// engine's mid-grey response (rollAnalysis.exposureUnitsForStops).
//
// Grades: Ilford multigrade ISO(R) values 170/150/130/110/90/70/50 for grades
// 00-5 give mid-slope ratios relative to grade 2; the contrast slider values
// below reproduce those ratios in CurveEngine.contrastLayer (calibrated
// numerically, see docs/darkroom.md).

import { exposureUnitsForStops, exposureMidGreyResponse } from './rollAnalysis.js';

// A little cyan in the reference pack keeps small red corrections
// representable on a head that cannot go below 0C.
export const REFERENCE_FILTER_PACK = Object.freeze({ cyan: 20, magenta: 50, yellow: 40 });
export const FILTER_MIN = 0;
export const FILTER_MAX = 200;
export const FILTER_STEP = 5;

// Contrast slider value for each paper grade (grade 2 is the paper's normal).
export const PAPER_GRADE_CONTRAST = Object.freeze([
  { grade: '00', value: 0, contrast: -45, isoR: 170 },
  { grade: '0', value: 1, contrast: -34, isoR: 150 },
  { grade: '1', value: 2, contrast: -21, isoR: 130 },
  { grade: '2', value: 3, contrast: 0, isoR: 110 },
  { grade: '3', value: 4, contrast: 12, isoR: 90 },
  { grade: '4', value: 5, contrast: 25, isoR: 70 },
  { grade: '5', value: 6, contrast: 44, isoR: 50 }
]);

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

// Core slider (-100..100) -> filter units on the head, around the reference pack.
export function filtrationFromSliders({ cyan = 0, tint = 0, temperature = 0 } = {}, pack = REFERENCE_FILTER_PACK) {
  return {
    cyan: clamp(pack.cyan - (Number(cyan) || 0), FILTER_MIN, FILTER_MAX),
    magenta: clamp(pack.magenta - (Number(tint) || 0), FILTER_MIN, FILTER_MAX),
    yellow: clamp(pack.yellow - (Number(temperature) || 0), FILTER_MIN, FILTER_MAX)
  };
}

// Filter units -> core sliders. The inverse of filtrationFromSliders wherever
// the slider range allows it (the head can ask for more than the slider has).
export function slidersFromFiltration({ cyan, magenta, yellow } = {}, pack = REFERENCE_FILTER_PACK) {
  const slider = (filter, reference) => clamp(reference - (Number.isFinite(Number(filter)) ? Number(filter) : reference), -100, 100);
  return {
    cyan: slider(cyan, pack.cyan),
    tint: slider(magenta, pack.magenta),
    temperature: slider(yellow, pack.yellow)
  };
}

export function snapFiltration(value) {
  return clamp(roundToStep(Number(value) || 0, FILTER_STEP), FILTER_MIN, FILTER_MAX);
}

// Exposure slider units -> stops at mid grey (inverse of exposureUnitsForStops).
export function stopsFromExposureUnits(units) {
  const response = exposureMidGreyResponse(Number(units) || 0);
  return Number(Math.log2(Math.max(1e-6, response) / 0.5).toFixed(2));
}

export function exposureUnitsFromStops(stops) {
  return exposureUnitsForStops(clamp(Number(stops) || 0, -2, 0.95));
}

export function formatStops(stops) {
  const value = Number(stops) || 0;
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}`;
}

// Grade value: 0 = 00, 1 = 0, 2 = 1, ... 6 = 5; halves allowed (2.5 = grade 1½).
export function contrastForGradeValue(value) {
  const v = clamp(Number(value) || 0, 0, PAPER_GRADE_CONTRAST.length - 1);
  const lower = Math.floor(v);
  const upper = Math.min(PAPER_GRADE_CONTRAST.length - 1, lower + 1);
  const t = v - lower;
  return Math.round(PAPER_GRADE_CONTRAST[lower].contrast * (1 - t) + PAPER_GRADE_CONTRAST[upper].contrast * t);
}

// Nearest half grade for a contrast value (monotone inverse of the table).
export function gradeValueForContrast(contrast) {
  const c = Number(contrast) || 0;
  const table = PAPER_GRADE_CONTRAST;
  if (c <= table[0].contrast) return 0;
  if (c >= table[table.length - 1].contrast) return table.length - 1;
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i].contrast; const b = table[i + 1].contrast;
    if (c >= a && c <= b) {
      const t = (c - a) / (b - a);
      return i + Math.round(t * 2) / 2;
    }
  }
  return 3;
}

export function gradeLabelForValue(value) {
  const v = clamp(Number(value) || 0, 0, PAPER_GRADE_CONTRAST.length - 1);
  const lower = Math.floor(v);
  const label = PAPER_GRADE_CONTRAST[lower].grade;
  return v - lower >= 0.5 ? `${label}½` : label;
}

// Axes the test strip offers in each paradigm: key = core state key, label
// key for i18n, default step and unit formatting.
export const TEST_STRIP_AXES = Object.freeze({
  digital: [
    { key: 'coreExposure', label: 'testStripAxisExposure', step: 20, min: -300, max: 300 },
    { key: 'coreContrast', label: 'testStripAxisContrast', step: 10, min: -100, max: 100 },
    { key: 'coreTemperature', label: 'testStripAxisTemperature', step: 10, min: -100, max: 100 },
    { key: 'coreTint', label: 'testStripAxisTint', step: 10, min: -100, max: 100 },
    { key: 'coreCyan', label: 'testStripAxisCyan', step: 10, min: -100, max: 100 },
    { key: 'coreSaturation', label: 'testStripAxisSaturation', step: 10, min: 0, max: 200 },
    { key: 'coreShadows', label: 'testStripAxisShadows', step: 10, min: -100, max: 100 },
    { key: 'coreHighlights', label: 'testStripAxisHighlights', step: 10, min: -100, max: 100 }
  ],
  enlarger: [
    { key: 'coreExposure', label: 'testStripAxisStops', step: 20, min: -300, max: 300, format: 'stops' },
    { key: 'coreTemperature', label: 'testStripAxisYellow', step: 10, min: -100, max: 100, format: 'filterYellow' },
    { key: 'coreTint', label: 'testStripAxisMagenta', step: 10, min: -100, max: 100, format: 'filterMagenta' },
    { key: 'coreCyan', label: 'testStripAxisCyanFilter', step: 10, min: -100, max: 100, format: 'filterCyan' },
    { key: 'coreContrast', label: 'testStripAxisGrade', step: 12, min: -45, max: 44, format: 'grade' }
  ]
});

// Human-readable label for a value on an axis.
export function formatAxisValue(axis, value, pack = REFERENCE_FILTER_PACK) {
  const v = Number(value) || 0;
  switch (axis.format) {
    case 'stops': return formatStops(stopsFromExposureUnits(v));
    case 'filterYellow': return `${Math.round(clamp(pack.yellow - v, FILTER_MIN, FILTER_MAX))}Y`;
    case 'filterMagenta': return `${Math.round(clamp(pack.magenta - v, FILTER_MIN, FILTER_MAX))}M`;
    case 'filterCyan': return `${Math.round(clamp(pack.cyan - v, FILTER_MIN, FILTER_MAX))}C`;
    case 'grade': return `G${gradeLabelForValue(gradeValueForContrast(v))}`;
    default: return `${v > 0 ? '+' : ''}${Math.round(v)}`;
  }
}

// Values for a test strip: `count` variants centred on `centre` with `step`,
// clamped to the axis range and de-duplicated after clamping.
export function testStripValues(axis, centre, step, count = 5) {
  const n = clamp(Math.round(count) || 5, 3, 9);
  const half = Math.floor(n / 2);
  const values = [];
  for (let i = -half; i <= half; i++) {
    const value = clamp(Math.round((Number(centre) || 0) + i * step), axis.min, axis.max);
    if (!values.includes(value)) values.push(value);
  }
  return values;
}
