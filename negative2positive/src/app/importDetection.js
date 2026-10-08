// The first photo converts before its frame and film-edge detections end
// (#236). These fields only describe those detections: no conversion, export
// or post-conversion analysis reads them (importDetection.test.mjs checks the
// pipeline, SilverCore, render and worker sources), so provisional settings
// that differ from the final ones only here convert identically.
export const META_ONLY_KEYS = Object.freeze([
  'autoFrameMeta', 'filmEdge', 'frameMetadata', 'filmTypeSource',
  'filmTypeConfidence', 'filmTypeReason', 'learnedDefaults'
]);

export function omitKeys(object, keys) {
  return Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));
}

// Serialises what a conversion of one settings object receives: the router
// settings (recipe, geometry, film type, learned values, the analysis region
// from the image area; the flat-field gain map by its id) and the adjustment
// settings, both without the detection descriptions, plus the two things the
// main thread reads from autoFrameMeta itself: the colour-analysis sample area
// and the automatic-WB review gate.
export function importConversionKey({ router, adjustment, meta = null }) {
  return JSON.stringify([
    omitKeys(router, [...META_ONLY_KEYS, 'flatField']),
    omitKeys(adjustment, META_ONLY_KEYS),
    meta?.imageArea || meta?.analysisArea || null,
    Boolean(meta?.analysisNeedsReview)
  ]);
}
