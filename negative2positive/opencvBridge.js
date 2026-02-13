const LOCAL_SCRIPT_URLS = [
  './node_modules/@techstark/opencv-js/dist/opencv.js'
];

const MODULE_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js/+esm',
  'https://esm.sh/@techstark/opencv-js'
];

const LOCAL_SOURCE_TIMEOUT_MS = 35000;
const MODULE_SOURCE_TIMEOUT_MS = 15000;

let cvReadyPromise = null;
const localScriptLoadPromises = new Map();

function hasRequiredApis(cv) {
  return !!(cv && typeof cv.Mat === 'function' && typeof cv.inpaint === 'function');
}

function stripThenable(cv) {
  if (!cv || typeof cv !== 'object') return cv;
  if (typeof cv.then === 'function') {
    try {
      if (!cv.__opencvThen) {
        cv.__opencvThen = cv.then;
      }
    } catch (err) {
      // Ignore property assignment failures on locked module objects.
    }
    try {
      delete cv.then;
    } catch (err) {
      // Ignore delete failures, fallback to assignment below.
    }
    if (typeof cv.then === 'function') {
      try {
        cv.then = undefined;
      } catch (err) {
        // Ignore assignment failures; unresolved thenables are handled by caller timeouts.
      }
    }
  }
  return cv;
}

function extractCv(moduleNs) {
  if (!moduleNs) return null;
  if (moduleNs.default) return moduleNs.default;
  if (moduleNs.cv) return moduleNs.cv;
  return moduleNs;
}

function getErrorMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  try {
    return JSON.stringify(err);
  } catch (jsonErr) {
    return String(err);
  }
}

function withTimeout(task, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(label));
    }, timeoutMs);

    task.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForRuntime(cv, timeoutMs = 20000) {
  if (!cv) {
    return Promise.reject(new Error('OpenCV module is empty.'));
  }

  if (hasRequiredApis(cv)) {
    return Promise.resolve(stripThenable(cv));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('OpenCV runtime initialization timed out.'));
    }, timeoutMs);

    const finishResolve = (candidate) => {
      if (settled) return;
      const resolvedCv = extractCv(candidate) || cv;
      if (!hasRequiredApis(resolvedCv)) return;
      settled = true;
      clearTimeout(timer);
      resolve(stripThenable(resolvedCv));
    };

    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(getErrorMessage(err)));
    };

    if (typeof cv.then === 'function') {
      try {
        cv.then(
          (candidate) => {
            finishResolve(candidate);
          },
          (err) => {
            finishReject(err);
          }
        );
      } catch (err) {
        finishReject(err);
      }
    }

    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      if (typeof previous === 'function') {
        try {
          previous();
        } catch (err) {
          // Ignore callback failures from third-party wrappers.
        }
      }
      finishResolve(cv);
    };

    if (typeof cv.then !== 'function' && typeof previous !== 'function') {
      finishReject(new Error('OpenCV object does not expose runtime hooks.'));
    }
  });
}

async function loadLocalScriptWithDom(url) {
  const existing = document.querySelector(`script[data-opencv-local="${url}"]`);
  if (existing && hasRequiredApis(globalThis.cv)) {
    return true;
  }

  return await new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.async = true;
    script.src = url;
    script.dataset.opencvLocal = url;

    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };
    const onLoad = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Failed to load local OpenCV script: ${url}`));
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out while loading local OpenCV script: ${url}`));
    }, LOCAL_SOURCE_TIMEOUT_MS);

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });

    if (!existing) {
      (document.head || document.documentElement).appendChild(script);
    }
  });
}

async function loadLocalScriptWithFetch(url) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to fetch local OpenCV script (${response.status}): ${url}`);
  }
  const source = await response.text();
  const run = new Function(`${source}\n//# sourceURL=${url}`);
  run.call(globalThis);
  return true;
}

async function loadLocalCv(url) {
  if (hasRequiredApis(globalThis.cv)) {
    return waitForRuntime(globalThis.cv);
  }
  if (localScriptLoadPromises.has(url)) {
    return localScriptLoadPromises.get(url);
  }

  const task = (async () => {
    if (typeof document === 'object') {
      await withTimeout(
        loadLocalScriptWithDom(url),
        LOCAL_SOURCE_TIMEOUT_MS + 2000,
        `Timed out while evaluating local OpenCV script: ${url}`
      );
    } else {
      await withTimeout(
        loadLocalScriptWithFetch(url),
        LOCAL_SOURCE_TIMEOUT_MS,
        `Timed out while fetching local OpenCV script: ${url}`
      );
    }
    const cv = extractCv(globalThis.cv);
    return await waitForRuntime(cv);
  })();

  localScriptLoadPromises.set(url, task);
  try {
    return await task;
  } catch (err) {
    localScriptLoadPromises.delete(url);
    throw err;
  }
}

async function loadCvFromModuleUrl(url) {
  const moduleNs = await withTimeout(
    import(url),
    MODULE_SOURCE_TIMEOUT_MS,
    `Timed out while importing OpenCV module: ${url}`
  );
  let cv = extractCv(moduleNs);
  if (typeof cv === 'function' && !hasRequiredApis(cv)) {
    cv = cv();
  }
  if (cv && typeof cv.then === 'function') {
    cv = await cv;
  }
  cv = stripThenable(cv);
  return await waitForRuntime(cv);
}

export async function ensureCvReady() {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = (async () => {
    let lastError = null;

    for (const localUrl of LOCAL_SCRIPT_URLS) {
      try {
        return await loadLocalCv(localUrl);
      } catch (err) {
        lastError = err;
      }
    }

    for (const moduleUrl of MODULE_URLS) {
      try {
        return await loadCvFromModuleUrl(moduleUrl);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to load @techstark/opencv-js.');
  })();

  return cvReadyPromise;
}
