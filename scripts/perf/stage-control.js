// Minimal --no-probe control: just two Wasm-heavy worker round trips, plus
// the film-edge time an 'analyze-import' reply reports (#273). No hashing,
// debugger, auto-attach, draw wrappers or performance observers.
(function installStageControl(global) {
  if (typeof global.Worker !== 'function' || global.__ncPerfControl) return;
  const stages = [];
  const pending = new WeakMap();
  const Original = global.Worker;
  const post = Original.prototype.postMessage;
  global.Worker = new Proxy(Original, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget === global.Worker ? target : newTarget);
      const requests = new Map();
      pending.set(worker, requests);
      worker.addEventListener('message', event => {
        const request = requests.get(event.data?.id);
        if (!request || event.data?.type === 'progress') return;
        requests.delete(event.data?.id);
        if (event.data?.error) return;
        stages.push({ ...request, ms: performance.now() - request.t });
        const edgeMs = request.key === 'autoFrameMs' ? event.data?.result?.filmEdgeMs : undefined;
        if (typeof edgeMs === 'number') stages.push({ key: 'filmEdgeMs', t: request.t, ms: edgeMs });
      });
      return worker;
    }
  });
  Original.prototype.postMessage = function (message) {
    const key = message?.fn === 'imageData' && Array.isArray(message.args) ? 'librawDecodeMs'
      : /^(analyze-frame|analyze-import)$/.test(message?.type || '') ? 'autoFrameMs' : null;
    if (key && pending.has(this)) pending.get(this).set(message.id, { key, t: performance.now() });
    return post.apply(this, arguments);
  };
  global.__ncPerfControl = { stages: from => stages.filter(stage => stage.t >= from) };
})(globalThis);
