// Metric definitions over the probe's event log (scripts/perf/probe.js).
// Pure functions, unit-tested with synthetic event streams. All times are
// page `performance.now()` milliseconds.
//
// Definitions follow the 2026-09-23 reports:
// - A *picture* is a draw on the display canvas whose state signature differs
//   from the previous draw's (a new texture, new uniforms or a new size), or
//   a 2D put/draw with new pixels on the CPU display canvas.
// - Input→draw is draw-anchored: picture time minus the time of the newest
//   input it reflects. A picture reflects the newest value-changing input at
//   or before its cause: the request time of the conversion whose result it
//   shows, else the latest upload or uniform change behind it.
// - Frames covered is the share of value-changing frames (60 Hz input frames)
//   whose newest input is reflected by some picture.

import { distribution, median, max, sum, round } from './stats.mjs';

export const GL_CANVAS = 'glCanvas';
export const CPU_CANVAS = 'canvas';
// Crop mode draws on a 2D canvas of its own (#245).
export const CROP_CANVAS = 'cropCanvas';
export const COVERAGE_GRACE_MS = 250;

export function byKind(events, kind) {
  return (events || []).filter(event => event.k === kind);
}

export function within(list, start, end) {
  return list.filter(event => event.t >= start && event.t <= end);
}

/** Conversion results by pixel hash → the request that produced them. */
export function conversionResultIndex(events) {
  const index = new Map();
  for (const res of byKind(events, 'res')) {
    if (res.cls !== 'convert' || res.hash === undefined || res.hash === null) continue;
    if (!index.has(res.hash)) index.set(res.hash, res);
  }
  return index;
}

export const SOURCE_TEXTURE_MIN_PX = 65536;

/**
 * New pictures on one canvas. Each carries its cause time, the conversion
 * result it shows (`res`), when its content arrived (`contentT`) and whether
 * it shows new positive content (`positive`):
 * - #glCanvas only ever shows converted positives (negatives are drawn to the
 *   2D canvas), so a draw after a new source-texture upload is a positive.
 *   Its result is the one whose pixels hash like the upload, else (when the
 *   app resized the result for display) the newest result before the upload.
 *   A uniform-only redraw is a picture but not new content.
 * - #canvas (CPU display path, negatives): a put/draw whose pixels hash
 *   like a conversion result is a positive.
 * - #cropCanvas (the crop view, #245): every draw is a new picture (an angle
 *   change redraws the same proxy with a new transform); `canvasW`/`canvasH`
 *   are the canvas's own pixels.
 */
export function pictures(events, canvasId = GL_CANVAS) {
  const results = conversionResultIndex(events);
  const ordered = byKind(events, 'res').filter(res => res.cls === 'convert' && !res.err).sort((x, y) => x.t - y.t);
  const newestResultBefore = time => {
    let found = null;
    for (const res of ordered) { if (res.t <= time) found = res; else break; }
    return found;
  };
  const out = [];
  if (canvasId === CPU_CANVAS || canvasId === CROP_CANVAS) {
    let lastSig = null;
    for (const event of events) {
      if (event.k !== 'c2d' || event.c !== canvasId) continue;
      const sig = canvasId === CROP_CANVAS ? `${event.fn}:${event.t}` : (event.hash ?? event.sig ?? `${event.fn}:${event.t}`);
      if (sig === lastSig) continue;
      lastSig = sig;
      const res = results.get(event.hash ?? event.src) || null;
      out.push({ t: event.t, causeT: res ? res.rt : event.t, contentT: event.t, positive: Boolean(res), res, w: event.w, h: event.h, canvasW: event.cw, canvasH: event.ch, kind: event.fn });
    }
    return out;
  }
  let lastSig = null;
  let lastDrawT = -Infinity;
  const uploads = byKind(events, 'gl.upload').filter(event => event.c === canvasId);
  let uploadCursor = 0;
  for (const event of events) {
    if (event.k !== 'gl.draw' || event.c !== canvasId) continue;
    const since = [];
    while (uploadCursor < uploads.length && uploads[uploadCursor].t <= event.t) {
      if (uploads[uploadCursor].t > lastDrawT) since.push(uploads[uploadCursor]);
      uploadCursor++;
    }
    const sig = event.sig;
    const prevDrawT = lastDrawT;
    lastDrawT = event.t;
    if (sig !== undefined && sig === lastSig) continue;
    lastSig = sig;
    const source = since.filter(upload => upload.w * upload.h >= SOURCE_TEXTURE_MIN_PX).pop() || null;
    let res = null;
    for (const upload of since) {
      const match = results.get(upload.hash);
      if (match && (!res || match.rt > res.rt)) res = match;
    }
    let matchedBy = res ? 'hash' : null;
    if (!res && source) {
      res = newestResultBefore(source.t);
      matchedBy = res ? 'order' : null;
    }
    let causeT;
    if (res) causeT = res.rt;
    else {
      const candidates = since.map(upload => upload.t);
      if (Number.isFinite(event.ut) && event.ut > prevDrawT) candidates.push(event.ut);
      causeT = candidates.length ? Math.max(...candidates) : event.t;
    }
    out.push({
      t: event.t, causeT, contentT: source ? source.t : null, positive: Boolean(source) || matchedBy === 'hash', res, matchedBy,
      uploads: since, w: source?.w ?? null, h: source?.h ?? null, kind: 'draw'
    });
  }
  return out;
}

/**
 * Inputs of a drag: value-changing events with the time of the trusted
 * pointer event that produced them.
 * - `mode: 'value'`: `input` events on `targetId` (range sliders).
 * - `mode: 'pointer'`: pointer moves with a button down on `targetId` (curve).
 */
export function dragInputs(events, { targetId, mode = 'value', start = -Infinity, end = Infinity, initialValue, allowUntrusted = false } = {}) {
  const inputs = byKind(events, 'input');
  const moves = inputs.filter(event => (event.type === 'mousemove' || event.type === 'pointermove') && (allowUntrusted || event.tr !== false));
  const out = [];
  if (mode === 'pointer') {
    let last = null;
    for (const event of moves) {
      if (event.t < start || event.t > end || event.id !== targetId || !event.b) continue;
      const key = `${event.x},${event.y}`;
      if (key === last) continue;
      last = key;
      out.push({ t: event.t, value: key, source: event });
    }
    return out;
  }
  let previous = initialValue === undefined ? undefined : String(initialValue);
  let moveCursor = 0;
  for (const event of inputs) {
    if (event.type !== 'input' || event.id !== targetId || event.t < start || event.t > end) continue;
    if (event.tr === false && !allowUntrusted) continue;
    const value = String(event.v);
    if (value === previous) continue;
    previous = value;
    // The trusted move that caused this input: the newest move at or before it.
    while (moveCursor + 1 < moves.length && moves[moveCursor + 1].t <= event.t) moveCursor++;
    const move = moves[moveCursor] && moves[moveCursor].t <= event.t && event.t - moves[moveCursor].t < 50 ? moves[moveCursor] : null;
    out.push({ t: move ? move.t : event.t, handledT: event.t, value, source: event });
  }
  return out;
}

/** Index of the newest input with t <= time (binary search); -1 if none. */
export function newestInputIndex(inputs, time) {
  let lo = 0, hi = inputs.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (inputs[mid].t <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Bucket times into 60 Hz frames using rAF frame starts when available. */
export function frameIndexer(frameTimes, fallbackStart, periodMs = 1000 / 60) {
  const frames = (frameTimes || []).slice().sort((a, b) => a - b);
  if (frames.length >= 2) {
    return time => {
      let lo = 0, hi = frames.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (frames[mid] <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    };
  }
  return time => Math.floor((time - fallbackStart) / periodMs);
}

export function longTaskSummary(events, start, end) {
  const tasks = byKind(events, 'lt').filter(task => task.s + task.d >= start && task.s <= end);
  const durations = tasks.map(task => task.d);
  return { n: tasks.length, totalMs: round(sum(durations)), maxMs: tasks.length ? round(max(durations)) : 0 };
}

export function rafGapSummary(frameTimes, thresholdMs = 50) {
  const frames = (frameTimes || []).slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i] - frames[i - 1]);
  const long = gaps.filter(gap => gap > thresholdMs);
  const spanMs = frames.length > 1 ? frames[frames.length - 1] - frames[0] : 0;
  return {
    frames: frames.length,
    fps: spanMs > 0 ? round((frames.length - 1) / (spanMs / 1000), 1) : null,
    gapsOver: long.length,
    maxGapMs: gaps.length ? round(max(gaps)) : null,
    over25: gaps.filter(gap => gap > 25).length
  };
}

/**
 * Main-thread busy share estimated from a 5 ms timer heartbeat: every tick
 * that arrives late was delayed by work. Used where the engine has no task
 * accounting (WebKit); Chrome runs use CDP Performance metrics instead.
 */
export function busyFromTimerTicks(tickTimes, { intervalMs = 5, start, end } = {}) {
  const ticks = (tickTimes || []).slice().sort((a, b) => a - b);
  if (ticks.length < 2) return null;
  const from = start ?? ticks[0], to = end ?? ticks[ticks.length - 1];
  let busy = 0;
  for (let i = 1; i < ticks.length; i++) busy += Math.max(0, ticks[i] - ticks[i - 1] - intervalMs);
  const span = to - from;
  return span > 0 ? round(Math.min(100, (busy / span) * 100), 1) : null;
}

export function timerGapSummary(tickTimes, thresholdMs = 50) {
  const ticks = (tickTimes || []).slice().sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ticks.length; i++) gaps.push(ticks[i] - ticks[i - 1]);
  const long = gaps.filter(gap => gap > thresholdMs);
  return { n: long.length, totalMs: round(sum(long)), maxMs: gaps.length ? round(max(gaps)) : null };
}

/**
 * Slider / curve drag metrics (S2, S3, S6 drags).
 * window: { start, release, end } — first input, button release, end of the
 * post-release observation.
 */
export function dragMetrics(events, {
  targetId, mode = 'value', canvasId = GL_CANVAS, window, initialValue, frameTimes = [], allowUntrusted = false
} = {}) {
  const { start, release, end } = window;
  const inputs = dragInputs(events, { targetId, mode, start: start - 1, end: release, initialValue, allowUntrusted });
  const pics = pictures(events, canvasId).filter(pic => pic.t >= start && pic.t <= end);
  const durationS = Math.max(1e-3, (release - start) / 1000);
  const toFrame = frameIndexer(frameTimes, start);

  const latencies = [];
  const reflected = new Set();
  let lastReflected = -1;
  let updates = 0;
  let finalValueAfterReleaseMs = null;
  let lastPictureAfterRelease = null;
  const lastInput = inputs.length - 1;
  for (const pic of pics) {
    const index = newestInputIndex(inputs, pic.causeT);
    if (pic.t > release) lastPictureAfterRelease = pic;
    if (index < 0 || index <= lastReflected) continue;
    lastReflected = index;
    // Coverage is about the drag: a settle-time swap long after release
    // (the idle full-resolution render) does not cover a skipped frame.
    if (pic.t <= release + COVERAGE_GRACE_MS) reflected.add(index);
    latencies.push(pic.t - inputs[index].t);
    if (pic.t <= release) updates++;
    if (index === lastInput && finalValueAfterReleaseMs === null) finalValueAfterReleaseMs = pic.t - release;
  }

  const changingFrames = new Set(inputs.map(input => toFrame(input.t)));
  const coveredFrames = new Set([...reflected].map(index => toFrame(inputs[index].t)));
  const latency = distribution(latencies);
  const roundTrips = byKind(events, 'res')
    .filter(res => res.cls === 'convert' && res.cache && res.t >= start && res.t <= end && Number.isFinite(res.rt))
    .map(res => res.t - res.rt);
  const encodes = byKind(events, 'enc').filter(event => event.t >= start && event.t <= release);

  return {
    updatesPerSecond: round(updates / durationS, 1),
    valueChangesPerSecond: round(inputs.length / durationS, 1),
    framesCoveredPct: changingFrames.size ? round((coveredFrames.size / changingFrames.size) * 100, 1) : null,
    inputToDrawP50Ms: round(latency.p50),
    inputToDrawP95Ms: round(latency.p95),
    inputToDrawMaxMs: round(latency.max),
    finalValueAfterReleaseMs: round(finalValueAfterReleaseMs),
    lastChangeAfterReleaseMs: lastPictureAfterRelease ? round(lastPictureAfterRelease.t - release) : null,
    workerRoundTripMs: roundTrips.length ? round(median(roundTrips)) : null,
    thumbnailReencodes: encodes.length,
    inputs: inputs.length,
    pictures: pics.length
  };
}

/** Event Timing p95 over the drag's events; events under the 16 ms reporting threshold count as 0. */
export function eventTimingP95(events, { start, end, inputCount }) {
  const entries = byKind(events, 'et').filter(entry => entry.s >= start && entry.s <= end
    && /^(pointermove|mousemove|pointerdown|mousedown|pointerup|mouseup|input|keydown|click|wheel)$/.test(entry.n));
  const durations = entries.map(entry => entry.d);
  const padded = durations.concat(new Array(Math.max(0, (inputCount || 0) - durations.length)).fill(0));
  const list = padded.sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.ceil(0.95 * list.length) - 1)];
}

// ---- visibility (loading overlay, studio-ready) ----

/** Times at which the overlay is hidden, from 'vis' events (opacity <= 0.5 or class removed). */
export function overlayHiddenAt(events, time) {
  let state = null;
  for (const event of byKind(events, 'vis')) {
    if (event.t > time) break;
    state = event;
  }
  if (!state) return true;
  if (Number.isFinite(state.op)) return state.op <= 0.5;
  return !state.ov;
}

/** First time >= `from` at which the overlay is hidden. */
export function nextOverlayHidden(events, from) {
  if (overlayHiddenAt(events, from)) return from;
  for (const event of byKind(events, 'vis')) {
    if (event.t < from) continue;
    const hidden = Number.isFinite(event.op) ? event.op <= 0.5 : !event.ov;
    if (hidden) return event.t;
  }
  return null;
}

export function firstReady(events, from) {
  let sawBusy = false;
  for (const event of byKind(events, 'vis')) {
    if (event.t < from) continue;
    if (!event.ready || event.busy) { sawBusy = true; continue; }
    if (event.ready && !event.busy && sawBusy) return event.t;
  }
  return null;
}

/**
 * Settled: the end of the last worker activity (a request in flight, or a
 * message) before `quietMs` without any. Requests that never get an answer
 * count as instantaneous messages. Null while not yet settled at `until`.
 */
export function settledAt(events, from, { quietMs = 2500, until = Infinity } = {}) {
  const spans = [];
  for (const res of byKind(events, 'res')) {
    if (res.t < from || res.t > until) continue;
    spans.push([Number.isFinite(res.rt) ? Math.max(from, res.rt) : res.t, res.t]);
  }
  const answered = new Set(byKind(events, 'res').filter(res => Number.isFinite(res.rt)).map(res => `${res.wid}:${res.rt}`));
  for (const req of byKind(events, 'req')) {
    if (req.t < from || req.t > until) continue;
    if (!answered.has(`${req.wid}:${req.t}`)) spans.push([req.t, req.t]);
  }
  if (!spans.length) return from;
  spans.sort((a, b) => a[0] - b[0]);
  let end = spans[0][1];
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] - end >= quietMs) return end;
    end = Math.max(end, spans[i][1]);
  }
  return until - end >= quietMs ? end : null;
}

/** S1 import timeline, all values relative to the file input `change`. */
export function importMetrics(events, { changeT, canvasIds = [GL_CANVAS, CPU_CANVAS], until = Infinity }) {
  const after = events.filter(event => event.t >= changeT);
  // New content only: a GL draw of a freshly uploaded source texture, or a 2D put/draw.
  const pics = canvasIds.flatMap(id => pictures(after, id))
    .filter(pic => pic.t >= changeT && pic.contentT !== null && pic.contentT >= changeT)
    .sort((a, b) => a.t - b.t);
  const first = pics[0] || null;
  let firstVisible = null;
  for (const pic of pics) {
    const visibleAt = nextOverlayHidden(events, pic.t);
    if (visibleAt !== null) { firstVisible = visibleAt; break; }
  }
  let firstPositive = null;
  for (const pic of pics.filter(p => p.positive)) {
    const visibleAt = nextOverlayHidden(events, pic.t);
    if (visibleAt !== null) { firstPositive = visibleAt; break; }
  }
  const ready = first ? firstReady(events, changeT) : null;
  const settled = settledAt(events, changeT, { until });
  const rel = t => (t === null || t === undefined ? null : round(t - changeT));
  const requests = byKind(after, 'req');
  const results = byKind(after, 'res');
  const stages = results.filter(res => Number.isFinite(res.rt)).map(res => ({
    cls: res.cls, fn: res.fn || null, startMs: rel(res.rt), endMs: rel(res.t), ms: round(res.t - res.rt)
  })).sort((a, b) => a.startMs - b.startMs);
  const librawOpens = requests.filter(req => req.cls === 'libraw' && req.fn === 'open');
  const measures = byKind(after, 'um').map(entry => ({ name: entry.n, startMs: rel(entry.s), ms: round(entry.d), detail: entry.detail || null }));
  return {
    firstPixelsDrawnMs: rel(first?.t ?? null),
    firstPhotoVisibleMs: rel(firstVisible),
    firstPositiveVisibleMs: rel(firstPositive),
    readyMs: rel(ready),
    settledMs: rel(settled),
    librawDecodes: librawOpens.length,
    changeToLibrawOpenMs: librawOpens.length ? rel(librawOpens[0].t) : null,
    longTasks: longTaskSummary(events, changeT, settled ?? until),
    stages,
    measures
  };
}

/**
 * One photo switch (S7): times from the Enter keydown.
 * `target` is the file name the switch should end on.
 */
export function switchMetrics(events, { keyT, target, displaySize = null, until = Infinity, previousKeyTimes = [] }) {
  const after = events.filter(event => event.t >= keyT && event.t <= until);
  const names = byKind(events, 'mut').filter(event => event.what === 'filename');
  const shownAt = names.find(event => event.t >= keyT && event.v === target)?.t ?? null;
  // New content that arrived after the keypress, drawn once the target is named.
  const pics = [GL_CANVAS, CPU_CANVAS].flatMap(id => pictures(events, id))
    .filter(pic => pic.t >= keyT && pic.t <= until && pic.contentT !== null && pic.contentT >= keyT)
    .sort((a, b) => a.t - b.t);
  const firstPixels = shownAt === null ? null : pics.find(pic => pic.t >= shownAt) || null;
  const displayOk = pic => !displaySize || !pic.w || (pic.w >= displaySize.w * 0.95 && pic.h >= displaySize.h * 0.95);
  const firstPositive = pics.find(pic => pic.positive && displayOk(pic) && (shownAt === null || pic.t >= shownAt)) || null;
  let ready = null;
  if (shownAt !== null) {
    for (const event of byKind(events, 'vis')) {
      if (event.t < Math.max(keyT, shownAt)) continue;
      if (event.ready && !event.busy) { ready = event.t; break; }
    }
  }
  const librawOpens = byKind(after, 'req').filter(req => req.cls === 'libraw' && req.fn === 'open');
  const readyOrUntil = ready ?? until;
  const lastKeyT = Math.max(keyT, ...previousKeyTimes);
  const stale = byKind(events, 'res').filter(res => Number.isFinite(res.rt) && res.rt < lastKeyT && res.t > (firstPositive?.t ?? readyOrUntil));
  const rel = t => (t === null || t === undefined ? null : round(t - keyT));
  return {
    firstPixelsMs: rel(firstPixels?.t ?? null),
    firstPixelsSize: firstPixels?.w ? `${firstPixels.w}×${firstPixels.h}` : null,
    firstDisplayPositiveMs: rel(firstPositive?.t ?? null),
    readyMs: rel(ready),
    librawDecodes: librawOpens.length,
    staleResultsAfterShown: stale.length,
    longTasks: longTaskSummary(events, keyT, readyOrUntil)
  };
}

/** Zoom step: transform applied, texture refinement and backing ÷ needed. */
export function zoomStepMetrics(events, { inputT, until, textureCanvas = GL_CANVAS, sourceWidth, displayedCssWidth, dpr }) {
  const transform = byKind(events, 'mut').find(event => event.what === 'transform' && event.t >= inputT && event.t <= until) || null;
  const uploads = byKind(events, 'gl.upload').filter(event => event.c === textureCanvas && event.w * event.h > 65536);
  const before = uploads.filter(event => event.t < inputT).pop() || null;
  const refined = uploads.find(event => event.t >= inputT && event.t <= until && (!before || event.w > before.w)) || null;
  const latest = uploads.filter(event => event.t <= until).pop() || null;
  const needed = Number.isFinite(sourceWidth) && Number.isFinite(displayedCssWidth) && Number.isFinite(dpr)
    ? Math.min(sourceWidth, displayedCssWidth * dpr) : null;
  const refineWindowEnd = refined ? refined.t + 100 : until;
  return {
    transformAppliedMs: transform ? round(transform.t - inputT) : null,
    textureRefinedAtMs: refined ? round(refined.t - inputT) : null,
    longTaskDuringRefineMs: longTaskSummary(events, inputT, refineWindowEnd).maxMs,
    backingPx: latest ? `${latest.w}×${latest.h}` : null,
    backingWidth: latest?.w ?? null,
    backingOverNeeded: latest && needed ? round(latest.w / needed, 2) : null
  };
}

/** Pan: transform frames per second and move→frame latency. */
export function panMetrics(events, { start, end, frameTimes = [] }) {
  const moves = byKind(events, 'input').filter(event => (event.type === 'mousemove' || event.type === 'pointermove') && event.b && event.t >= start && event.t <= end);
  const transforms = byKind(events, 'mut').filter(event => event.what === 'transform' && event.t >= start && event.t <= end);
  const toFrame = frameIndexer(frameTimes, start);
  const frames = new Set(transforms.map(event => toFrame(event.t)));
  const latencies = [];
  let cursor = 0;
  for (const move of moves) {
    while (cursor < transforms.length && transforms[cursor].t < move.t) cursor++;
    if (cursor < transforms.length) latencies.push(transforms[cursor].t - move.t);
  }
  const d = distribution(latencies);
  const spanS = Math.max(1e-3, (end - start) / 1000);
  return {
    transformFramesPerSecond: round(frames.size / spanS, 1),
    moveToFrameP50Ms: round(d.p50),
    moveToFrameP95Ms: round(d.p95),
    longTasks: longTaskSummary(events, start, end + 500)
  };
}

/** Flatten nested metric objects into dotted keys with numeric/string leaves. */
export function flattenMetrics(prefix, object, out = {}) {
  for (const [key, value] of Object.entries(object || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') out[name] = value;
    else if (!Array.isArray(value) && typeof value === 'object') flattenMetrics(name, value, out);
  }
  return out;
}

/**
 * Long Animation Frame script attribution, aggregated by source-mapped
 * location (`mapper.mapCharPosition`): where main-thread frames spent time.
 */
export function loafAttribution(events, mapper, { top = 12 } = {}) {
  const totals = new Map();
  for (const frame of byKind(events, 'loaf')) {
    for (const script of frame.scripts || []) {
      const mapped = mapper && script.u ? mapper.mapCharPosition(script.u, script.cp) : null;
      const where = mapped ? `${mapped.source}:${mapped.line}` : `${String(script.u || '(unknown)').split('/').pop()}@${script.cp ?? '?'}`;
      const key = `${script.fn || script.inv || '(anonymous)'} ${where}`;
      const entry = totals.get(key) || { label: key, ms: 0, count: 0, forcedLayoutMs: 0 };
      entry.ms += script.d || 0;
      entry.forcedLayoutMs += script.fsl || 0;
      entry.count++;
      totals.set(key, entry);
    }
  }
  return [...totals.values()].sort((a, b) => b.ms - a.ms).slice(0, top)
    .map(entry => ({ ...entry, ms: round(entry.ms), forcedLayoutMs: round(entry.forcedLayoutMs) }));
}

/**
 * Worker-side timing (Chrome worker probe, epoch ms) against the page's
 * request records: queue delay (request → handler start) and handling time
 * (start → reply) per request class.
 */
export function workerTimingSummary(events, workerTiming, pageTimeOrigin) {
  if (!Number.isFinite(pageTimeOrigin) || !workerTiming?.length) return null;
  const requests = byKind(events, 'req').filter(req => req.id !== undefined && req.id !== null);
  const starts = workerTiming.filter(record => record.ph === 'start');
  const replies = workerTiming.filter(record => record.ph === 'reply');
  const perClass = {};
  for (const start of starts) {
    const t = start.t - pageTimeOrigin;
    const req = requests.filter(entry => entry.id === start.id && entry.t <= t + 1).pop();
    if (!req) continue;
    const reply = replies.find(entry => entry.session === start.session && entry.id === start.id && entry.t >= start.t);
    const bucket = perClass[req.cls] ||= { queue: [], handle: [] };
    bucket.queue.push(t - req.t);
    if (reply) bucket.handle.push(reply.t - start.t);
  }
  return Object.fromEntries(Object.entries(perClass).map(([cls, bucket]) => [cls, {
    n: bucket.queue.length, queueP50Ms: round(median(bucket.queue)), handleP50Ms: round(median(bucket.handle)), handleMaxMs: round(max(bucket.handle))
  }]));
}
