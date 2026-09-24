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
- **Thumbnails for every file.** At import every TIFF-container RAW (DNG,
  NEF, CR2, ARW, RW2, ...) gets an `embedded` tile: the scan-decode worker
  locates the smallest preview with a long side of at least 288 px through
  Blob slices (720 × 480 on the M11, ~50-140 KB read), inverts it and returns a
  ~320 px JPEG data URL. Two workers keep up to four jobs in flight, the first
  photo first, then rows on screen (`IntersectionObserver`), then the rest; the
  jobs are not gated on roll import, and tile DOM updates are batched once per
  frame. These tiles are provisional camera renderings: they stay
  `data-preview-state="pending"`. During automatic roll import each measured
  frame then gets a converted `analysis` tile from its 900 px sample, rendered
  in a conversion worker without delaying the next decode; the roll commit and
  the canonical lane (`loadStudioThumbnails`, final recipe) replace them, and a
  tile never moves back from `processed` or `analysis` to `embedded`
  (`data-thumbnail-kind` on each tile). CR3, RAF and other non-TIFF containers
  keep their numbered tile until a converted preview exists. Where workers
  cannot decode images (macOS 10.15 WebKit, older WebKitGTK) tiles decode on the
  main thread, one per animation frame.
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
