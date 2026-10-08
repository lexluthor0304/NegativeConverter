// Yields for long jobs that must keep going while the window is hidden
// (#241, shared with #245's Apply Crop).
//
// A hidden document never fires requestAnimationFrame, and WebKit and Chrome
// align DOM timers in hidden pages to 1 s or more, so a job that paces itself
// with either stalls or crawls as soon as the user switches apps. A
// MessageChannel round trip is a real task boundary that is not a DOM timer,
// so hidden-page alignment does not apply to it.

function currentDocument() {
  return typeof document === 'undefined' ? null : document;
}

export function isDocumentHidden(doc = currentDocument()) {
  return Boolean(doc && doc.visibilityState === 'hidden');
}

/** One task boundary that hidden-page timer alignment does not clamp. */
export function yieldTask() {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/**
 * Paint, then continue: rAF then setTimeout(0) while visible, so progress and
 * overlays are committed before the next task; a MessageChannel task while
 * hidden. A page that hides while the frame is pending continues through the
 * hidden branch instead of waiting for a frame that will not come.
 */
export function yieldToPaint(doc = currentDocument()) {
  if (!doc || isDocumentHidden(doc) || typeof requestAnimationFrame !== 'function') return yieldTask();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      doc.removeEventListener?.('visibilitychange', onHidden);
      resolve();
    };
    const onHidden = () => {
      if (isDocumentHidden(doc)) void yieldTask().then(finish);
    };
    doc.addEventListener?.('visibilitychange', onHidden);
    requestAnimationFrame(() => setTimeout(finish, 0));
  });
}

// The name #241 uses on job paths; the same helper.
export const yieldForJob = yieldToPaint;

/**
 * A task boundary for job loops that do not need a paint (ZIP CRC, roll
 * analysis frames): setTimeout(0) while visible, as before, and the
 * MessageChannel task while hidden.
 */
export function yieldTaskForJob(doc = currentDocument()) {
  if (isDocumentHidden(doc)) return yieldTask();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
