// Hang watchdog. A heartbeat Runtime.evaluate('1') goes to the page every
// second; after NC_PERF_HANG_S seconds without a reply (default 30 s, above
// the longest main-thread task measured so far) the watchdog dumps state:
//
// - Debugger.pause on the page and every attached worker session. Chrome
//   handles Debugger.pause on the IO thread and interrupts running
//   JavaScript, while Debugger.enable queues behind the busy main thread, so
//   the Debugger is enabled at attach time (section 1 of #230).
// - The probe ring buffer, read with Debugger.evaluateOnCallFrame.
// - The continuous trace ring buffer when one is recording (H, profiled reps).
// - `sample <pid> 3` of the renderer and GPU processes on macOS: when the
//   main thread is stuck in native code (GPU sync, WASM) no JS pause arrives.
// - SystemInfo.getProcessInfo CPU times.
// Then the browser is killed and the scenario is recorded as `hang`.

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function hangThresholdMs(env = process.env) {
  const seconds = Number(env.NC_PERF_HANG_S);
  return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
}

export class HangWatchdog {
  constructor({
    ping, thresholdMs = hangThresholdMs(), intervalMs = 1000, onHang,
    now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval
  }) {
    Object.assign(this, { ping, thresholdMs, intervalMs, onHang, now, setTimer, clearTimer });
    this.timer = null;
    this.inFlightSince = null;
    this.lastReply = null;
    this.fired = false;
  }

  start() {
    if (this.timer) return;
    this.lastReply = this.now();
    this.timer = this.setTimer(() => this.tick(), this.intervalMs);
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.fired) return;
    const t = this.now();
    if (this.inFlightSince === null) {
      this.inFlightSince = t;
      Promise.resolve().then(() => this.ping()).then(
        () => { this.inFlightSince = null; this.lastReply = this.now(); },
        () => { this.inFlightSince = null; }
      );
      return;
    }
    const silentMs = t - this.inFlightSince;
    if (silentMs >= this.thresholdMs) {
      this.fired = true;
      this.stop();
      Promise.resolve().then(() => this.onHang({ detectedAt: t, silentSince: this.inFlightSince, silentMs, lastReply: this.lastReply }));
    }
  }
}

function sampleProcess(pid, seconds, file) {
  return new Promise(resolve => {
    execFile('sample', [String(pid), String(seconds), '-file', file], { timeout: (seconds + 20) * 1000 }, error => {
      resolve(error ? { pid, error: String(error.message || error) } : { pid, file });
    });
  });
}

/**
 * Collect a hang dump. `sessions` = [{ id, kind: 'page'|'worker', url, session }].
 * Returns the dump object (also written to `dir/hang-<label>.json`).
 */
export async function collectHangDump({
  connection, sessions, mapper = null, traceRecorder = null, processIds = {}, dir, label, info,
  platform = process.platform, pauseTimeoutMs = 5000, sampleSeconds = 3
}) {
  const dump = { label, info, at: new Date().toISOString(), stacks: [], ring: null, samples: [], processes: null, trace: null, errors: [] };
  const mapFrame = frame => {
    const location = frame.location || {};
    const url = frame.url || '';
    const mapped = mapper ? mapper.map(url, location.lineNumber, location.columnNumber) : null;
    return { function: frame.functionName || '(anonymous)', url, line: (location.lineNumber ?? -1) + 1, column: location.columnNumber,
      source: mapped ? `${mapped.source}:${mapped.line}` : null };
  };
  const native = platform === 'darwin'
    ? Promise.all([...(processIds.renderer || []), ...(processIds.gpu || [])].map(pid =>
      sampleProcess(pid, sampleSeconds, join(dir, `hang-${label}-sample-${pid}.txt`))))
    : Promise.resolve([]);

  await Promise.all(sessions.map(async entry => {
    try {
      const paused = entry.session.waitFor('Debugger.paused', { timeoutMs: pauseTimeoutMs });
      await entry.session.send('Debugger.pause', {}, { timeoutMs: pauseTimeoutMs });
      const event = await paused;
      const frames = (event.callFrames || []).map(mapFrame);
      const stack = { kind: entry.kind, url: entry.url || null, reason: event.reason, frames };
      if (entry.kind === 'page' && event.callFrames?.length) {
        try {
          const response = await entry.session.send('Debugger.evaluateOnCallFrame', {
            callFrameId: event.callFrames[0].callFrameId,
            expression: 'JSON.stringify(globalThis.__ncPerf ? globalThis.__ncPerf.dump() : null)',
            returnByValue: true
          }, { timeoutMs: pauseTimeoutMs });
          dump.ring = JSON.parse(response.result?.value || 'null');
        } catch (error) {
          dump.errors.push(`ring buffer: ${error.message}`);
        }
      }
      dump.stacks.push(stack);
    } catch (error) {
      dump.stacks.push({ kind: entry.kind, url: entry.url || null, error: `no JS pause: ${error.message}` });
    }
  }));

  if (traceRecorder) {
    try {
      await traceRecorder.stop({ timeoutMs: 60_000 });
      dump.trace = traceRecorder.file || true;
    } catch (error) {
      dump.errors.push(`trace: ${error.message}`);
    }
  }
  try {
    dump.processes = (await connection.send('SystemInfo.getProcessInfo', {}, { timeoutMs: 10_000 })).processInfo || null;
  } catch (error) {
    dump.errors.push(`process info: ${error.message}`);
  }
  dump.samples = await native;
  if (dir) writeFileSync(join(dir, `hang-${label}.json`), JSON.stringify(dump, null, 2));
  return dump;
}
