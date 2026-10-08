// Failure classes of the multi-shot merge, shared by its worker and the page.
// A memory failure gets its own alert ("merge fewer shots or close other
// apps"); anything else is logged and reported as a failed merge.

const MEMORY_MESSAGE = /Insufficient memory|Failed to allocate|out of memory|\bOOM\b|enlarge memory|allocation failed/i;

export class MultiShotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MultiShotError';
    this.code = code;
  }
}

// { code: 'memory' | 'failed', message } for any thrown value. OpenCV.js
// throws C++ exceptions as bare numbers (pointers into its heap); only
// cv.exceptionFromPtr(ptr).msg makes them readable, and only in the realm
// that owns that heap, so a worker must describe them before posting.
// StsNoMem (-4) reads "(-4:Insufficient memory) Failed to allocate N bytes".
export function describeMultiShotError(error, cv = globalThis.cv) {
  if (error instanceof MultiShotError) return { code: error.code, message: error.message };
  let message;
  if (typeof error === 'number') {
    try { message = cv?.exceptionFromPtr?.(error)?.msg; } catch { /* not an exception pointer */ }
    message ||= `OpenCV exception ${error}`;
  } else {
    message = String(error?.message || error || 'Unknown error');
  }
  // A RangeError here comes from an ArrayBuffer or typed-array allocation
  // ("Array buffer allocation failed", "Invalid typed array length", JSC's
  // "Out of memory"); a stack overflow is the one that is not about memory.
  const memory = MEMORY_MESSAGE.test(message) || (error instanceof RangeError && !/call stack/i.test(message));
  return { code: memory ? 'memory' : 'failed', message };
}
