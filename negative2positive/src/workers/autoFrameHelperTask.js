// A detection helper's work (#252 part 4), kept apart from the worker shell
// so Node tests drive it over a real message channel. The shared auto-frame
// worker (A) posts the 1600 px preview it built once and asks for
// independent stages of its detection; the helper answers with plain data
// computed by the same stage functions on the same bytes:
//   { type: 'load', det, preview, options }           the detection's preview
//   { type: 'units', det, id, channels, order }       line channel units -> { id, units }
//   { type: 'fallback', det, id, stride, offset }     the fallback's preview stage -> { id, fallback },
//                                                     then its angle passes at offset, offset + stride, ...
//                                                     -> { id, index, pass } ..., { id, done }
//   { type: 'passes', det, id, items: [{ index, angle }] } -> { id, index, pass } ..., { id, done }
//   { type: 'cancel', det }                           stop between units and passes
// The last reply of a request carries `final: true` (with `units`, `done`,
// `cancelled` or `error`); `fallback` and pass replies come before it. A
// failed stage answers { id, error, final }; A then computes it itself.
import { getAnalyzerContext, fallbackPreviewStage, anglePassStage } from '../app/autoFrameAnalyzer.js';
import { duplicateLinePlanes, lineChannelUnit } from '../app/imageWindowLines.js';

export function createAutoFrameHelperTask({
  loadCv, rotate,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
  makeImage = (data, width, height) => new ImageData(data, width, height),
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
}) {
  let current = null; // { det, preview, context, fallback, cancelled }

  const live = det => current && current.det === det && !current.cancelled;

  function load(msg) {
    const preview = makeImage(msg.preview.data, msg.preview.width, msg.preview.height);
    const context = getAnalyzerContext({ ...msg.options, rotateImageData: rotate });
    // The preview's contour and density caches serve its angle-0 pass here
    // as they do on A.
    context.reusablePreview = preview;
    current = { det: msg.det, preview, context, deterministicPreview: context.settings.deterministicPreview === true, fallback: null, cancelled: false };
  }

  async function units(msg, send) {
    if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
    try {
      await loadCv();
      if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
      const { preview } = current;
      const src = globalThis.cv.matFromImageData(preview);
      try {
        // The same duplicate-plane decision A makes, on the same bytes.
        const skip = duplicateLinePlanes(src, msg.order);
        const out = [];
        for (const channel of msg.channels) {
          if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
          if (skip.has(channel)) { out.push({ channel, skipped: true }); continue; }
          const started = now();
          const unit = lineChannelUnit(preview, src, channel);
          unit.ms = Math.round(now() - started);
          out.push(unit);
        }
        send({ id: msg.id, units: out, final: true });
      } finally { src.delete(); }
    } catch (error) {
      send({ id: msg.id, error: String(error?.message || error), final: true });
    }
  }

  async function passes(msg, send, items) {
    for (const { index, angle } of items) {
      await yieldTask();
      if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
      try {
        const started = now();
        const pass = anglePassStage(current.preview, current.context, angle, current.deterministicPreview);
        send({ id: msg.id, index, pass, ms: Math.round(now() - started) });
      } catch (error) {
        send({ id: msg.id, index, error: String(error?.message || error) });
      }
    }
    send({ id: msg.id, done: true, final: true });
  }

  async function fallback(msg, send) {
    if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
    let result;
    try {
      await loadCv();
      if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
      const started = now();
      result = fallbackPreviewStage(current.preview, current.context);
      current.fallback = result;
      send({ id: msg.id, fallback: result, ms: Math.round(now() - started) });
    } catch (error) {
      send({ id: msg.id, error: String(error?.message || error), final: true });
      return;
    }
    // The speculative passes: A discards them when the window search wins.
    const angles = result.angleCandidates || [];
    const items = [];
    for (let index = msg.offset || 0; index < angles.length; index += Math.max(1, msg.stride || 1)) items.push({ index, angle: angles[index] });
    await passes(msg, send, items);
  }

  return {
    async handle(msg, send) {
      switch (msg?.type) {
        case 'load': load(msg); return;
        case 'cancel': if (current?.det === msg.det) { current.cancelled = true; current = { ...current, preview: null, context: null }; } return;
        case 'units': await units(msg, send); return;
        case 'fallback': await fallback(msg, send); return;
        case 'passes':
          if (!live(msg.det)) { send({ id: msg.id, cancelled: true, final: true }); return; }
          try { await loadCv(); } catch (error) { send({ id: msg.id, error: String(error?.message || error), final: true }); return; }
          await passes(msg, send, msg.items || []);
          return;
        default: send({ id: msg?.id, error: `Unknown helper request: ${msg?.type}`, final: true });
      }
    },
    get detection() { return current?.det ?? null; }
  };
}
