# Positive processing and import detection

Positive film offers **Correct slide** (shared RGB tone mapping, bounded highlight shoulder and high-confidence neutral balance) and **Edit only** (no histogram/white-balance analysis). Neutral Edit only preserves input 16-bit RGBA samples. Explicit manual edits, looks, flat fields, retouching and export format choices still apply.

The default positive model does not apply the negative model's blue hue adjustment. Film-base compensation remains exclusive to colour negatives. Shared analysis samples keep preview, crop and export consistent; changing positive mode invalidates cached analysis.

New imports use a bounded pixel sample. An orange rebate provides stronger evidence for a colour negative; an orange mask can also be detected when the border is cropped away. Uniform clear monochrome rebates suggest B&W negative. Consistent DX film data takes precedence. Without polarity evidence, monochrome images remain in positive orientation and show an explicit prompt to choose B&W negative or Positive. Warm scenes and colour-corrected negatives can be ambiguous; a confidence label and manual override remain available. No accuracy percentage has been established on a representative labelled real-film corpus.

Detection applies to new photos and never-viewed batch exports. Saved settings, manual choices, undo and project recovery retain per-photo mode. The import checkbox lets a photographer explicitly apply the selected type to a uniform batch instead. Correction strength and AI reconstruction do not recover detail already clipped in the input.

Validation: `node negative2positive/src/pipeline/positiveProcessing.test.mjs`, `node negative2positive/src/app/filmTypeDetection.test.mjs`, and `node scripts/smoke-test.mjs --positive-only`.
