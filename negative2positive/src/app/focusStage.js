// Focus recovery as a stage of the editor (render/focusRecovery.js does the
// arithmetic; docs/focus-recovery.md).
//
// The stage sits after the repairs and before Step 3. The repaired frame stays
// the editor's processed frame (the dust input, the brush's target, what
// history holds); the recovered frame is derived from it on the GPU and read
// by what comes next: the display preview, the detail layer and each export.
// This module keeps the open photo's recovered frame current: which frame it
// was made of, at which revision of its pixels (strokes patch the repaired
// frame in place) and at which strength.
//
// There is no CPU path: where WebGL2 cannot render to float textures the stage
// is unsupported and the control is off.

/**
 * @param {object} deps
 * @param {() => { supported: boolean, lost?: boolean, recover: Function, dispose: Function }} deps.createRecoverer
 * @param {(frame) => object|null} deps.estimate - estimateFocus
 * @param {(width, height, estimate, strength01) => object|null} deps.plan - focusPlan
 * @param {() => object|null} deps.frame - the editor's processed (repaired) frame
 * @param {() => number} deps.revision - bumped when that frame's pixels are patched in place
 * @param {() => number} deps.strength - 0-100
 * @param {() => boolean} deps.active - the editor shows a converted photo
 * @param {() => boolean} deps.repairsPending - dust detection or a repair is about to replace the frame
 * @param {() => boolean} deps.frameIsPreview - the processed frame is not the full-resolution one
 * @param {() => Promise<void>} deps.requestFullFrame - asks for the full-resolution frame
 * @param {() => void} deps.onChanged - the recovered frame changed: readers refresh
 * @param {(state: { kind: string, estimate?: object, plan?: object, error?: Error }) => void} deps.onStatus
 */
export function createFocusStage({
  createRecoverer, estimate, plan, frame, revision, strength, active, repairsPending, frameIsPreview,
  requestFullFrame, onChanged = () => {}, onStatus = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)), warn = (...args) => console.warn(...args)
}) {
  let recoverer = null;
  // { source, revision, strength, frame }: `frame` is null when the photo has no blur worth undoing.
  let live = null;
  let job = null;
  let timer = null;
  const estimates = new WeakMap();   // frame -> { revision, estimate }

  function supported() {
    if (!recoverer || recoverer.lost) {
      try { recoverer?.dispose(); } catch { /* a lost context has nothing left to free */ }
      try { recoverer = createRecoverer(); }
      catch (error) { warn('Focus recovery is unavailable:', error); recoverer = { supported: false, dispose() {} }; }
    }
    return Boolean(recoverer.supported);
  }
  const wanted = () => strength() > 0 && active() && supported();
  const current = (processed = frame()) => Boolean(live && processed && live.source === processed
    && live.revision === revision() && live.strength === strength());
  // What is shown and exported of a frame: the open photo's recovered frame when it is current.
  const sourceOf = (processed) => (processed && processed === frame() && current(processed) && live.frame ? live.frame : processed);

  function planOf(target, amount, at = 0) {
    let known = estimates.get(target);
    if (!known || known.revision !== at) {
      known = { revision: at, estimate: estimate(target) };
      estimates.set(target, known);
    }
    return { estimate: known.estimate, plan: plan(target.width, target.height, known.estimate, amount / 100) };
  }

  /** The recovered frame of any frame (a new one), or the frame itself when there is nothing to undo. */
  async function recoverFrame(target, amount, { isCurrent = null } = {}) {
    if (!(amount > 0) || !target) return target;
    if (!supported()) throw new Error('Focus recovery needs a GPU (WebGL2) that this device does not provide.');
    const planned = planOf(target, amount).plan;
    if (!planned) return target;
    return (await recoverer.recover(target, planned, { isCurrent, yieldBetweenTiles: yieldTask })) || target;
  }

  function schedule(delay = 250) {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; void run(); }, delay);
  }
  /** The frame the recovery was made of is no longer the editor's, or its pixels moved. */
  function noteSourceChanged() {
    if (live && !current()) live = null;
    if (strength() > 0) schedule();
  }

  async function run() {
    const amount = strength();
    if (!(amount > 0) || !supported()) {
      if (live) { live = null; onChanged(); }
      onStatus({ kind: supported() ? 'off' : 'unsupported' });
      return;
    }
    let processed = frame();
    if (!processed || !active()) return;
    // Repairs first: what they are about to replace is not worth recovering.
    if (repairsPending()) { schedule(400); return; }
    // The blur is the full-resolution frame's: a large photo keeps only its
    // display-size conversion until something asks for the rest. The frame
    // that lands is noted (noteSourceChanged) and comes back here.
    if (frameIsPreview()) {
      onStatus({ kind: 'working' });
      await requestFullFrame();
      if (frame() !== processed || frameIsPreview()) {
        if (strength() > 0 && frame() && !frameIsPreview()) schedule(0);
        return;
      }
    }
    if (current(processed)) return;
    const at = revision();
    const mine = job = {};
    const isCurrent = () => job === mine && frame() === processed && revision() === at && strength() === amount;
    onStatus({ kind: 'working' });
    try {
      const planned = planOf(processed, amount, at);
      const recovered = planned.plan
        ? await recoverer.recover(processed, planned.plan, { isCurrent, yieldBetweenTiles: yieldTask }) : null;
      if (!isCurrent()) return;
      live = { source: processed, revision: at, strength: amount, frame: recovered };
      onStatus({ kind: !planned.estimate ? 'no-edges' : planned.plan ? 'done' : 'sharp', estimate: planned.estimate, plan: planned.plan });
      onChanged();
    } catch (error) {
      if (error?.name === 'AbortError' || !isCurrent()) return;
      onStatus({ kind: 'error', error });
    } finally {
      if (job === mine) job = null;
    }
  }

  /** An export's barrier: resolves once the frame about to be exported has its recovered frame. */
  async function ensureForExport() {
    if (!(strength() > 0) || !active()) return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    for (let attempt = 0; attempt < 8 && !current(); attempt++) {
      await run();
      if (job || repairsPending()) await new Promise(resolve => setTimer(resolve, 50));
    }
    if (!current()) throw new Error('Focus recovery could not finish, so nothing was exported.');
  }

  /** The open photo changed or closed: nothing of the last one is kept. */
  function reset() {
    live = null;
    job = null;
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  return { supported, wanted, current, sourceOf, recoverFrame, schedule, noteSourceChanged, run, ensureForExport, reset,
    /** Bytes the recovered frame holds beside the editor's own planes. */
    get retainedBytes() { return live?.frame ? live.frame.data.byteLength + (live.frame.__image16?.data.byteLength || 0) : 0; } };
}

/** A stage that is off: for harnesses that run editor code without one. */
export const INERT_FOCUS_STAGE = Object.freeze({
  supported: () => false, wanted: () => false, current: () => false, sourceOf: (frame) => frame,
  recoverFrame: async (frame) => frame, schedule() {}, noteSourceChanged() {}, run: async () => {},
  ensureForExport: async () => {}, reset() {}, retainedBytes: 0
});
