# Audit backlog

Findings from the 2026-09-03 repository audit that were reviewed and left
unfixed. Each was produced by a lensed finder over the source and, where a
`verified` marker appears, confirmed by three independent reviewers reading the
cited code. They are ordered by severity within each area.

Items already fixed are not listed. This file is a work queue, not a record of
what shipped — delete an entry when it is done.


## Auto frame detection

- **medium/ux** — Non-sprocket density templates are capped at 0.68 < highConfidence 0.72, so 'high' confidence and the 'Auto-apply high confidence' setting are unreachable for 120 film and most single 135 frames _(verified)_  
  `negative2positive/src/app/autoFrameAnalyzer.js:1236`  
  Every density-template candidate that is not from the sprocket loop has its confidence clamped to 0.68 (line 1236), while inferAutoFrameConfidenceLevel (line 1311-1316) needs >= 0.72 for 'high'. Density templates are the winning method on lightbox scans (the OpenCV contour/Hough path rarely produces a valid quad on a soft-edged negative), so 120 scans and single-frame 135 scans always land on 'med…  
  _Suggested fix:_ Either raise the non-sprocket cap above the 'high' threshold when strongImageWindow holds (e.g. 0.74 for strong, 0.68 for moderate) or lower highConfidence to 0.66 for density-template results; alternatively surface in the UI that auto-apply only triggers for sprocket-lane detect…

- **low/test** — autoFrameAnalyzer test covers 1 of 5 exports; three pure exports and the confidence classifier are untested and the caller re-declares the analyzer's constants _(verified)_  
  `negative2positive/src/app/autoFrameAnalyzer.test.mjs:5`  
  Only getAutoFrameAspectTargets is tested. `inferAutoFrameConfidenceLevel` (:1311, the 0.72/0.55 classifier that round 1 found duplicated three times), `buildDensityAnalysis` (:276) and `scoreDensityRect` (:518) contain no OpenCV references between lines 276-560 and run in plain Node, yet have no tests. main.js:116-130 re-declares DEFAULT_FORMAT_RATIOS/DEFAULT_120_FORMATS/DEFAULT_SCORE_WEIGHTS verb…  
  _Suggested fix:_ Export DEFAULT_FORMAT_RATIOS/DEFAULT_120_FORMATS/DEFAULT_SCORE_WEIGHTS from the analyzer, import them in main.js and the test. Add tests: `inferAutoFrameConfidenceLevel` at 0.72/0.719/0.55/0.549 and with custom thresholds; `buildDensityAnalysis` on a synthetic dark frame inside a…


## Dust removal

- **high/perf** — Dust detection and TELEA inpainting run synchronously on the main thread at full resolution, retriggered every 300 ms while dragging the strength slider  
  `negative2positive/src/app/main.js:5033`  
  runDustDetection (5010-5045) calls detectDust/updateDustStrength and then inpaintMasked synchronously on getDustSource() (4981-4983 = cleanSource || processedImageData, i.e. the full-resolution positive once the background render has landed). detectDust → computeHatResponses (DustRemoval.js 206-220) builds a full RGBA Mat, cvtColor, and two 9×9 ellipse morphologyEx passes; buildDustMask (244-324) …  
  _Suggested fix:_ Run detection on the preview-resolution positive (dustMaxParticleSizeFor at 4989 already scales the size cap for that) and only inpaint full-res once on commit; better, move detectDust/inpaintMasked into a worker that loads opencv.js (it is already a plain module with no DOM use …

- **medium/perf** — 除塵ブラシの修復はまだ画像全体を走査する  
  `negative2positive/src/app/main.js` / `negative2positive/src/silvercore/engine/DustRemoval.js`  
  2026-09-05に筆跡ごとのSilverCore再変換を廃止。追加改善では、inpaintを全マスクの外接矩形＋近傍余白に限定し、スマートブラシのグレースケール化も筆跡領域に限定した。空マスクはOpenCVを呼ばずに原画像を複製する。ただし、マスク作成・範囲探索・出力の複製・粒子数集計は画像全体に比例し、広範囲のマスクは全画面inpaintへ戻る。  
  _次の改善案:_ 離れたマスクを連結成分に分けて処理するか、検出・集計をWorkerへ移す。修復領域が互いに近い場合の影響と、追加・削除・取り消しの画素一致を検証する。

- **medium/bug** — Thin real content (power lines, antennas, masts, fence wire, thin branches against sky) is classified as a 'scratch' and inpainted: any line up to 60 % of the short side and <= max(3, maxSize/3) px thick is kept with no area cap  
  `negative2positive/src/silvercore/engine/DustRemoval.js:197`  
  classifyDustBlob keeps every blob whose long side exceeds maxSize as long as area/longSide <= max(3, maxSize/3) and longSide <= 0.6*min(W,H); the DUST_MAX_AREA_RATIO guard is bypassed on that branch. On a 6000x4000 scan (maxSize 64 -> thickness limit 21 px) a probe shows: 2000x8 px line keep=true, 2300x20 px line keep=true (46,000 px = 0.19 % of the frame), 1500x21 keep=true; only a 2401 px line i…  
  _Suggested fix:_ Make scratch removal opt-in (separate 'remove scratches' toggle, default off) and, when on, require evidence specific to film scratches: response in BOTH top-hat and black-hat along the blob (the comment already notes real scratches do both, a wire is dark-only), a much smaller t…

- **medium/ux** — Dust brush is wired to mouse events only, so painting a dust mask is impossible on touch devices  
  `negative2positive/src/app/main.js:5419`  
  The brush uses `mousedown` on the canvases and `mousemove`/`mouseup` on document. Touch input only synthesises a single `mousedown`/`mouseup` pair at tap time (and Chrome emits at most one `mousemove`), so a finger drag never produces a stroke; additionally, without `touch-action:none` the drag scrolls/rubber-bands instead. Brush size adjustment is Ctrl+wheel only (5425-5437). Scenario: iPad user …  
  _Suggested fix:_ Convert the brush to pointer events (`pointerdown` with `setPointerCapture`, `pointermove`, `pointerup`/`pointercancel`) and set `touch-action: none` on the canvas while `state.dustRemoval.showMask` is true; the brush-size slider already exists (`#dustBrushSize`) so no extra UI i…

- **low/bug** — RAW error classification shows the 'not supported in this Safari version' message on any browser for any error containing 'worker', while the real module-worker failure path is unreachable  
  `negative2positive/src/app/main.js:5705`  
  `isRawSupportIssue` is true for any RAW-like file whose error text matches `/module worker|worker|webassembly|wasm/i`, so 'Conversion worker crashed', 'Sensor defect worker crashed' or a wasm OOM ('RuntimeError: ... wasm') on Chrome/Firefox/Android produces 'RAW decode is not supported in this Safari version. Update Safari (iOS 16.4+) or convert to TIFF/JPEG first.' Conversely the intended trigger…  
  _Suggested fix:_ Feature-detect up front instead of parsing messages: `const supportsModuleWorkers = (() => { let s = false; try { new Worker('data:,', { get type() { s = true; return 'module'; } }).terminate(); } catch {} return s; })()` plus `typeof WebAssembly === 'object'`; show `rawUnsupport…

  `negative2positive/src/app/main.js:5657`  
  _Suggested fix:_ Delete the three fields and their assignments, and document that __image16 attached to the ImageData is the single source of 16-bit data.

- **low/quality** — suggestStep2Mode's orangeBias > 10 test is not a border detector: any C-41 scan returns 'border', so 'noBorder' is only ever suggested when a crop already exists  
  `negative2positive/src/app/main.js:5794`  
  autoDetectFilmBase samples the outer band (filmBaseDetection.js:289-297: edgeBand = borderBufferPct % of the short side, samples centred at half that band) and the caller treats an orange result as proof of a visible film rebate. But the darkest content of any colour negative is orange too. Probe: a 600x400 synthetic C-41 frame with no rebate at all (content R120-230/G60-150/B30-90) -> autoDetectF…  
  _Suggested fix:_ Decide border vs no-border from a real border signal: compare the edge-band estimate with an interior-grid estimate (autoDetectFilmBase with bufferPct 0 already computes both); suggest 'border' only when the edge band is both brighter (thinner) and lower-spread than the interior …

- **low/ux** — runDustDetection ignores ensureOpenCvReady's boolean result, unlike every other call site  
  `negative2positive/src/app/main.js:5018`  
  createOpenCvLoader's ensureOpenCvReady resolves false (never throws) when all OpenCV sources fail (opencvLoader.js:157-171). The other four call sites check `const ready = await ensureOpenCvReady()` (7077, 7343, 7419) and bail with a message; runDustDetection discards the value and proceeds into detectDust, which throws an internal error (e.g. 'cv is undefined') that is shown raw and unlocalized v…  
  _Suggested fix:_ `const ready = await ensureOpenCvReady(); if (!ready) { updateDustStatusUI(getLocalizedText('opencvUnavailable', ...)); state.dustRemoval.processing = false; return; }` and use a localized key for the generic error status.


## App runtime (main.js)

- **medium/a11y** — Crop/straighten and the curve editor are pointer-only; no keyboard path exists  
  `negative2positive/src/app/main.js:8106`  
  Crop handles are empty <span>s with no tabindex/role; resizing is hit-tested from pointer coordinates (getHandle returns 'nw' etc. from nearLeft/nearTop) inside canvasContainer mousedown/pointerdown/touchstart handlers. Straightening additionally requires Cmd/Ctrl+drag. The RGB curve editor is a <canvas> with only mouse/pointer/dblclick listeners and no fallback text or numeric inputs. The global …  
  _Suggested fix:_ While state.cropping, handle Arrow keys (move 1px, Shift+Arrow 10px) and Alt+Arrow (resize) in the existing keydown block, and give the crop overlay tabindex="0" role="application" with an aria-label explaining the keys; optionally expose crop x/y/w/h as four number inputs in the…

- **medium/bug** — Lens numeric input formatter strips trailing zeros from integers ("10" becomes "1") and the blur handler re-parses the corrupted text into state  
  `negative2positive/src/app/main.js:6279`  
  bindLensNumericParamInput formats with `String(Number(value).toFixed(decimals)).replace(/\.?0+$/, '')`. With decimals=0 (lensStepInput, range 1-16) the regex has no decimal point to anchor to and removes trailing zeros from the integer itself: 10 -> "1". Because the same handler is bound to both `change` and `blur`, the blur pass reads the displayed "1" and writes params.step = 1. Verified: node -…  
  _Suggested fix:_ Only strip zeros after a decimal point: `.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')`, or skip the strip entirely when decimals === 0. Bind the handler to `change` only (change already fires on blur for text/number inputs).

- **medium/bug** — Slider numeric text input pushes its undo snapshot after the value was applied and on every blur  
  `negative2positive/src/app/main.js:6716`  
  Typing into a slider's value box applies each keystroke via the `input` handler (state mutated, no undo). On blur/Enter commitFromInput() calls pushUndo(stateKey) *after* the mutation, so the snapshot equals the current state and undo is a no-op. It also pushes unconditionally, so merely focusing and leaving a value box adds a junk undo entry and clears the redo stack.  
  _Suggested fix:_ Capture `preEditSnapshot = captureSnapshot(stateKey)` on `focus` of valueInput, and in commitFromInput push it only when the committed value differs from the snapshot's value; reset it to null afterwards (same pattern as preDragSnapshot).

- **medium/bug** — applyAutoFrameToSelected discards the current file's unsaved adjustments  
  `negative2positive/src/app/main.js:7451`  
  The batch builds each item's settings from item.settings (last persisted) or createDefaultSettings(), never from live state, sets item.isDirty = false, and finally calls restoreSettings(currentItem.settings). For the current file that overwrites every live adjustment with the stale persisted copy — or, if the file was never saved, with factory defaults (film type, film base, all sliders). switchTo…  
  _Suggested fix:_ Call persistCurrentFileSettings({ silent: true }) before the loop, or for `item === getCurrentQueueItem()` seed `existing` from extractCurrentSettings() instead of item.settings.

- **medium/bug** — Auto Frame Selected stores createDefaultSettings as the file's saved settings, so auto-framed unviewed files skip the automatic gray point and keep a film base sampled before the crop  
  `negative2positive/src/app/main.js:7451`  
  applyAutoFrameToSelected builds `existing = createDefaultSettings(imageData)` for files without settings and assigns it to `item.settings`. That snapshot has wbR/wbG/wbB = 1, grayPointSampled false and no wbAutoConfidence, and its filmBase was measured by `autoDetectFilmBase(imageData, 10)` on the unrotated, uncropped decode — the border the auto-frame is about to crop away is sampled as if it wer…  
  _Suggested fix:_ Replace the `!savedSettings` gate with a provenance check: run auto-WB when `!settings.grayPointSampled && !settings.wbAutoConfidence && wbR/wbG/wbB are identity`, and run/refresh autoDetectFilmBase in processFileWithSettings when the snapshot carries `filmBaseSet: false` (or an …

- **medium/bug** — Single-finger pan at zoom > 1 and double-tap zoom rely on preventDefault in pointerdown, which does not stop the browser's touch pan/zoom gestures (touch-action is only set in crop mode)  
  `negative2positive/src/app/main.js:7931`  
  `.canvas-container` has no `touch-action` in CSS; main.js sets `touchAction = 'none'` only while cropping (7931). Outside crop mode the touch pan path (8387-8404) calls `e.preventDefault()` on `pointerdown`, but per the Pointer Events spec that only suppresses compatibility mouse events; it does not prevent the browser from claiming the touch for scrolling/rubber-banding, after which the browser f…  
  _Suggested fix:_ Set `touch-action: none` on `.canvas-container` whenever an image is loaded (or at least `pinch-zoom` when zoom==1 and `none` when zoom>1 / sampling / crop), e.g. in `applyZoomPanTransform`/`showImageUI`. Implement double-tap detection on pointer events (two `pointerup`s within 3…

- **medium/bug** — Batch film-base detection samples the unrotated, uncropped decode with a fixed 10% border buffer, while the interactive path samples the cropped frame with the Step-2 heuristic (buffer 0 for borderless scans)  
  `negative2positive/src/app/main.js:9472`  
  Interactive Step 2 calls `autoDetectFilmBase(state.croppedImageData || state.originalImageData, state.coreBorderBuffer)`. goToStep(2) and every rotate/crop call setStep2Mode(suggestStep2Mode()), which returns 'noBorder' whenever a crop exists or the edge band shows no orange bias, and 'noBorder' sets coreBorderBuffer = 0. In filmBaseDetection.autoDetectFilmBase a buffer <= 0.5 disables the border …  
  _Suggested fix:_ Move film-base detection out of createDefaultSettings into processFileWithSettings after rotation/crop/lens, and reuse the Step-2 heuristic: compute `mode = suggestStep2ModeFor(workingData, cropRegion)` (extract suggestStep2Mode into a pure function taking the image and crop), se…

- **medium/bug** — Frontier guide defaults (colorModel 'frontier' + 'frontier-lab' preset) are applied to every interactive first conversion but never to unviewed batch files  
  `negative2positive/src/app/main.js:9478`  
  processNegative awaits maybeApplyFrontierGuideDefaults(), which on the first conversion of a colour negative whose model/preset are still 'standard'/'none' switches coreColorModel to 'frontier' and applies the 'frontier-lab' preset (writing coreEnhancedProfile, coreSaturation, coreGlow, coreFade, coreShadows, coreHighlights, coreBlacks, coreWhites from the preset). createDefaultSettings returns `c…  
  _Suggested fix:_ Factor the guide default into a pure `applyFrontierGuideDefaults(settings)` that returns the modified settings (model + preset values from loadFilmPresets) and call it both from maybeApplyFrontierGuideDefaults (on state) and from processFileWithSettings when no snapshot exists (o…

- **medium/bug** — Dust removal is global session state, not per-file settings: batch applies the current toggle to every file and re-detects from scratch, discarding manual brush edits that single export keeps  
  `negative2positive/src/app/main.js:9576`  
  extractCurrentSettings/deepCopySanitizedSettings carry no dust keys. processFileWithSettings reads `options.dustRemoval || state.dustRemoval` (enabled, strength, maxParticleSize) and always runs a fresh `detectDust` + `inpaintMasked`. Interactively the mask is refined by brush strokes (refineMaskDirect / refineMaskRemove on state.dustRemoval.mask) and the inpainted result is what displayImageData/…  
  _Suggested fix:_ Add `dustRemoval: { enabled, strength, maxParticleSize }` to sanitizeSettings/deepCopySanitizedSettings/restoreSettings and read it from `settings` in processFileWithSettings (fall back to state only for files without a snapshot). For the current file, reuse `state.dustRemoval.ma…

- **medium/bug** — Clear list + Add files leaves currentFileIndex pointing at a file that is not the one displayed, so edits/settings persist into the wrong queue item  
  `negative2positive/src/app/main.js:10569`  
  clearFileListBtn empties the queue and sets currentFileIndex = 0 but keeps the loaded image on screen. openAddFilesPicker then appends files and only loads one `if (!state.originalImageData ...)` — which is false — so nothing is loaded. Now getCurrentQueueItem() returns the first newly added (never loaded) file: the 'Current File' label shows its name, markCurrentFileDirty flags it on every slider…  
  _Suggested fix:_ Either keep the displayed image as a queue entry when clearing (clear everything except the current item), or set `state.currentFileIndex = -1` after clearing and make openAddFilesPicker load the first added file when the index is invalid; guard persistCurrentFileSettings/markCur…

- **medium/bug** — Resizing/rotating the viewport at Step 3 clears the WebGL preview to black until the next slider move  
  `negative2positive/src/app/main.js:10772`  
  The window resize handler calls `adjustCanvasDisplay(canvas.width, canvas.height)`, which (line ~5453) calls `resizeWebGLCanvas()` when WebGL is active. `resizeWebGLCanvas` assigns `glCanvas.width/height` when the CSS size changed (4130-4131); assigning a canvas's width/height attribute discards the drawing buffer, and the context was created with `preserveDrawingBuffer: false` (3861). Nothing re-…  
  _Suggested fix:_ In the resize handler, after `adjustCanvasDisplay(...)`, call `if (isWebGLActive()) schedulePreviewUpdate();` (or have `resizeWebGLCanvas` set a `webglState.needsRedraw` flag consumed by a rAF that calls `renderWebGL()`). Also listen to `window.visualViewport` `resize` for iOS to…

- **medium/memory** — syncTransformCanvasFromMainCanvas copies the full-res canvas into a canvas nobody reads, on every full render and export _(verified)_  
  `negative2positive/src/app/main.js:3110`  
  transformCanvas/transformCtx are created at 2500-2501 and written by syncTransformCanvasFromMainCanvas (called from updateFullCpu 4432, ensureFullRender 4519 and displayNegative 5575) but are never read anywhere in main.js. Each call resizes the canvas to the full image size and blits the whole main canvas into it, so a 90 MP scan keeps an extra ~360 MB backing store alive for the session and pays…  
  _Suggested fix:_ Delete transformCanvas, transformCtx, syncTransformCanvasFromMainCanvas and its three call sites (4432, 4519, 5575).

- **medium/memory** — Desktop batch ZIP accumulates every encoded file in memory in JSZip and DEFLATEs already-compressed images  
  `negative2positive/src/app/main.js:9690`  
  exportBatchAsZipDesktop calls `zip.file(name, blob)` for every frame and only writes at the end via generateAsync, so peak memory is the sum of all exported files (a 36-frame roll of 16-bit TIFFs at 300 MB each = 10.8 GB) plus the generated archive plus the base64 IPC copy. `compression: 'DEFLATE', level 6` re-compresses PNG/JPEG/deflated data — CPU cost of minutes for no size gain, and the whole …  
  _Suggested fix:_ On desktop write each frame directly to the chosen directory via write_export_file_to_directory (streamed, see previous finding) or build the ZIP incrementally in Rust (zip crate, Stored method) by pushing entries one at a time; at minimum switch JSZip to `compression: 'STORE'` a…

- **medium/quality** — main.js refactor map: 10,779 lines decompose into ~20 cohesive blocks; six can be extracted with almost no coupling _(verified)_  
  `negative2positive/src/app/main.js:76`  
  Blocks by line range (section headers at the `// =====` markers): perf/debug scaffolding 76-135; auto-frame constants 115-135; i18n/language 237-345; guide mode + Frontier guide popup 345-634; SP3000 correction console 634-783; feedback popup 783-972; lens correction (Lensfun loader, map sampling, applyLensCorrectionWithSettings, search UI) 972-1505 + 6129-6324; desktop update check + MAS banner 1…  
  _Suggested fix:_ Extract in the order (c) desktopBridge → (a) desktopUpdate → (b) feedbackPopup → (f) batchExport → (d) lensCorrection → (e) webglPreview, each as an ES module that receives `{ state, i18n helpers, showToast }` via an init function rather than reaching into module globals. Wrap th…

- **medium/quality** — Settings schema is hand-enumerated in five places; adding one adjustment requires five coordinated edits _(verified)_  
  `negative2positive/src/app/main.js:1858`  
  The same ~45 scalar setting keys are listed by hand in: the `state` literal (1858-2044, 92 keys), SNAPSHOT_SCALAR_KEYS for undo (2259-2271), sanitizeSettings (3251-3358; 54 `source.x` reads with per-key clamps), createDefaultSettings for batch items (9471-9531) and restoreSettings (10199-10326, one `state.x = safe.x` line per key), plus a sixth partial list in undoLabelMap (2190-2251, in three lan…  
  _Suggested fix:_ Introduce `app/settingsSchema.js` exporting a table `{ key: { default, min, max, kind: 'number'|'enum'|'bool', undoLabelKey, snapshot: true } }`. Derive `createDefaultSettings`, the scalar part of `sanitizeSettings`, SNAPSHOT_SCALAR_KEYS and the scalar assignments in `restoreSett…

- **medium/quality** — Step-3 adjustment math is maintained three times: GLSL shader in main.js, CPU path in pixelAdjustments.js, and (partially) in ImageProcessor.js _(verified)_  
  `negative2positive/src/app/main.js:3900`  
  The preview shader (main.js:3900-3947 hue2rgb/rgbToHsl/hslToRgb; 3956-3999 exposure→contrast→highlights/shadows→temp/tint→HSL sat/vibrance→CMY→curves) is a hand transliteration of workers/pixelAdjustments.js (hue2rgb 6-13; per-pixel stages 127-237). ImageProcessor.js carries a third hue2rgb (373-380) and a third RGB↔HSL round-trip (309-364). Verified drift today: the CPU *preview* quality path (pi…  
  _Suggested fix:_ (1) Export hue2rgb/rgbToHsl/hslToRgb once from a `colorMath.js` and import it in both pixelAdjustments.js and ImageProcessor.js. (2) Move the fragment shader into `render/adjustmentShader.glsl.js` next to a small table of stage constants (TEMP_TINT_GAIN=0.3, LUMA coefficients, co…

- **medium/quality** — Four copy-pasted batch-export loops (ZIP desktop, ZIP browser, individual desktop, individual browser)  
  `negative2positive/src/app/main.js:9639`  
  exportBatchAsZipDesktop (9639-9724), exportBatchAsZipBrowser (9726-9872), exportBatchIndividuallyDesktop (9926-10040) and exportBatchIndividuallyBrowser (10042-10130) each re-implement: item.status='processing' → updateFileListUI → progress → getSettingsForExport → processFileWithSettings → applySprocketFrameForExport → imageDataToBlob → sink → status 'done'/'error' with `console.error(`Error proc…  
  _Suggested fix:_ Extract `app/batchExport.js` with one `runBatchExport(jobs, { prepare, sink, progress })` driver that owns the loop, status bookkeeping and error capture; implement the four variants as ~15-line sink/progress adapters. Keep `processFileWithSettings` as the per-item pipeline.

- **medium/ux** — Loading overlay's cancel button is never enabled and hard-codes 'Cancel'; long batch exports cannot be cancelled from the UI _(verified)_  
  `negative2positive/src/app/main.js:4909`  
  LoadingOverlay.show() supports { cancelable, onCancel, cancelText } but every one of the seven overlay.show() calls in main.js passes only { title }, so the cancel button is permanently display:none. The default label is the English literal 'Cancel' even though i18n defines loadingCancel/loadingCancelled in all three languages (never referenced). Result: a multi-file ZIP export (exportBatchAsZipDe…  
  _Suggested fix:_ For the batch/ZIP export paths pass { title, cancelable: true, cancelText: lang.loadingCancel, onCancel: () => { cancelRequested = true; } } and check cancelRequested inside the per-file loops (the loops already support cancelledByUser); show showToast(lang.loadingCancelled) on a…

- **medium/ux** — Film-base / gray-point sampling has no touch flow: a tap samples immediately and the loupe is positioned under the finger  
  `negative2positive/src/app/main.js:6497`  
  The loupe is driven by `pointermove`/`pointerdown` and hidden on `pointerleave`/`pointercancel` (6497-6502); the actual sample is taken on `click` (6573-6574). On touch the sequence is pointerdown -> pointerup -> click within one tap, so the sample is committed before the user can see what is under the fingertip; there is no press-and-hold-then-release flow. `positionLoupe` offsets the loupe only …  
  _Suggested fix:_ For `pointerType !== 'mouse'`: on pointerdown capture the pointer and show the loupe offset ~90px above the touch point (flip below near the top edge); on pointermove keep updating; commit the sample on `pointerup` at the last pointer position and ignore the synthesized `click`. …

- **medium/ux** — Auto Frame analyses the unrotated base image and overwrites the user's manual rotation: a strip rotated 90° by hand snaps back because 0° wins ties and 90° is penalised _(verified)_  
  `negative2positive/src/app/main.js:7332`  
  applyAutoFrameToCurrent passes state.loadedBaseImageData (the as-loaded orientation) to the analyzer, and applyAutoFrameResult sets state.rotationAngle = effectiveAngle and rebuilds originalImageData from the base (main.js:7138-7141), discarding any rotation the user applied with the rotate buttons (which only change state.rotationAngle/originalImageData, main.js:7279). Inside the analyzer, ±90° c…  
  _Suggested fix:_ Run detection on the currently displayed originalImageData and compose the result: state.rotationAngle = normalizeAngleDegrees(currentRotation + result.angle); or pass the current rotation as a seed so the angle penalty is measured relative to it instead of relative to 0°.

- **medium/ux** — Straightening requires holding Cmd/Ctrl while dragging; touch users have no way to straighten  
  `negative2positive/src/app/main.js:8347`  
  `shouldStartStraightenLine(event)` returns `event.metaKey || event.ctrlKey`, and both the mouse path (8352) and the touch pointer path (8393) use it to decide between crop-drag and straighten-line. There is no on-screen toggle, no angle slider and no gesture alternative (index.html has only the `#straightenGuideLine` element, no straighten control). The crop hint text tells users to 'Hold Command/…  
  _Suggested fix:_ Add a 'Straighten' toggle button next to Crop/Apply/Cancel (visible in crop mode) that sets a `state.straightenLineMode` flag; make `shouldStartStraightenLine` return `state.straightenLineMode || event.metaKey || event.ctrlKey`. Optionally add a numeric angle input (-45..45) wire…

- **medium/ux** — User-facing error reporting is inconsistent: alert() ×25, showToast ×17, console-only for background failures, silent null in the export worker bridge  
  `negative2positive/src/app/main.js:9007`  
  Four different strategies coexist: (1) blocking `alert()` for both errors and success confirmations (25 sites, e.g. 9010 'Export failed', 9207 'Settings saved', 9272 'roll reference set'); (2) non-blocking showToast for a different subset of success/cancel messages (17 sites, e.g. 2170, 9628); (3) console.error only for failures the user would notice as a stale preview — Step-2 auto convert (4665)…  
  _Suggested fix:_ Add a single `notify(kind, key, vars)` in ui/ (kind: 'success'|'info'|'error') that renders a toast for transient messages and a dismissible banner for errors, then replace the 25 alert() calls (reserve window.confirm for the one real decision at 7387). Route the four background …

- **medium/ux** — 16-bit export is offered for every source and filenames are stamped `_16bit` regardless of provenance; the UI never shows the source's real bit depth and loader downgrades are console-only  
  `negative2positive/src/app/main.js:9131`  
  updateExportUI only disables the 16-bit button for JPEG; index.html:1233-1234 enables it for JPEG scans, embedded-preview RAW fallbacks and iPhone DNGs alike, and buildExportFileName appends `_16bit` (main.js:8966) whenever the button is on. There is no state field for source bit depth and no i18n key beyond `bitDepthJpegLocked` (i18n.js:858). Meanwhile every 8-bit fallback in the RAW loader only …  
  _Suggested fix:_ Have loaders tag genuine planes (`image16.genuine = true` only on rawFileLoader.js:286-320 for outputBps 16 and pngFileLoader.js for depth 16; fabricated planes get `genuine = false`) and record `state.sourceBitDepth` in loadFile/loadFileToImageData. Show it in the file info / ne…

- **low/a11y** — Space shortcut steals activation from any focused button once a conversion exists  
  `negative2positive/src/app/main.js:7584`  
  isEditableTarget (3117) matches only input/textarea/select/[contenteditable]. With focus on any toolbar/footer button (Tab navigation, or after a mouse click in Chrome), pressing Space toggles before/after and preventDefault() suppresses the button's native activation whenever canActivateBeforeAfter() is true (i.e. after loading an image). Keyboard users cannot activate buttons with Space in the e…  
  _Suggested fix:_ Bail when `event.target instanceof Element && event.target.closest('button, a, [role="button"], summary')`, or only handle Space when document.activeElement is body/canvas.

- **low/bug** — Console '+'/'-' keys move the value the wrong way when a detail slider set it beyond ±8 steps _(verified)_  
  `negative2positive/src/app/main.js:690`  
  The C/M/Y sliders span -100..100 (index.html line 1160-1174) and coreExposure spans -300..300 (line 936), i.e. up to ±20 / ±30 console steps, but CONSOLE_MAX_STEPS is 8. With cyan at 60 the readout shows '+12'; pressing '+' computes next = min(8, 13) = 8 and writes 40, so the value drops from 60 to 40 on a '+' press (and pushes an undo entry). Same for '-' on large negative values.  
  _Suggested fix:_ Return early when the current value is already outside the range in the pressed direction (`if ((dir > 0 && current >= CONSOLE_MAX_STEPS) || (dir < 0 && current <= -CONSOLE_MAX_STEPS)) return;`), and clamp/mark the readout (e.g. '+8*') when the underlying value exceeds the keypad…

- **low/bug** — sanitizeLensCorrection falls back per field to the current file's lens state, so a snapshot with selectedLens null or stepMode 'auto' silently adopts another file's lens profile / manual step _(verified)_  
  `negative2positive/src/app/main.js:1821`  
  Every batch export sanitizes each file's snapshot with `fallbackSettings: state`. Inside sanitizeLensCorrection the selected lens is `sanitizeLensSelection(source.selectedLens, fallbackValue.selectedLens)`, and sanitizeLensSelection uses the fallback whenever the source is not an object — a saved `selectedLens: null` therefore resolves to the current file's lens. Likewise `stepMode` becomes 'manua…  
  _Suggested fix:_ In sanitizeLensCorrection distinguish 'key present' from 'key missing': use `'selectedLens' in source ? sanitizeLensSelection(source.selectedLens, null) : sanitizeLensSelection(undefined, fallbackValue.selectedLens)`, take stepMode from source when it is a string, and never inher…

- **low/bug** — restoreSnapshot re-suggests the step-2 mode, overriding the restored step2Mode and coreBorderBuffer _(verified)_  
  `negative2positive/src/app/main.js:2385`  
  restoreSnapshot restores step2Mode, coreBorderBuffer and coreBorderBufferBorderValue from SNAPSHOT_SCALAR_KEYS, then calls goToStep(s.currentStep). goToStep (line 2764-2768) runs `setStep2Mode(suggestStep2Mode())` whenever step === 2, and setStep2Mode (5798-5820) rewrites coreBorderBuffer/coreBorderBufferBorderValue based on the suggested mode. So if a user manually picks 'noBorder', samples the f…  
  _Suggested fix:_ Give goToStep an option such as `goToStep(step, { suggestMode: false })` and have restoreSnapshot pass it, then call `setStep2Mode(s.step2Mode)` explicitly so the restored values win.

- **low/bug** — sanitizeCurvePointChannel's non-finite guard is dead: corrupt curve points become (0,0) and clobber the real endpoint _(verified)_  
  `negative2positive/src/app/main.js:3171`  
  sanitizeNumeric(value, NaN, ...) returns 0 (not NaN) when both value and fallback are non-finite (3153-3158), so the `if (!Number.isFinite(x) || !Number.isFinite(y)) return;` check at 3173 never triggers. A malformed point in a saved/pasted settings object (e.g. {x:'abc', y:null}) is coerced to {x:0,y:0}; after sort/dedupe it overwrites the y of the genuine x=0 point (3187: `last.y = point.y`), fo…  
  _Suggested fix:_ Check `Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))` before calling sanitizeNumeric (or give sanitizeNumeric an explicit 'return NaN on failure' mode).

- **low/bug** — applyProcessedImageToState sizes the sprocket-frame canvas without edge-marking options or the portrait swap used elsewhere _(verified)_  
  `negative2positive/src/app/main.js:4556`  
  When sprocket preview is on, applyProcessedImageToState calls getSprocketFrameMetrics(processed.width, processed.height) with no options and no portrait handling, whereas getFullResDisplayReference (5442-5460) passes getSprocketFrameComposeOptions() and swaps width/height for portrait images, and composeSprocketFrame pre-rotates portrait input. Because bandMin depends on whether markings are visib…  
  _Suggested fix:_ Factor the portrait-aware, options-aware computation out of getFullResDisplayReference into `getSprocketOutputSize(w, h)` and use it in applyProcessedImageToState.

- **low/bug** — handleFilmPresetChange (and the auto-frame click handlers) are fire-and-forget with no rejection handling, and applyFilmPresetSettingsToState mutates state before awaiting the preset chunk  
  `negative2positive/src/app/main.js:6842`  
  applyFilmPresetSettingsToState sets state.coreFilmPreset synchronously (line 445-446) and only then awaits loadFilmPresets() (a dynamic import). handleFilmPresetChange chains .then() with no .catch(), so if the chunk fails to load (offline, stale deploy hash) the promise rejects, the `.then` never runs, the rejection is unhandled, and the select shows the new preset while the image is never refres…  
  _Suggested fix:_ Append `.catch(err => { console.error(err); state.coreFilmPreset = previous; syncAllSelectsFromState(); showToast(getLocalizedText('loadError', 'Error')); })` to the preset chain, and inside applyFilmPresetSettingsToState capture a request token before the await and bail if state…

- **low/bug** — Undo/redo (shortcut and buttons) can run during crop mode and desync the crop draft  
  `negative2positive/src/app/main.js:7617`  
  The Ctrl/Cmd+Z handler and #undoBtn/#redoBtn have no state.cropping/samplingMode guard, and setCropActionUi disables mirror/auto-frame but not undo/redo. restoreSnapshot (2328-2386) swaps originalImageData/croppedImageData and calls displayNegative() without exiting crop mode, so the canvas shows the restored image while cropOverlay and state.cropDraft (sourceImageData captured at beginCropMode) s…  
  _Suggested fix:_ In performUndo/performRedo (or the callers here) return early when state.cropping || state.samplingMode, and disable #undoBtn/#redoBtn in setCropActionUi(true), re-enabling via updateUndoRedoButtons() on exit.

- **low/bug** — Touch pinch-zoom and pointer panning run simultaneously and fight over panX/panY  
  `negative2positive/src/app/main.js:8465`  
  pointerdown (8387) starts a pan for any non-mouse pointer when canPan() (zoom > 1) and captures the pointer; touchstart with two fingers (8465) then starts a pinch without cancelling that pan. On every move both fire: pointermove sets `state.panX = panStartPanX + (clientX - panStartX)` from finger 1 while touchmove's zoomAtPoint recomputes panX/panY around the pinch centre, so the image jitters be…  
  _Suggested fix:_ When a second touch begins, call finishPan() and release pointer capture; ignore pointermove while `pinchStartDist > 0`; handle touchcancel like touchend; on returning to one finger re-seed panStart from the current pointer position.

- **low/bug** — Apply-crop compounds rotations on an already-rotated buffer while restore/export rotate the base once, so crop rectangles drift and the preview is double-resampled  
  `negative2positive/src/app/main.js:8515`  
  beginCropMode seeds the draft with `state.originalImageData`, which after any previous rotate/straighten is already a rotated, padded buffer. applyCropBtn then rotates that buffer again by the new delta and stores the sum in state.rotationAngle, with cropRegion expressed in the twice-rotated image's coordinates. restoreSettings (10210) and processFileWithSettings (9549-9551) instead rotate loadedB…  
  _Suggested fix:_ Always derive from the base: in applyCropBtn compute `total = normalizeAngleDegrees(state.rotationAngle + angle)` and `rotatedImageData = applyRotationToImageData(state.loadedBaseImageData || draft.sourceImageData, total)`, mapping the draft rect from the draft's (delta-rotated) …

- **low/bug** — downloadBlobInBrowser revokes the object URL synchronously after click(), which can abort large downloads in Firefox/Safari  
  `negative2positive/src/app/main.js:8793`  
  The anchor's href is revoked on the very next statement after `link.click()`. Chrome snapshots the blob at click time, but Firefox and WebKit have a long history of cancelling/producing 0-byte downloads when the URL is revoked before the download actually starts (FileSaver.js delays revocation by 40 s for this reason). This path is used for every single-file export and for browser 'Export All Indi…  
  _Suggested fix:_ Defer revocation: `setTimeout(() => URL.revokeObjectURL(url), 60_000)` (or revoke on the next 'focus' event), and append/remove the anchor from the DOM for Firefox compatibility.

- **low/bug** — processFileWithSettings ignores ensureOpenCvReady()'s boolean result, so an OpenCV load failure surfaces as a cryptic per-file error for the whole batch  
  `negative2positive/src/app/main.js:9578`  
  createOpenCvLoader resolves `false` (opencvLoader.js, `return false` after all sources fail) rather than throwing; every other call site checks it (`const ready = await ensureOpenCvReady(); if (!ready) alert(...)` at 7077/7343/7419). Here the result is discarded and detectDust is called anyway, which throws on the missing `cv` global — each file in the batch is marked status 'error' with a message…  
  _Suggested fix:_ `const cvReady = await ensureOpenCvReady(); if (!cvReady) { console.warn(...); trace.mark('dustRemovalSkipped'); } else { ...detectDust/inpaint... }` and show one toast per batch explaining dust removal was skipped.

- **low/bug** — Automatic gray point is estimated from a different image in batch (full-res, post-inpaint, full analysis) than interactively (250k-px preview conversion, pre-dust), and the batch result is never written back to the item  
  `negative2positive/src/app/main.js:9601`  
  maybeAutoWhiteBalance samples `state.previewSourceImageData`, i.e. a 250k-pixel downsample of the preview-slot conversion (whose histogram analysis ran on conversionPreviewImageData) and runs only once per processNegative, before dust inpainting. processFileWithSettings samples the full-resolution `processed` buffer after inpaintMasked. estimateAutoWhiteBalance stride-samples ~120k pixels and appl…  
  _Suggested fix:_ Estimate from the same input in both paths: in processFileWithSettings call `estimateAutoWhiteBalance(buildPreviewSourceImageData(processed))` on the pre-inpaint positive (or switch the interactive path to estimate from the full-res result when it lands). After a batch file is pr…

- **low/bug** — On every mobile browser (no showSaveFilePicker) ZIP export silently turns into N programmatic <a download> clicks, which Chrome blocks after the first without the batch noticing  
  `negative2positive/src/app/main.js:9727`  
  `canUseBrowserZipStreaming` requires `window.showSaveFilePicker` (zipStoreWriter.js:166-171), which no mobile browser (Chrome Android, Safari iOS, Firefox Android) and no desktop Safari/Firefox implement, so `exportBatchAsZipBrowser` toasts 'files will download individually' and calls `exportBatchIndividuallyBrowser`. That loop calls `saveBlob` -> `downloadBlobInBrowser` per file, which triggers `…  
  _Suggested fix:_ For browsers without showSaveFilePicker build the ZIP in memory with a size cap (e.g. abort with a clear message above 500 MB or when `navigator.deviceMemory <= 4`) and hand out one download, or require a user tap per file ('Save next file' button) so each download runs inside a …

- **low/bug** — Desktop batch-export lock does not cover file-list clicks (switchToFile), so a file can be switched mid-export  
  `negative2positive/src/app/main.js:10171`  
  updateDesktopBatchExportControlLock (2135-2159) disables a fixed list of buttons, and most handlers in this range check isDesktopBatchExportLocked(), but switchToFile — reachable via renderFileList's onOpenFile — has no guard. During exportBatchIndividuallyDesktop (which deliberately has no blocking overlay) clicking another row runs persistCurrentFileSettings + loadFile, resetting the displayed s…  
  _Suggested fix:_ Add `if (isDesktopBatchExportLocked()) return;` at the top of switchToFile and pass a `disabled` flag to renderFileList so rows render non-interactive while locked.

- **low/i18n** — Export failure alert and several export-path Error messages are hard-coded English; 'selected folder' fallback leaks into localized toast  
  `negative2positive/src/app/main.js:9010`  
  notifyExportError shows alert(`Export failed: ${message}`) where message is one of several English-only Error strings thrown in the export path ('Full-resolution processing is not ready yet. Please wait…', 'Export payload is not a Blob.', 'No image available for export.', 'JSZip module is unavailable'). Chinese/Japanese users see an English dialog for the most important failure in the app. showDes…  
  _Suggested fix:_ Add exportFailed: 'Export failed: {message}' (plus zh/ja) and use getInterpolatedText; attach an i18n key (err.i18nKey) to the known thrown errors so notifyExportError can localize them, falling back to err.message only for unknown errors. Add a desktopBatchExportFolderFallback k…

- **low/memory** — Crop/rotate undo entries retain full-resolution ImageData references; 30-entry stack can pin gigabytes  
  `negative2positive/src/app/main.js:8514`  
  pushUndo('crop') captures a snapshot whose refs include originalImageData, croppedImageData, processedImageData, conversionSourceImageData, conversionPreviewImageData, previewSourceImageData, histogramSourceImageData and webglSourceImageData (SNAPSHOT_REF_KEYS 2273-2277). applyCropBtn immediately replaces originalImageData/croppedImageData with new buffers, so each crop/rotate/straighten iteration…  
  _Suggested fix:_ For geometry actions store only {rotationAngle, cropRegion} and recompute from loadedBaseImageData on undo (they are deterministic), or cap the stack by estimated bytes (e.g. drop oldest entries once retained pixel bytes exceed ~500 MB) instead of by count.

- **low/perf** — exitBeforeAfter forces a full-resolution CPU render even when WebGL preview is active _(verified)_  
  `negative2positive/src/app/main.js:2839`  
  When leaving before/after in Step 3, exitBeforeAfter hides the GL canvas and calls updateFullCpu() directly instead of updateFull(). That runs applyAdjustmentsToBuffer over the entire full-res processedImageData on the main thread (plus histogram and the transform-canvas copy) on every release of the Space key / button, freezing the UI for roughly 0.5-3 s on 24-90 MP scans even though updateFull()…  
  _Suggested fix:_ Replace the block with `updateFull();` (it calls updateCanvasVisibility and falls back to updateFullCpu only when WebGL is unavailable).

- **low/quality** — Update check bookkeeping: 'Later' is not persisted (dead last-seen key), a failed/offline launch suppresses the next check for 24 h, and any pre-release tag silently disables the check _(verified)_  
  `negative2positive/src/app/main.js:1629`  
  Three small defects in the desktop update logic: (1) `DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY` is written at 1624 but never read anywhere, and the 'Later' button only calls `hideDesktopUpdateBanner()`, so a user who declines is nagged again on the next 24-hour check for every launch until they update. (2) `markDesktopUpdateChecked()` sits in `finally`, so when the app starts offline (or `get_app_versi…  
  _Suggested fix:_ Read the last-seen key in `checkDesktopUpdate` and skip the banner when `latestParsed.normalized === safeStorageGet(DESKTOP_UPDATE_LAST_SEEN_LATEST_KEY)`, writing the key from the 'Later' handler instead of on every detection. Move `markDesktopUpdateChecked()` into the success pa…

  `negative2positive/src/app/main.js:1877`  
  The three 16-bit mirror fields are declared at 1877-1879 with a comment saying they are 'dormant' until a later stage; the codebase has since moved to attaching `__image16` directly on ImageData (silverAdapter.js:23-33, 264-266). The fields are still assigned at 5657-5659 and 5738 but no code reads them, so they only pin a second reference to the largest buffer in the app.  
  _Suggested fix:_ Delete the three fields, the comment block at 1873-1876, and the four assignments.

- **low/quality** — Legacy non-SilverCore WebGL export/readback path is unreachable dead code _(verified)_  
  `negative2positive/src/app/main.js:4437`  
  PRESET_TYPES is ['color','bw','positive'] and sanitizePresetType coerces anything else to 'color', so usesSilverCoreConversion() always returns true. Consequently renderFullWebGL (4437-4507, including a full-res gl.readPixels + Y-flip + canvas resize to image size), the WebGL branch of ensureFullRender (4513-4522), the `useLegacyTone` branch of webglSetUniforms (4222-4238), buildRouterSettings's `…  
  _Suggested fix:_ Remove renderFullWebGL and the legacy branches, or reduce usesSilverCoreConversion to `return true` with a comment and delete the dead callers; keep webglSetUniforms passing zeros for the legacy uniforms.

- **low/quality** — File-type dispatch (RAW / PNG / standard) and the 100 MiB 'heavy RAW' threshold are duplicated between loadFile and loadFileToImageData  
  `negative2positive/src/app/main.js:9388`  
  main.js:5600-5637 (loadFile) and 9388-9400 (loadFileToImageData, used by batch/auto-frame) both implement `isRawLikeFileName → loadRawImageData; file.type==='image/png' → loadPngImageData; else loadStandardImage`. loadFile additionally checks `arrayBuffer.byteLength > 100 * 1024 * 1024` at 5603 to choose the two-stage preview path — the same constant rawFileLoader.js:19 defines as RAW_SIZE_HEAVY. …  
  _Suggested fix:_ Move `loadFileToImageData(file, { preview, onMetadata })` into app/imageFileLoaders.js (it already owns isRawLikeFileName and the three loaders), export RAW_SIZE_HEAVY from rawFileLoader.js, and have loadFile call the shared function with the extra options.

- **low/quality** — exportBatchAsZipDesktop (JSZip in-memory ZIP loop) is unreachable: the ZIP button is hidden on desktop and the web build never takes the desktop branch  
  `negative2positive/src/app/main.js:9639`  
  exportBatchAsZip() routes to exportBatchAsZipDesktop only when isTauriDesktop(), but updateDesktopExportMenuUI() (called at init, 9122) sets `#exportZipBtn.style.display = 'none'` on desktop, and exportZipBtn's click handler (9068) is the only caller of exportBatchAsZip. On the web isTauriDesktop() is false, so the JSZip path is dead in both builds, together with getJSZipCtor (8932) and the jszip …  
  _Suggested fix:_ Delete exportBatchAsZipDesktop and getJSZipCtor, drop jszip from package.json, and make exportBatchAsZip call exportBatchAsZipBrowser directly (or, if desktop ZIP is wanted, implement it with ZipStoreWriter over a Tauri file stream and unhide the button). Fold the remaining three…

- **low/ux** — Export path silently drops lens correction when the runtime fails, with no user-visible warning _(verified)_  
  `negative2positive/src/app/main.js:1287`  
  applyLensCorrectionWithSettings returns the uncorrected imageData on ensureLensfunClient failure or buildCorrectionMaps/apply exceptions and only surfaces the reason through setLensStatus when updateUi is true. The export/batch path calls it with `{ updateUi: false }` (line 9559), so an exported or batch-exported file can silently lack the distortion/TCA/vignetting correction the user enabled and …  
  _Suggested fix:_ Always console.warn the reason, and return `{ imageData, skipped: true, reason }` (or set a flag on the export result) so the export routine can show a toast / mark the item in the batch summary when lens correction was requested but not applied.

- **low/ux** — Curve editor renders blank when first revealed because renderCurve sizes the canvas from a hidden element _(verified)_  
  `negative2positive/src/app/main.js:3499`  
  renderCurve sets curveCanvas.width/height from offsetWidth/offsetHeight. The canvas lives in additionalSection (display:none, content collapsed in index.html ~1180-1187) and renderCurve is only called from curve interactions, restoreSnapshot (2366), reset (8597) and restoreSettings (10321) - all of which can run while the section is hidden, producing a 0x0 canvas. Nothing calls renderCurve when th…  
  _Suggested fix:_ Call renderCurve() from the section-header toggle for 'additional' and from setPanelMode('detail'), or attach a ResizeObserver to curveCanvas that calls renderCurve when its size becomes non-zero; skip resizing when offsetWidth === 0.

- **low/ux** — Histogram does not follow core-control changes in WebGL mode until the full-res render lands _(verified)_  
  `negative2positive/src/app/main.js:4687`  
  applyPreviewProcessedImageToState refreshes previewSourceImageData and webglSourceImageData for the new preview conversion but not histogramSourceImageData. renderHistogramForWebGL prefers histogramSourceImageData, so while dragging core sliders/keypad the displayed image updates but the histogram keeps showing the previous conversion for at least ~1.8 s (1200 ms + 600 ms + render time) until the …  
  _Suggested fix:_ Add `state.histogramSourceImageData = buildHistogramSourceImageData(state.previewSourceImageData || processed);` in applyPreviewProcessedImageToState.

- **low/ux** — Rotate, crop, film-type and goToStep(2) overwrite the user's explicit Step-2 mode with the heuristic suggestion _(verified)_  
  `negative2positive/src/app/main.js:7289`  
  setStep2Mode(suggestStep2Mode()) is called after every rotation (7289), auto-frame (7156, 7178), crop apply (8521), film-type click (6598) and on entering step 2 (2767). suggestStep2Mode returns 'noBorder' when a crop exists, otherwise decides by orange bias, so a user who deliberately chose 'No border' (or 'Border') gets flipped back — and coreBorderBuffer is rewritten to 0 or the cached value — …  
  _Suggested fix:_ Add state.step2ModeTouched (set in the .step2-mode-btn handler, cleared in loadFile) and make the automatic call sites use `if (!state.step2ModeTouched) setStep2Mode(suggestStep2Mode())`.

- **low/ux** — Sprocket edge markings stamp the same frame number and DX code on every file in a batch export  
  `negative2positive/src/app/main.js:8978`  
  applySprocketFrameForExport composes with `getSprocketFrameComposeOptions()` = `{ edgeMarkings: state.sprocketEdge }` for every file in all four batch loops. sprocketFrame.js derives the printed frame number from `edge.frameNumber` (+index only for repeats inside one frame), so with frameNumberEnabled every exported frame reads e.g. '18'/'18A' and the barcode encodes 18. Concrete failure: user ena…  
  _Suggested fix:_ Give applySprocketFrameForExport an optional `{ frameOffset }` argument and pass the loop index from the batch loops: `edgeMarkings: { ...state.sprocketEdge, frameNumber: clampInt(state.sprocketEdge.frameNumber + i, 0, 99) }` when frameNumberEnabled, so consecutive files get cons…

- **low/ux** — exportSingle only uses the source filename when at Step 3, so sprocket/raw exports from Step 1-2 are always named converted_negative*.png  
  `negative2positive/src/app/main.js:9017`  
  fileName is initialised with `buildActiveExportFileName(null, exportInfo)` and only overwritten with `currentItem.file.name` inside the `state.currentStep >= 3 && state.processedImageData` branch. The else branch (Step 1/2 export, e.g. sprocket-frame preview export which getCurrentExportImageData explicitly supports) never names the file after its source, so batch users exporting several frames th…  
  _Suggested fix:_ Move the `currentItem?.file?.name` filename assignment above the if/else so both branches use it.

- **low/ux** — exportBatchIndividuallyBrowser hides the loading overlay before saveBlob and only re-shows it on success, so a save error mid-batch leaves the rest of the batch running with no overlay  
  `negative2positive/src/app/main.js:10087`  
  The overlay is hidden before saveBlob; if saveBlob throws (e.g. Blob creation failure) the catch marks the item as error and the loop continues, but nothing calls overlay.show again — subsequent files are processed with the page fully interactive and overlay.updateProgress writing into a hidden element. The user can start a second export or switch files while the loop is still mutating item.status…  
  _Suggested fix:_ Move the `overlay.show` re-arm to the top of each loop iteration (guarded by `!overlay.isVisible`), or wrap saveBlob in its own try/finally that always re-shows when more files remain.

- **low/ux** — supportsFolderPicker() only checks `'webkitdirectory' in folderInput`, so 'Select Folder' is enabled on platforms where directory picking does not work (Linux WebKitGTK desktop build; Chrome Android < 132, Safari iOS < 18.4, Firefox Android < 142)  
  `negative2positive/src/app/main.js:10640`  
  `supportsFolderPicker()` returns `'webkitdirectory' in folderInput`, which is true on every Chromium/WebKit/Gecko build because the property exists on the prototype regardless of whether the engine can actually present a directory chooser. Two concrete platforms expose this: (1) Linux Tauri/AppImage: WebKitGTK's default file chooser (`webkitWebViewRunFileChooser` in WebKitWebViewGtk.cpp) always cr…  
  _Suggested fix:_ Strengthen the detection instead of relying on property presence: (a) on Linux desktop (`isTauriDesktop()` plus a tiny `get_platform` command, or `navigator.platform`/`navigator.userAgent` containing 'Linux'), treat the folder picker as unsupported and run the existing `applyFold…


## Engine and rendering

- **medium/bug** — softHigh/softLow (profile defaultSoftHigh/-SoftLow) are 8-bit offsets added to 16-bit clip points, and softClipLayer divides 16-bit overflow by 255  
  `negative2positive/src/silvercore/engine/CurveEngine.js:551`  
  computeClipPoints adds softHigh (e.g. -3, -9, -15 from the base/filmic profiles) directly to whitePointOrigin, which since the 16-bit migration is bin*257 (ImageProcessor.js:118). A -15 offset is 0.02% of range, so the profile's 'flat' soft clipping is effectively a no-op (probe: base vs base_flat differ by ≤ 20 LSB16). When an overflow does occur (whitePointOrigin near 0) the resulting whiteOverf…  
  _Suggested fix:_ Scale the soft offsets to the pixel domain in computeClipPoints (`softHigh * 257`, `softLow * 257`) and normalise overflow by PIXEL_MAX in softClipLayer (`whiteScale = (PIXEL_MAX - wc) / PIXEL_MAX; blackScale = bc / PIXEL_MAX`). Add a test that base_flat produces a measurably lif…

- **medium/bug** — Coloured point lights on a colour negative (red/blue LEDs, distant signal lamps, coloured stars) match the 'dead photosite' signature and are erased from every RAW decode  
  `negative2positive/src/silvercore/util/sensorDefects.js:131`  
  The header assumes real content is neutral, but on C-41 a small red light source becomes a single-channel dip (cyan dye absorbs only red) and a blue light a blue-only dip; both are isolated 3x3 features after demosaic. The CORRELATED_FRACTION test (other channel must move >= 25 % of the defect's excess) does not fire because the other channels are genuinely unchanged, so the pixel is rewritten wit…  
  _Suggested fix:_ Only repair values that sit at a sensor rail (v <= absoluteThreshold for dead, v >= PIXEL_MAX - absoluteThreshold for hot) rather than any isolated outlier: a stuck photosite reads the black level or clips, an optical point light does not. Also expose the repair as a setting (def…

- **medium/memory** — Unsharp mask allocates three full-frame Float32 planes per call and walks the vertical pass column-strided  
  `negative2positive/src/silvercore/engine/Sharpening.js:52`  
  Every applyUnsharpMask call allocates lum (164), temp and output (52-53) as Float32Array(width*height) — 3 × 96 MB = 288 MB transient at 24MP, on every full render with sharpenAmount > 0 and on every core-slider commit at preview size, with no reuse. The vertical interior loop (115-124) iterates k innermost over `temp[(baseY + k) * width + x]`, touching a different row per k for each x; the 64-col…  
  _Suggested fix:_ Keep module-level scratch planes reused when the size matches (or pass a scratch object like lutScratch), reuse `lum` as the vertical-pass output, and restructure the vertical pass as k-outer/x-inner (accumulate `output[row] += temp[row+k*width] * kernel[k]` across a contiguous r…

- **medium/perf** — Histogram scans the full-resolution image (16-bit plane when present) on the main thread; the pre-built downsampled histogram source is bypassed on redraws  
  `negative2positive/src/render/histogramService.js:45`  
  draw() iterates every pixel of whatever ImageData it is given and prefers `__image16`. main.js passes full-resolution buffers in most call sites — updateFullCpu passes the full adjusted buffer, redrawHistogramIfPossible (called on every resize) passes `displayImageData || processedImageData || croppedImageData || originalImageData`, and the load/crop/rotate paths pass the raw source with its 16-bi…  
  _Suggested fix:_ Inside draw(), compute a pixel stride so at most ~1 M pixels are sampled (`step = ceil(sqrt(pixels / MAX))`, iterate rows/cols with that step) — the 256-bin histogram is statistically identical. Alternatively make renderHistogram always route through buildHistogramSourceImageData…

- **medium/perf** — _applyLuts chains up to nine separate full-image read/write passes that could be fused  
  `negative2positive/src/silvercore/engine/Engine.js:102`  
  For each reprocess the 16-bit buffer is walked by applyLUT (ImageProcessor 133-142), applyHSLAdjustments, applyLut3D, adjustSaturation (387-399, which uses Math.max/Math.min function calls per channel and recomputes luminance), applyUnsharpMask (luma extract + horizontal blur + vertical blur + apply = 4 passes), then silverAdapter's toGrayscaleInPlace (108-118, Math.round per pixel, B&W only) and …  
  _Suggested fix:_ Fuse applyLUT + adjustSaturation (+ B&W mix) into one loop with inline clamps; have applyUnsharpMask accept a precomputed luma plane and write the 8-bit output directly in its final pass when no further stage follows; in toImageData8 skip alpha (write 255) and process pixels with…

- **medium/perf** — SilverCore HSL pass does a full RGB→HSL→RGB round-trip per pixel on every reprocess for basic/frontier/noritsu models  
  `negative2positive/src/silvercore/engine/ImageProcessor.js:308`  
  applyHSLAdjustments is called unconditionally from Engine._applyLuts (Engine.js 103) and runs whenever the color model has hslAdjustments (Presets.js: basic, frontier, noritsu — 'standard' and 'mono' skip). Per pixel it does three divisions, Math.floor, three hue2rgb calls and three clamped writes on the 16-bit buffer. Its output depends only on (colorModel, profileStrength) and the input color, i…  
  _Suggested fix:_ Bake the HSL adjustment into a 33³ (or 65³) RGB 3D LUT once per (colorModel, profileStrength) — 35k evaluations — and apply it with the existing trilinear applyLut3D (EnhancedProfiles.js 156-227), ideally pre-composed with the enhanced-profile LUT when both are active so the imag…

- **medium/perf** — Full-resolution histogram uses the slow per-draw-allocating Histogram.js while the optimized render/histogramService.js is dead code  
  `negative2positive/src/silvercore/ui/Histogram.js:16`  
  main.js imports Histogram from silvercore/ui/Histogram.js (line 55) and calls renderHistogram with full-resolution buffers: updateFullCpu (4430, the adjusted 24MP buffer), ensureFullRender (4518), before/after (2804), displayNegative sources at load/crop-exit (2846, 2978, 3003, 8050, 8531). Histogram.draw allocates four Uint32Array(256) per call and computes `Math.round(0.299*r + 0.587*g + 0.114*b…  
  _Suggested fix:_ Switch main.js to HistogramService (or delete the duplicate) and feed renderHistogram a stride-decimated buffer (downsampleImageDataForMaxPixels(…, HISTOGRAM_MAX_SAMPLES) as renderHistogramForWebGL does) in updateFullCpu, ensureFullRender, displayNegative and the before/after pat…

- **medium/quality** — silvercore WebGLRenderer.js (369 lines) is dead code shipped in the worker bundle — Engine.initWebGL is never called — and, with other unreachable engine exports, hides latent bugs (256-entry LUT upload, null matrices, log(1) division)  
  `negative2positive/src/silvercore/engine/WebGLRenderer.js:134`  
  Engine.js:28-35 defines initWebGL(canvas) and Engine.js:10 imports WebGLRenderer, but grep shows no call to `initWebGL(` or `.glRenderer` outside Engine.js (main.js has its own unrelated initWebGLRenderer); `this.glRenderer` stays null forever and Engine.js:92-94 even documents 'WebGL path is currently disabled'. The module is nevertheless pulled into the conversionWorker bundle (conversionWorker.…  
  _Suggested fix:_ Delete WebGLRenderer.js, the import at Engine.js:10, initWebGL() and every `this.glRenderer` branch (Engine.js:20,28-35,44,48). If a GPU path for SilverCore is planned, keep it in git history rather than shipping it in the worker bundle; if the GL renderer is ever revived, resize…

- **low/bug** — Auto curve-resolution thresholds (30/70/128) are 8-bit widths compared against 16-bit widths, so 'auto' always yields 9 points  
  `negative2positive/src/silvercore/engine/CurveEngine.js:125`  
  getCurveResolution receives minWidth = min(blacks - whites) where both are bin*257 values, so any non-degenerate range is ≥ 257 and the `<= 30`, `<= 70`, `< 128` branches never fire. The adaptive behaviour advertised by the UI labels ('Auto (30)', 'Smooth (70)', 'Precise (128)') is dead; narrow-range (thin) negatives that used to get 3–7 points for smoothness now always get 9.  
  _Suggested fix:_ Compare `curveWidth / 257` (or define the thresholds as 30*257 etc.) so the auto heuristic works again, and fix the misleading i18n labels if the thresholds change.

- **low/bug** — blacksLayer/whitesLayer exponential lift produces tone reversals when |blacks| or |whites| exceeds ~69 (or ~48 at range 0)  
  `negative2positive/src/silvercore/engine/CurveEngine.js:224`  
  The lift term lift*exp(-x*decay) + x has derivative 1 - lift*decay at x=0; with lift = blacks/255 and decay = 5 - (shadowRange-1)*0.33 (3.68 at the default range 5, 5.33 at range 0) the slope goes negative once blacks > 255/decay ≈ 69 (48 at range 0), so the deepest shadows come back up. Probe blacks=100: outputs 25045 (input 180·257), 24949 (200·257), 26158 (220·257 and above). whitesLayer has th…  
  _Suggested fix:_ Clamp the product so the curve stays monotone (`lift = Math.min(blacks/255, 0.95/decay)`), or use a monotone lift such as `x + lift * Math.pow(1 - x, k)` whose derivative at 0 is 1 - lift*k with k chosen ≤ 1/liftMax; mirror for whites.

- **low/bug** — Midtone toning is ~20× weaker than shadow/highlight toning, so preset midCyan/midTint/midTemp values (1–12) are invisible  
  `negative2positive/src/silvercore/engine/CurveEngine.js:452`  
  midtoneColorLayer shifts by colorVal*0.1*weight/255, i.e. at most 0.039 at ±100 and ≈0.002 (≈0.5 of an 8-bit level) at the ±5 values presets use, whereas shadowColorLayer/highlightColorLayer convert the same numeric range into a tanh steepness (0.75 + |v|*rangeFactor*0.125) that visibly reshapes the curve. Probe: midTemp 12 moves B@mid 9572→9387 (−185 LSB16) while shadowTemp 12 moves it 9572→6239.…  
  _Suggested fix:_ Drop the /255 (colorVal is already a ±100 slider unit) or use a divisor that gives ±100 a shift comparable to the shadow/highlight layers (e.g. `/ 25`), then re-tune the preset mid* values.

- **low/bug** — Per-tile sampling stride aliases with the tile width, so on common sensor sizes the 64 'samples' fall on 1-4 columns of each tile  
  `negative2positive/src/silvercore/util/garbledCheck.js:46`  
  stride = floor(innerW*innerH/64) and lx = s % innerW, so lx = innerW * frac(k*innerH/64): the number of distinct columns visited is 64/gcd(innerH, 64). Probe: 6720x4480 (Canon R5 class) -> 64 samples on 2 columns; 4096x4096 -> 1 column; 6048x4032 (Nikon Z f/Z6III), 9504x6336, 7008x4672, 5472x3648 -> 4 columns; only sizes like 6000x4000 spread over 64 columns. The snow test then depends on a couple…  
  _Suggested fix:_ Sample an 8x8 grid per tile with independent x and y strides (x = x0 + (i+0.5)*innerW/8, y = y0 + (j+0.5)*innerH/8), and add a test that asserts the visited columns cover the tile for a 6720x4480 and a 4096x4096 input.

- **low/bug** — Outer two rows/columns are never scanned, so a dead photosite within 2 px of the frame edge still exports as a coloured dot  
  `negative2positive/src/silvercore/util/sensorDefects.js:108`  
  The main loop runs y from 2 to height-3 and x from 2 to width-3 because the Chebyshev-2 ring would fall outside the image. Defects in the 2-px border are skipped entirely. Probe: four dead red photosites placed at (1,1), (1,30), (W-2,30), (30,H-2) -> repaired=0. On a full-frame scan that is cropped afterwards this is usually invisible, but on a frame used edge-to-edge (sprocket export, borderless …  
  _Suggested fix:_ Clamp/mirror ring coordinates at the border (readRing with clamped dx/dy) and scan from 0 to width-1/height-1, or run a reduced 3x3-ring variant on the two border rows/columns. Add a test with a defect at x=1.

- **low/perf** — toImage16 fabricates a fresh x257 plane on every call for 8-bit inputs, so the adapter's source/film-base reuse cache never hits for JPEG scans or lens-corrected RAW  
  `negative2positive/src/pipeline/silverAdapter.js:32`  
  _reuseInputBuffer keys its cache on the identity of `image16.data` (:177-178). For inputs without a plane, toImage16 returns a brand-new Uint16Array each call (:32), so `sourceChanged` is always true: every core-slider move on the main-thread preview re-promotes the 250k-pixel preview and re-runs the film-base compensation loop, and every full render on the main thread (worker disabled, or small i…  
  _Suggested fix:_ Memoise the promotion per slot on the 8-bit input identity: store `slot.lastSource8Ref = input.data` and, when it matches and lengths agree, skip fromImageData8 and treat the source as unchanged; or promote directly into `slot.pristineBuffer` (loop `pristine[i] = data[i] * 257`) …

- **low/quality** — pipeline/legacyPositive.js is unreachable: settings.positiveEngine is never set to 'legacy'  
  `negative2positive/src/pipeline/legacyPositive.js:10`  
  conversionRouter.js:14 gates convertPositiveLegacy on `settings.positiveEngine === 'legacy'`, but grep across src and *.html finds 'positiveEngine' only on that line — no state field, no UI, no sanitizeSettings key, no persisted setting produces it. The 60-line percentile-stretch converter is dead code that still ships in both the main and worker bundles.  
  _Suggested fix:_ Delete legacyPositive.js and lines 2 and 14-17 of conversionRouter.js; if a legacy positive path is still wanted as a debug escape hatch, expose it via a DEBUG_UI query flag so it is reachable and testable.

- **low/quality** — render/histogramService.js is a dead, better duplicate of silvercore/ui/Histogram.js  
  `negative2positive/src/render/histogramService.js:3`  
  HistogramService is exported but never imported anywhere (0 references outside its own file). main.js:55 imports the older `Histogram` class instead. The dead version is the more capable one (16-bit __image16 aware at lines 30-53, DPR-aware resize at 13-22, stroke outlines), while the live Histogram.js:9-63 only bins 8-bit data and stores width/height at construction so main.js has to poke `histog…  
  _Suggested fix:_ Pick one: either delete render/histogramService.js, or migrate main.js to HistogramService (it already handles resizing internally, so resizeHistogramCanvas at main.js:3442-3460 and the external width/height mutation can go) and delete silvercore/ui/Histogram.js. Either way, remo…

- **low/quality** — ColorSpace.js: 9 of 11 exports (≈140 lines) are never imported — only convertSpace and rgbToHSV are used  
  `negative2positive/src/silvercore/engine/ColorSpace.js:177`  
  newColor (177), from255 (181), colorAvg (185), hsvToRGB (215), linearBalance (242), gammaBalance (268), fromHex (289), gammaPresets (305) and the re-export of colorSpaces (314) have zero references outside this file (colorAvg/newColor are only used by the other dead functions). gammaPresets is annotated 'from GammaUtility.lua' — ported Lua utilities that never got a caller.  
  _Suggested fix:_ Delete lines 177-187 and 240-314 (keep convertSpace, rgbToHSV, the transfer functions and the colorSpaces table they need). Vite tree-shakes the bundle, so this is about maintenance surface, not size.

- **low/quality** — 65535 is redefined under seven local names although image16.js already exports IMAGE16_MAX  
  `negative2positive/src/silvercore/engine/CurveEngine.js:14`  
  CurveEngine.js:14 PIXEL_MAX, sensorDefects.js:43 PIXEL_MAX, Sharpening.js:142 PIXEL_MAX, EnhancedProfiles.js:102 PIXEL_MAX, ImageProcessor.js:12 MAX_16, filmBaseCompensation.js:1 PIXEL_MAX_16, filmBaseDetection.js:3 UINT16_MAX — plus bare literals at garbledCheck.js:32, pngFileLoader.js:34, EnhancedProfiles.js:65 and WebGLRenderer.js:286-288 — while silvercore/util/image16.js:6 exports `IMAGE16_MA…  
  _Suggested fix:_ Import IMAGE16_MAX from util/image16.js in the seven modules and delete the local constants. Export `LUMA_R/G/B` (or a `luma(r,g,b)` helper) from a shared colorMath.js and reference it from the JS sites; keep the GLSL literal but add a comment pointing at the constant.

- **low/quality** — ImageProcessor.boxBlur (97 lines) and negateImage are exported but never called  
  `negative2positive/src/silvercore/engine/ImageProcessor.js:151`  
  boxBlur (151-247, a separable sliding-window blur) and negateImage (249-257) have no callers in src, tests or scripts; Engine.js:6 imports only analyzeImage, applyLUT, adjustSaturation, applyHSLAdjustments. Sharpening.js has its own separableBlur (49) for the blur it needs, so boxBlur is an orphaned second implementation.  
  _Suggested fix:_ Delete lines 143-257 of ImageProcessor.js.

- **low/quality** — Presets.defaultSettings, Presets.filmCharacter, FilmPresets.presetCategories and EnhancedProfiles.PROFILES are never imported  
  `negative2positive/src/silvercore/engine/Presets.js:6`  
  Presets.js:6-47 `defaultSettings` (42 keys including `saturation: 3`, `filmBorder`, `wb: 'warm'` that no code path reads) and 224-229 `filmCharacter` have no importers; Engine.buildSettings builds its own defaults inline (Engine.js:145-200), so the two can and do disagree (e.g. defaultSettings.colorModel 'basic' vs Engine fallback 'standard' at 124/184). FilmPresets.js:1093-1110 `presetCategories`…  
  _Suggested fix:_ Delete defaultSettings, filmCharacter and presetCategories. If a canonical default object is wanted, have Engine.buildSettings spread it instead of re-listing defaults.

- **low/quality** — colorModels has no entries for 'standard', 'warm', 'cine-*' or 'neutral', so all of them silently inherit 'basic' (blueHue −10°, thresholds 0.002/0.001)  
  `negative2positive/src/silvercore/engine/Presets.js:173`  
  The Step-2 Color Model select offers frontier/noritsu/standard/warm/mono/cine-log/cine-rich/cine-flat/neutral, but colorModels only defines none/basic/frontier/mono/noritsu. Engine.buildSettings and analyzeImage fall back to colorModels.basic for the missing keys, so 'neutral' (mapped to the base tone profile) still applies basic's −10° blue hue rotation and 'warm' is byte-identical to 'standard'.…  
  _Suggested fix:_ Add explicit colorModels entries for standard/warm/cine-log/cine-rich/cine-flat/neutral (neutral → hslAdjustments: null like 'none'), and log/assert on unknown model names instead of silently using basic.

- **low/quality** — WhiteBalance.js: analyzeAutoWB/hsbAnalysis, CHANNEL_MULTIPLIER and TEMP_STRENGTH are dead; only computeAutoColor is used  
  `negative2positive/src/silvercore/engine/WhiteBalance.js:16`  
  Engine.js:8 imports only computeAutoColor. hsbAnalysis (16-61) and analyzeAutoWB (68-83) — a full-image HSB masked sampler — plus the CHANNEL_MULTIPLIER matrix (107-111) and TEMP_STRENGTH (113) have no callers anywhere in src, tests, or scripts. They are the only reason ColorSpace.rgbToHSV is imported here.  
  _Suggested fix:_ Delete lines 6-83 and 103-113, leaving computeAutoColor. If the HSB auto-WB was intended to replace app/autoWhiteBalance.js, track that as an issue instead of keeping unreachable code.

- **low/test** — NEF fixture smoke resolves the RAW relative to cwd, exits 0 silently when absent, and is not discoverable from npm  
  `negative2positive/src/silvercore/util/nef-fixture.smoke.mjs:17`  
  The smoke passes today from the repo root (the ignored DSC_4127.NEF is present) but `path.resolve(process.cwd(), 'DSC_4127.NEF')` means running it from any other directory prints a warning and exits 0, identical to a pass from the runner's point of view. No npm script or runner picks it up, so the Z f fallback regression it documents (#81) is protected only when a developer remembers the exact com…  
  _Suggested fix:_ Read the fixture path from `process.env.NC_NEF_FIXTURE` with a repo-root default computed from `import.meta.url`; wire it into run-tests.mjs as an optional test that prints `SKIP` (and counts it separately) when the env var/file is missing; document the env var in CLAUDE.md next …


## Build and release

- **medium/ci** — macOS release build is Apple-Silicon-only while download.html hands the arm64 DMG to every Mac user _(verified)_  
  `.github/workflows/desktop-release.yml:163`  
  `npm run tauri:build` on `macos-latest` builds only the host target (aarch64). The published assets and R2 manifest contain a single `..._aarch64.dmg` (verified `lipo -info` -> 'architecture: arm64'), yet download.html's macOS card picks `preferredTypes: ['dmg']` with no arch check, so Intel Mac visitors download a binary that macOS refuses to launch. The Mac App Store build already goes universal…  
  _Suggested fix:_ In the macOS matrix entry add `targets: aarch64-apple-darwin,x86_64-apple-darwin` to the dtolnay/rust-toolchain step and run `npm run tauri:build -- --target universal-apple-darwin` (upload path becomes `src-tauri/target/universal-apple-darwin/release/bundle/**`). If binary size …


## Public pages

- **medium/docs** — Every page promises 16-bit export that 'preserves tonal range' while the exporters emit 8-bit data x257  
  `negative2positive/guide.html:144`  
  The 16-bit export promise is the main differentiator on the marketing pages: guide.html FAQ (JSON-LD :144 and body :687 'preserve tonal range for further editing in Photoshop, Lightroom, or Capture One'), :472 badge '16-bit PNG / TIFF', :534, :635; negative-lab-pro-alternative.html:95 ('strongest for ... 16-bit output'), :113, :126 ('Exporting 16-bit PNG or TIFF files for later finishing'); llms.t…  
  _Suggested fix:_ Fix the export path (feed the engine's 16-bit result into the PNG16/TIFF16 encoders) before the next content update; if that ships later, soften the copy now to '16-bit container output (8-bit precision until vX.Y)' in guide.html:144/:472/:534/:687, negative-lab-pro-alternative.h…

- **medium/docs** — Guide advertises 12-bit ProRaw and 'real bit depth' while ProRaw DNG and TIFF are decoded to 8-bit RGBA  
  `negative2positive/guide.html:530`  
  The formats table lists 'DNG (ProRaw) ... 12-bit' and the feature card says 'Real RAW, real bit depth ... 16-bit PNG and TIFF input'; iphone-proraw-negative-converter.html:116 tells users to 'Use ProRaw DNG if available to preserve tonal range'; raw-negative-converter.html:120 lists TIFF as an input. In rawFileLoader.js the iPhone-DNG branch and the .tif/.tiff branch both call UTIF.toRGBA8 (8-bit)…  
  _Suggested fix:_ Until the loader decodes 16-bit TIFF/ProRaw samples (UTIF.decodeImage exposes ifd.data with bitsPerSample; build the __image16 plane from it instead of toRGBA8), change guide.html:530 to '8-bit (decoded via UTIF)', drop 'real bit depth' at :553 and the 'preserve tonal range' advi…

- **medium/i18n** — Privacy page declares hreflang for three languages that all resolve to one JS-toggled page, served with lang="zh" and every content block display:none  
  `negative2positive/privacy.html:11`  
  hreflang en/zh/ja point at `privacy.html?lang=en|zh|ja`; the canonical (line 10) strips the query, so all three alternates are non-canonical URLs — Google ignores hreflang that does not point at canonical pages, and the live probe confirms `?lang=en` returns byte-identical HTML. The document itself is `<html lang="zh">` with an English `<title>`/description, a Chinese `<h1>` and all three `.conten…  
  _Suggested fix:_ Pick one model. (a) Real localisation: split into privacy.html (EN, lang="en"), privacy.zh.html and privacy.ja.html, each with a self-referential canonical and reciprocal hreflang links (x-default -> privacy.html); main.js:271 already builds the link per language so it can target…

- **low/a11y** — Step badge, dust/lens status boxes, file count and batch progress text change dynamically without aria-live _(verified)_  
  `negative2positive/index.html:304`  
  Only #cropModeHint, #desktopUpdateBanner, #feedbackStatus and #headerExportProgress are live regions. The following are rewritten by main.js on state changes but never announced: #statusBadge (Step 1→2→3 transitions, main.js 2706), #noviceGuideStatus / #noviceGuideWarning ('mask not set, converting may shift colors'), #dustStatus (processing/ready), #lensStatusBox (search results count, apply fail…  
  _Suggested fix:_ Add role="status" (polite) to #statusBadge, #dustStatus, #lensStatusBox, #batchProgressText and #noviceGuideStatus, and role="alert" to #noviceGuideWarning; keep messages short so they do not flood the reader.

- **low/a11y** — Language switcher on privacy/download pages exposes no state or language semantics to assistive tech  
  `negative2positive/privacy.html:345`  
  The three `.lang-btn` buttons signal the active language only through the `.active` class; there is no `aria-pressed`, and the button labels ('中文', '日本語') have no `lang` attribute so screen readers announce them in the page language. The wrapper is a `<div aria-label="Language selector">` without a role, so the label is dropped. The same markup is duplicated in download.html:429-433 and index.html…  
  _Suggested fix:_ Use `<div role="group" aria-label="Language">`, add `lang="zh"`/`lang="ja"` on the buttons, set `aria-pressed` in the toggle loop, and use the `hidden` attribute (not inline display) for inactive content blocks so they are removed from the accessibility tree consistently.

- **low/docs** — Supported-format lists disagree across guide, landing pages, llms.txt, pricing.md and index.html JSON-LD, and undersell what the app accepts  
  `negative2positive/guide.html:498`  
  guide.html (badge :471, step :498, table :524-531) and index.html JSON-LD (:49, :53), llms.txt:14 and pricing.md:28 list exactly CR2/NEF/ARW/DNG/RW2 (+JPG/PNG) and omit TIFF input; raw-negative-converter.html:58/:92/:115-120 additionally lists CR3, NRW, PEF, SRW, TIFF and 'several other RAW-like formats'. The app's file picker (index.html:254) and RAW_LIKE_EXTENSIONS accept 22 extensions (.cr3, .c…  
  _Suggested fix:_ Make imageFileLoaders.js RAW_LIKE_EXTENSIONS (plus a small `formatCatalog.js` with vendor names) the single source and render the format table/badges/llms.txt lines from it at build; at minimum align guide.html:471/:498/:524-531, llms.txt:14, pricing.md:28 and index.html:49/:53 w…

- **low/i18n** — download.html is lang="zh" with English head metadata, Chinese static body, hreflang en only, and a runtime title that drops the brand  
  `negative2positive/download.html:2`  
  The head says this is an English page (English title/description, `hreflang="en"` + x-default) while the root element is lang="zh" and every static string in the body is Chinese (h1 '离线版下载', hero, notes 472-475). applyI18n() rewrites `documentElement.lang`, the title and all data-i18n text at runtime, so JS-capable crawlers see English and non-JS fetchers see Chinese with an English title; both di…  
  _Suggested fix:_ Author the static markup in English with lang="en" (matching the hreflang the head already declares) and let the script switch to zh/ja; keep the brand in docTitle ('Offline Download | Negative Converter'). In check-seo-heads.mjs add: `<html lang>` must equal the language of the …

- **low/quality** — Each page embeds two anonymous Organization nodes instead of referencing the #org entity; download.html SoftwareApplication points downloadUrl at itself with no version  
  `negative2positive/raw-negative-converter.html:35`  
  Every Article page repeats `{"@type":"Organization","name":"NegativeConverter"}` inline as both author and publisher (2 per page, 8 pages), and index.html defines the canonical `#org` node plus another inline creator copy. Search engines cannot tell these are the same entity as `https://negative-converter.tokugai.com/#org` (the only node with sameAs -> GitHub), weakening entity consolidation. down…  
  _Suggested fix:_ Use `"author": {"@id": "https://negative-converter.tokugai.com/#org"}` / `"publisher": {"@id": ...}` everywhere and include one Organization node with `@id`, `sameAs` and `logo` per page (from the shared head partial). For download.html emit `softwareVersion` and `downloadUrl` pe…

- **low/security** — Desktop ('offline') app contacts api.github.com on every launch via the star-count script _(verified)_  
  `negative2positive/index.html:1348`  
  The inline star-count script runs in the Tauri webview as well as on the web; unlike analytics.js it has no `window.__TAURI__` guard. Every desktop launch (until the 6-hour localStorage cache) sends the user's IP and UA to GitHub, contradicting download.html's 'no internet required' / privacy claims and the Mac App Store listing, and it is wasted work because the header copyright block it renders …  
  _Suggested fix:_ Add `if (window.__TAURI__) return;` at the top of loadGithubStars() (Tauri injects the global before page scripts run because withGlobalTauri is enabled), or move the logic into main.js behind isTauriDesktop().

- **low/ux** — All download and fallback links are hidden until JS succeeds; init() runs history.replaceState before wiring anything, so any early exception leaves a page with no links at all  
  `negative2positive/download.html:461`  
  The Mac App Store / GitHub fallback block is `display:none` in static markup and only revealed by renderDownloads() or the catch branch. init() first calls applyI18n(), which ends with `history.replaceState` to add `?lang=`; that throws SecurityError on a file:// origin (the privacy page explicitly invites users to download the source and run it locally) and t() relies on `String.prototype.replace…  
  _Suggested fix:_ Render the fallback links visible in static HTML (hide them only after a successful renderDownloads), add a `<noscript>` with the same links, wrap the replaceState in try/catch and move it after the fetch/wiring, and wire buttons before applyI18n so a locale error cannot disable …

- **low/ux** — Both 4-column tables in guide.html overflow a 360px viewport and force horizontal page scrolling  
  `negative2positive/guide.html:514`  
  Rendered the built guide.html in Chrome inside a 360px-wide frame: the formats table (line 514) is 360px and the comparison table (line 619) is 412px wide inside a 324px content column; documentElement.scrollWidth is 430px, so the whole page pans sideways on a phone and the right-hand 'Bit depth' / 'FilmLab' columns are cut off until the user drags. The table's own `overflow: hidden` (line 342) on…  
  _Suggested fix:_ Wrap each `<table>` in `<div class="table-wrap">` with `.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}` (do the same in seo-content.css for future landing tables), or add `@media (max-width:600px){ table{display:block;overflow-x:auto;white-space:nowrap} }`. Keep bo…

- **low/ux** — 'Machine-readable pricing' card sends human visitors to a raw markdown text dump  
  `negative2positive/negative-lab-pro-alternative.html:135`  
  The Related-guides grid links /pricing.md. Vercel serves it as text/markdown and Chrome renders it as unstyled plain text starting with '# Pricing — Negative Converter' — no header, no navigation, no way back, on a page positioned as a conversion aid against a paid competitor. It also gives search engines a duplicate, un-styled 'free / no account' page competing with the HTML pages (and it is list…  
  _Suggested fix:_ Point the card at a human page (e.g. guide.html#why or a small pricing.html rendered from pricing.md at build), keep pricing.md only as the llms.txt target, and remove it from sitemap.xml.


## Other

- **medium/memory** — Every full-resolution render materialises, transfers and retains a 16-bit output plane (8 bytes/px) that no code path reads, including for 8-bit JPEG sources where it is fabricated by x257 _(verified)_  
  `negative2positive/src/app/conversionWorkerClient.js:77`  
  The adapter always attaches an output plane (silverAdapter.js:264-265), the worker always transfers it back (conversionWorker.js:41-44) and the client always re-wraps it as `out.__image16` (conversionWorkerClient.js:77-83). applyProcessedImageToState then keeps it on `state.processedImageData` and downsampleImageDataByStep copies it again into previewSourceImageData, histogramSourceImageData and w…  
  _Suggested fix:_ Make the output plane opt-in: pass `options.wantImage16` only from the export path (once finding 2 lands) and from any future 16-bit consumer; in the worker skip `payload.image16` and in the adapter skip `result.__image16` when it is not requested; never copy the plane into the p…

- **medium/perf** — Every full-resolution render structured-clones the whole source into the worker and defeats silverAdapter's input-buffer reuse cache, so three full-size 16-bit buffers are reallocated/refilled per render _(verified)_  
  `negative2positive/src/app/conversionWorkerClient.js:59`  
  convertFrameInWorker posts `src16.data.buffer` (16-bit sources) or `imageData.data.buffer` (8-bit sources) with no transfer list, so every full render — scheduled after every slider commit via scheduleFullResolutionRender (main.js 4834-4849) and on export — synchronously structured-clones the entire source on the main thread: 720 MB for a 90 MP 16-bit scan, 96 MB (8-bit) / 192 MB (16-bit) at 24 MP…  
  _Suggested fix:_ Keep the source resident in the worker: post the 16-bit source once with a sourceId (transferring a one-off copy) and have later messages send only {sourceId, settings, options}; in the worker keep the upcast Uint16 plane keyed by sourceId so toImage16 does not re-run fromImageDa…

- **medium/perf** — Full-resolution sprocket frame is recomposed with per-pixel procedural noise on the main thread for every full render and export _(verified)_  
  `negative2positive/src/app/sprocketFrame.js:386`  
  When sprocket preview is on, the non-fast path in renderAdjustedImageDataToMainCanvas (main.js 3100) and applySprocketFrameForExport (8975-8978) call composeSprocketFrame on the full-res image. createSprocketFrameImageData (1144-1178) allocates a new output buffer, fillFilmBase (378-408) first fills the whole output (including the photo region that copyPhotoRegion overwrites), then paintSpan evalu…  
  _Suggested fix:_ Cache the composed background per (sourceWidth, sourceHeight, edge options) at full resolution too (reuse ensureSprocketPreviewFrameBackground's cache with a full-size key) and only copyPhotoRegion into a copy of it; drop the initial whole-buffer fill; generate the noise on a til…

- **low/a11y** — Focus ring removed on the JPEG quality slider and weakened on selects/number inputs; .recommended-action outline masks the focus ring  
  `negative2positive/src/styles/app.css:3431`  
  The global :focus-visible ring (2px cyan, line 100-104) is good, but: (1) .export-quality-slider sets outline:none unconditionally, so keyboard focus on the quality slider is completely invisible. (2) .preset-select:focus, .film-edge-color-input:focus, .lens-field input/select:focus, .autoframe-row select:focus and .slider-number-input:focus all set outline:none and rely on a 1px border-color chan…  
  _Suggested fix:_ Delete outline:none from .export-quality-slider. Change the :focus rules to :focus:not(:focus-visible) so mouse clicks keep the subtle border while keyboard focus falls through to the global ring (or add box-shadow: 0 0 0 2px var(--info-glow)). Express .recommended-action's highl…

- **low/bug** — DX edge-code parity bar is computed over the numeric sum of the fields instead of the set-bit count, and frame numbers above 63 are silently clamped in the barcode while the printed number shows 64-99 _(verified)_  
  `negative2positive/src/app/sprocketFrame.js:847`  
  A parity bit protects the number of set bits, but the code tests (dx1 + dx2 + frame + aFlag) % 2. Probe: dx1=64 dx2=0 frame=0 has 1 set bit but no parity bar; dx1=3 dx2=0 frame=0 has 2 set bits but gets a bar; dx1=82 dx2=3 frame=18 happens to agree, which is why sprocketFrame.test.mjs (line 221-222) passes. Line 844 encodes clampInt(frameNumber, 0, 63) although normalizeSprocketEdgeMarkings allows…  
  _Suggested fix:_ Compute parity from the popcount of the encoded bits (dx1 7 bits, dx2 4 bits, frame 6 bits, aFlag) and cap frameNumber at 63 in normalizeSprocketEdgeMarkings when dxEnabled (or show a UI note). Add test cases for dx1=64 and dx1=3.

- **low/bug** — Preview and full-quality saturation/vibrance use different colour math, so the interactive preview does not match the export  
  `negative2positive/src/workers/pixelAdjustments.js:166`  
  When doHsl is true, quality==='preview' scales chroma around luma using HSV saturation (`(max-min)/max`), while 'full' converts to HSL, adjusts s, and converts back. These produce visibly different hue/lightness for saturated colours. main.js renders the interactive preview with 'preview' (4385) and exports with 'full' (9324, 9331), and stripLegacyToneSettingsForSilverCore zeroes `saturation` but …  
  _Suggested fix:_ Use one formula for both qualities (the luma-chroma scale is cheaper and adequate; if the HSL result is preferred, use it for preview too — the preview is only 250 k pixels). Also decide whether vibrance/CMY should be stripped under SilverCore like saturation is.

- **low/bug** — Save panel result is rewritten after the user chose it, which the App Store sandbox rejects and which ignores the extension the user typed  
  `src-tauri/src/lib.rs:93`  
  `pick_export_file_path` and `save_export_file` pass the NSSavePanel/IFileDialog result through `normalize_export_path`, which appends the suggested extension when the chosen name has none. No rfd filter is set, so the panel does not enforce an extension itself. Under the Mac App Store build (Entitlements.mas.plist grants only `files.user-selected.read-write`), the powerbox grants write access to e…  
  _Suggested fix:_ Let the dialog enforce the extension instead of rewriting the result: call `rfd::FileDialog::new().add_filter("ZIP archive", &["zip"])` (and `png`/`jpg`/`tiff` for single exports, passing the format from JS) so NSSavePanel's allowedContentTypes / the Windows filter append the ext…

- **low/bug** — xdg-open inherits the AppImage's GIO/GTK environment overrides, so the host browser launched for the update page can misbehave; spawned children are never reaped  
  `src-tauri/src/lib.rs:521`  
  `open_url_with_system_browser` spawns `xdg-open` with the full process environment. Inside the AppImage that environment already contains the app's own guards (`GIO_MODULE_DIR=<empty temp dir>`, `GIO_USE_VFS=local`, possibly `WEBKIT_DISABLE_DMABUF_RENDERER=1`, lines 222-243/401-403) plus the linuxdeploy GTK hook's `GTK_PATH`, `GTK_IM_MODULE_FILE`, `GDK_PIXBUF_MODULE_FILE`, `GSETTINGS_SCHEMA_DIR`, …  
  _Suggested fix:_ Before spawning the browser, scrub the injected variables: `.env_remove("GIO_MODULE_DIR").env_remove("GIO_EXTRA_MODULES").env_remove("GIO_USE_VFS").env_remove("GTK_PATH").env_remove("GTK_IM_MODULE_FILE").env_remove("GDK_PIXBUF_MODULE_FILE").env_remove("GSETTINGS_SCHEMA_DIR").env_…

- **low/i18n** — Default 'edgePixel' font renders every non-ASCII character as '?', so Japanese/Chinese film names typed by ja/zh users come out as '?????' on the film edge _(verified)_  
  `negative2positive/src/app/sprocketFrame.js:561`  
  getGlyphRows falls back to BITMAP_FONT['?'] for any character outside A-Z, 0-9 and a few punctuation marks; drawBitmapText upper-cases and then paints '?' for each glyph. The app ships zh/ja UIs (i18n.js) and the edge-text input is free text (index.html sprocket edge controls, default 'KODAK PORTRA 160'). With the default fontStyle 'edgePixel' a user entering 'フジカラー 400' or '柯达' gets a row of ques…  
  _Suggested fix:_ In drawEdgeText, if the text contains any character not in BITMAP_FONT, fall through to drawCanvasText (which already handles arbitrary Unicode) and only use the bitmap glyphs for the covered set; add a test with a CJK string asserting no '?' glyph is painted.

- **low/memory** — PNG16 encoder concatenates the whole file into one extra Uint8Array instead of handing chunks to Blob  
  `negative2positive/src/workers/imageEncoders.js:77`  
  After deflating the 8 B/px raw buffer, encodePng16Blob allocates `png` of the full file size and copies signature/IHDR/IDAT/IEND into it before `new Blob([png])`. Blob accepts an array of parts, so the copy is pure overhead (hundreds of MB for large scans, on top of `raw` + `compressed`). It also writes RGBA (colour type 6) although alpha is constant, inflating the raw buffer and the file by 25%. …  
  _Suggested fix:_ `return new Blob([signature, ihdrChunk, idatChunk, iendChunk], { type: 'image/png' })`, use colour type 2 (RGB, rowBytes = width*6), and consider a PNG filter (Sub/Up) for materially better compression.

- **low/memory** — TIFF encoder builds the strip in a temp buffer and then copies it into the file buffer (2× file size), and writes a redundant alpha channel  
  `negative2positive/src/workers/imageEncoders.js:99`  
  encodeTiffBlob allocates `pixelData` (w*h*4*bytesPerSample), fills it, then allocates `out` of the same size + header and `out.set(pixelData, 8)`. For a 90 MP 16-bit export that is 720 MB + 720 MB live in the worker at once. The alpha sample is always 255/65535 (the adjustment stage forces alpha to 255) but is still written with SamplesPerPixel=4 and ExtraSamples=1 (associated alpha), making files…  
  _Suggested fix:_ Write samples straight into `out` at offset 8 (pass a subarray to the conversion loop), emit 3 samples per pixel (drop ExtraSamples), and add XResolution/YResolution (e.g. 300/1 RATIONAL) + ResolutionUnit=2. Export the encoder from one module and import it in both the worker and …

- **low/memory** — Crashed export worker is nulled but never terminated; rejected requests also leak pending entries on postMessage failure  
  `negative2positive/src/workers/workerBridge.js:18`  
  On `onerror` the bridge rejects pending requests and sets `worker = null` without calling `terminate()`, so the crashed (but still alive) worker and its heap survive until page unload while a new one is created on the next call. In sendToWorker a synchronous `postMessage` failure (DataCloneError from a non-cloneable setting) rejects the promise but leaves the id in `pending` forever. conversionWor…  
  _Suggested fix:_ Call `worker.terminate()` before nulling in onerror, and wrap postMessage in try/catch that deletes the pending entry before rejecting.

- **low/quality** — Hard high/medium switch changes the applied correction by a third (0.9 vs 0.6 damping) and the verdict is computed from different sample sets in the interactive (250k-pixel preview) and batch (full-res) paths _(verified)_  
  `negative2positive/src/app/autoWhiteBalance.js:229`  
  The same raw estimate is damped at 0.9 when 'high' and 0.6 when 'medium'; e.g. raw wbB=1.35 -> 1.310 vs 1.197, raw 1.20 -> 1.178 vs 1.116. The verdict flips on hard thresholds (coverageHigh 0.02, magnitudeHigh log 1.35, disagreementHigh 0.035), and main.js runs the estimator on state.previewSourceImageData (a 250k-pixel step-downsample, main.js:4574) for viewed files but on the full-resolution pro…  
  _Suggested fix:_ Make the strength continuous (interpolate 0.6..0.9 from the distance to the 'high' thresholds) and run both paths on the same downsampled source (downsampleImageDataForMaxPixels(processed, 250_000)) before dust removal so viewed and unviewed files agree.

- **low/quality** — Dead CSS: .step2-guide-* (6 selectors), .slider-value-group, .slider-unit, .workflow-guide-note have no markup anywhere  
  `negative2positive/src/styles/app.css:1937`  
  These classes are never emitted by index.html, main.js, fileListView.js or the ui/ modules (grep across src and all HTML pages returns nothing). They belong to the removed Step-2 guide card and an older slider layout, matching the dead i18n keys reported separately. .step2-guide-title/.step2-guide-tip are even re-referenced in the theme override block at 3563-3564.  
  _Suggested fix:_ Delete the listed rule blocks (approx. 1937-1980, 2267-2295, 2511-2520) and the two references at 3563-3564.

- **low/quality** — Late 'theme override' block redefines ~20 earlier selectors, leaving the original declarations dead and contradictory  
  `negative2positive/src/styles/app.css:3455`  
  A block starting at 3455 restyles buttons/toasts/popups by re-declaring selectors that already exist earlier. The original rules are now dead or partially dead, and some pairs contradict: .toast-message is defined three times (2478 sets background rgba(30,30,30,.92)/color #e0e0e0 which 3604 overrides); .toolbar-btn.primary/.footer-btn.primary flat accent (1240, 2485) vs gradient (3497); .footer-bt…  
  _Suggested fix:_ Merge the override values into the original rule blocks (keep one definition per selector), delete the 3455-3655 override layer except for genuinely new selectors, and resolve the two .footer-btn:disabled rules into one. A stylelint run with no-duplicate-selectors would keep it f…

- **low/quality** — LoadingOverlay's cancel button is never enabled, and its label is hard-coded English  
  `negative2positive/src/ui/LoadingOverlay.js:63`  
  The overlay builds a `.loading-cancel-btn` (63-70) and supports `cancelable`/`onCancel`/`cancelText` options (87, 94), but grep finds no `cancelable` in main.js — every `overlay.show()` call passes only `{ title }`. The i18n keys `loadingCancel`/`loadingCancelled` exist in all three languages but are unused, and the fallback label is the literal 'Cancel' (66, 87). This is either an unfinished feat…  
  _Suggested fix:_ Either wire `cancelable: true, cancelText: getLocalizedText('loadingCancel'), onCancel` into the batch-export and heavy-RAW show() calls (and honour it in the loops), or remove the button, the three options and the two i18n keys.

- **low/quality** — Three hand-rolled worker bridges duplicate lifecycle code with different error semantics  
  `negative2positive/src/workers/workerBridge.js:10`  
  conversionWorkerClient.js:7-35, sensorDefectsClient.js:14-63 and workerBridge.js:6-76 each own `let worker / requestId / pending Map / getWorker() / onmessage lookup / onerror reject-all + terminate`. Behaviour diverges: workerBridge returns null on any failure (125-128) and logs nothing; conversionWorkerClient rejects and logs; sensorDefectsClient adds a ping/timeout handshake (65-84) that the ot…  
  _Suggested fix:_ Create `workers/createWorkerClient({ url, name, pingTimeoutMs })` returning `{ request(message, transfer, onProgress), terminate() }` with one implementation of the pending map, crash handling and optional ping; rebuild the three clients on top of it.

- **low/security** — Direct-download macOS entitlements opt out of hardened-runtime protections (dyld env vars, unsigned executable memory, JIT) that the app does not need  
  `src-tauri/entitlements.plist:8`  
  entitlements.plist (used by the non-App-Store Developer ID build via tauri.conf.json bundle.macOS.entitlements) grants `cs.allow-jit`, `cs.allow-unsigned-executable-memory` and `cs.allow-dyld-environment-variables`. Tauri on macOS renders through WKWebView, whose JavaScript/WASM JIT runs in the separate WebContent XPC process, so the host binary needs none of these: `allow-dyld-environment-variabl…  
  _Suggested fix:_ Drop `allow-dyld-environment-variables` and `allow-unsigned-executable-memory` (keep `app-sandbox false`); also try removing `allow-jit`, since WebContent is a separate process. Rebuild with `npm run tauri:build` and run the smoke flow in the desktop DMG — verify it launches and …

- **low/ux** — Sprocket geometry hard-codes a 36x24 gate: X scale comes from width/36 mm and Y scale from the edge band, so non-3:2 inputs get distorted perforations and always ~7.6 holes across _(verified)_  
  `negative2positive/src/app/sprocketFrame.js:175`  
  imagePxPerMmX = sourceWidth / 36 and filmEdgePxPerMmY = bandHeight / 5.49 (with bandHeight = 0.229 * sourceHeight) only agree when the input is 3:2. Probe via getSprocketFrameMetrics: 3000x3000 (a 6x6 or square crop) -> hole 165x350 px, w/h 0.47 vs spec 0.71, pxPerMmX 83 vs pxPerMmY 125; 4000x3000 -> 0.63; a 6500x2400 XPan panorama -> hole 358x280, w/h 1.28 (wider than tall) with 858 px pitch, sti…  
  _Suggested fix:_ Derive a single px/mm from the short side (sourceHeight / 24 mm) and use it for both axes; compute holeCount from the actual width in mm (width / imagePxPerMm / 4.75) instead of assuming 8 per frame, or letterbox non-3:2 inputs into a 3:2 gate. Add a metrics test for a 1:1 and a …

- **low/ux** — Feedback popup has no max-height/scroll, so on short viewports its title and Send/Cancel buttons are cut off; its 13px textarea also triggers iOS focus zoom  
  `negative2positive/src/styles/app.css:2661`  
  `.feedback-popup-overlay` is `position: fixed; inset: 0; align-items: center` with no overflow (2645-2655) and `.feedback-popup` has no `max-height`/`overflow-y` (2661-2671). Verified by emulation at 664x390 (phone landscape): popup top -22px / bottom 412px on a 390px viewport, title clipped above the screen, Cancel/Send at 355-393 partially below it; nothing can be scrolled because the overlay is…  
  _Suggested fix:_ Add `.feedback-popup { max-height: calc(100dvh - 40px); overflow-y: auto; }` (same for `.frontier-guide-popup` and `.batch-progress-modal`) and `align-items: flex-start` on the overlay under `(max-height: 600px)`; set `.feedback-message { font-size: 16px }` inside the <=900px blo…

- **low/ux** — Upload screen relies on the :has() selector to give the preview the full height; unsupported browsers get a half-height placeholder  
  `negative2positive/src/styles/app.css:3722`  
  At <=900px the grid rows are `minmax(220px, 1.08fr) minmax(0, 1fr)` and only the `.app-main:has(> .controls-panel[style*="none"])` rule collapses the second row while the panel is hidden. `:has()` is unsupported in Firefox < 121 (Dec 2023, incl. some Firefox Android builds), Safari/iOS < 15.4 and Chrome < 105; there the empty controls row keeps ~48% of the height and the drop/upload placeholder is…  
  _Suggested fix:_ Toggle a class from JS instead (`appMain.classList.toggle('panel-hidden', controlsPanel.style.display === 'none')` in showImageUI/hide paths) and write the rule as `.app-main.panel-hidden { grid-template-rows: 1fr 0; }`.


## Test coverage

- **medium/test** — settingsSnapshot test fixture is hand-written, already stale (wbAutoConfidence), and cannot detect keys silently dropped by the copier _(verified)_  
  `negative2positive/src/app/settingsSnapshot.test.mjs:6`  
  deepCopySanitizedSettings enumerates fields by hand; any key added to sanitizeSettings() (main.js:3251-3300) but not to the copier is silently dropped from per-file settings, batch 'apply to selected' and cloneSettings. The test's makeSafeSettings() is a second hand-written list that mirrors the copier rather than the producer, so it can never notice an omission - it already lacks `wbAutoConfidenc…  
  _Suggested fix:_ Export a single `SANITIZED_SETTINGS_KEYS` array from settingsSnapshot.js and have both sanitizeSettings (main.js) and the copier iterate it; in the test assert `Object.keys(deepCopySanitizedSettings(fixture)).sort()` deep-equals that list and that no value is `undefined` (`for (c…

- **medium/test** — The engine smoke runs one fixed-parameter invocation (all sliders 0, filmPreset 'none') and never compares two runs, so slider and preset regressions go undetected  
  `negative2positive/src/silvercore/util/silvercore16.smoke.mjs:67`  
  silvercore16.smoke.mjs calls convertColorWithSilverCore exactly once (lines 67-79) with `filmPreset: 'none', brightness: 0, exposure: 0, contrast: 0, temperature: 0, tint: 0` and never runs a second configuration for comparison, so no assertion pins the direction or magnitude of any Step-3 control. Three round-1 engine findings would each be caught by a two-run differential assertion here and each…  
  _Suggested fix:_ Engine level, in silvercore16.smoke.mjs: (a) loop `exposure` over [-300,-100,-50,-36,0,50,300] and `brightness` over [-100,-50,0,50,100], assert `meanLuma16 > 512` and monotonic non-decreasing luma with the slider; (b) run the same input with `temperature: 0` and `temperature: 60…

- **medium/test** — The only test that executes the SilverCore engine is not run by npm test, and its assertions would pass on non-inverted output  
  `negative2positive/src/silvercore/util/silvercore16.smoke.mjs:121`  
  silvercore16.smoke.mjs is the sole test importing silverAdapter/Engine/CurveEngine/ImageProcessor (no *.test.mjs imports any engine module). run-tests.mjs only globs `.test.mjs`, package.json has no script for it, and no workflow/doc references it. It passes today in 12 ms, so it is cheap to wire in. Its three assertions (range in [0,65535], >50% of pixels changed, some sample not a multiple of 25…  
  _Suggested fix:_ Rename to silvercore16.test.mjs (or add `*.smoke.mjs` to the run-tests glob with a SKIP convention). Add an inversion assertion: mean output R of the left column > mean output R of the right column, and output G increasing down Y; assert alpha stays 65535. Keep the sub-8-bit chec…

- **medium/test** — derive-noritsu-lut.mjs writes a profile the adapter refuses; no contract test checks that presets/PROFILES are accepted by the adapter _(verified)_  
  `scripts/derive-noritsu-lut.mjs:152`  
  The script emits resources/profiles/noritsu.bin (196,608 bytes, shipped), EnhancedProfiles.PROFILES lists 'noritsu' and the 'noritsu-lab' preset requests it, but silverAdapter's ENHANCED_PROFILE_SET omits it, so `normalizeEnhancedProfile` maps it to 'none'. The script is therefore effectively dead and the three sources of truth (script, PROFILES, adapter set, preset) can drift silently because no …  
  _Suggested fix:_ Add pipeline/silverAdapter.test.mjs: export `ENHANCED_PROFILE_SET` (or `normalizeEnhancedProfile`) and `buildSilverCoreParams`; assert `PROFILES` is a subset of the set, that for every film preset `normalizeEnhancedProfile(p.settings.enhancedProfile) === p.settings.enhancedProfil…

- **medium/test** — Core conversion math and pipeline adapters have no unit tests; 20 of ~45 non-DOM modules are pure but untested _(verified)_  
  `scripts/run-tests.mjs:19`  
  Inventory of negative2positive/src modules without a colocated *.test.mjs, classified by grepping for document/window/self/Worker/fetch usage. PURE OR NODE-TESTABLE (no browser globals): pipeline/silverAdapter.js (292 lines — param sanitization, film base compensation, mode routing; exports convertColorWithSilverCore/convertBwWithSilverCore/convertPositiveWithSilverCore/invalidateSilverCoreCache),…  
  _Suggested fix:_ Add, in priority order: (1) silverAdapter.test.mjs — feed a synthetic 16x16 ImageData through each mode with edge-case settings (NaN/undefined/out-of-range sliders, every filmPreset id) and assert finite output in range; (2) CurveEngine.test.mjs — for every toneProfile assert LUT…

- **medium/test** — Smoke never exercises RAW decode, 16-bit/TIFF export, dust removal, lens correction, undo/redo, film presets, Step-3 sliders or language switching _(verified)_  
  `scripts/smoke-test.mjs:184`  
  The flow is: load 8-bit JPEG -> auto-frame click -> convert -> curve drag -> batch of two JPEGs -> individual PNG download. Export runs with the defaults (`exportFormat: 'png', exportBitDepth: 8`, main.js:2025-2026), so the 16-bit PNG/TIFF encoders, the __image16 plane, the RAW loaders (libraw-wasm, nefJpegPreview, sensorDefects), dust detection/inpainting, lensfun, undo/redo, film presets and eve…  
  _Suggested fix:_ Add scenarios behind flags so the base run stays fast: (1) click `.bitdepth-btn[data-bitdepth="16"]` + TIFF and single export, decode with UPNG/UTIF and assert depth 16 and a non-x257 sample; (2) move `#coreExposure` to -50/-300 and assert luminance > 3; (3) pick a preset then mo…

- **medium/test** — Smoke never exercises the streaming ZIP export it claims to verify; deleting showSaveFilePicker forces the individual-PNG fallback and the export check is only magic bytes and >=10 KB _(verified)_  
  `scripts/smoke-test.mjs:299`  
  The header comment promises 'export ZIP (real download, verified with JSZip)', but the script deletes `window.showSaveFilePicker`, so `exportBatchAsZipBrowser` takes the `!canUseBrowserZipStreaming(window)` branch and calls `exportBatchIndividuallyBrowser()` (main.js:9727-9736). JSZip is never imported by the smoke. ZipStoreWriter, createBrowserZipWritable and the ZIP naming/collision logic are un…  
  _Suggested fix:_ Instead of deleting the picker, install a fake: `window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: c => chunks.push(c), close: () => {}, abort: () => {} }) })` collecting chunks in-page; after export, read the bytes back, parse with JSZip (already a…

- **low/quality** — Eight files each hand-roll a permissive globalThis.ImageData shim that skips the browser's length/type validation _(verified)_  
  `negative2positive/src/app/exportImageEncoders.test.mjs:5`  
  exportImageEncoders.test.mjs:5, filmBaseDetection.test.mjs:12, imageDataOps.test.mjs:12, sprocketFrame.test.mjs:17, workerBridge.test.mjs:31, silvercore16.smoke.mjs:19, eval-autoframe.mjs:30 and eval-dust.mjs:17 each define `class ImageData { constructor(data, width, height) { this.data = data; ... } }`. A real ImageData throws when `data` is not a Uint8ClampedArray or `data.length !== width*heigh…  
  _Suggested fix:_ Create negative2positive/test-helpers/imageDataShim.mjs exporting `installImageDataShim()` that throws `RangeError` unless `data instanceof Uint8ClampedArray && data.length === width*height*4` (mirroring the DOM constructor), and import it at the top of every test/eval/smoke that…

- **low/test** — ZipStoreWriter test covers only a 3-entry success path; abort(), the ZIP32 limit guards, duplicate names and canUseBrowserZipStreaming are untested _(verified)_  
  `negative2positive/src/app/zipStoreWriter.test.mjs:56`  
  The test adds three small blobs, closes, and re-reads with JSZip. It never calls `abort()`, never drives `ensureZipU32`/`ensureZipU16` (the code round 1 found throws mid-batch and discards already-written entries), never adds the same name twice (round 1: duplicate entries from RAW+JPEG pairs), and does not touch the exported `canUseBrowserZipStreaming`. Since the smoke does not reach the streamin…  
  _Suggested fix:_ Add cases: `addBlob('a.png')` twice -> assert it throws (or auto-suffixes) rather than writing two entries; `writer.position = 0xFFFF_FFF0` then `addBlob` -> assert it throws before any byte is written and `writable.chunks.length` is unchanged; `abort()` -> `writable.aborted === …

- **low/test** — jpegSize.test.mjs duplicates nefJpegPreview.test.mjs under a non-existent module name with a stale rationale, and pins a threshold that makes the extractor's own size check dead  
  `negative2positive/src/silvercore/util/jpegSize.test.mjs:4`  
  There is no jpegSize.js in silvercore/util; the test reaches into ../../app/nefJpegPreview.js and re-tests readJpegDimensionsFromSOF, which nefJpegPreview.test.mjs already covers. Its header says it imports the function directly 'to avoid pulling in utif at module-load time', but nefJpegPreview.js imports nothing (its own header says it eliminated the UTIF dependency). Test 9 asserts the dimension…  
  _Suggested fix:_ Fold the unique cases (SOF at a non-zero offset, SOF2, truncated-before-SOF, bad args) into nefJpegPreview.test.mjs and delete jpegSize.test.mjs. Move the size threshold out of readJpegDimensionsFromSOF into extractNefPreviewJpeg (single check) and update the test to assert the r…

- **low/test** — Auto-frame step asserts only that OpenCV loaded, not that a frame was detected or applied _(verified)_  
  `scripts/smoke-test.mjs:199`  
  After clicking #autoFrameBtn the script waits for `window.cv.Mat` and logs 'auto-frame analysis ran'. `applyAutoFrameToCurrent()` is fire-and-forget (main.js:7525-7527); a detection that returns null, throws inside its promise chain, or declines on low confidence leaves the DOM unchanged and the smoke passes. The whole autoFrameAnalyzer (1,430 lines) therefore has no end-to-end assertion, and the …  
  _Suggested fix:_ Record canvas dimensions / the crop overlay before the click and wait for a visible outcome: the auto-frame toast text (i18n `autoFramePreviewDetail`) or a change in `#mainCanvas.width/height`; fail if neither appears within 30 s. For determinism, add a fixture with a clear frame…
