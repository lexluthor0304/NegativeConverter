import { answerOpenCvWorker } from './opencvRuntime.js';
import { isSharedPlane, hasDerivedEightBit, guardSharedPlanes } from './crossOriginIsolation.js';

// Content hash and occupied blocks of each mask the worker returned, keyed by
// the mask object. A mask made on the page (the OpenCV fallback) has none.
const maskInfos = new WeakMap();
export function dustMaskInfo(mask) {
  return (mask && maskInfos.get(mask)) || null;
}
// A mask the page patches in place (a brush stroke or its undo, #259) no
// longer has the content its summary describes.
export function forgetDustMaskInfo(mask) {
  if (mask) maskInfos.delete(mask);
}

// Planes are sent in slices of at most this size, one per task, so seeding the
// worker with a 60 MP frame never blocks the page for long (#259): a 480 MB
// 16-bit plane becomes 15 copies of about 11 ms each instead of one 163 ms task.
const PLANE_SLICE_BYTES = 32 * 1024 * 1024;

function abortError() {
  return new DOMException('Dust worker released', 'AbortError');
}

/**
 * Reusable full-resolution dust worker; source pixels and morphology stay there.
 *
 * While dust editing is active the page pins the worker: it is then never
 * released for idleness and keeps the clean source (both planes) and the
 * current mask, so a brush stroke sends only its points. `pinned` is the
 * reservation a memory ledger can see; unpinning restores the idle release.
 */
export function createDustWorkerClient({
  workerFactory = () => new Worker(new URL('../workers/dustWorker.js', import.meta.url), { type: 'module' }),
  timeoutMs = 120000, idleTimeoutMs = 30000, planeSliceBytes = PLANE_SLICE_BYTES,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0))
} = {}) {
  let worker = null, sequence = 0, source = null, precision = null, idleTimer = null;
  // Tag of the mask the worker holds (set by the page), or null.
  let maskTag = null;
  let pinned = false, generation = 0, postingTail = null;
  const pending = new Map();

  function armIdleRelease() {
    clearTimeout(idleTimer);
    if (!worker || pending.size || pinned) return;
    idleTimer = setTimeout(() => release(new Error('Dust worker idle')), idleTimeoutMs);
    idleTimer.unref?.();
  }
  function release(error) {
    clearTimeout(idleTimer);
    generation++;
    const dying = worker;
    worker = source = precision = maskTag = null;
    if (dying) {
      dying.onmessage = dying.onerror = dying.onmessageerror = null;
      try { dying.terminate(); } catch { /* already stopped */ }
    }
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  }
  function getWorker() {
    if (worker) return worker;
    const current = workerFactory();
    worker = current;
    current.onerror = () => { if (worker === current) release(new Error('Dust worker crashed')); };
    current.onmessageerror = () => { if (worker === current) release(new Error('Invalid dust worker message')); };
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      // The worker asks for the session's compiled OpenCV module (#252).
      if (answerOpenCvWorker(current, data)) return;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) {
        // Reported by the worker's own code (an OpenCV error), not a lost worker.
        const error = Object.assign(new Error(data.error), { dustWorkerReported: true, staleMask: Boolean(data.staleMask) });
        entry.reject(error);
        // A stroke against a mask the worker no longer holds leaves it intact.
        if (data.staleMask) { maskTag = null; armIdleRelease(); } else release(new Error(data.error));
        return;
      }
      try {
        if (data.mask && data.maskInfo) maskInfos.set(data.mask, data.maskInfo);
        entry.resolve(entry.decode(data));
      } catch (error) { entry.reject(error); release(error); }
      armIdleRelease();
    };
    return current;
  }

  // Posts one message now and returns the promise of its reply.
  function post(message, transfers, decode) {
    clearTimeout(idleTimer);
    const current = getWorker();
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => release(new Error('Dust worker timed out')), timeoutMs);
      pending.set(id, { resolve, reject, timer, decode });
      current.postMessage({ ...message, id }, transfers);
    });
  }

  // Messages leave in call order. A sliced upload spans several tasks, and
  // anything requested meanwhile is posted after its last slice.
  function schedule(step) {
    if (!postingTail) {
      let out;
      try { out = step(); } catch (error) { release(error); return Promise.reject(error); }
      if (out.posted) track(out.posted);
      return out.reply;
    }
    return new Promise((resolve, reject) => {
      track(postingTail.then(() => {
        let out;
        try { out = step(); } catch (error) { release(error); reject(error); return undefined; }
        out.reply.then(resolve, reject);
        return out.posted;
      }));
    });
  }
  function track(posted) {
    const tail = posted.catch(() => {}).then(() => { if (postingTail === tail) postingTail = null; });
    postingTail = tail;
  }

  function uploadPlane(kind, image, array, extra = {}) {
    const run = generation;
    // A shared plane (#264) is posted whole, without a copy or a transfer;
    // the worker keeps that view. `derive8` also makes the worker's 8-bit
    // source from it (the frame's 8-bit plane is the 16-bit one >>> 8).
    if (isSharedPlane(array)) {
      const guard = guardSharedPlanes(`dust plane ${kind}`, [array]);
      const reply = post({ type: 'plane', kind, width: image.width, height: image.height,
        offset: 0, total: array.length, chunk: array, done: true, ...extra }, [], data => data);
      reply.then(() => guard.verify(), () => guard.verify());
      return { posted: reply.then(() => undefined, () => undefined), reply };
    }
    const step = Math.max(1, Math.floor(planeSliceBytes / array.BYTES_PER_ELEMENT));
    let reply;
    const posted = (async () => {
      for (let offset = 0; ; offset += step) {
        if (run !== generation) throw abortError();
        const end = Math.min(array.length, offset + step);
        const chunk = array.slice(offset, end);
        const done = end >= array.length;
        reply = post({ type: 'plane', kind, width: image.width, height: image.height,
          offset, total: array.length, chunk, done, ...extra }, [chunk.buffer], data => data);
        if (done) return;
        reply.catch(() => {});
        await yieldTask();
      }
    })();
    return { posted, reply: posted.then(() => reply) };
  }

  // Seeds the worker with what it lacks of `image` (8-bit, then 16-bit) and,
  // when given, a mask under `tag`. Each plane goes in slices; what the worker
  // lacks is decided when the plane's turn comes, so repeated calls are cheap.
  function seed(image, maskInfo = null) {
    const skip = () => ({ reply: Promise.resolve() });
    const plane16 = image.__image16?.data;
    // A shared 16-bit plane whose >>> 8 is the frame's 8-bit plane seeds
    // both at once: no 8-bit copy either (#264).
    const derive8 = isSharedPlane(plane16) && hasDerivedEightBit(image);
    const replies = [schedule(() => {
      if (source === image) return skip();
      const out = derive8
        ? uploadPlane('image16', image, plane16, { derive8: true })
        : uploadPlane('rgba', image, image.data);
      source = image; precision = derive8 ? plane16 : null; maskTag = null;
      return out;
    })];
    if (image.__image16?.data) {
      replies.push(schedule(() => {
        const plane16 = image.__image16.data;
        if (source !== image || precision === plane16) return skip();
        const out = uploadPlane('image16', image, plane16);
        precision = plane16;
        return out;
      }));
    }
    if (maskInfo) {
      replies.push(schedule(() => {
        if (source !== image || maskTag === maskInfo.tag) return skip();
        const out = uploadPlane('mask', image, maskInfo.mask,
          { tag: maskInfo.tag, particleCount: maskInfo.particleCount ?? null, pinned });
        maskTag = maskInfo.tag;
        return out;
      }));
    }
    return Promise.all(replies).then(() => undefined);
  }

  function request(type, image, options, decode) {
    // Masks are copied now: the page patches its mask in place afterwards.
    const extra = { ...options };
    const transfers = [];
    for (const key of ['mask', 'brushMask']) {
      if (extra[key]) { extra[key] = extra[key].slice(); transfers.push(extra[key].buffer); }
    }
    return schedule(() => {
      const reuseSource = source === image;
      const message = { type, width: image.width, height: image.height, reuseSource, ...extra };
      const moved = transfers.slice();
      const plane16 = image.__image16?.data;
      // A shared 16-bit plane is sent as it is (#264), and derives the 8-bit
      // source too where it can; plain planes are copied as before.
      const shared16 = isSharedPlane(plane16) ? plane16 : null;
      const derive8 = !reuseSource && Boolean(shared16) && hasDerivedEightBit(image);
      if (!reuseSource && !derive8) {
        message.rgba = image.data.slice();
        moved.push(message.rgba.buffer);
      }
      const image16 = type === 'detect' && !shared16 ? null : plane16;
      if (image16 && (!reuseSource || precision !== image16)) {
        message.image16 = shared16 || image16.slice();
        if (!shared16) moved.push(message.image16.buffer);
      }
      if (derive8) message.derive8 = true;
      const guard = guardSharedPlanes(`dust ${type}`, [shared16]);
      const reply = post(message, moved, decode);
      reply.then(() => guard.verify(), () => guard.verify());
      source = image;
      precision = image16 || (reuseSource ? precision : null);
      if (!reuseSource) maskTag = null;
      return { reply };
    });
  }

  function detect(image, options = {}) {
    const { maskTag: tag = null, ...settings } = options;
    const reply = request('detect', image, { ...settings, maskTag: tag, pinned }, data => {
      if (tag != null) maskTag = tag;
      return { mask: data.mask, particleCount: data.particleCount, _state: null, tint: data.tint || null };
    });
    // Brush strokes need the 16-bit plane; send it now, behind detection.
    if (pinned) seed(image).catch(() => {});
    return reply;
  }

  function decodeImage(data) {
    const raw = data.image;
    const image = new ImageData(raw.data, raw.width, raw.height);
    if (raw.image16) image.__image16 = { width: raw.width, height: raw.height, data: raw.image16 };
    return image;
  }

  /**
   * One brush stroke on the worker's mask, which must carry `baseTag`; it
   * then carries `tag`. When the worker lacks the source, both planes are
   * re-sent first (in slices); when it lacks that mask (or `forceMask`),
   * `mask` is sent once. Resolves to the patch, or null when the stroke set
   * no pixel. A worker holding another mask rejects with `staleMask`.
   */
  function stroke(image, { baseTag, tag, mask, points, brushRadius, mode, radius = 3, forceMask = false, tint = null }) {
    if (source !== image || (image.__image16 && precision !== image.__image16.data)) seed(image).catch(() => {});
    const resend = forceMask || maskTag !== baseTag ? mask.slice() : null;
    const options = { baseTag, tag, points, brushRadius, mode, radius, tint };
    return schedule(() => {
      if (source !== image) {
        return { reply: Promise.reject(Object.assign(new Error('Dust worker lost its source'), { staleMask: true })) };
      }
      const message = { type: 'stroke', width: image.width, height: image.height, reuseSource: true, ...options };
      const transfers = [];
      if (resend) { message.mask = resend; transfers.push(resend.buffer); }
      const reply = post(message, transfers, data => {
        maskTag = data.patch ? tag : baseTag;
        return data.patch;
      });
      maskTag = null;
      return { reply };
    });
  }

  /** Follows an undo/redo of a stroke; skipped when the worker holds another mask. */
  function maskDelta(image, { baseTag, tag, rect, bytes, particleCount = null }) {
    if (maskTag !== baseTag || source !== image) return Promise.resolve(false);
    const copy = bytes.slice();
    return schedule(() => {
      if (maskTag !== baseTag || source !== image) return { reply: Promise.resolve(false) };
      const reply = post({ type: 'maskDelta', width: image.width, height: image.height,
        baseTag, tag, rect, bytes: copy, particleCount }, [copy.buffer], () => true);
      maskTag = tag;
      return { reply };
    });
  }

  return {
    detect,
    inpaint: (image, mask, radius = 3) => request('inpaint', image, { mask, radius }, decodeImage),
    stroke,
    maskDelta,
    /** Keeps the worker (and `image`'s planes, and `mask` under `tag`) until unpin. */
    pin(image, maskInfo = null) {
      pinned = true;
      clearTimeout(idleTimer);
      // The page patches its mask in place: send a copy, and only when the
      // worker holds another mask.
      const sendMask = maskInfo?.mask && (maskTag !== maskInfo.tag || source !== image);
      return seed(image, sendMask ? { ...maskInfo, mask: maskInfo.mask.slice() } : null);
    },
    unpin() {
      if (!pinned) return;
      pinned = false;
      armIdleRelease();
    },
    dispose: () => release(abortError()),
    get pinned() { return pinned; },
    get maskTag() { return maskTag; },
    get pendingCount() { return pending.size; }
  };
}

const shared = createDustWorkerClient();
export const detectDustInWorker = shared.detect;
export const inpaintDustInWorker = shared.inpaint;
export const strokeDustInWorker = shared.stroke;
export const followDustMaskInWorker = shared.maskDelta;
export const pinDustWorker = shared.pin;
export const unpinDustWorker = shared.unpin;
export const disposeDustWorker = shared.dispose;
/** The page's dust worker (#258 reads `pinned` before trimming OpenCV workers). */
export const dustWorker = shared;
