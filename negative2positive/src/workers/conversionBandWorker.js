/**
 * Conversion band worker (#256 Part 5): one of the band pool's workers
 * (createConversionBandPool in app/conversionWorkerClient.js). It converts row
 * bands of a frame with the steps of pipeline/silverBands.js and keeps each
 * band until the pool fetches, adjusts or releases it, so a frame's Step 3
 * can run on the bands its conversion left here. Worker 0 of a job also plans
 * the job and builds its tables.
 *
 * A band arrives as its own ArrayBuffer (transferred) or, when the page is
 * cross-origin isolated, as rows of one SharedArrayBuffer that the bands
 * share and write in place (the 8-bit output likewise).
 *
 * Messages are handled one at a time, in arrival order.
 */
import {
  planSilverCoreBands, prepareSilverCoreBand, buildBandTables, applySilverCoreBand, sharpenSilverCoreBand,
  bandOutput8, adjustBand, copyBandRows
} from '../pipeline/silverBands.js';

// job -> { planned, bands: Map(index -> band) }
const jobs = new Map();
const scratch = {
  lut8: { lutR: new Uint8Array(256), lutG: new Uint8Array(256), lutB: new Uint8Array(256) },
  lut16: { lutR: new Uint16Array(65536), lutG: new Uint16Array(65536), lutB: new Uint16Array(65536) },
};

function jobState(job) {
  let state = jobs.get(job);
  if (!state) {
    state = { planned: null, bands: new Map() };
    jobs.set(job, state);
  }
  return state;
}

function bandOf(job, index) {
  const band = jobs.get(job)?.bands.get(index);
  if (!band) throw new Error(`Band ${index} of job ${job} is not here`);
  return band;
}

function sharedView(Type, shared) {
  return shared ? new Type(shared.buffer, shared.offset, shared.length) : null;
}

// A band from a message: its 16-bit rows (own or shared), and where its 8-bit
// output goes when the planes are shared.
function bandFrom(message, extra = {}) {
  const data = message.shared ? sharedView(Uint16Array, message.shared)
    : message.data16 ? new Uint16Array(message.data16) : null;
  return {
    width: message.width,
    height: message.y1 - message.y0,
    y0: message.y0,
    y1: message.y1,
    data,
    data8: message.data8 ? new Uint8ClampedArray(message.data8) : null,
    shared: Boolean(message.shared),
    shared8: sharedView(Uint8ClampedArray, message.shared8),
    ...extra
  };
}

// The band's outputs for the pool. Shared planes are already written in
// place (the 8-bit rows are copied into theirs); own buffers are
// transferred. The band is dropped either way.
function outputs(state, band, index, { data16 = true, data8 = true } = {}) {
  const payload = { index, data16: null, data8: null };
  const transfers = [];
  if (data16 && !band.shared) {
    payload.data16 = band.data.buffer;
    transfers.push(band.data.buffer);
  }
  if (data8) {
    const out8 = band.data8 || bandOutput8(band);
    if (band.shared8) {
      if (out8 !== band.shared8) band.shared8.set(out8);
    } else {
      payload.data8 = out8.buffer;
      transfers.push(out8.buffer);
    }
  }
  state.bands.delete(index);
  return { payload, transfers };
}

async function handle(message) {
  const { type, id, job } = message;
  switch (type) {
    case 'warm-up':
      return { reply: { id } };
    case 'plan': {
      const planned = await planSilverCoreBands({
        settings: message.settings,
        width: message.width,
        height: message.height,
        analysisImageData: message.reference || null,
        includeAnalysisPreview: message.includeAnalysisPreview !== false,
      });
      jobState(job).planned = planned;
      const preview = planned.analysisPreview;
      const reply = { id, plan: planned.plan, tables: planned.tables, analysisPreview: null };
      const transfers = [];
      if (preview) {
        reply.analysisPreview = { width: preview.width, height: preview.height, data: preview.data.buffer };
        transfers.push(preview.data.buffer);
      }
      return { reply, transfers };
    }
    case 'load': {
      const band = bandFrom(message, { plan: message.plan });
      const partial = prepareSilverCoreBand(message.plan, band, band.y0);
      jobState(job).bands.set(message.index, band);
      return { reply: { id, partial } };
    }
    case 'tables': {
      const state = jobs.get(job);
      if (!state?.planned) throw new Error(`Job ${job} was not planned here`);
      return { reply: { id, tables: buildBandTables(state.planned.job, message.partials) } };
    }
    case 'apply': {
      const state = jobs.get(job);
      const band = bandOf(job, message.index);
      band.tables = message.tables;
      applySilverCoreBand(band.plan, message.tables, band, band.y0);
      const halo = message.halo || 0;
      if (halo) {
        // The unsharpened edge rows its neighbours need: copies, taken
        // before any band sharpens.
        const top = copyBandRows(band.data, band.width, band.y0, band.y0, Math.min(band.y1, band.y0 + halo));
        const bottom = copyBandRows(band.data, band.width, band.y0, Math.max(band.y0, band.y1 - halo), band.y1);
        return { reply: { id, index: message.index, top, bottom }, transfers: [top.buffer, bottom.buffer] };
      }
      if (message.keep) return { reply: { id, index: message.index, kept: true } };
      const { payload, transfers } = outputs(state, band, message.index);
      return { reply: { id, ...payload }, transfers };
    }
    case 'sharpen': {
      const state = jobs.get(job);
      const band = bandOf(job, message.index);
      sharpenSilverCoreBand(band.plan, band.tables, band, band.y0, message.above, message.below);
      band.data8 = null;
      if (message.keep) return { reply: { id, index: message.index, kept: true } };
      const { payload, transfers } = outputs(state, band, message.index);
      return { reply: { id, ...payload }, transfers };
    }
    case 'adjust': {
      // Step 3 on a band: one its conversion left here, or one sent now.
      const state = jobState(job);
      let band = state.bands.get(message.index);
      if (!band) {
        band = bandFrom(message);
        state.bands.set(message.index, band);
      }
      const bits16 = Boolean(message.bits16);
      const bits8 = Boolean(message.bits8);
      const planes = {
        data16: bits16 ? band.data : null,
        data8: bits8 ? (band.data8 || (band.data8 = bandOutput8(band))) : null
      };
      const result = adjustBand(planes, {
        width: band.width, rows: band.height, startRow: band.y0, frameWidth: message.frameWidth, frameHeight: message.frameHeight,
        settings: message.settings, bits16, bits8, mirror8: Boolean(message.mirror8), scratch
      });
      if (message.mirror8 && !bits8) band.data8 = result.data8;
      const { payload, transfers } = outputs(state, band, message.index, { data16: bits16, data8: bits8 || Boolean(message.mirror8) });
      return { reply: { id, ...payload }, transfers };
    }
    case 'fetch': {
      // The converted band as it is. `keep` sends copies and keeps the band
      // for a later Step 3; otherwise the band goes.
      const state = jobs.get(job);
      const band = bandOf(job, message.index);
      if (!message.keep) {
        const { payload, transfers } = outputs(state, band, message.index);
        return { reply: { id, ...payload }, transfers };
      }
      const out8 = band.data8 || (band.data8 = bandOutput8(band));
      if (band.shared8 && out8 !== band.shared8) band.shared8.set(out8);
      const data16 = band.shared ? null : band.data.slice();
      const data8 = band.shared8 ? null : out8.slice();
      const transfers = [data16, data8].filter(Boolean).map((array) => array.buffer);
      return { reply: { id, index: message.index, data16: data16 ? data16.buffer : null, data8: data8 ? data8.buffer : null }, transfers };
    }
    case 'release':
      jobs.delete(job);
      return { reply: { id, released: true } };
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

let queue = Promise.resolve();
self.onmessage = function (e) {
  const message = e.data;
  const run = queue.then(async () => {
    try {
      const { reply, transfers = [] } = await handle(message);
      self.postMessage({ type: 'result', ...reply }, transfers);
    } catch (err) {
      self.postMessage({ type: 'error', id: message.id, message: err?.message || String(err) });
    }
  });
  queue = run.catch(() => {});
  return run;
};
