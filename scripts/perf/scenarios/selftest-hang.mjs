// --inject-hang: a 60 s busy loop injected through CDP proves the watchdog.
// It must be detected within NC_PERF_HANG_S + 5 s, and the dump must hold the
// injected function in the main-thread JS stack, every worker's stack, the
// probe ring buffer, the trace ring buffer and a native sample of the
// renderer and GPU processes. The run then continues.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { bootApp, importPhotos, sleep } from './common.mjs';
import { hangThresholdMs } from '../lib/hang.mjs';

export const INJECTED = '(function ncInjectedHang() { const end = Date.now() + 60000; while (Date.now() < end) {} })()';

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
    await sleep(1000);
    const injectedAt = Date.now();
    session.page.send('Runtime.evaluate', { expression: INJECTED }, { timeoutMs: 0 }).catch(() => {});
    const limit = hangThresholdMs() + 5000;
    while (session.status === 'ok' && Date.now() - injectedAt < limit + 30_000) await sleep(200);
    const detectedMs = session.status === 'hang' ? Date.now() - injectedAt : null;
    while (session.status === 'hang' && !session.hangDump && Date.now() - injectedAt < limit + 120_000) await sleep(200);
    const dump = session.hangDump || {};
    const page = (dump.stacks || []).find(stack => stack.kind === 'page');
    const workers = (dump.stacks || []).filter(stack => stack.kind === 'worker');
    const checks = {
      detected: session.status === 'hang',
      detectedWithinBudget: detectedMs !== null && detectedMs <= limit + 2000,
      injectedFrame: Boolean(page?.frames?.some(frame => frame.function === 'ncInjectedHang')),
      workerStacks: workers.length > 0 && workers.every(stack => stack.frames || stack.error),
      ringBuffer: Array.isArray(dump.ring?.ring) && dump.ring.ring.length > 0,
      traceRingBuffer: Boolean(dump.trace),
      nativeSamples: process.platform !== 'darwin' || (dump.samples || []).some(sample => sample.file && existsSync(sample.file)),
      processCpu: Array.isArray(dump.processes) && dump.processes.length > 0
    };
    ctx.record('selftest.detectedMs', detectedMs);
    for (const [key, value] of Object.entries(checks)) ctx.record(`selftest.${key}`, String(value));
    ctx.raw.selftest = { checks, dumpFile: dump.file || join(ctx.outDir, `hang-${ctx.label}.json`) };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key);
    if (failed.length) ctx.note(`hang self-test failed: ${failed.join(', ')}`);
    ctx.selftestPassed = failed.length === 0;
    ctx.hangs.push({ label: ctx.label, info: dump.info, file: dump.file, topFrame: page?.frames?.[0]?.function });
  }
};
