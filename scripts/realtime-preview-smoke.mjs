// 解像度だけでなく、change（指を離す）前に実際の描画が更新されることを検証。
export async function runRealtimePreviewSmoke({ send, evaluate, wait, fail }) {
  await evaluate(`(() => {
    const proto = WebGLRenderingContext.prototype;
    const upload = proto.texImage2D;
    const draw = proto.drawArrays;
    const post = Worker.prototype.postMessage;
    window.__previewProbe = { uploads: [], draws: 0, requests: [] };
    proto.texImage2D = function (...args) {
      const pixels = args[8];
      if (this.canvas.id === 'glCanvas' && args[3] > 256 && ArrayBuffer.isView(pixels)) {
        let hash = 2166136261;
        for (let i = 0; i < pixels.length; i += 113) hash = Math.imul(hash ^ pixels[i], 16777619);
        window.__previewProbe.uploads.push({ width: args[3], height: args[4], hash, time: performance.now() });
      }
      return upload.apply(this, args);
    };
    proto.drawArrays = function (...args) {
      if (this.canvas.id === 'glCanvas') window.__previewProbe.draws++;
      return draw.apply(this, args);
    };
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'convert') window.__previewProbe.requests.push({ cache: !!message.cacheInput, reuse: !!message.reuseSource, exposure: message.settings.exposure, time: performance.now() });
      return post.call(this, message, ...args);
    };
    window.__restorePreviewProbe = () => { proto.texImage2D = upload; proto.drawArrays = draw; Worker.prototype.postMessage = post; };
  })()`);
  for (const dpr of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
    await wait(3200);
    const result = await evaluate(`(async () => {
      const slider = document.getElementById('coreExposure');
      const probe = window.__previewProbe;
      probe.uploads = []; probe.draws = 0; probe.requests = [];
      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        slider.value = String(-90 + i * 3);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      const end = performance.now();
      const during = probe.uploads.filter(item => item.time <= end);
      await new Promise(resolve => setTimeout(resolve, 700));
      const canvas = document.getElementById('glCanvas');
      return { dpr: devicePixelRatio, width: canvas.width, height: canvas.height,
        uploads: during.length, changes: new Set(during.map(item => item.hash)).size,
        firstFrameMs: during.length ? during[0].time - start : null,
        minimumWidth: Math.min(...during.map(item => item.width)),
        minimumHeight: Math.min(...during.map(item => item.height)),
        draws: probe.draws, requests: probe.requests, duration: end - start };
    })()`);
    if (result.uploads < 3 || result.changes < 3 || result.draws < 3) fail('continuous preview did not update before release: ' + JSON.stringify(result));
    if (result.minimumWidth < result.width - 2 || result.minimumHeight < result.height - 2) fail('interactive preview lost display resolution: ' + JSON.stringify(result));
    if (!result.requests.some(request => request.cache && request.reuse) || result.requests.at(-1)?.exposure !== 87) fail('preview worker did not reuse source / converge to latest input: ' + JSON.stringify(result));
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
