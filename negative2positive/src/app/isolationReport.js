// Isolation report (#264 Part A): `crossOriginIsolated` of the page and of
// every worker the app runs. Each worker entry imports workers/isolationProbe.js
// first, which answers a probe message; this module spawns one of each, asks,
// and terminates it. LibRaw's worker belongs to the libraw-wasm package and
// cannot answer: its script is checked for the COEP header instead (a module
// worker of an isolated page is isolated exactly when its own response
// carries COEP), and a threaded build reports from inside where it can
// (librawRuntime.js).
import { ISOLATION_PROBE, describeRealmIsolation, planeGuardReport } from './crossOriginIsolation.js';
import { probeLibRawWorker } from './librawRuntime.js';

const PROBE_TIMEOUT_MS = 20_000;

// One factory per worker script. Vite bundles each `new Worker(new URL(...))`
// once, so these are the same scripts the clients start.
export const WORKER_PROBES = Object.freeze({
  conversion: () => new Worker(new URL('../workers/conversionWorker.js', import.meta.url), { type: 'module' }),
  conversionBand: () => new Worker(new URL('../workers/conversionBandWorker.js', import.meta.url), { type: 'module' }),
  geometry: () => new Worker(new URL('../workers/geometryWorker.js', import.meta.url), { type: 'module' }),
  rawPostDecode: () => new Worker(new URL('../workers/rawPostDecodeWorker.js', import.meta.url), { type: 'module' }),
  autoFrame: () => new Worker(new URL('../workers/autoFrameWorker.js', import.meta.url), { type: 'module' }),
  dust: () => new Worker(new URL('../workers/dustWorker.js', import.meta.url), { type: 'module' }),
  aiInpaint: () => new Worker(new URL('../workers/aiInpaintWorker.js', import.meta.url), { type: 'module' }),
  semantic: () => new Worker(new URL('../workers/semanticWorker.js', import.meta.url), { type: 'module' }),
  scanDecode: () => new Worker(new URL('../workers/scanDecodeWorker.js', import.meta.url), { type: 'module' }),
  multiShot: () => new Worker(new URL('../workers/multiShotWorker.js', import.meta.url), { type: 'module' }),
  export: () => new Worker(new URL('../workers/exportWorker.js', import.meta.url), { type: 'module' }),
  // The desktop's native RAW plane transfer (nativeRawTransfer.js).
  nativeRawFetch: () => new Worker(new URL('../workers/nativeRawFetchWorker.js', import.meta.url), { type: 'module' }),
  // A classic worker from public/codecs (it answers the probe inline).
  heif: () => new Worker(`${import.meta.env.BASE_URL}codecs/heif-worker.js`),
  // blob: workers (the plane-release sink) inherit the page's policy.
  blob: () => {
    const url = URL.createObjectURL(new Blob([
      `onmessage=e=>{if(e.data&&e.data.type===${JSON.stringify(ISOLATION_PROBE)})postMessage({type:${JSON.stringify(ISOLATION_PROBE)},id:e.data.id,crossOriginIsolated:self.crossOriginIsolated===true,sharedArrayBuffer:typeof SharedArrayBuffer==='function',secureContext:self.isSecureContext===true})}`
    ], { type: 'text/javascript' }));
    const worker = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return worker;
  }
});

/**
 * Starts `factory()`'s worker, posts the probe and resolves with its answer
 * ({ crossOriginIsolated, sharedArrayBuffer, secureContext }) or an
 * `{ error }` when it cannot start or does not answer. Never rejects.
 */
export function probeWorker(factory, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let worker;
    let timer = null;
    const finish = (answer) => {
      clearTimeout(timer);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        try { worker.terminate(); } catch { /* gone */ }
      }
      resolve(answer);
    };
    try {
      worker = factory();
    } catch (error) {
      finish({ error: String(error?.message || error) });
      return;
    }
    const id = Math.floor(Math.random() * 1e9);
    timer = setTimeout(() => finish({ error: 'no answer' }), timeoutMs);
    // Other messages (a worker's own "ready") are ignored.
    worker.onmessage = ({ data }) => {
      if (data?.type !== ISOLATION_PROBE || data.id !== id) return;
      finish({
        crossOriginIsolated: data.crossOriginIsolated === true,
        sharedArrayBuffer: data.sharedArrayBuffer === true,
        secureContext: data.secureContext === true
      });
    };
    worker.onerror = (event) => {
      event?.preventDefault?.();
      finish({ error: String(event?.message || 'worker failed to start') });
    };
    worker.onmessageerror = () => finish({ error: 'unreadable answer' });
    try {
      worker.postMessage({ type: ISOLATION_PROBE, id });
    } catch (error) {
      finish({ error: String(error?.message || error) });
    }
  });
}

/**
 * The whole report: `{ page, workers: { name: answer }, allIsolated,
 * planeGuard }`. `names` limits the workers probed (default: all, plus
 * LibRaw). Workers are probed a few at a time.
 */
export async function collectIsolationReport({ names = null, probes = WORKER_PROBES, concurrency = 3, libraw = true } = {}) {
  const page = describeRealmIsolation(globalThis);
  const wanted = (names || Object.keys(probes)).filter((name) => typeof probes[name] === 'function');
  const workers = {};
  let next = 0;
  const lane = async () => {
    while (next < wanted.length) {
      const name = wanted[next++];
      workers[name] = await probeWorker(probes[name]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, wanted.length)) }, lane));
  if (libraw && (!names || names.includes('libraw'))) {
    workers.libraw = await probeLibRawWorker({ pageIsolated: page.crossOriginIsolated });
  }
  const answers = Object.values(workers);
  return {
    page,
    workers,
    allIsolated: page.crossOriginIsolated && answers.every((answer) => answer.crossOriginIsolated === true),
    planeGuard: planeGuardReport()
  };
}

/**
 * One line for the desktop's terminal log (log_webview_diagnostics). Each
 * worker reads `<crossOriginIsolated>/<SharedArrayBuffer>`: macOS WKWebView
 * reports isolation without SharedArrayBuffer.
 */
export function formatIsolationLine(report) {
  const flag = (answer) => (answer?.error ? `error(${answer.error})`
    : `${answer?.crossOriginIsolated ? 1 : 0}/${answer?.sharedArrayBuffer ? 1 : 0}`);
  const workers = Object.entries(report?.workers || {})
    .map(([name, answer]) => `${name}=${flag(answer)}${answer?.inferred ? '~' : ''}`)
    .join(' ');
  return `isolation page=${report?.page?.crossOriginIsolated ? 1 : 0} sab=${report?.page?.sharedArrayBuffer ? 1 : 0}`
    + ` secure=${report?.page?.secureContext ? 1 : 0} workers: ${workers}`;
}
