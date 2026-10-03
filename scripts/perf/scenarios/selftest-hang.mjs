// --inject-hang: a 60 s busy loop injected through CDP proves the watchdog.
// It must be detected within NC_PERF_HANG_S + 5 s, and the dump must hold the
// injected function in the main-thread JS stack, busy workers' frames, the
// probe ring buffer, the trace ring buffer and a native sample of the
// renderer and GPU processes. The run then continues.
import { existsSync } from 'node:fs';
import { bootApp, importPhotos, sleep } from './common.mjs';
import { hangThresholdMs } from '../lib/hang.mjs';

export const INJECTED = '(function ncInjectedHang() { const end = Date.now() + 60000; while (Date.now() < end) {} })()';

export function validateHangSelftest({ dump, status, detectedMs, limit = hangThresholdMs() + 5000, platform = process.platform, fileExists = existsSync }) {
  const page = (dump.stacks || []).find(stack => stack.kind === 'page');
  const workers = (dump.stacks || []).filter(stack => stack.kind === 'worker');
  const busy = workers.filter(stack => stack.busy !== false);
  const renderer = dump.processIds?.renderer || (dump.processes || []).filter(p => p.type === 'renderer').map(p => p.id);
  const gpu = dump.processIds?.gpu || (dump.processes || []).filter(p => /^(GPU|gpu-process|gpu)$/.test(p.type)).map(p => p.id);
  const checks = {
    detected: status === 'hang',
    detectedWithinBudget: detectedMs !== null && detectedMs <= limit,
    injectedFrame: Boolean(page?.frames?.some(frame => frame.function === 'ncInjectedHang')),
    workerStacks: busy.length > 0 && busy.every(stack => stack.frames?.length > 0),
    ringBuffer: Array.isArray(dump.ring?.ring) && dump.ring.ring.length > 0,
    traceRingBuffer: Boolean(dump.trace),
    nativeSamples: platform !== 'darwin' || (renderer.length > 0 && gpu.length > 0 && [...renderer, ...gpu]
      .every(pid => (dump.samples || []).some(sample => sample.pid === pid && sample.file && fileExists(sample.file)))),
    processCpu: Array.isArray(dump.processes) && dump.processes.length > 0
  };
  return { checks, idleWorkers: workers.filter(stack => stack.busy === false), busyWorkers: busy };
}

export default {
  id: 'selftest-hang',
  title: 'Hang watchdog self-test',
  fixtureGroup: 'smoke',
  continuousTrace: true,
  singleRep: true,
  expectHang: true,
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    await importPhotos(ctx, [ctx.fixture.path], { settle: false });
    // Ensure the stack test has a busy worker to capture. Idle workers are
    // listed separately; a failed pause never counts as a captured stack.
    await session.evaluate(`new Promise(resolve => {
      const source = "postMessage({type:'ready'}); onmessage = function ncInjectedWorkerHang() { postMessage({type:'started'}); const end = Date.now() + 60000; while (Date.now() < end) {} };";
      const url = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
      const worker = new Worker(url, {name:'nc-perf-hang-selftest'});
      globalThis.__ncPerfSelftestWorker = worker;
      worker.onmessage = event => {
        if (event.data.type === 'ready') worker.postMessage({type:'selftest-hang', id:-229});
        if (event.data.type === 'started') { URL.revokeObjectURL(url); resolve(true); }
      };
    })()`);
    await sleep(1000);
    const injectedAt = Date.now();
    session.page.send('Runtime.evaluate', { expression: INJECTED }, { timeoutMs: 0 }).catch(() => {});
    const limit = hangThresholdMs() + 5000;
    while (session.status === 'ok' && Date.now() - injectedAt < limit + 30_000) await sleep(200);
    const detectedMs = session.status === 'hang' ? Date.now() - injectedAt : null;
    while (session.status === 'hang' && !session.hangDump && Date.now() - injectedAt < limit + 120_000) await sleep(200);
    const dump = session.hangDump || {};
    const page = (dump.stacks || []).find(stack => stack.kind === 'page');
    const { checks, idleWorkers, busyWorkers } = validateHangSelftest({ dump, status: session.status, detectedMs, limit });
    ctx.record('selftest.detectedMs', detectedMs);
    for (const [key, value] of Object.entries(checks)) ctx.record(`selftest.${key}`, String(value));
    ctx.raw.selftest = { checks, idleWorkers, busyWorkers, dumpFile: dump.file || null };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    if (failed.length) ctx.note(`hang self-test failed: ${failed.join(', ')}`);
    ctx.selftestPassed = failed.length === 0;
    ctx.hangs.push({ label: ctx.label, info: dump.info, file: dump.file, topFrame: page?.frames?.[0]?.function });
  }
};
