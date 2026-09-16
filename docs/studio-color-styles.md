# Studio color styles

The four quick Color styles apply editable recipes to the existing core
controls (`app/studioStyles.js`). Previously they only selected scanner color
models: Warm fell back to the same model as Natural, while Vivid and Soft
mostly changed hue offsets.

| Button | Result |
| --- | --- |
| Natural / 自然 | Neutral temperature, contrast and saturation; no glow or fade |
| Warm / 暖调 | Warmer temperature with a small tint and saturation adjustment |
| Vivid / 鲜明 | More saturation and contrast, slightly deeper shadows |
| Soft / 柔和 | Lower contrast and saturation, lifted shadows and gentler highlights |

Each choice replaces the recipe's temperature, tint, contrast, saturation,
shadow/highlight, glow and fade controls, and clears the film/enhanced preset.
It preserves exposure, manual CMYD, white-balance gains, geometry, film type
and one-click correction. All resulting controls remain editable. Existing
saved photos keep their settings until a style is chosen; no schema migration
or new processing path is needed. One undo restores the previous recipe.

One-click correction holds the original conversion and settings while its
second analysis phase loads OpenCV. A look chosen during that wait cannot
change the measured baseline. A superseded analysis cannot overwrite a later
correction or undo.

## Regression checks

```sh
PORT=5283 CDP_PORT=9383 npm run test:smoke -- --styles-only
```

The real Chrome test exports PNGs for all four styles, with correction both
off and on. It compares decoded pixels for warmth, chroma and luminance
range, checks unchanged exposure/CMYD and dimensions, and verifies exact
pixel restoration on Natural and undo. It also switches to Warm while
OpenCV loads and compares against a fresh correction measured on Natural.
The full smoke suite includes this test; its measurements are written to
`output/verification/style-comparison.json`.
