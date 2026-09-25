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
   `encodePng16Blob(data, w, h, pako.deflate)`. The Blob crosses back
   without a copy; the page adds the sRGB iCCP chunk with
   `attachMetadataToBlob` and queues the file.

The worker posts progress after each stage (align, warp, exposure, each
merge band, encode); the progress modal shows the stage and a fraction and
has a **Cancel** button, which terminates the worker and releases the Studio
at once (a decode still running finishes unobserved and is dropped). The
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
not fit the renderer's memory budget (#258 supplies the budget; until then
the failure is reported when it happens).

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
  `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`).
- Fixtures come from `node scripts/make-camera-fixtures.mjs`.
