// Worker 成功時は主スレッド側の OpenCV を初期化しない。
// 「候補なし」は正常な結果なのでフォールバックで同じ探索を繰り返さない。
export async function detectFrameWithFallback(image, options, {
  workerSupported, analyzeInWorker, ensureOpenCvReady, analyzeOnMainThread, onWorkerError = () => {}
}) {
  if (workerSupported) {
    try { return await analyzeInWorker(image, options); }
    catch (error) {
      // A superseded request must not restart the search on the main thread.
      if (error?.name === 'AbortError') throw error;
      onWorkerError(error);
    }
  }
  if (!await ensureOpenCvReady()) return null;
  return analyzeOnMainThread(image, options);
}

/**
 * The import analyses of one decoded frame (#251): frame detection
 * (`frame`: analyzer options, or null to skip it) and the film-edge read
 * (`filmEdge: true`), in one worker request on one buffer (see
 * autoFrameWorkerClient analyzeImport), with today's fallbacks: a part the
 * worker cannot run, or that failed there, runs on the main thread; a
 * missing OpenCV means no detection. An `owned` frame is transferred to the
 * worker; when its planes are lost with a failed request, `reload()` decodes
 * it again before anything reads it, so a detached buffer is never
 * analysed.
 *
 * Resolves { image, reloaded, detection, read }:
 * - image: the frame to use from now on (the rebuilt or reloaded one when
 *   owned, else the input); `reloaded` when it is a new decode;
 * - detection: undefined when not asked, else { result } or { error } (the
 *   main-thread analysis threw, or the frame could not be reloaded);
 * - read: undefined when not asked, else { result } or null when the reader
 *   failed.
 * Only an abort rejects.
 */
export async function runImportAnalyses(image, { frame = null, filmEdge = false, owned = false, signal = null } = {}, {
  frameWorkerSupported, edgeWorkerSupported, analyzeImport, ensureOpenCvReady, analyzeOnMainThread, readOnMainThread,
  reload = null, onWorkerError = () => {}, onReadError = () => {}
}) {
  const inWorker = { frame: Boolean(frame && frameWorkerSupported), edge: Boolean(filmEdge && edgeWorkerSupported) };
  let current = image;
  let outcome = null;
  if (inWorker.frame || inWorker.edge) {
    outcome = await analyzeImport(current, {
      frame: inWorker.frame ? frame : null, filmEdge: inWorker.edge ? {} : null, owned, signal
    });
    current = outcome.image;
  }
  // Whatever the main thread still has to read needs intact planes.
  const needsMainThread = (frame && (!inWorker.frame || outcome.frameError)) || (filmEdge && (!inWorker.edge || outcome.filmEdgeError));
  let reloadError = null;
  let reloaded = false;
  if (outcome?.imageLost && needsMainThread) {
    try { current = reload ? await reload() : null; }
    catch (error) { current = null; reloadError = error; }
    if (!current) reloadError ||= new Error('The frame was lost with the worker and could not be decoded again');
    reloaded = Boolean(current);
  }
  const result = { image: current, reloaded };
  if (frame) {
    if (inWorker.frame && !outcome.frameError) result.detection = { result: outcome.frame };
    else {
      if (inWorker.frame) onWorkerError(outcome.frameError);
      if (reloadError) result.detection = { error: reloadError };
      else {
        try { result.detection = { result: await ensureOpenCvReady() ? await analyzeOnMainThread(current, frame) : null }; }
        catch (error) {
          if (error?.name === 'AbortError') throw error;
          result.detection = { error };
        }
      }
    }
  }
  if (filmEdge) {
    if (inWorker.edge && !outcome.filmEdgeError) result.read = { result: outcome.filmEdge };
    else {
      if (inWorker.edge) onReadError(outcome.filmEdgeError);
      if (reloadError) result.read = null;
      else {
        try { result.read = { result: await readOnMainThread(current) }; }
        catch (error) {
          onReadError(error);
          result.read = null;
        }
      }
    }
  }
  return result;
}
