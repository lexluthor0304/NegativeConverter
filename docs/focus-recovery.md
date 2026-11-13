# Focus recovery

A slider on the Retouch tab (Cleanup → **Focus recovery**, 0–100, off by
default) for photos shot slightly out of focus. It is a deconvolution, not a
sharpening: the frame's own excess blur is estimated and a share of it is
undone, on the luminance, on the GPU.

Code: `render/focusRecovery.js` (the estimate, the plan, the WebGL2 kernel and
its JavaScript reference), `app/focusStage.js` (the editor's stage), and the
few places `main.js` reads `focusStage`.

## What it does

1. **Estimate** (`estimateFocus`). At an edge blurred by σ, the gradient of
   the frame smoothed at scale s falls as 1/√(σ² + s²). The gradient at two
   scales (1.5 and 3 px), at the strongest 0.3 % of the edges, gives
   σ² = (s₂² − R² s₁²) / (R² − 1) with R the median ratio. It is read on up
   to twelve 384 px patches of the frame's interior (15–85 %): on an
   uncropped scan the film's border is the sharpest edge and says nothing
   about the focus. The same patches give the fine grain: the spread of the
   frame less itself smoothed at 2 px, in the calmest quarter of them.
2. **Plan** (`focusPlan`). No frame is sharper than its film, lens and scan
   allow: 0.042 % of the short side (2.6 px at 60 MP on 35 mm), at least
   1 px. Only the blur beyond that baseline counts (σ² less the baseline's),
   and the slider takes its share of it, capped at 5 px; below 0.6 px there
   is nothing worth undoing and the frame is left as it is. The damping is
   three grains, between 6 and 20 grey levels of 255.
3. **Recovery.** Twenty Richardson-Lucy iterations with that Gaussian. Each
   multiplies the estimate by the blurred ratio of the frame to the blurred
   estimate; the ratio's distance from one is scaled by
   min(|frame − blurred estimate| / damp, 1)², so differences the size of the
   grain are left alone. The grain was never blurred (it lies on the film),
   and undamped iterations turn it into worm-like clumps. R, G and B are
   scaled by the luminance's gain, so colour stays.

## Why the GPU, and only the GPU

Twenty iterations are eighty separable convolutions over the frame. At 60 MP
one CPU thread takes about 100 s (1.7 s per megapixel, measured in Node);
WebGL2 takes about 2 s (Chrome, ANGLE on Metal, M5 Pro: 2.2 s for 59 MP in 8
bits, 3.5 s from the slider's release in the editor at 16 bits, estimate
included). A CPU path at a minute and a half per photo would not be used, so
there is none: `createFocusRecoverer().supported` needs WebGL2 with
`EXT_color_buffer_float` and textures of 2176 px; without them the slider is
disabled and says why, and a batch file that asks for recovery fails with
that message instead of exporting something else.

This is the one place where the GPU produces exported pixels
(`gpu-preview.md`: the CPU engine is otherwise the only producer of settled
and exported frames). What keeps that honest:

- **The same tiles everywhere.** The frame is cut into tiles of 2048 px with
  a 64 px halo (`focusTiles`), whatever the device's texture limit, so the
  tiling never changes a result. Across a tile border the result equals the
  untiled reference within one least significant bit.
- **A reference.** `recoverFocusReference` is the shaders' arithmetic in
  JavaScript, in Float32. `focusRecovery.test.mjs` tests it in Node; the
  smoke's focus module (`scripts/focus-recovery-smoke.mjs`, `--focus-only`)
  compares the GPU with it in the browser, 8 and 16 bits: at most one least
  significant bit apart. Different GPUs may round that last bit differently;
  an export with focus recovery is therefore not guaranteed byte-identical
  between machines, as every other export is.
- **Integer in, integer out.** The tile is uploaded as RGBA16UI (or RGBA8UI)
  straight from the frame's plane (`UNPACK_ROW_LENGTH`), the iterations run in
  R32F, and the last pass writes RGBA16UI read back into the new plane
  (`PACK_ROW_LENGTH`). The input frame is never written.

## The stage (`focusStage.js`)

The repaired frame stays `state.processedImageData`: it is the dust input, the
brush's target and what history and photo sessions hold. The recovered frame
is derived from it and kept by the stage as `{ source, revision, strength,
frame }`; it is current while the editor's frame is `source`, the pixel
revision (`convertedPixelsRevision`: strokes patch the repaired frame in
place) and the strength are the same. Readers ask `focusStage.sourceOf(frame)`:

| reader | where |
|---|---|
| display preview | `buildPreviewSourceImageData`, `rebuildDisplayPreview` |
| detail layer (zoom) | `detailFullFrame`; with recovery on it crops the recovered frame and is hidden until that is ready |
| single export | `getCurrentExportImageData`, the fused 16-bit encode, the gain map's source; `focusStage.ensureForExport()` is the barrier |
| batch export, contact sheet | `processFileWithSettings`, after the repairs and the measurements, before Step 3 (`focusStage.recoverFrame`); such a frame is not kept resident in the band pool |

A new processed frame, a restored one, a stroke's patch and an undo of the
slider call `noteSourceChanged` or `schedule`; the run waits for pending
repairs, asks for the full-resolution frame when the editor holds only a
display-size conversion (as dust detection does), and drops a result that was
overtaken. The slider recomputes when it rests, not while it moves.

The setting is `focusRecovery` in the photo's recipe, the photo's own like its
crop and its dust removal: never inherited from the photo on screen
(`perPhotoSettingsFallback`), not copied by Sync color, processing settings or
a roll reference.

## Measured (2026-11-13)

The owner's roll of 38 Leica frames at 60 MP: the sharp frames read 2.5–3.0 px,
six soft ones 4.2–6.2 px.

- A uniformly soft frame (a window grille) comes back: its bars become thin
  lines. Unsharp masking at the same radius adds contrast and halos and leaves
  them wide.
- Defocus changes with depth, and one blur for the whole frame over-sharpens
  what was in focus: at 100 % a bright rail in one frame got a double line. At
  50–70 % the three frames tried had none, hence the hint to start at 60.
- Fine grain grows 1.4–1.9 times at 100 %.
- On a clean scene with real grain added, error against the clean scene falls
  for a blur the scan added (edges 29.0 → 34.6 dB at a 3 px disc) and rises a
  little for a blur under sharp grain: what is recovered is the picture's
  edges, at the price of the grain.

## Known limits

- One blur per frame. A photo with a sharp subject and a soft background is
  read by its sharpest edges and little is undone; one with a soft subject and
  sharper surroundings likewise. There is no depth map.
- Not for missed focus: past about 5 px of excess blur the recovery stops
  short (the cap), and what is gone is gone.
- The recovered frame of the open photo is a second full-resolution frame
  (480 MB at 60 MP in 8 bits, 1.4 GB with its 16-bit plane) that the memory
  ledger does not count yet (`audit-backlog.md`).
- Tiles, the filmstrip thumbnail and reduced previews do not show it: at their
  size there is no blur left to undo.
- A batch in a hidden window (macOS) runs it on the page's WebGL context,
  which the system may throttle or drop; a lost context fails that file.
- Other GPUs, WKWebView and iPhone were not measured.
