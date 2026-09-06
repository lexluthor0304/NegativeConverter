// Worker 成功時は主スレッド側の OpenCV を初期化しない。
// 「候補なし」は正常な結果なのでフォールバックで同じ探索を繰り返さない。
export async function detectFrameWithFallback(image, options, {
  workerSupported, analyzeInWorker, ensureOpenCvReady, analyzeOnMainThread, onWorkerError = () => {}
}) {
  if (workerSupported) {
    try { return await analyzeInWorker(image, options); }
    catch (error) { onWorkerError(error); }
  }
  if (!await ensureOpenCvReady()) return null;
  return analyzeOnMainThread(image, options);
}
