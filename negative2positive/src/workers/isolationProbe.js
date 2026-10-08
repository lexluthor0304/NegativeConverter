// Isolation probe (#264 Part A), imported first by every worker entry: it
// answers the page's probe message (app/isolationReport.js) with this worker's
// `crossOriginIsolated`, and stops the message before the worker's own
// handler sees it. Listeners run in registration order, and this module is
// evaluated before the entry's body registers `onmessage`.
import { ISOLATION_PROBE, describeRealmIsolation } from '../app/crossOriginIsolation.js';

const scope = typeof WorkerGlobalScope === 'function' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope
  ? self : null;
if (scope) {
  scope.addEventListener('message', (event) => {
    if (event?.data?.type !== ISOLATION_PROBE) return;
    event.stopImmediatePropagation();
    scope.postMessage({ type: ISOLATION_PROBE, id: event.data.id, ...describeRealmIsolation(scope) });
  });
}
