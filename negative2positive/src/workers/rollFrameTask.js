// One roll-analysis frame in its lane's worker (#252 part 2), kept apart from
// the worker shell so Node tests drive it with the real steps.
//
// LibRaw's result buffer is transferred in and every step runs on the
// worker's own planes, with the functions the page ran on them before:
//   1. post-decode (rawPostDecode.js): pack, garbled check, defect pass, the
//      >>> 8 mirror, film type and film base statistics; a `packed` message
//      then tells the page the decode's buffers are gone (its lane's memory
//      claim keeps the frame's analysis bytes from there);
//   2. frame detection (sizes only, rotatedOutput 'none'), with the
//      full-resolution fallback on these planes, in place;
//   3. the film-edge read on the same 8-bit plane;
// and on the page's second request, once it has merged the settings:
//   4. the roll sample (rollSample.js) of the recipe's geometry.
// Only plain data goes back; the frame's planes stay here and are dropped
// after the sample, unless the page asks for them (`returnPlanes`, a
// `return-planes` for a frame the foreground adopts, or a failed step that
// leaves the rest to the page). Detection must not write its input plane:
// the film edge and the sample read the same one.
import { runRawPostDecode, describeView, viewFromDescription } from '../app/rawPostDecode.js';
import { buildRollSample, packRollSample } from '../app/rollSample.js';

/**
 * The frame's own film type, as createDefaultSettings would choose it: the
 * automatic detection when the import detects it, else the chosen type.
 */
export function rollFrameFilmType(choice, filmStats) {
  if (choice?.automatic) return filmStats?.filmType?.filmType ?? null;
  return choice?.filmType ?? null;
}

function planesOf(frame, transfers) {
  const rgba16 = describeView(frame.__image16.data);
  const rgba8 = describeView(frame.data);
  transfers.add(rgba16.buffer);
  transfers.add(rgba8.buffer);
  return { rgba16, rgba8 };
}

/**
 * @param {object} deps
 * @param {() => Promise<any>} deps.loadCv
 * @param {(image, options) => object} deps.detect detectFrameAndRotation
 * @param {(image, angle) => object} deps.rotate applyRotationToImageData
 * @param {(image, options) => Promise<object>} deps.readEdge
 * @param {() => Promise<void>} [deps.yieldTask] lets a queued `return-planes` in between steps
 * @param {(data, width, height) => object} [deps.makeImage]
 * @returns {{ handle(message, reply): Promise<void>, readonly held: number|null }}
 */
export function createRollFrameTask({
  loadCv, detect, rotate, readEdge, realmStats = () => null,
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
  makeImage = (data, width, height) => new ImageData(data, width, height)
}) {
  let held = null; // { id, image }
  const planesWanted = new Set();

  function reply(send, message, transfers) {
    send(message, [...transfers]);
  }

  async function process(msg, send) {
    const { id } = msg;
    const options = msg.options || {};
    const progress = { stage: 'input', image16: null, defects: null };
    let outcome;
    try {
      const data = viewFromDescription(msg.input);
      outcome = runRawPostDecode({ width: msg.width, height: msg.height, bits: msg.bits, colors: msg.colors, data }, {
        suppressSensorDefects: options.suppressSensorDefects,
        filmStats: options.filmStats || null
      }, progress);
    } catch (err) {
      // The page finishes from what is intact, exactly as #232's worker does.
      const message = { type: 'error', id, message: err?.message || String(err), code: err?.code, name: err?.name, stage: progress.stage };
      const transfers = new Set();
      if (progress.stage === 'input') {
        if (msg.input?.buffer?.byteLength > 0) { message.input = msg.input; transfers.add(msg.input.buffer); }
      } else if (progress.image16?.data?.buffer?.byteLength > 0) {
        message.rgba16 = describeView(progress.image16.data);
        if (progress.stage === 'repaired') message.defects = progress.defects;
        transfers.add(message.rgba16.buffer);
      }
      reply(send, message, transfers);
      return;
    }
    if (outcome.garbled) {
      planesWanted.delete(id);
      reply(send, { type: 'result', id, garbled: true }, new Set());
      return;
    }
    // Progress, not the answer: the planes are packed and LibRaw's result is
    // dropped, before the detection and the film-edge read (#229 review
    // R2-017).
    send({ type: 'packed', id, width: outcome.width, height: outcome.height }, []);
    const image = makeImage(outcome.rgba8, outcome.width, outcome.height);
    image.__image16 = { width: outcome.width, height: outcome.height, data: outcome.rgba16 };
    held = { id, image };
    const result = {
      type: 'result', id, garbled: false, width: outcome.width, height: outcome.height,
      defects: outcome.defects, filmStats: outcome.filmStats,
      frameFilmType: rollFrameFilmType(options.filmTypeChoice, outcome.filmStats),
      detection: null, detectionError: null, edge: null, edgeError: null, complete: false
    };
    // The foreground adopted this frame: its planes, at once, and no analysis.
    const interrupted = async () => {
      await yieldTask();
      return planesWanted.has(id);
    };
    const handBack = (extra = {}) => {
      const transfers = new Set();
      planesWanted.delete(id);
      const planes = planesOf(image, transfers);
      held = null;
      reply(send, { ...result, ...extra, planes }, transfers);
    };
    if (await interrupted()) { handBack({ interrupted: true }); return; }
    if (options.frame) {
      try {
        await loadCv();
        result.detection = detect(image, {
          ...options.frame, frameFilmType: result.frameFilmType, rotateImageData: rotate, deferFullResolution: false
        });
        // Sizes only: the page reads the rotated frame's size, never its pixels.
        if (result.detection?.rotatedImageData) delete result.detection.rotatedImageData;
      } catch (error) {
        result.detectionError = String(error?.message || error);
      }
      if (await interrupted()) { handBack({ interrupted: true }); return; }
    }
    if (options.filmEdge) {
      try { result.edge = await readEdge(image, {}); }
      catch (error) { result.edgeError = String(error?.message || error); }
      if (await interrupted()) { handBack({ interrupted: true }); return; }
    }
    result.complete = true;
    if (options.returnPlanes) { handBack(); return; }
    planesWanted.delete(id);
    reply(send, result, new Set());
  }

  function sample(msg, send) {
    const { id } = msg;
    if (held?.id !== id) {
      send({ type: 'error', id, stage: 'sample', message: 'The roll frame is no longer held' }, []);
      return;
    }
    const { image } = held;
    const transfers = new Set();
    let packed;
    try {
      packed = packRollSample(buildRollSample(image, msg.settings || {}, { tileMax: msg.tileMax, fullSize: msg.fullSize || null }), transfers);
    } catch (error) {
      // The page builds it from the planes, with the same function.
      const planeTransfers = new Set();
      const planes = planesOf(image, planeTransfers);
      held = null;
      send({ type: 'error', id, stage: 'sample', message: String(error?.message || error), planes }, [...planeTransfers]);
      return;
    }
    held = null;
    const message = { type: 'sample', id, sample: packed };
    if (msg.returnPlanes) message.planes = planesOf(image, transfers);
    reply(send, message, transfers);
  }

  function release(msg, send) {
    const { id } = msg;
    const message = { type: 'released', id };
    const transfers = new Set();
    if (held?.id === id) {
      if (msg.returnPlanes) message.planes = planesOf(held.image, transfers);
      held = null;
    }
    reply(send, message, transfers);
  }

  return {
    async handle(msg, send) {
      switch (msg?.type) {
        case 'ping': send({ type: 'pong', id: msg.id }, []); return;
        case 'warm-up':
          try { await loadCv(); send({ type: 'ready', id: msg.id, opencv: realmStats() }, []); }
          catch (error) { send({ type: 'error', id: msg.id, stage: 'warm-up', message: String(error?.message || error) }, []); }
          return;
        case 'process': await process(msg, send); return;
        case 'return-planes': planesWanted.add(msg.id); return;
        case 'sample': sample(msg, send); return;
        case 'release': release(msg, send); return;
        default: send({ type: 'error', id: msg?.id, stage: 'input', message: `Unknown roll-frame request: ${msg?.type}` }, []);
      }
    },
    get held() { return held?.id ?? null; }
  };
}
