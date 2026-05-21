function getOpenCvScriptBySource(src) {
  return Array.from(document.querySelectorAll('script[data-opencv-loader="1"]'))
    .find(script => script.dataset.opencvSource === src) || null;
}

function waitForScriptLoad(script, src) {
  return new Promise((resolve, reject) => {
    const loadState = script.dataset.loadState;
    if (loadState === 'loaded') {
      resolve();
      return;
    }
    if (loadState === 'failed') {
      reject(new Error(`OpenCV script load failed: ${src}`));
      return;
    }

    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`OpenCV script load failed: ${src}`));
    };
    const cleanup = () => {
      script.removeEventListener('load', onLoad);
      script.removeEventListener('error', onError);
    };

    script.addEventListener('load', onLoad);
    script.addEventListener('error', onError);
  });
}

function waitForOpenCvRuntime(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!window.cv) {
      reject(new Error('OpenCV global is unavailable'));
      return;
    }
    if (window.cv.Mat) {
      resolve(true);
      return;
    }

    let settled = false;
    const timeoutId = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('OpenCV runtime init timeout'));
    }, timeoutMs);

    const prev = window.cv.onRuntimeInitialized;
    window.cv.onRuntimeInitialized = () => {
      if (typeof prev === 'function') {
        try {
          prev();
        } catch (err) {
          console.warn('Previous OpenCV runtime hook failed:', err);
        }
      }
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      if (window.cv && window.cv.Mat) {
        resolve(true);
      } else {
        reject(new Error('OpenCV initialized without Mat API'));
      }
    };
  });
}

export function createOpenCvLoader(sources) {
  let readyPromise = null;
  let activeSource = null;

  async function loadOpenCvFromSource(src) {
    if (window.cv && window.cv.Mat) {
      activeSource = src;
      return true;
    }

    let script = getOpenCvScriptBySource(src);
    if (script && script.dataset.loadState === 'failed') {
      script.remove();
      script = null;
    }

    if (!script) {
      script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      script.dataset.opencvLoader = '1';
      script.dataset.opencvSource = src;
      script.dataset.loadState = 'loading';
      script.onload = () => {
        script.dataset.loadState = 'loaded';
      };
      script.onerror = () => {
        script.dataset.loadState = 'failed';
      };
      document.head.appendChild(script);
    }

    await waitForScriptLoad(script, src);

    if (!window.cv) {
      throw new Error(`OpenCV global unavailable after loading ${src}`);
    }
    if (!window.cv.Mat) {
      await waitForOpenCvRuntime();
    }
    if (!(window.cv && window.cv.Mat)) {
      throw new Error(`OpenCV runtime incomplete after loading ${src}`);
    }

    activeSource = src;
    return true;
  }

  return async function ensureOpenCvReady() {
    if (window.cv && window.cv.Mat) return true;
    if (readyPromise) return readyPromise;

    readyPromise = (async () => {
      const errors = [];
      for (const src of sources) {
        try {
          await loadOpenCvFromSource(src);
          if (activeSource) {
            console.info('OpenCV loaded from:', activeSource);
          }
          return true;
        } catch (err) {
          const message = err?.message || String(err);
          errors.push(`[${src}] ${message}`);
          console.warn('OpenCV source failed:', src, message);
        }
      }

      console.error('OpenCV unavailable. Tried sources:', errors.join(' | '));
      return false;
    })();

    const ready = await readyPromise;
    if (!ready) {
      readyPromise = null;
    }
    return ready;
  };
}
