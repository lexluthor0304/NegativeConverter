// When the GPU preview draws, and when its exact frame settles it (#239).
//
// A SilverCore request that the GPU can show is drawn with applyProgram at the next
// animation frame instead of being converted. That frame is display-only: it never
// reaches processedImageData, the photo-session cache, thumbnails or an export. The
// exact worker frame for the newest settings ("the settle") leaves on commit, after
// GPU_SETTLE_IDLE_MS without a new request, or at once from an export barrier
// (settleNow). Until it has been applied the display is "ahead" of the state, and
// busy() says so, so every barrier that waits for the reprocess chain waits for it.
//
// main.js supplies the effects:
//   armFrame(fire) / cancelFrame(handle)  the frame gate (coreReprocessGates.armFrame)
//   setTimeout / clearTimeout
//   draw()          draws the newest settings with applyProgram; false when it cannot
//   postExact(token) dispatches the exact frame carrying `token`
//   onIdle()        busy() may have turned false (noteCoreReprocessSettled)
//   onAbandon()     the display fell back to the exact frame on screen (redraw it)

export const GPU_SETTLE_IDLE_MS = 150;
// A 3D profile or an analysis whose request failed is asked for again after
// this long (main.js gpuProfileLoaded, requestGpuAnalyze); meanwhile the ticks
// it is missing for convert in the worker.
export const GPU_INPUT_RETRY_MS = 5000;

export function createGpuPreviewScheduler(env) {
  const settleMs = Number.isFinite(env.settleMs) ? env.settleMs : GPU_SETTLE_IDLE_MS;
  // Token of the newest settings the GPU shows (or is about to show) with no exact
  // frame applied for them yet; null when the exact frame on screen is current.
  let ahead = null;
  // Token of the exact frame dispatched for `ahead`.
  let posted = null;
  let frame = null;
  let settleTimer = null;
  const stats = { requests: 0, draws: 0, failedDraws: 0, settles: 0 };

  function clearTimer() {
    if (settleTimer) env.clearTimeout(settleTimer);
    settleTimer = null;
  }

  function clearAll() {
    ahead = null;
    posted = null;
    clearTimer();
    if (frame) env.cancelFrame(frame);
    frame = null;
  }

  function fire() {
    frame = null;
    if (ahead === null) return;
    if (env.draw()) {
      stats.draws += 1;
      return;
    }
    // Not drawable after all: the exact frame shows these settings instead.
    stats.failedDraws += 1;
    settleNow();
  }

  function armSettle() {
    clearTimer();
    settleTimer = env.setTimeout(() => {
      settleTimer = null;
      settleNow();
    }, settleMs);
  }

  // Dispatches the exact frame for the newest GPU settings unless it already left.
  // Returns whether the display was ahead.
  function settleNow() {
    clearTimer();
    if (ahead === null) return false;
    if (posted !== ahead) {
      posted = ahead;
      stats.settles += 1;
      env.postExact(ahead);
    }
    return true;
  }

  return {
    stats,

    // A SilverCore request the GPU shows. `settle` sends its exact frame at once
    // (a commit such as a select change).
    request(token, { settle = false } = {}) {
      stats.requests += 1;
      ahead = token;
      if (!frame) frame = env.armFrame(fire);
      armSettle();
      if (settle) settleNow();
    },

    settleNow,

    // Draw again with the newest state (an analysis reply, a Step-3 change).
    redraw() {
      if (ahead !== null && !frame) frame = env.armFrame(fire);
    },

    // A request that converts instead (full, resize, excluded mode) now carries the
    // newest settings; its frame settles the display.
    handOver(token) {
      if (ahead === null) return;
      ahead = token;
      posted = token;
      clearTimer();
    },

    // An exact frame for `token` was applied.
    exactApplied(token) {
      if (ahead === null || token < ahead) return;
      clearAll();
      env.onIdle();
    },

    // A conversion carrying `token` ended. If it was the one settling the display and
    // did not apply (dropped for another source or generation, or failed), nothing else
    // will: the display returns to the exact frame on screen.
    flightEnded(token) {
      if (ahead === null || token !== ahead || posted !== ahead) return;
      clearAll();
      env.onAbandon?.();
      env.onIdle();
    },

    // Photo switch, restart, undo, context loss: nothing on screen is ahead anymore.
    cancel() {
      const was = ahead !== null || settleTimer !== null;
      clearAll();
      if (was) env.onIdle();
    },

    isAhead() {
      return ahead !== null;
    },

    busy() {
      return ahead !== null || settleTimer !== null;
    },

    settleArmed() {
      return settleTimer !== null;
    },
  };
}

// The scheduler main.js uses where the GPU path does not exist (WebGL1, tests).
export const DISABLED_GPU_PREVIEW_SCHEDULER = Object.freeze({
  stats: Object.freeze({ requests: 0, draws: 0, failedDraws: 0, settles: 0 }),
  request() {}, settleNow: () => false, redraw() {}, handOver() {}, exactApplied() {}, flightEnded() {}, cancel() {},
  isAhead: () => false, busy: () => false, settleArmed: () => false,
});
