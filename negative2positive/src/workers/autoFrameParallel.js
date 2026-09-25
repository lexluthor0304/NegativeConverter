// Foreground frame detection on three workers (#252 part 4), run by the
// shared auto-frame worker A with two helpers (B, C) it reaches through
// MessagePorts the page handed it (no nested workers).
//
// A builds the preview once and posts its bytes to both helpers (a canvas
// resize in another context could differ), then:
//   - C starts the fallback at once, speculatively: its preview stage, then
//     the angle passes at even indices;
//   - B runs the G and B line channel units;
//   - A runs the contour variants and, when they find nothing, the grey and
//     R units, then the window search's tail;
//   - when the window settles the result (a window whose crop maps, or a
//     frame that needs review), the helpers are cancelled and their work
//     discarded; otherwise B takes the odd angle passes, and A merges every
//     pass in angle order and runs the full-resolution finish on the frame
//     it holds.
// The merge is exactly the serial detector's: channel units concatenated in
// channel order before the stable select(), the line path only when the
// contour variants found nothing, angle passes in angle order with the
// 0.001 tie-break. Any stage a helper does not deliver (it failed, timed
// out or is gone) is computed here with the same function, so a result
// never depends on the helpers: they only change when it arrives.
import { beginFrameDetection, settleFromWindow, fallbackPreviewStage, anglePassStage, finishFromFallback } from '../app/autoFrameAnalyzer.js';
import { contourWindowCandidates, windowFromCandidates, NO_LINE_QUADS } from '../app/imageWindowDetector.js';
import { duplicateLinePlanes, lineChannelUnit, lineQuadsFromUnits, LINE_SEARCH_CHANNELS } from '../app/imageWindowLines.js';

const HELPER_TIMEOUT_MS = 20000;
// The channels A searches itself; B takes the others (G, B).
const A_CHANNELS = new Set([-1, 0]);

const performanceNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The analyzer options a helper needs: everything but functions and A's own concerns. */
export function helperAnalyzerOptions(options) {
  const { rotateImageData, sanitizeCropRegion, deferFullResolution, ...rest } = options || {};
  return rest;
}

/**
 * One helper as A sees it. `request(message, onItem)` posts a request with a
 * fresh id and resolves with its final reply; the replies before it (the
 * fallback's preview stage, angle passes) go to `onItem`. A helper that
 * stays silent for `timeoutMs` is taken as gone: the request rejects and A
 * computes the stage itself.
 */
export function createHelperLink(port, { timeoutMs = HELPER_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let sequence = 0;
  let broken = false;
  const waiting = new Map();
  port.onmessage = ({ data }) => {
    const entry = waiting.get(data?.id);
    if (!entry) return;
    if (!data.final) { entry.touch(); entry.onItem?.(data); return; }
    waiting.delete(data.id);
    clearTimer(entry.timer);
    entry.resolve(data);
  };
  return {
    post(message) {
      if (broken) return false;
      try { port.postMessage(message); return true; } catch { broken = true; return false; }
    },
    request(message, onItem = null) {
      if (broken) return Promise.reject(new Error('Detection helper is gone'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const entry = { resolve, reject, onItem, timer: null };
        entry.touch = () => {
          clearTimer(entry.timer);
          entry.timer = setTimer(() => {
            waiting.delete(id);
            broken = true;
            reject(new Error('Detection helper timed out'));
          }, timeoutMs);
        };
        waiting.set(id, entry);
        entry.touch();
        try { port.postMessage({ ...message, id }); }
        catch (error) { waiting.delete(id); clearTimer(entry.timer); broken = true; reject(error); }
      });
    },
    close() {
      broken = true;
      for (const entry of waiting.values()) { clearTimer(entry.timer); entry.reject(new Error('Detection helper released')); }
      waiting.clear();
      try { port.close?.(); } catch {}
    },
    get broken() { return broken; }
  };
}

let detections = 0;

/**
 * detectFrameAndRotation's result, computed with the helpers' help.
 * `helpers`: `{ b, c }` links (either may be missing or broken). The
 * result's `stageMs.units` and `stageMs.passes` record where each line unit
 * and angle pass ran and how long it took; `stageMs.helpers` is true.
 */
export async function detectFrameAndRotationParallel(imageData, options, helpers) {
  const detection = beginFrameDetection(imageData, options);
  if (!detection) return null;
  const { previewData, context, clock, targets } = detection;
  const det = ++detections;
  const b = helpers?.b && !helpers.b.broken ? helpers.b : null;
  const c = helpers?.c && !helpers.c.broken ? helpers.c : null;
  const preview = { width: previewData.width, height: previewData.height, data: previewData.data };
  const unitsLog = {};
  const passesLog = [];
  for (const helper of [b, c]) helper?.post({ type: 'load', det, preview, options: helperAnalyzerOptions(options) });

  // Passes by angle index, whoever computed them first (identical either way).
  const passResults = new Map();
  const takePass = where => (reply) => {
    if (reply.index === undefined || reply.error || passResults.has(reply.index)) return;
    passResults.set(reply.index, reply.pass);
    passesLog.push({ index: reply.index, where, ms: reply.ms ?? null });
  };

  // C: the speculative fallback, from the first moment.
  let settleFallback = () => {};
  const fallbackFromC = new Promise((resolve) => { settleFallback = resolve; });
  let fallbackMs = null;
  const fallbackRequest = c
    ? c.request({ type: 'fallback', det, stride: 2, offset: 0 }, (reply) => {
      if (reply.fallback) { fallbackMs = reply.ms ?? null; settleFallback(reply.fallback); } else takePass('c')(reply);
    }).then(() => settleFallback(null), () => settleFallback(null))
    : (settleFallback(null), Promise.resolve());

  // B: the G and B units of the planned channels.
  const order = detection.linePlanOf().channels || LINE_SEARCH_CHANNELS;
  const bChannels = order.filter(channel => !A_CHANNELS.has(channel));
  const unitsFromB = b && bChannels.length ? b.request({ type: 'units', det, channels: bChannels, order }) : null;
  unitsFromB?.catch(() => {});

  const cv = globalThis.cv;
  const src = cv.matFromImageData(previewData);
  let window;
  try {
    const contours = contourWindowCandidates(previewData, src, targets);
    if (contours.length) {
      window = windowFromCandidates(previewData, targets, contours, NO_LINE_QUADS);
    } else {
      detection.planLines();
      const skip = duplicateLinePlanes(src, order);
      const units = new Map();
      const computeHere = (channel) => {
        const started = performanceNow();
        units.set(channel, lineChannelUnit(previewData, src, channel));
        unitsLog[channel] = { where: 'a', ms: Math.round(performanceNow() - started) };
      };
      for (const channel of order) {
        if (!skip.has(channel) && (A_CHANNELS.has(channel) || !unitsFromB)) computeHere(channel);
      }
      let remote = null;
      if (unitsFromB) {
        try { remote = await unitsFromB; } catch { remote = null; }
      }
      for (const channel of order) {
        if (skip.has(channel) || units.has(channel)) continue;
        const unit = remote?.units?.find(entry => entry.channel === channel && !entry.skipped);
        if (unit) {
          units.set(channel, unit);
          unitsLog[channel] = { where: 'b', ms: unit.ms ?? null };
        } else computeHere(channel);
      }
      const ordered = order.filter(channel => units.has(channel)).map(channel => units.get(channel));
      window = windowFromCandidates(previewData, targets, [], lineQuadsFromUnits(previewData, ordered));
    }
  } finally {
    src.delete();
  }
  clock.mark('window');
  const finish = (result) => {
    for (const helper of [b, c]) helper?.post({ type: 'cancel', det });
    if (result?.stageMs) Object.assign(result.stageMs, { helpers: true, units: unitsLog, passes: passesLog, fallbackMs });
    return result;
  };
  const settled = settleFromWindow(detection, window);
  if (settled !== undefined) return finish(settled);

  // The fallback: C's preview stage, or this worker's.
  const fallback = (await fallbackFromC) || fallbackPreviewStage(previewData, context, clock);
  if (!fallback.angleCandidates) return finish(detection.withStages(null));
  const angles = fallback.angleCandidates;
  // B takes the odd passes; C is on the even ones (or A, without C).
  const oddItems = angles.map((angle, index) => ({ index, angle })).filter(item => item.index % 2 === 1);
  const fromB = b && oddItems.length ? b.request({ type: 'passes', det, items: oddItems }, takePass('b')).catch(() => null) : null;
  await Promise.all([fromB, fallbackRequest]);
  const passes = angles.map((angle, index) => {
    if (passResults.has(index)) return passResults.get(index);
    const started = performanceNow();
    const pass = anglePassStage(previewData, context, angle, detection.deterministicPreview);
    passesLog.push({ index, where: 'a', ms: Math.round(performanceNow() - started) });
    return pass;
  });
  clock.mark('anglePasses');
  return finish(finishFromFallback(detection, fallback, passes));
}
