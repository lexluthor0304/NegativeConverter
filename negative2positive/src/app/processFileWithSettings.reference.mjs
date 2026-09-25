// processFileWithSettings as it was on perf229/251 (#251 on 7d61dec, the
// integration tip #247 started from), frozen for
// processFileWithSettings.parity.test.mjs: the export branch must stay the
// same once #247 is combined with #251. Two backticks in comments became
// quotes.
export const HEAD_PROCESS_FILE_WITH_SETTINGS = String.raw`
    async function processFileWithSettings(file, savedSettings, options = {}) {
      const isCurrent = options.isCurrent || (() => true);
      const previewMax = Math.max(0, Number(options.previewMaxDimension) || 0);
      // Batch jobs run without the blocking "Detecting frame" overlay and its
      // frame wait: they must keep going in a hidden window (#241). Detection
      // inputs, thresholds and geometry are the same either way.
      const silent = options.silent ?? Boolean(previewMax);
      const ownedPlanes = Array.isArray(options.ownedPlanes) ? options.ownedPlanes : null;
      // A plane this call allocated: stamped, and exposed to the caller.
      const own = (plane, input = null) => {
        if (!plane || plane === input) return plane;
        if (input) {
          const inputBuffers = planeBuffersOf(input);
          if (planeBuffersOf(plane).some((buffer) => inputBuffers.includes(buffer))) return plane;
        }
        markOwnedPlanes(plane);
        ownedPlanes?.push(plane);
        return plane;
      };
      const trace = createPerfTrace('processFileWithSettings', {
        file: file?.name || '',
        bytes: file?.size || 0
      });
      // Load the image
      let imageData = options.sourceImageData || own(await loadFileToImageData(file, { filmStats: !savedSettings }));
      assertRepairCurrent(isCurrent);
      options.onDecoded?.(imageData);
      trace.mark('load', {
        pixels: getImageDataPixelCount(imageData)
      });

      // Use saved settings or create default with auto-detect.
      // Geometry is per-file and must never leak in from whichever frame
      // happens to be on screen: sanitizeSettings substitutes the fallback
      // whenever cropRegion / autoFrameMeta are null, which is exactly what a
      // never-cropped file carries, so the live crop would be stamped onto
      // every other frame in the roll.
      const studioColors = state.fileQueue.find(item => item.file === file)?.studioColors;
      let initialSettings = savedSettings || mergeStudioColors(createDefaultSettings(imageData, state.fileQueue.find(item => item.file === file)), studioColors || {});
      const detectFrame = !initialSettings.autoFrameMeta && !initialSettings.cropRegion
        && !expiredImportKeepsFullFrame(initialSettings) && state.autoFrame.enabled;
      const readEdge = !initialSettings.filmEdge?.checked;
      if (detectFrame || readEdge) {
        // Frame and film edge in one worker request (#251). A decode this
        // call made itself, which nothing else has seen, goes there without
        // a copy and comes back as a new ImageData over the same buffer.
        const owned = !options.sourceImageData && !options.onDecoded;
        const analysed = await runImportDetections(imageData, {
          frame: detectFrame, filmEdge: readEdge, owned, silent, frameFilmType: initialSettings.filmType,
          reload: owned ? () => loadFileToImageData(file, { filmStats: !savedSettings }) : null
        });
        if (!analysed.image) throw analysed.detection?.error || new Error('The frame could not be decoded again');
        if (analysed.image !== imageData) {
          const stamped = ownedPlanes ? ownedPlanes.indexOf(imageData) : -1;
          if (stamped >= 0) ownedPlanes.splice(stamped, 1);
          imageData = own(analysed.image);
        }
        assertRepairCurrent(isCurrent);
        if (detectFrame) {
          initialSettings = await analyzeStudioImportFrame(imageData, initialSettings, { allowCrop: !savedSettings, detection: analysed.detection });
        }
        if (readEdge) {
          const edge = await mergeImportFilmEdge(imageData, initialSettings, analysed.read, { applyDefaults: !savedSettings && state.importFilmTypeAuto });
          if (edge) initialSettings = edge.settings;
        }
      }
      if (!savedSettings) {
        const queued = state.fileQueue.find(item => item.file === file);
        initialSettings = await learnedImportSettings(settleImportFilmType(queued, initialSettings), queued);
      }
      assertRepairCurrent(isCurrent);
      const settings = sanitizeSettings(initialSettings, {
        fallbackSettings: { ...state, cropRegion: null, autoFrameMeta: null, rotationAngle: 0, mirrored: false }
      });

      // Geometry chain (base -> rotation -> mirror -> crop). One pass that
      // only resamples the cropped window: rotating a whole 24 MP scan to keep
      // a 5 MP frame of it was the largest main-thread block per file.
      const geometry = {
        rotationAngle: Number.isFinite(settings.rotationAngle) ? settings.rotationAngle : 0,
        mirrored: Boolean(settings.mirrored),
        cropRegion: settings.cropRegion || null
      };
      // In the geometry pool: batch lanes, the contact sheet and the thumbnail
      // lane no longer queue on the main thread for this step (#244). The
      // auto-frame worker sends no rotated frame back (#251), so this is the
      // file's one rotation.
      let workingData = own(await renderGeometryChain(imageData, geometry, { isCurrent, maxInFlight: options.geometryBands }), imageData);
      workingData = own(await applyLensCorrectionWithSettings(workingData, settings, { updateUi: false }), workingData);
      assertRepairCurrent(isCurrent);
      const fullWorkingShortSide = Math.min(workingData.width, workingData.height);
      // Lensfun's repair mapping is expressed in native working pixels.
      // Downsampling drops that map; reusing it unscaled would also misplace
      // strokes. Keep this combination native until repair, then shrink only
      // the final adjusted thumbnail. Other previews retain the small path.
      const nativeMappedRepair = Boolean(workingData.__lensMapping && settings.repairStrokes?.length);
      const reducedPreview = Boolean(previewMax && !nativeMappedRepair);
      if (reducedPreview) workingData = downsampleImageDataForMaxDim(workingData, previewMax);
      trace.mark('transform', {
        pixels: getImageDataPixelCount(workingData)
      });
      // The linear DNG wants the geometry-applied negative, not the conversion.
      if (options.stage === 'source') {
        trace.end({ outputPixels: getImageDataPixelCount(workingData) });
        if (!savedSettings) {
          const item = state.fileQueue.find((entry) => entry.file === file);
          if (item) item.settings = cloneSettings(settings);
        }
        return { source: workingData, settings };
      }

      // Convert negative/positive via unified conversion router (in a worker
      // when available — keeps batch export from freezing the page).
      // Every batch file is a new source, so it needs its own histogram
      // analysis. Without forceFullProcess the adapter reuses the cached
      // engine whenever the dimensions match and rebuilds the LUTs from the
      // PREVIOUS frame's black/white points, so a thin negative in a roll of
      // same-size scans is levelled against its neighbour.
      // A batch export brings its own pooled workers (options.convert).
      const convert = typeof options.convert === 'function' ? options.convert : convertFrameOffMainThread;
      // 'sourceRole' states what happens to the working plane afterwards
      // (#250): 'base' is read again below (analysis region, brush mapping,
      // expired rescue); 'derived' (a geometry or lens output) is not, only
      // its dimensions and '__lensMapping' are. A batch export's convert may
      // lend the one and hand over the other; every other convert ignores it.
      const baseBuffers = planeBuffersOf(imageData);
      const sourceRole = workingData !== imageData && !planeBuffersOf(workingData).some((buffer) => baseBuffers.includes(buffer))
        ? 'derived' : 'base';
      let processed = own(await convert({
        imageData: workingData,
        settings: buildRouterSettings(settings, imageData),
        options: { preview: reducedPreview, forceFullProcess: true, analysisImageData: getColorAnalysisSample(settings, imageData) },
        sourceRole
      }), workingData);
      assertRepairCurrent(isCurrent);
      trace.mark('convert', {
        pixels: getImageDataPixelCount(processed)
      });

      // Apply dust removal if enabled (full resolution for export)
      const dustRemoval = options.dustRemoval || state.dustRemoval;
      if (dustRemoval && dustRemoval.enabled && processed) {
        const strength = Number.isFinite(dustRemoval.strength) ? dustRemoval.strength : state.dustRemoval.strength;
        let maxParticleSize = Number.isFinite(dustRemoval.maxParticleSize)
          ? dustRemoval.maxParticleSize
          : state.dustRemoval.maxParticleSize;
        const processedShortSide = Math.min(processed.width, processed.height);
        if (previewMax && processedShortSide > 0 && processedShortSide < fullWorkingShortSide) {
          maxParticleSize = Math.max(3, Math.round(maxParticleSize * processedShortSide / fullWorkingShortSide));
        }
        const { mask, particleCount } = await detectDustOffMainThread(processed, { strength, maxParticleSize }, null, isCurrent, options.dustWorker);
        const dustSource = processed;
        // Batch lanes and thumbnails reuse the open photo's tiles but never
        // evict them (lookups only).
        if (particleCount > 0) processed = own(await withAiRepairTurn(() => inpaintForCommit(dustSource, mask, isCurrent, options.dustWorker, { memoInsert: false })), dustSource);
        trace.mark('dustRemoval', {
          pixels: getImageDataPixelCount(processed)
        });
      }

      if (settings.repairStrokes?.length) {
        const brushSource = processed;
        processed = own(await withAiRepairTurn(() => inpaintManualBrush(brushSource, settings, imageData, workingData.__lensMapping, isCurrent, { memoInsert: false })), brushSource);
      }

      // Never-viewed batch files carry default settings — give them the same
      // automatic gray point a viewed file would get, baked into the settings
      // BEFORE the adjustment stage (which may run in the export worker).
      // Saved settings are always respected as-is: they already hold manual,
      // auto, or roll-applied gains.
      if (
        (!savedSettings || state.fileQueue.find(item => item.file === file)?.automaticSettings)
        && !settings.wbUserOverride
        && !settings.wbSemanticApplied
        && processed
        && usesSilverCoreConversion(settings)
        && sanitizePresetType(settings.filmType || 'color') === 'color'
        && !settings.grayPointSampled
        && !settings.expiredEnabled
      ) {
        const roi = resolveAnalysisRegion(settings, imageData);
        const estimate = settings.autoFrameMeta?.analysisNeedsReview ? { confidence: 'low' }
          : settings.semanticMap ? estimateAutoWhiteBalance(processed, { anchors: settings.semanticMap })
          : processed.__analysisPreview ? estimateAutoWhiteBalance(processed.__analysisPreview)
          : estimateAutoWhiteBalance(processed, analysisRegionSample(processed, roi));
        if (estimate.confidence !== 'low') {
          settings.wbR = estimate.wbR;
          settings.wbG = estimate.wbG;
          settings.wbB = estimate.wbB;
          settings.wbAutoConfidence = estimate.confidence;
        }
        settings.wbAutoConfidence = estimate.confidence;
        trace.mark('autoWhiteBalance', { confidence: estimate.confidence });
      }

      // Expired-film rescue: a frame the user never opened carries no
      // measurement yet, so take it from this frame's own positive (with the
      // OpenCV fog map when OpenCV is available).
      if (settings.expiredEnabled && !settings.expiredAnalysis && processed) {
        const analysis = await measureExpiredAnalysisForExport(processed, settings, imageData);
        if (analysis) applyExpiredAnalysisDefaults(settings, analysis);
        trace.mark('expiredRescue', { analysed: Boolean(analysis), spatial: Boolean(analysis?.spatial) });
      }

      // A batch export adjusts, composes and encodes the frame itself (#250),
      // so it can hand its planes to the worker without a copy.
      if (options.stage === 'processed') {
        assertRepairCurrent(isCurrent);
        trace.end({ outputPixels: getImageDataPixelCount(processed) });
        options.onPreparedSettings?.(settings);
        if (!savedSettings && options.updateItemSettings !== false) {
          const item = state.fileQueue.find(item => item.file === file);
          if (item) item.settings = cloneSettings(settings);
        }
        return { processed, settings };
      }

      // Apply adjustments (at 16 bits when the export asks for it)
      assertRepairCurrent(isCurrent);
      const adjusted = previewMax
        ? createAdjustedPhotoPreview(processed, buildAdjustmentSettings(settings), { maxSize: previewMax })
        : await applyAdjustmentsWithSettings(processed, settings, { bitDepth: options.bitDepth === 16 ? 16 : 8, bridge: options.bridge });
      if (!previewMax) ownedPlanes?.push(adjusted);
      trace.mark('adjustments', {
        pixels: getImageDataPixelCount(adjusted)
      });
      trace.end({
        outputPixels: getImageDataPixelCount(adjusted)
      });
      assertRepairCurrent(isCurrent);
      options.onPreparedSettings?.(settings);
      if (!savedSettings && options.updateItemSettings !== false) {
        const item = state.fileQueue.find(item => item.file === file);
        if (item) item.settings = cloneSettings(settings);
      }
      return adjusted;
    }`;
