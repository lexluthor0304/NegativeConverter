// Run the actual merge UI orchestration with small, controllable dependencies.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createMemoryBudget, createMemoryClaim } from './memoryBudget.js';
import { createMultiShotProgress, multiShotFitsBudget, estimateMultiShotWorkerBytes } from './multiShotWorkerClient.js';
import { MultiShotError, describeMultiShotError } from './multiShotErrors.js';

export function mergeHarness({ budget = 1e6, retained = 128, pixels = [64 * 48, 64 * 48], decode = async () => ({ width: 64, height: 48 }), merge = async () => null } = {}) {
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const pick = name => {
    const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source).index;
    return source.slice(start, source.indexOf('\n    }', start) + '\n    }'.length);
  };
  const events = [], alerts = [];
  const memoryBudget = createMemoryBudget({ budgetBytes: budget, retainedBytes: () => retained });
  const body = { dataset: {} };
  const elements = Object.fromEntries(['batchProgressCancel', 'batchProgressFill', 'batchProgressText', 'batchProgressCurrent'].map(id => [id, { style: {} }]));
  let job;
  const context = vm.createContext({
    console: { warn() {}, error() {} }, AbortController, Promise, Number, Math,
    memoryBudget, memoryLedger: { retained: () => retained }, MULTI_SHOT_MAX: 5,
    createMemoryClaim, createMultiShotProgress, multiShotFitsBudget, estimateMultiShotWorkerBytes, MultiShotError, describeMultiShotError,
    document: { body, getElementById: id => elements[id] },
    state: { fileQueue: pixels.map((_, index) => ({ selected: true, file: { name: `${index}.dng`, index } })) },
    studioAutoFrameRunning: false, studioWorkspace: { sync() {} },
    isDesktopBatchExportLocked: () => false,
    getLocalizedText: (_key, text) => text, getInterpolatedText: (_key, _params, text) => text,
    appAlert: text => alerts.push(text), showBatchProgress: visible => events.push(['ui', visible]),
    imagePixelsForBatch: file => pixels[file.index], persistCurrentFileSettings() {},
    loadFileToImageData: (file, options) => { events.push(['decode', file.index, memoryBudget.snapshot().user]); return decode(file, options); },
    createMultiShotMergeJob: () => {
      let reject;
      const failed = new Promise((_, no) => { reject = no; });
      failed.catch(() => {});
      job = {
        failed, framesPosted: 0,
        addFrame: async () => { job.framesPosted++; events.push(['posted', job.framesPosted, memoryBudget.snapshot().user]); },
        merge: () => merge(memoryBudget),
        cancel: () => reject(new MultiShotError('cancelled', 'cancelled')),
        dispose: () => events.push(['dispose', memoryBudget.snapshot().user])
      };
      return job;
    }
  });
  vm.runInContext(['multiShotBudgetBytes', 'coveredMemoryClaim', 'setBatchProgressCancel', 'showMultiShotProgress', 'mergeSelectedShots'].map(pick).join('\n'), context);
  return { context, events, alerts, memoryBudget, body, run: () => context.mergeSelectedShots(), cancel: () => elements.batchProgressCancel.onclick() };
}
