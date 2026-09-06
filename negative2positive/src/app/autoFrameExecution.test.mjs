import assert from 'node:assert/strict';
import { detectFrameWithFallback } from './autoFrameExecution.js';
const image = {}, options = {}, result = { confidence: .9 };
for (const workerSupported of [true, false]) for (const workerResult of [result, null, 'error']) {
  const calls = [];
  const actual = await detectFrameWithFallback(image, options, {
    workerSupported,
    analyzeInWorker: async (source, settings) => {
      assert.equal(source, image); assert.equal(settings, options);
      calls.push('worker');
      if (workerResult === 'error') throw new Error('unavailable');
      return workerResult;
    },
    ensureOpenCvReady: async () => { calls.push('load-main-cv'); return true; },
    analyzeOnMainThread: async () => { calls.push('main'); return result; },
    onWorkerError: () => calls.push('error'),
  });
  if (!workerSupported) assert.deepEqual(calls, ['load-main-cv', 'main']);
  else if (workerResult === 'error') assert.deepEqual(calls, ['worker', 'error', 'load-main-cv', 'main']);
  else assert.deepEqual(calls, ['worker'], '正常終了時は主スレッドでロードも再検出もしない');
  assert.equal(actual, workerSupported && workerResult === null ? null : result);
}
assert.equal(await detectFrameWithFallback(image, options, {
  workerSupported: false, ensureOpenCvReady: async () => false,
  analyzeOnMainThread: () => assert.fail('OpenCV 不在時に処理しない')
}), null);
console.log('autoFrameExecution: OpenCV 二重初期化の防止・候補なし・Worker 失敗・非対応時の復帰を検証');
