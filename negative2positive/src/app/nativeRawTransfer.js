// Moves one native decode's packed RGBA16 plane (#264 part C) from the
// desktop shell into the page. The shell serves it in parts from its
// `rawdecode://` scheme (`http://rawdecode.localhost` on Windows); a
// disposable worker streams every part into one preallocated buffer and
// transfers that buffer here, so no task on this thread copies pixels. Where
// a worker cannot reach the scheme (the first fetch fails as a network
// error), the same reads run on this thread: every part arrives in chunks of
// at most a few hundred KiB, so no single task is long.
//
// `shared: true` allocates the plane in shared memory where the reading realm
// is cross-origin isolated (Part A's allocPlane16 rule: the plane is built
// where it is allocated, by one writer, and never written again), and the
// worker then posts it without a transfer list.

export class NativePlaneError extends Error {
  constructor(message, { network = false } = {}) {
    super(message);
    this.name = 'NativePlaneError';
    this.code = 'NATIVE_RAW_TRANSFER';
    this.network = network;
  }
}

// Where a plane may live in shared memory: an isolated realm with the
// SharedArrayBuffer constructor.
function canSharePlanes(scope = globalThis) {
  return scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === 'function';
}

/**
 * Read `urls` in order into one buffer of exactly `byteLength` bytes.
 * `fetchImpl` is the global fetch in the worker and on the page. `ahead`
 * parts are requested before the current one is read, so the shell's copy of
 * the next part overlaps this realm's copy of the current one.
 * @returns {Promise<ArrayBuffer | SharedArrayBuffer>}
 */
export async function readNativePlane(urls, byteLength, { fetchImpl = globalThis.fetch, signal = null, shared = false, ahead = 1 } = {}) {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) throw new NativePlaneError(`bad plane size ${byteLength}`);
  const plane = new Uint8Array(shared && canSharePlanes() ? new SharedArrayBuffer(byteLength) : byteLength);
  // Settled wrappers: a request made ahead may fail before it is awaited.
  const request = (index) => Promise.resolve()
    .then(() => fetchImpl(urls[index], { cache: 'no-store', signal }))
    .then((response) => ({ response }), (error) => ({ error }));
  const requests = [];
  const depth = Math.max(0, Math.floor(Number(ahead) || 0));
  let offset = 0;
  for (let index = 0; index < urls.length; index++) {
    for (let next = requests.length; next <= Math.min(urls.length - 1, index + depth); next++) requests.push(request(next));
    const { response, error: err } = await requests[index];
    requests[index] = null;
    if (err) {
      if (err?.name === 'AbortError') throw err;
      // A worker that may not load the scheme at all fails here, on part 0.
      throw new NativePlaneError(`rawdecode fetch failed: ${err?.message || err}`, { network: index === 0 && offset === 0 });
    }
    if (!response.ok) throw new NativePlaneError(`rawdecode part ${index} answered ${response.status}`);
    const add = (chunk) => {
      if (offset + chunk.byteLength > byteLength) throw new NativePlaneError('rawdecode sent more bytes than announced');
      plane.set(chunk, offset);
      offset += chunk.byteLength;
    };
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        add(value);
      }
    } else {
      add(new Uint8Array(await response.arrayBuffer()));
    }
  }
  if (offset !== byteLength) throw new NativePlaneError(`rawdecode sent ${offset} of ${byteLength} bytes`);
  return plane.buffer;
}

/**
 * Worker side: `{ type: 'read', id, urls, byteLength, shared, ahead }` →
 * `{ type: 'plane', id, buffer }` (transferred, or posted as it is when
 * shared) or `{ type: 'error', id, message, network }`.
 */
export async function handleNativePlaneMessage(message, reply, { fetchImpl = globalThis.fetch } = {}) {
  const id = message?.id;
  try {
    if (message?.type !== 'read') throw new NativePlaneError(`unknown message ${message?.type}`);
    const buffer = await readNativePlane(message.urls, message.byteLength, { fetchImpl, shared: message.shared === true, ...(Number.isInteger(message.ahead) ? { ahead: message.ahead } : {}) });
    reply({ type: 'plane', id, buffer }, buffer instanceof ArrayBuffer ? [buffer] : []);
  } catch (err) {
    reply({ type: 'error', id, message: err?.message || String(err), network: Boolean(err?.network) });
  }
}

// Whether workers may fetch the scheme, learnt from the first attempt.
let workerReachesScheme = null;

export function resetNativePlaneTransport() {
  workerReachesScheme = null;
}

function abortError() {
  return new DOMException('Native RAW transfer was aborted', 'AbortError');
}

// Posts the read to an already started worker (see openNativePlaneReader).
function readInWorker(worker, urls, byteLength, { signal, shared, ahead }) {
  return new Promise((resolve, reject) => {
    const done = (settle, value) => {
      signal?.removeEventListener?.('abort', onAbort);
      try { worker.terminate(); } catch {}
      settle(value);
    };
    const onAbort = () => done(reject, abortError());
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg?.type === 'plane') done(resolve, msg.buffer);
      else done(reject, new NativePlaneError(msg?.message || 'native plane worker failed', { network: Boolean(msg?.network) }));
    };
    worker.onerror = (event) => {
      try { event?.preventDefault?.(); } catch {}
      done(reject, new NativePlaneError(`native plane worker crashed: ${event?.message || 'error'}`, { network: true }));
    };
    worker.postMessage({ type: 'read', id: 1, urls, byteLength, shared, ahead });
  });
}

function defaultCreateWorker() {
  return new Worker(new URL('../workers/nativeRawFetchWorker.js', import.meta.url), { type: 'module' });
}

/**
 * Starts the transfer worker now, so its module load overlaps the native
 * decode; `read()` then moves the plane behind `urls` into an ArrayBuffer of
 * `byteLength` bytes (a SharedArrayBuffer with `shared` where the realm is
 * isolated), through the worker when workers reach the scheme, else on this
 * thread. `close()` drops an unused worker.
 */
export function openNativePlaneReader({
  createWorker = defaultCreateWorker,
  fetchImpl = globalThis.fetch,
  hasWorker = typeof Worker !== 'undefined',
} = {}) {
  let worker = null;
  if (hasWorker && workerReachesScheme !== false) {
    try {
      worker = createWorker();
    } catch (err) {
      console.warn('[RAW] native plane worker unavailable, reading on the page:', err?.message || err);
      worker = null;
    }
  }
  return {
    async read(urls, byteLength, { signal = null, shared = false, ahead = 1 } = {}) {
      if (signal?.aborted) throw abortError();
      if (worker) {
        const started = worker;
        worker = null;
        try {
          const buffer = await readInWorker(started, urls, byteLength, { signal, shared, ahead });
          workerReachesScheme = true;
          return buffer;
        } catch (err) {
          if (err?.name === 'AbortError' || !err?.network || workerReachesScheme === true) throw err;
          console.warn('[RAW] workers cannot fetch the native plane; reading it on the page:', err.message);
          workerReachesScheme = false;
        }
      }
      return readNativePlane(urls, byteLength, { fetchImpl, signal, shared, ahead });
    },
    close() {
      if (!worker) return;
      try { worker.terminate(); } catch {}
      worker = null;
    },
  };
}

/** One-shot `openNativePlaneReader().read(...)`. */
export function fetchNativePlane(urls, byteLength, { signal = null, shared = false, ahead = 1, ...options } = {}) {
  return openNativePlaneReader(options).read(urls, byteLength, { signal, shared, ahead });
}
