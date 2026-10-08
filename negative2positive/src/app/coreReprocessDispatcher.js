// Frame-gated dispatch for the interactive SilverCore preview (#233).
//
// `scheduleCoreReprocess` in main.js owns the request slot and the busy lane.
// This module owns *when* a request leaves: at the end of the current task, at
// the next animation frame, or after a plain timer, and what counts as "this
// frame". A 16 ms timer used to do all of that; it is shorter than the frame
// interval it tried to match, so it dropped every other changed frame and
// delayed every idle request by a full timer period.
//
// A gate handle is a plain object that stays truthy until it fires or is
// cancelled, so `coreReprocessTimer` keeps meaning "a request is still held".

export const CORE_FULL_REPROCESS_DELAY_MS = 70;
// rAF can be throttled while `document.hidden` stays false (an occluded
// WKWebView window). The fallback keeps the newest settings from sticking.
export const CORE_FRAME_GATE_FALLBACK_MS = 50;

// How a preview request should leave, given the lane and the armed gate.
//  'queue' – a preview is converting: hand it to the newest-wins slot now.
//  'keep'  – a gate is armed and will post the newest slot.
//  'task'  – idle lane, first post this frame: post at the end of this task.
//  'frame' – already posted this frame: wait for the next one.
export function previewDispatchAction({ laneBusy, gateArmed, postedThisFrame }) {
  if (laneBusy) return 'queue';
  if (gateArmed) return 'keep';
  return postedThisFrame ? 'frame' : 'task';
}

export function createCoreReprocessGates(env = {}) {
  const requestFrame = env.requestAnimationFrame
    || (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
  const cancelFrame = env.cancelAnimationFrame
    || (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : () => {});
  const startTimer = env.setTimeout || setTimeout;
  const stopTimer = env.clearTimeout || clearTimeout;
  const enqueueMicrotask = env.queueMicrotask
    || (typeof queueMicrotask === 'function' ? queueMicrotask : (callback) => Promise.resolve().then(callback));
  const timeline = env.timeline || null;
  const isHidden = typeof env.isHidden === 'function' ? env.isHidden : () => false;
  const fallbackMs = Number.isFinite(env.fallbackMs) ? env.fallbackMs : CORE_FRAME_GATE_FALLBACK_MS;

  // document.timeline.currentTime holds still for the whole frame. Without it,
  // a counter bumped by the first rAF after a post stands in for it.
  let frameCounter = 0;
  let counterFrame = 0;
  let lastPostFrame = null;

  function frameKey() {
    const time = timeline ? timeline.currentTime : null;
    if (typeof time === 'number' && Number.isFinite(time)) return time;
    return frameCounter;
  }

  function markPosted() {
    lastPostFrame = frameKey();
    const time = timeline ? timeline.currentTime : null;
    if ((typeof time !== 'number' || !Number.isFinite(time)) && !counterFrame && requestFrame) {
      counterFrame = requestFrame(() => { counterFrame = 0; frameCounter += 1; });
    }
  }

  function postedThisFrame() {
    return lastPostFrame !== null && frameKey() === lastPostFrame;
  }

  function settle(handle) {
    if (!handle || handle.done) return false;
    handle.done = true;
    if (handle.frame) cancelFrame(handle.frame);
    if (handle.timer !== null) stopTimer(handle.timer);
    handle.frame = 0;
    handle.timer = null;
    return true;
  }

  function gate(kind, fire) {
    const handle = { kind, done: false, frame: 0, timer: null };
    handle.fire = () => { if (settle(handle)) fire(); };
    return handle;
  }

  // Runs once the current task's synchronous code has finished, so a caller
  // that writes more state after scheduling is still included in the request.
  function armTask(fire) {
    const handle = gate('task', fire);
    enqueueMicrotask(handle.fire);
    return handle;
  }

  function armFrame(fire) {
    if (isHidden() || !requestFrame) return armTimeout(fire, 0);
    const handle = gate('frame', fire);
    handle.frame = requestFrame(handle.fire);
    handle.timer = startTimer(handle.fire, fallbackMs);
    return handle;
  }

  function armTimeout(fire, delayMs) {
    const handle = gate('timeout', fire);
    handle.timer = startTimer(handle.fire, Math.max(0, delayMs || 0));
    return handle;
  }

  // Cancels whichever gate is armed. A bare id from an older caller is
  // cleared as a timeout.
  function cancel(handle) {
    if (!handle) return;
    if (typeof handle === 'object' && 'done' in handle) {
      settle(handle);
      return;
    }
    stopTimer(handle);
  }

  return { frameKey, markPosted, postedThisFrame, armTask, armFrame, armTimeout, cancel };
}
