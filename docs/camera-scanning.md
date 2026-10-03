# Camera scanning: flat field, lab match, multi-shot merge, live loupe

Roadmap items #153, #154, #155 and #156. Negatives photographed with a
digital camera on a light pad bring their own problems: the pad and the lens
fall off towards the corners, the lab's scan looks different from ours, one
shot is noisy or clips a dense frame, and framing and focus are judged
through a viewfinder that shows an orange negative. These four tools address
them inside the Studio, with nothing leaving the browser.

## Flat field (#153)

**Flat field** drawer in the Retouch tab. Shoot one empty frame of the light
source with the same lens, aperture and exposure as the negatives. Then either
open it and press **Use this photo as flat field**, or select the roll and
press **Find blank frame in selection** (`scoreBlankFrame` picks the photo
with no structure and a bright, even tone; a photo that does not look blank
asks for confirmation).

`flatField.js` builds a 64×64 gain map in linear light: 3×3 median and a
±6 % speck suppression remove dust on the pad, two box passes smooth the
rest, and the map is normalised to its 98th percentile so gains are ≥ 1
except for the brightest spot. The map lives in a session registry
(`state.flatFields`) and each photo carries a `flatFieldId`, inherited by
the roll the way the film base is. `silverAdapter.js` applies it in
`_preprocessBuffer` before the film base compensation, in every cache slot
(preview, full, scratch) and in the analysis buffer, so the histogram
analysis sees the flattened frame too. Interactive requests keep the result
as the slot's pristine plane; `forceFullProcess` requests (settle, export,
frame repair) and frames over 16 MP apply it in place on their one work
plane and keep nothing (`docs/silvercore-conversion-cache.md`). The gain is looked up through the
frame geometry (`workingPointToBase`), so rotation and crop keep the map on
the right pixels. `stats.cornerFalloff` and `stats.castSpread` describe the
pad; the status line shows the falloff and how many photos use the map.

Lens vignetting correction and the flat field remove the same falloff; the
drawer warns when both are on.

## Lab match (#154)

**Lab match** drawer in the Edit tab. Pick the lab's JPEG of the same frame
and press **Match**. `imageAlignment.js` aligns it to our conversion (ORB
features on both images brought to a common scale, brute-force Hamming
matching with cross-check, RANSAC homography, a transform sanity check) and
`warpImageData` brings the lab scan onto our pixels. `labMatch.js` then collects pixel pairs (`collectPairs`, skipping
clipped and uncovered pixels) and fits a **look**: a 3×3 colour matrix with
offset, ridge-regularised towards the identity so a near-grey frame keeps its
gain on the diagonal (`fitAffineMatrix`), followed by per-channel
histogram-matched curves (`histogramMatchCurves`, smoothed). When fewer than
400 aligned pairs survive, the curves alone are fitted from the histograms
of the two images (`method: 'histogram'`).

The look is a per-photo setting (`settings.look`, sanitised by
`sanitizeLookForSettings`, identity looks dropped) applied as the last stage
of the 8-bit adjustment pipeline (`pixelAdjustments.js`), so it survives
export and can be pushed to the roll with **Apply look to selected**. The
status reports the inlier count and the mean colour difference before and
after the fit.

## Multi-shot merge (#155)

Batch menu on the photo strip: **Merge selected: average** and **Merge
selected: HDR brackets**, enabled for 2–5 selected photos. The shots are
aligned to the first with the same ORB/RANSAC homography, warped at full
resolution (16-bit when the source carries it), merged in linear light and
written back into the queue as a 16-bit PNG named
`merged-<mode>-<timestamp>.png`, which opens as the selected photo in place
of its sources.

`multiShot.js`:

- `estimateExposureRatio` — a frame's exposure relative to the reference,
  the median luminance ratio over pixels both frames expose well.
- `mergeFrames` — **average** weights every frame equally and, with three
  or more frames, drops the one sample farthest from the median when it is
  more than 25 % off (a speck that moved between shots); **hdr** weights
  each sample by a hat function of its raw value so clipped and noisy ends
  contribute nothing. The result is expressed at the darkest bracket's
  exposure, so anything a frame captured unclipped stays unclipped; the
  conversion's film-base analysis normalises the brightness afterwards.
  `mergeRows` merges a band of rows with the same arithmetic; rows are
  independent, so banding is exact.
- `coverageRect` — trims the wedges a warp leaves along the edges so the
  merged frame is fully covered.

The kernels read two 65,536-entry Float64 tables (`LIN`, the linear value of
every 16-bit sample, and `HAT`, its HDR weight) that hold exactly what the
per-sample interpolation computed, so the rewrite of #260 is bit-identical to
the first implementation (`multiShot.reference.mjs` keeps it for the parity
tests).

### Merge worker (#260)

The page only decodes. Everything else runs in a disposable module worker,
one per merge (`workers/multiShotWorker.js` hosting
`multiShotWorkerProcessor.js`, driven by `app/multiShotWorkerClient.js`),
so a 60 MP merge neither blocks the page nor grows the page's OpenCV heap,
which Emscripten never shrinks:

1. **Page, per selected file:** decode, sample the grey proxy the alignment
   needs (`sampleAlignmentGray`, longest side
   `min(1200, longest side of both frames)`; a reference under 1200 px keeps
   a small copy so it can be sampled again when a larger frame follows), and
   post the frame, transferring the 16-bit plane (or the 8-bit samples when
   the file has none). The page keeps no reference to the plane.
2. **Worker, per frame:** the first frame is the reference; each later one is
   matched (`matchAlignment`: ORB, BFMatcher, RANSAC; a failed match skips
   the frame as before), warped and given its exposure ratio. A 16-bit plane
   is warped alone (`warpPlane16`): only the source and destination 16-bit
   Mats live on the OpenCV heap (16 B/px, 967 MB at 60.4 MP, under the 1 GiB
   cap), where warping the 8-bit image alongside needed 24 B/px and failed
   above about 44 MP. 8-bit sources keep the 8-bit warp and ×257 widening.
3. **Worker, merge and encode:** `coverageRect`, then `mergeRows` in 64-row
   bands with a progress message per band, then the export worker's
   `encodePng16Blob(out, rect.width, rect.height, pako)`. The #257 band encoder
   takes the pako module: decoded samples are unchanged, but compressed bytes
   differ from the pre-band encoder at 1703835. The Blob crosses back
   without a copy; the page adds the sRGB iCCP chunk with
   `attachMetadataToBlob` and queues the file.

The worker posts progress after each stage (align, warp, exposure, each
merge band, encode); the progress modal shows the stage and a fraction and
has a **Cancel** button, which terminates the worker and releases the Studio
at once. It also aborts the current decode through its signal, disposing the
LibRaw, post-decode and HEIF workers, or withdraws a reservation still waiting
for memory. Ordinary JPEG/PNG browser decodes also receive the signal: an
`<img>` decode releases its URL and handlers, and a late `ImageBitmap` is closed
without copying its pixels or starting a fallback. The native bitmap API
cannot interrupt a decode already executing inside the browser: its memory
reservation stays held until that decode settles, even though Cancel has
already closed the merge UI. The merge
worker is terminated after the result, on any failure and on Cancel, which
releases its heap and planes.

Failures are classified before they leave the worker: OpenCV.js throws C++
exceptions as numeric pointers, readable only through
`cv.exceptionFromPtr(ptr).msg` in the realm that owns the heap. `StsNoMem`
("Insufficient memory", "Failed to allocate"), a `RangeError` from an
allocation and a worker crash or silence are memory failures and show the
`multiShotMemory` alert; OpenCV failing to load shows `multiShotOpenCv`;
anything else is logged and shows `multiShotFailed`. If the module worker
cannot start at all (no handshake), the same processor runs on the main
thread with the page's OpenCV, yielding between merge bands.

Memory at 60.4 MP (estimate): each stored frame is a 483 MB plane, plus the
output and the worker's idle heap — about 3.0 GB for 3 frames, 4.0 GB for 5
(`estimateMultiShotWorkerBytes`). A merge is refused up front when that does
not fit the renderer's memory budget minus retained bytes. One user
reservation covers the entire estimate from before the first decode through
worker disposal; posting a frame does not release its accounting.

Test hook: a `fault: 'warp-memory'` field in the worker's `start` message
makes the next warp request an over-cap Mat, a genuine OpenCV `StsNoMem`
pointer; the camera smoke uses it to check the alert, the released UI and
the terminated worker.

## Live loupe (#156)

**Live loupe** button in the header (shown when the browser can open a
camera). The camera feed is converted continuously at 640 px through the
current photo's recipe — film base, preset, colour controls and look,
without its geometry, strokes, flat field or roll lock — or, before any
photo is converted, through the automatic defaults for the camera frame
itself. That makes focusing and judging exposure possible on a positive
image instead of an orange negative. The conversion uses the adapter's
`scratch` cache slot, so the open photo's preview and export caches are
untouched.

How it runs (#261):

- **Paced by the camera.** `video.requestVideoFrameCallback` drives it:
  each presented camera frame converts at most once, one at a time; when a
  conversion ends, the newest frame converts at once and the ones in
  between are dropped. Without the API, or without a callback within
  200 ms of a playable video, display frames thinned to the track's frame
  rate (30 if unknown) drive it instead. Switching from raw to converted
  re-arms the 200 ms check, since hiding the video can stop callbacks in
  some engines. The first presented frame announces Live in either view.
- **Off the main thread.** The loupe has its own conversion worker
  (created when it opens, released when it closes, so the editor's
  preview worker keeps its cached source). The worker runs the router and
  then the adjustment stage with prepared settings
  (`pipeline/adjustedFrame.js`, shared with the main-thread fallback) and
  returns the 8-bit frame; the frame's pixels are transferred, not copied.
  The main thread only grabs (`drawImage` + `getImageData`) and paints.
  If the worker cannot start, crashes or times out, the loupe converts on
  the main thread for the rest of the session.
- **Recipe built once.** Router settings and prepared adjustments are
  built when needed and rebuilt when an edit bumps the edit revision (the
  panel, the C/M/Y/D/N keys, undo/redo), when "hold to see before",
  the photo, the step or the frame size changes, and at most once a
  second otherwise. The automatic recipe's film type and base therefore
  follow the camera once a second instead of every frame; auto levels
  still follow every frame (the analysis stays inside the conversion).
  The worker keeps the recipe until it changes.
- **Show raw** neither grabs nor converts; the canvas keeps the last
  converted frame, and switching back converts the newest one at once.

Controls: camera selection, zoom and torch where the track offers them
(`MediaStreamTrack.getCapabilities`), **Show raw** to see the feed itself,
and **Capture to photos**, which takes a still (`ImageCapture.takePhoto`
where supported, otherwise the video frame at stream resolution) and adds it
to the photo list as `loupe-<timestamp>.png`. Closing the loupe opens the
capture when no photo was open. Escape closes; the stream is stopped on
close and on page hide.

## Tests

- `flatField.test.mjs`, `imageAlignment.test.mjs`, `labMatch.test.mjs`,
  `multiShot.test.mjs` — unit tests (`npm test`).
- `scripts/camera-smoke.mjs` (`npm run test:smoke -- --camera-only`) —
  flat field from a blank pad frame (corner deviation 0.40 → 0.02), lab
  match against a warmer, cropped, downscaled copy of the preview, average
  merge of three noisy shifted shots (grain 7 → 4) plus an HDR bracket pair,
  and the loupe against Chrome's fake camera (launch flags
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`):
  conversions in the loupe's worker, no more than the presented camera
  frames, the automatic recipe at most once a second, Show raw idle, the
  C key and Ctrl+Z reaching the loupe within two frames, and no loupe
  worker or track left after closing it (`?debugCounters=1`).
- `conversionWorker.test.mjs` — a 640×360 frame and recipe give
  byte-identical RGBA in the worker and on the main thread (colour, B&W,
  positive); `liveLoupe.test.mjs` runs the real loop from `main.js`
  against a scripted camera (pacing, raw view, recipe rebuilds, worker
  release and fallback).
- Fixtures come from `node scripts/make-camera-fixtures.mjs`.
