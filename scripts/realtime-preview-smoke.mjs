// 解像度だけでなく、change（指を離す）前に実際の描画が更新されることを検証。
export async function runRealtimePreviewSmoke({ send, evaluate, wait, fail }) {
  await evaluate(`(() => {
    // WebGL2 (#239) and the WebGL1 fallback have separate prototypes.
    const protos = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean);
    const originals = protos.map(proto => ({ proto, upload: proto.texImage2D, subUpload: proto.texSubImage2D,
      storage: proto.texStorage2D, getError: proto.getError, draw: proto.drawArrays }));
    const post = Worker.prototype.postMessage;
    const workers = new Map();
    const pixelHash = pixels => {
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 113) hash = Math.imul(hash ^ pixels[i], 16777619);
      return hash;
    };
    const probe = window.__previewProbe = {
      uploads: [], draws: 0, applyDraws: [], requests: [], results: [], allocations: 0, getErrors: 0,
      inputs: [], changes: [], pendingPreview: 0, commits: [], committed: []
    };
    // Only the exact 8-bit frame is an "upload": the GPU preview's integer
    // textures (prepared negative, tables) are not frames on screen.
    const exactFrame = (gl, args) => args[6] === gl.RGBA && args[7] === gl.UNSIGNED_BYTE;
    const isApply = new WeakMap();
    for (const original of originals) {
      const proto = original.proto;
      // Same-size frames are uploaded with texSubImage2D (#233): width is
      // argument 4 and the pixels argument 8 there.
      proto.texImage2D = function (...args) {
        const pixels = args[8];
        if (this.canvas.id === 'glCanvas' && args[3] > 256 && ArrayBuffer.isView(pixels)) {
          probe.allocations++;
          if (exactFrame(this, args)) probe.uploads.push({ width: args[3], height: args[4], hash: pixelHash(pixels), time: performance.now(), allocate: true });
        }
        return original.upload.apply(this, args);
      };
      proto.texSubImage2D = function (...args) {
        const pixels = args[8];
        if (this.canvas.id === 'glCanvas' && args[4] > 256 && ArrayBuffer.isView(pixels) && exactFrame(this, args)) {
          probe.uploads.push({ width: args[4], height: args[5], hash: pixelHash(pixels), time: performance.now(), allocate: false });
        }
        return original.subUpload.apply(this, args);
      };
      if (original.storage) {
        proto.texStorage2D = function (...args) {
          if (this.canvas.id === 'glCanvas' && args[3] > 256) probe.allocations++;
          return original.storage.apply(this, args);
        };
      }
      proto.getError = function (...args) {
        if (this.canvas.id === 'glCanvas') probe.getErrors++;
        return original.getError.apply(this, args);
      };
      proto.drawArrays = function (...args) {
        const result = original.draw.apply(this, args);
        // The GPU preview's self-test draws into its own framebuffer.
        if (this.canvas.id === 'glCanvas' && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
          probe.draws++;
          const program = this.getParameter(this.CURRENT_PROGRAM);
          let apply = program ? isApply.get(program) : false;
          if (program && apply === undefined) {
            apply = this.getUniformLocation(program, 'u_prepared') !== null;
            isApply.set(program, apply);
          }
          // An applyProgram frame (#239): hash a few patches in the draw's own task.
          if (apply) {
            const width = this.drawingBufferWidth, height = this.drawingBufferHeight, patch = new Uint8Array(8 * 8 * 4);
            let hash = 2166136261;
            for (const [fx, fy] of [[.2, .2], [.5, .5], [.8, .8], [.3, .7], [.7, .3]]) {
              this.readPixels(Math.floor(width * fx), Math.floor(height * fy), 8, 8, this.RGBA, this.UNSIGNED_BYTE, patch);
              for (const value of patch) hash = Math.imul(hash ^ value, 16777619);
            }
            probe.applyDraws.push({ time: performance.now(), hash: hash >>> 0, width, height });
          }
        }
        return result;
      };
    }
    // Capture runs before the slider's own listener: this is when the app
    // starts processing the input.
    const onInput = event => {
      if (event.target?.id !== 'coreExposure') return;
      probe.inputs.push({ time: performance.now(), value: Number(event.target.value), trusted: event.isTrusted, idle: probe.pendingPreview === 0 });
    };
    const onChange = event => {
      if (event.target?.id === 'coreExposure') probe.changes.push({ time: performance.now(), value: Number(event.target.value) });
    };
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'commit') {
        probe.commits.push({ time: performance.now() });
        const record = workers.get(this);
        if (record) record.pending.set(message.id, { commit: true });
      }
      if (message?.type === 'convert') {
        const request = { cache: !!message.cacheInput, reuse: !!message.reuseSource, exposure: message.settings.exposure,
          width: message.width, height: message.height, time: performance.now() };
        probe.requests.push(request);
        // cacheInput is the dedicated interactive-preview worker contract.
        // Background light-table/full conversions use separate, uncached lanes.
        if (message.cacheInput) {
          let record = workers.get(this);
          if (!record) {
            record = { pending: new Map() };
            record.receive = event => {
              const reply = event.data, request = record.pending.get(reply?.id);
              if (!request) return;
              record.pending.delete(reply.id);
              if (request.commit) {
                probe.committed.push({ plane: !!reply.image16, time: performance.now() });
                return;
              }
              probe.pendingPreview = Math.max(0, probe.pendingPreview - 1);
              // #233: a frame whose display preview is not the source keeps its
              // 16-bit plane in the worker and sends a histogram sample instead.
              if (reply.type === 'result' && reply.rgba) probe.results.push({
                exposure: request.exposure, width: reply.width, height: reply.height,
                hash: pixelHash(new Uint8Array(reply.rgba)), time: performance.now(),
                retained: !!reply.retained16, plane: !!reply.image16,
                histogramPixels: reply.histogram ? reply.histogram.width * reply.histogram.height : null
              });
            };
            this.addEventListener('message', record.receive);
            workers.set(this, record);
          }
          record.pending.set(message.id, request);
          probe.pendingPreview++;
        }
      }
      return post.call(this, message, ...args);
    };
    window.__restorePreviewProbe = () => {
      for (const original of originals) {
        Object.assign(original.proto, { texImage2D: original.upload, texSubImage2D: original.subUpload,
          getError: original.getError, drawArrays: original.draw });
        if (original.storage) original.proto.texStorage2D = original.storage;
      }
      Worker.prototype.postMessage = post;
      document.removeEventListener('input', onInput, true);
      document.removeEventListener('change', onChange, true);
      for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    };
  })()`);
  for (const dpr of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
    await wait(3200);
    const result = await evaluate(`(async () => {
      const slider = document.getElementById('coreExposure');
      const probe = window.__previewProbe;
      probe.uploads = []; probe.draws = 0; probe.requests = []; probe.results = []; probe.applyDraws = [];
      probe.allocations = 0; probe.getErrors = 0; probe.commits = []; probe.committed = [];
      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        slider.value = String(-90 + i * 3);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const end = performance.now();
      const during = probe.uploads.filter(item => item.time <= end);
      // #239: with the GPU preview the drag draws applyProgram frames and converts
      // only the settle frame; without it every tick uploads a converted frame.
      const applied = probe.applyDraws.filter(item => item.time <= end);
      const requestsDuring = probe.requests.filter(request => request.cache && request.time <= end).length;
      const converged = () => {
        const result = probe.results.at(-1), upload = probe.uploads.at(-1);
        return result?.exposure === 87 && upload?.hash === result.hash
          && upload.width === result.width && upload.height === result.height;
      };
      while (!converged() && performance.now() - end < 8000) await new Promise(resolve => setTimeout(resolve, 25));
      // A retained plane comes back about 150 ms after the last frame.
      const retainedDrag = probe.results.some(item => item.retained);
      while (retainedDrag && !probe.committed.some(item => item.plane) && performance.now() - end < 8000) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const canvas = document.getElementById('glCanvas');
      const sourceSize = window.__studioSourceSize || null;
      return { dpr: devicePixelRatio, width: canvas.width, height: canvas.height,
        uploads: during.length, changes: new Set(during.map(item => item.hash)).size,
        applyDraws: applied.length, applyChanges: new Set(applied.map(item => item.hash)).size, requestsDuring,
        minimumApplyWidth: Math.min(...applied.map(item => item.width)),
        firstFrameMs: during.length ? during[0].time - start : null,
        minimumWidth: Math.min(...during.map(item => item.width)),
        minimumHeight: Math.min(...during.map(item => item.height)),
        draws: probe.draws, requests: probe.requests, latestResult: probe.results.at(-1),
        latestUpload: probe.uploads.at(-1), converged: converged(),
        allocations: probe.allocations, getErrors: probe.getErrors,
        retention: { sourceSize, frames: probe.results.length, retained: probe.results.filter(item => item.retained).length,
          withPlane: probe.results.filter(item => item.plane).length,
          largestSample: Math.max(0, ...probe.results.map(item => item.histogramPixels || 0)),
          commits: probe.commits.length, committedPlanes: probe.committed.filter(item => item.plane).length },
        slider: Number(slider.value), duration: end - start };
    })()`);
    const gpu = result.applyDraws > 0;
    if (gpu) {
      if (result.applyDraws < 3 || result.applyChanges < 3) fail('GPU preview did not update before release: ' + JSON.stringify(result));
      // The first ticks may convert while the GPU inputs are still being prepared.
      if (result.requestsDuring > 2) fail('a GPU drag still converted per tick: ' + JSON.stringify(result));
      if (result.minimumApplyWidth < result.width - 2) fail('GPU preview frames lost display resolution: ' + JSON.stringify(result));
    } else if (result.uploads < 3 || result.changes < 3 || result.draws < 3) {
      fail('continuous preview did not update before release: ' + JSON.stringify(result));
    }
    // getError is a GPU round trip: only a size-changing allocation may check it.
    if (result.getErrors > result.allocations) fail('WebGL draw path still calls getError per frame: ' + JSON.stringify({ getErrors: result.getErrors, allocations: result.allocations, draws: result.draws }));
    // A display preview smaller than the source keeps each frame's 16-bit plane
    // in the worker; a preview that is the source always carries its plane.
    const retention = result.retention;
    const separatePreview = retention.sourceSize && result.width < retention.sourceSize[0] - 2;
    if (separatePreview && (retention.retained === 0 || retention.largestSample > 24576 || retention.committedPlanes === 0)) {
      fail('interactive frames did not keep their 16-bit plane in the worker until committed: ' + JSON.stringify(retention));
    }
    if (!separatePreview && retention.retained > 0) fail('a preview that is the source must carry its 16-bit plane: ' + JSON.stringify(retention));
    // A GPU drag uploads no converted frame (its sizes are checked above);
    // Math.min over none arrives here as null.
    if (!gpu && (result.minimumWidth < result.width - 2 || result.minimumHeight < result.height - 2)) fail('interactive preview lost display resolution: ' + JSON.stringify(result));
    const interactive = result.requests.filter(request => request.cache);
    if (!interactive.some(request => request.reuse) || interactive.at(-1)?.exposure !== 87
      || result.slider !== 87 || !result.converged) fail('preview worker did not reuse source / converge to latest displayed pixels: ' + JSON.stringify(result));
    console.log(`ok: continuous sharp preview (${gpu ? 'GPU frames' : 'worker frames'}) ` + JSON.stringify({ ...result, requests: result.requests.length }));
  }
  await runTrustedDragCheck({ send, evaluate, wait, fail });
  await evaluate(`(() => {
    window.__restorePreviewProbe();
    const slider = document.getElementById('coreExposure');
    slider.value = '0'; slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await wait(3200);
}

// A trusted mouse drag on the Exposure slider (#233). Structure only, no frame
// rates: the moves are spaced so each lands on an idle preview lane, where the
// request must leave in the input's own task (not after a timer), every value
// change must be requested, and the release must not request the shown value
// again.
async function runTrustedDragCheck({ send, evaluate, wait, fail }) {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await wait(3200);
  const track = await evaluate(`(() => {
    const slider = document.getElementById('coreExposure');
    slider.scrollIntoView({ block: 'center' });
    const rect = slider.getBoundingClientRect();
    const probe = window.__previewProbe;
    probe.inputs = []; probe.changes = []; probe.requests = []; probe.results = []; probe.commits = []; probe.committed = [];
    probe.applyDraws = [];
    return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width,
      min: Number(slider.min), max: Number(slider.max), value: Number(slider.value) };
  })()`);
  if (!(track.width > 40)) fail('exposure slider is not visible for the trusted drag: ' + JSON.stringify(track));
  const thumb = 12;
  const xFor = value => track.x + thumb / 2 + (value - track.min) / (track.max - track.min) * (track.width - thumb);
  const mouse = (type, x) => send('Input.dispatchMouseEvent', {
    type, x, y: track.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const startX = xFor(track.value);
  await mouse('mousePressed', startX);
  await wait(120);
  const steps = 12;
  for (let step = 1; step <= steps; step++) {
    await mouse('mouseMoved', startX + (track.width * 0.35 * step) / steps);
    await wait(90);
  }
  await wait(400);
  await mouse('mouseReleased', startX + track.width * 0.35);
  await wait(600);
  const drag = await evaluate(`(() => {
    const probe = window.__previewProbe;
    const inputs = probe.inputs.filter(input => input.trusted);
    const posts = probe.requests.filter(request => request.cache);
    const release = probe.changes.at(-1);
    const idle = inputs.filter(input => input.idle);
    const sameTask = idle.filter(input => posts.some(post => post.exposure === input.value
      && post.time >= input.time && post.time - input.time < 3));
    const latency = idle.map(input => {
      const post = posts.find(item => item.time >= input.time && item.exposure === input.value);
      return post ? Math.round((post.time - input.time) * 10) / 10 : null;
    });
    // #263: a drag in the reduced preview tier converts at <= 1 MP and then
    // once more, at the normal size, when it ends (at pointerup, before or
    // after the change event). Hardware hosts never reduce.
    const dragPosts = posts.filter(post => inputs.length && post.time >= inputs[0].time);
    const largest = Math.max(0, ...dragPosts.map(post => post.width * post.height));
    const reducedPosts = dragPosts.filter(post => post.width * post.height < largest);
    const lastReduced = reducedPosts.at(-1);
    const settleTicks = lastReduced ? dragPosts.filter(post => post.time > lastReduced.time) : [];
    // #239: an input the GPU draws shows at the next animation frame.
    const drawn = probe.applyDraws.filter(draw => inputs.length && draw.time >= inputs[0].time && (!release || draw.time <= release.time));
    const drawLatency = inputs.map(input => {
      const draw = drawn.find(item => item.time >= input.time);
      return draw ? Math.round((draw.time - input.time) * 10) / 10 : null;
    });
    return {
      inputs: inputs.length, idleInputs: idle.length, sameTask: sameTask.length, latency,
      applyDraws: drawn.length, drawLatency,
      posts: posts.filter(post => inputs.length && post.time >= inputs[0].time && (!release || post.time <= release.time)).length,
      afterRelease: release ? posts.filter(post => post.time > release.time).length : null,
      tierSession: document.documentElement.dataset.previewTierLastSession || null,
      reducedPosts: reducedPosts.length,
      maxReducedPixels: Math.max(0, ...reducedPosts.map(post => post.width * post.height)),
      settleTicks: settleTicks.map(post => ({ pixels: post.width * post.height, exposure: post.exposure })),
      retainedFrames: probe.results.filter(item => item.retained).length,
      committedPlanes: probe.committed.filter(item => item.plane).length,
      released: !!release, slider: Number(document.getElementById('coreExposure').value)
    };
  })()`);
  if (drag.inputs < 5 || !drag.released) fail('trusted slider drag did not drive the slider: ' + JSON.stringify(drag));
  if (drag.applyDraws > 0) {
    // GPU preview: every value change drawn within a frame, no conversion per tick
    // (the pause before release settles once).
    if (drag.applyDraws < 0.8 * drag.inputs) fail('trusted GPU drag drew fewer frames than value changes: ' + JSON.stringify(drag));
    if (drag.drawLatency.filter(value => value !== null && value < 50).length < 0.8 * drag.inputs) {
      fail('GPU frames did not follow their inputs within a frame: ' + JSON.stringify(drag));
    }
    if (drag.posts > 2) fail('a trusted GPU drag converted per tick: ' + JSON.stringify(drag));
  } else {
    if (drag.posts < 0.8 * drag.inputs) fail('trusted drag requested fewer frames than value changes: ' + JSON.stringify(drag));
    if (drag.idleInputs < 3 || drag.sameTask < 0.8 * drag.idleInputs) {
      fail('idle-lane inputs were not posted in their own task (< 3 ms): ' + JSON.stringify(drag));
    }
  }
  if (drag.reducedPosts === 0) {
    if (drag.afterRelease !== 0) fail('releasing the slider requested the shown frame again: ' + JSON.stringify(drag));
  } else {
    // Reduced frames only in a reduced session, never above 1 MP, and exactly
    // one normal-size conversion of the final value after them.
    if (drag.tierSession !== 'reduced' || drag.maxReducedPixels > 1_000_000) fail('smaller preview frames outside a reduced preview-tier session: ' + JSON.stringify(drag));
    if (drag.settleTicks.length !== 1 || drag.settleTicks[0].exposure !== drag.slider || drag.afterRelease > 1) {
      fail('a reduced drag did not settle with exactly one normal-size conversion: ' + JSON.stringify(drag));
    }
  }
  if (drag.retainedFrames > 0 && drag.committedPlanes === 0) fail('the dragged frame never got its 16-bit plane back: ' + JSON.stringify(drag));
  console.log(`ok: trusted drag ${drag.applyDraws > 0 ? 'draws every input on the GPU' : 'posts idle-lane frames in the input task'} and converts none on release (one normal-size settle after a reduced tier) ` + JSON.stringify(drag));
}
