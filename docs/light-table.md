# Light table (thumbnail grid of the roll)

Roadmap item #148. The film strip under the preview can grow into a light
table: a grid of larger thumbnails for the whole roll, so colour consistency,
detected stocks and roll outliers are visible at a glance.

## Behaviour

- **Light table / Film strip** button in the strip header
  (`#studioToggleLightTable`, `studioWorkspace.js`) toggles `body.studio-lighttable`.
  Turning it on also un-hides a hidden strip. The state is session only.
- In the light table the strip row grows to 44 % of the viewport (40 % on
  phones), `.file-list-items` becomes `grid` with `auto-fill` tiles of at least
  150 px (120 px on phones), and the tiles show a larger thumbnail, the file
  name and the badges from the film edge reader (`film-stock`) and the roll
  analysis (`roll-outlier`). `renderFileList` is unchanged; only CSS differs.
- **Thumbnails for every file.** RAW files used to show a numbered placeholder
  until opened; `loadStudioThumbnails` now decodes them through the fast
  embedded-preview path (`loadRawImageDataPreview`) one at a time in the
  background. After **Analyse roll** every analysed frame gets a converted
  thumbnail rendered from the 900 px sample already in memory, so the light
  table shows the roll as it will convert instead of orange negatives.
- **Keyboard.** With a tile focused, Left/Right move by one tile, Up/Down by
  one row (the number of tiles sharing the first tile's top edge), Home/End to
  the ends. Selection (checkboxes, shift-range) and the existing "apply to
  selected" / batch export flows are untouched.

## Verification

`scripts/light-table-smoke.mjs` (part of `npm run test:smoke` and of
`node scripts/smoke-test.mjs --film-edge-only`) imports four fixtures, asserts
the default strip view, toggles the light table and checks `display: grid`
with at least four columns in a 1440 px window, a strip row that grew by more
than 60 px, larger tiles, preserved badges and four thumbnails, then drives the
arrow keys and toggles back. `scripts/roll-analysis-smoke.mjs` checks that the
thumbnails of unopened frames lose the orange mask after a roll analysis.

## Not in this change

Flags / stars for culling, drag-to-reorder (frame order for the contact sheet),
and a hover negative/positive compare are still open on #148.
