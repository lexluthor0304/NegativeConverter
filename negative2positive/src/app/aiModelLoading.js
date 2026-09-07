// Serialize model sessions: a user's local file waits for an active download
// and replaces it. Repeated automatic requests cannot discard that choice.
export function createAiModelLoader(load, defaultSource, isFile = value => value instanceof File) {
  let pending = null, queuedSource = null, queuedPreference = null;
  return function request(source, options = {}) {
    const prefer = options.prefer || 'webgpu';
    if (pending && prefer === queuedPreference
        && (source === queuedSource || (source === defaultSource && isFile(queuedSource)))) return pending;
    const run = () => load(source, options);
    const next = pending ? pending.then(run, run) : Promise.resolve().then(run);
    pending = next;
    queuedSource = source;
    queuedPreference = prefer;
    const clear = () => { if (pending === next) pending = null; };
    void next.then(clear, clear);
    return next;
  };
}
