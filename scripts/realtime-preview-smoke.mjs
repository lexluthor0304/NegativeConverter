// 解像度だけでなく、change（指を離す）前に実際の描画が更新されることを検証。
export async function runRealtimePreviewSmoke({ send, evaluate, wait, fail }) {
  await evaluate(`(() => {
    const proto = WebGLRenderingContext.prototype;
    const upload = proto.texImage2D;
    const draw = proto.drawArrays;
    const post = Worker.prototype.postMessage;
    const workers = new Map();
    const pixelHash = pixels => {
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i += 113) hash = Math.imul(hash ^ pixels[i], 16777619);
      return hash;
    };
    window.__previewProbe = { uploads: [], draws: 0, requests: [], results: [] };
    proto.texImage2D = function (...args) {
      const pixels = args[8];
      if (this.canvas.id === 'glCanvas' && args[3] > 256 && ArrayBuffer.isView(pixels)) {
        window.__previewProbe.uploads.push({ width: args[3], height: args[4], hash: pixelHash(pixels), time: performance.now() });
      }
      return upload.apply(this, args);
    };
    proto.drawArrays = function (...args) {
      if (this.canvas.id === 'glCanvas') window.__previewProbe.draws++;
      return draw.apply(this, args);
    };
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'convert') {
        const request = { cache: !!message.cacheInput, reuse: !!message.reuseSource, exposure: message.settings.exposure, time: performance.now() };
        window.__previewProbe.requests.push(request);
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
              if (reply.type === 'result' && reply.rgba) window.__previewProbe.results.push({
                exposure: request.exposure, width: reply.width, height: reply.height,
                hash: pixelHash(new Uint8Array(reply.rgba)), time: performance.now()
              });
            };
            this.addEventListener('message', record.receive);
            workers.set(this, record);
          }
          record.pending.set(message.id, request);
        }
      }
      return post.call(this, message, ...args);
    };
    window.__restorePreviewProbe = () => {
      proto.texImage2D = upload; proto.drawArrays = draw; Worker.prototype.postMessage = post;
      for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    };
  })()`);
  for (const dpr of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
    await wait(3200);
    const result = await evaluate(`(async () => {
      const slider = document.getElementById('coreExposure');
      const probe = window.__previewProbe;
      probe.uploads = []; probe.draws = 0; probe.requests = []; probe.results = [];
      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        slider.value = String(-90 + i * 3);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const end = performance.now();
      const during = probe.uploads.filter(item => item.time <= end);
      const converged = () => {
        const result = probe.results.at(-1), upload = probe.uploads.at(-1);
        return result?.exposure === 87 && upload?.hash === result.hash
          && upload.width === result.width && upload.height === result.height;
      };
      while (!converged() && performance.now() - end < 8000) await new Promise(resolve => setTimeout(resolve, 25));
      const canvas = document.getElementById('glCanvas');
      return { dpr: devicePixelRatio, width: canvas.width, height: canvas.height,
        uploads: during.length, changes: new Set(during.map(item => item.hash)).size,
        firstFrameMs: during.length ? during[0].time - start : null,
        minimumWidth: Math.min(...during.map(item => item.width)),
        minimumHeight: Math.min(...during.map(item => item.height)),
        draws: probe.draws, requests: probe.requests, latestResult: probe.results.at(-1),
        latestUpload: probe.uploads.at(-1), converged: converged(),
        slider: Number(slider.value), duration: end - start };
    })()`);
    if (result.uploads < 3 || result.changes < 3 || result.draws < 3) fail('continuous preview did not update before release: ' + JSON.stringify(result));
    if (result.minimumWidth < result.width - 2 || result.minimumHeight < result.height - 2) fail('interactive preview lost display resolution: ' + JSON.stringify(result));
    const interactive = result.requests.filter(request => request.cache);
    if (!interactive.some(request => request.reuse) || interactive.at(-1)?.exposure !== 87
      || result.slider !== 87 || !result.converged) fail('preview worker did not reuse source / converge to latest displayed pixels: ' + JSON.stringify(result));
    console.log('ok: continuous sharp preview ' + JSON.stringify({ ...result, requests: result.requests.length }));
  }
  await evaluate(`(() => {
    window.__restorePreviewProbe();
    const slider = document.getElementById('coreExposure');
    slider.value = '0'; slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await send('Emulation.clearDeviceMetricsOverride');
  await wait(3200);
}
