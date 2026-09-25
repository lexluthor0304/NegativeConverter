// Chrome trace analysis for the profiled repetition, consumed incrementally
// from Tracing.dataCollected so a five-minute roll trace never has to exist
// as one JSON string. Produces per-thread busy time (union of top-level task
// slices), cores used (Σ busy ÷ wall) and self-time hot functions from the V8
// CPU profile samples, source-mapped to src/ file:line.

import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { round } from './stats.mjs';

export const TRACE_CATEGORIES = [
  'toplevel', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo', 'devtools.timeline',
  'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-v8.cpu_profiler', 'v8'
];

const TOP_LEVEL = /^(RunTask|ThreadControllerImpl::RunTask|ThreadPool_RunTask|RunMicrotasks)$/;
const SKIP_FUNCTIONS = new Set(['(idle)', '(root)']);

function unionLength(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = intervals[0];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s > end) { total += end - start; start = s; end = e; } else if (e > end) end = e;
  }
  return total + (end - start);
}

export function createTraceAnalyzer({ mapper = null } = {}) {
  const threads = new Map();
  const processes = new Map();
  const profiles = new Map();
  let minTs = Infinity;
  let maxTs = -Infinity;

  function thread(pid, tid) {
    const key = `${pid}:${tid}`;
    let entry = threads.get(key);
    if (!entry) { entry = { pid, tid, name: null, slices: [] }; threads.set(key, entry); }
    return entry;
  }

  function add(events) {
    for (const event of events || []) {
      if (Number.isFinite(event.ts) && event.ph !== 'M') {
        if (event.ts < minTs) minTs = event.ts;
        const end = event.ts + (event.dur || 0);
        if (end > maxTs) maxTs = end;
      }
      if (event.ph === 'M') {
        if (event.name === 'thread_name') thread(event.pid, event.tid).name = event.args?.name || null;
        else if (event.name === 'process_name') processes.set(event.pid, event.args?.name || null);
        continue;
      }
      if (event.ph === 'X' && TOP_LEVEL.test(event.name) && Number.isFinite(event.dur)) {
        thread(event.pid, event.tid).slices.push([event.ts, event.ts + event.dur]);
        continue;
      }
      if (event.name === 'Profile' && event.ph === 'P') {
        const key = `${event.pid}:${event.id}`;
        profiles.set(key, { pid: event.pid, tid: event.tid, startTime: event.args?.data?.startTime ?? event.ts, nodes: new Map(), samples: [], lastTs: null });
        continue;
      }
      if (event.name === 'ProfileChunk' && event.ph === 'P') {
        const key = `${event.pid}:${event.id}`;
        let profile = profiles.get(key);
        if (!profile) {
          profile = { pid: event.pid, tid: event.tid, startTime: event.ts, nodes: new Map(), samples: [], lastTs: null };
          profiles.set(key, profile);
        }
        profile.tid = event.tid;
        const data = event.args?.data || {};
        for (const node of data.cpuProfile?.nodes || []) profile.nodes.set(node.id, node);
        const samples = data.cpuProfile?.samples || [];
        const deltas = data.timeDeltas || [];
        let ts = profile.lastTs ?? profile.startTime;
        for (let i = 0; i < samples.length; i++) {
          ts += deltas[i] || 0;
          profile.samples.push([ts, samples[i]]);
        }
        profile.lastTs = ts;
      }
    }
  }

  function describe(frame) {
    const name = frame.functionName || '(anonymous)';
    if (!frame.url) return { function: name, location: name.startsWith('(') ? '' : '(native)' };
    const location = mapper ? mapper.label(frame.url, frame.lineNumber, frame.columnNumber)
      : `${String(frame.url).split('/').pop()}:${(frame.lineNumber ?? -1) + 1}`;
    const mapped = mapper ? mapper.map(frame.url, frame.lineNumber, frame.columnNumber) : null;
    return { function: mapped?.name || name, location };
  }

  function finalize({ topN = 12, fromUs = -Infinity, toUs = Infinity } = {}) {
    const selfByThread = new Map();
    for (const profile of profiles.values()) {
      const key = `${profile.pid}:${profile.tid}`;
      const totals = selfByThread.get(key) || new Map();
      const samples = profile.samples.filter(([ts]) => ts >= fromUs && ts <= toUs);
      const intervals = samples.slice(1).map(([ts], i) => ts - samples[i][0]).filter(d => d >= 0);
      const typical = intervals.length ? intervals.sort((a, b) => a - b)[intervals.length >> 1] : 1000;
      for (let i = 0; i < samples.length; i++) {
        const duration = i + 1 < samples.length ? samples[i + 1][0] - samples[i][0] : typical;
        const node = profile.nodes.get(samples[i][1]);
        if (!node || SKIP_FUNCTIONS.has(node.callFrame?.functionName)) continue;
        const described = describe(node.callFrame || {});
        const label = `${described.function} ${described.location}`.trim();
        totals.set(label, (totals.get(label) || 0) + Math.max(0, Math.min(duration, typical * 20)));
      }
      selfByThread.set(key, totals);
    }
    const wallUs = Number.isFinite(maxTs - minTs) ? Math.min(maxTs, toUs) - Math.max(minTs, fromUs) : 0;
    const out = [];
    for (const [key, entry] of threads) {
      const slices = entry.slices.filter(([s, e]) => e >= fromUs && s <= toUs).map(([s, e]) => [Math.max(s, fromUs), Math.min(e, toUs)]);
      const busyUs = unionLength(slices);
      const hot = [...(selfByThread.get(key) || new Map())].sort((a, b) => b[1] - a[1]).slice(0, topN)
        .map(([label, us]) => ({ label, selfMs: round(us / 1000) }));
      if (!busyUs && !hot.length) continue;
      out.push({ pid: entry.pid, tid: entry.tid, name: entry.name, process: processes.get(entry.pid) || null, busyMs: round(busyUs / 1000), hot });
    }
    out.sort((a, b) => b.busyMs - a.busyMs);
    const busyTotalMs = out.reduce((total, entry) => total + entry.busyMs, 0);
    return {
      wallMs: round(wallUs / 1000),
      busyTotalMs: round(busyTotalMs),
      coresUsed: wallUs > 0 ? round(busyTotalMs / (wallUs / 1000), 2) : null,
      threads: out
    };
  }

  return { add, finalize };
}

/** Streams trace events into a gzipped Chrome trace JSON file. */
export function createTraceFileWriter(path) {
  const gzip = createGzip();
  const file = createWriteStream(path);
  gzip.pipe(file);
  let first = true;
  gzip.write('{"traceEvents":[');
  return {
    write(events) {
      for (const event of events || []) {
        gzip.write((first ? '' : ',\n') + JSON.stringify(event));
        first = false;
      }
    },
    close() {
      gzip.end(']}');
      return new Promise(resolve => file.once('close', resolve));
    }
  };
}

/**
 * Record a trace over CDP: start → run → end, feeding analyzer and file.
 * `connection` is the browser-level CdpConnection.
 */
export async function recordTrace(connection, { continuous = false, analyzer, writer, categories = TRACE_CATEGORIES }) {
  const chunks = connection.on('Tracing.dataCollected', params => {
    analyzer?.add(params.value);
    writer?.write(params.value);
  }, { sessionId: null });
  await connection.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { recordMode: continuous ? 'recordContinuously' : 'recordAsMuchAsPossible', includedCategories: categories }
  });
  let stopped = false;
  return {
    async stop({ timeoutMs = 120_000 } = {}) {
      if (stopped) return;
      stopped = true;
      const complete = connection.waitFor('Tracing.tracingComplete', { sessionId: null, timeoutMs });
      await connection.send('Tracing.end', {}, { timeoutMs });
      await complete;
      chunks();
      await writer?.close();
    }
  };
}
