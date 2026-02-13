const MODULE_URLS = [
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js/+esm',
  'https://esm.sh/@techstark/opencv-js'
];

let cvReadyPromise = null;

function extractCv(moduleNs) {
  if (!moduleNs) return null;
  if (moduleNs.default) return moduleNs.default;
  if (moduleNs.cv) return moduleNs.cv;
  return moduleNs;
}

function waitForRuntime(cv, timeoutMs = 20000) {
  if (!cv) {
    return Promise.reject(new Error('OpenCV module is empty.'));
  }

  if (typeof cv.Mat === 'function' && typeof cv.inpaint === 'function') {
    return Promise.resolve(cv);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('OpenCV runtime initialization timed out.'));
    }, timeoutMs);

    const previous = cv.onRuntimeInitialized;
    cv.onRuntimeInitialized = () => {
      clearTimeout(timer);
      if (typeof previous === 'function') {
        try {
          previous();
        } catch (err) {
          // Ignore upstream callback failures and still resolve when core APIs are ready.
        }
      }
      if (typeof cv.Mat === 'function' && typeof cv.inpaint === 'function') {
        resolve(cv);
      } else {
        reject(new Error('OpenCV runtime initialized without required APIs.'));
      }
    };
  });
}

export async function ensureCvReady() {
  if (cvReadyPromise) return cvReadyPromise;

  cvReadyPromise = (async () => {
    let lastError = null;
    for (const url of MODULE_URLS) {
      try {
        const moduleNs = await import(url);
        let cv = extractCv(moduleNs);
        if (typeof cv === 'function' && typeof cv.Mat !== 'function') {
          cv = cv();
        }
        if (cv && typeof cv.then === 'function') {
          cv = await cv;
        }
        return await waitForRuntime(cv);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Failed to load @techstark/opencv-js.');
  })();

  return cvReadyPromise;
}
