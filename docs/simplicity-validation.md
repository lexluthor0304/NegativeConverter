# Roadmap #181: local validation

Implementation branch: `feat/simplicity-181`. No deployment or issue closure is
implied by this local preview.

| Issue | Implementation | Evidence / remaining acceptance |
| --- | --- | --- |
| #188 HEIC | Native first, bundled libheif worker, primary image, timeout, formats and guide | Chrome decoded the actual HEIC fixture at 1400 × 1284 and imported/converted it. Camera-original orientation variants and iPhone Safari remain manual checks. |
| #184 Automatic roll | Same-stock groups, first-paint deferral, user-edit guards, atomic undo | Browser imported three matching strips, reported 3/3 with base RGB 150/100/70, preserved selection, and one Undo restored “Not analysed”. Pure grouping/skip tests pass. |
| #182 Semantic colour | Bundled ADE20K model, WebGPU/WASM worker, stored label map, WB and expired-neutral weights | Real Chrome inference returned 4096 labels; measured 0.372–5.4 s across runs on this machine (cache/session state differs). Native ONNX check returned finite `[1,150,64,64]` output. Pure anchor tests use explicit labels. Real negative/reference ΔE improvement and the locomotive/cab cases are **not established** by these tests. |
| #183 Edge text | Shared bitmap templates, rectified 135 lanes / outer 120 bands, mirror/frame/year metadata | Synthetic template, mirror, ambiguous year and unknown-text tests. Physical 120/135 lettering and year marks need real-scan validation. |
| #185 Learned taste | Touched controls, per-roll shrinkage, local IndexedDB, successful-save training, reset | Pure learning/dedup/category/manual-field tests. Multi-session training with real rolls remains manual acceptance. Formula discrepancy explained in simplicity-automation.md. |
| #186 Export | ICC for PNG/JPEG/TIFF, gain-map JPEG container, structured names | ICC chunk/tag tests, unchanged JPEG scan tests, MPF offsets and browser decode. True HDR highlight headroom is unavailable in the existing bounded source plane; HDR-display rendering remains unverified. |
| #187 Review | Shared reasons, badges, filter, acknowledgement, persistence, export notice | Pure reasons/manual/error tests and browser filter/mark-reviewed interactions. |
| #189 Panels | Relevant contexts, active-effect visibility, persistent Advanced | Pure context tests and actual browser HEIC/Advanced checks; CMYD stays visible above basic adjustments with Advanced off. |
| #190 Hot folder | Native picker grant, stability, bounded reads, opt-in existing files, Stop | 34 Rust tests pass including chunk/scope/stability checks. Browser reader/cancellation tests pass; actual macOS/Windows/Linux and MAS sandbox folder-watch runs remain manual acceptance. |

The repository does not contain manually balanced reference images/masks for
face ΔE measurements or identified locomotive/cab fixture files. Model execution
and hand-labelled synthetic colour tests must not be presented as proof of
improved colour on those real negatives.

Automated validation on 2026-09-15: `npm test` passes 92/92 test files;
`npm run test:rust` passes 34 tests; `npm run build:web` succeeds.
`PORT=5281 CDP_PORT=9381 npm run test:smoke` completes with **SMOKE PASS**.
The full run includes Studio controls and mobile geometry, automatic crop,
colour-analysis/export invariants, DX and roll analysis, darkroom, camera,
metadata/contact sheets/projects/recipes, 16-bit and AI repair, fonts,
positive/expired workflows, and the #181 simplicity scenarios.

The final run decoded the HEIC at 1400 × 1284, ran the real semantic model on
WebGPU, and automatically analysed all three same-stock frames with base
RGB 150/100/70. One Undo restored the pre-analysis state. Retained-edge versus
cropped PNGs had mean pixel error 0; individual and batch PNGs matched.

PNG profile insertion preserves the compressed image tail after the first
IDAT chunk. A 2,048-chunk regression checks bounded header reads and identical
compressed bytes. The technical browser suite passes repair export, mouse and
touch strokes, undo/redo, clear/repaint, restart, and automatic AI dust loading.
Local logs are retained in `output/verification/`.

## Borderless DNG follow-up: L1009967

The user's local `L1009967.dng` reproduced a false positive classification:
`positive / low / warmScene`. Roughly 68% of sampled pixels met the old
orange predicate, below its 72% threshold; magenta subject regions still
shared the red mask. Classification now also accepts majority-orange images
with red dominance over more than 95% of sampled pixels and the existing
cross-channel quantile separation. This uses pixels, not filenames or RAW
extensions, and retains medium confidence and manual override.

The original 9536 × 6336 DNG was imported through the real browser file input:
it selected `color`, detected film base RGB 164/70/42, and displayed the
inverted, mask-corrected image. `output/L1009967-fixed.png` records the preview.
The user's original file is not included in the commit. Synthetic 8/16-bit
regressions cover mixed orange/magenta negatives, warm positives with neutral
regions or blue sky, and explicit positive selection.
After this classifier change, all 92 test files and the web build pass;
`npm run test:smoke -- --positive-only` also passes mixed-batch exports,
borderless positive/negative/monochrome imports, identity positive export and
saved manual selection. The full-suite result above predates this follow-up.

## Synthetic colour measurement

For the deterministic 64 × 64 test in `semanticAnchors.test.mjs`, 24 columns
are a green-cast neutral `[100,120,100]`; the rest is foliage `[75,150,70]`.
Labels are explicitly supplied (road = 11, tree = 4), confidence 0.9. Against
the known neutral reference `[120,120,120]`, using sRGB/D65 Lab and ΔE76:

| Method | Corrected neutral RGB, before rounding | ΔE76 |
| --- | --- | --- |
| Statistics | 117.832, 120, 117.832 | 1.565 |
| Semantic weights with explicit labels | 119.672, 120, 119.672 | 0.236 |

This checks the estimator's correction direction and its combination with the
statistical result. It is **not** an end-to-end model recognition score, a skin
measurement, or evidence for the real-scene acceptance criteria.
