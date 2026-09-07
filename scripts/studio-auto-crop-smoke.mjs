// 合成した既知の撮影窓を、通常のファイル入力から読み込んで検証する。
export async function runStudioAutoCropSmoke({ send, evaluate, waitFor, wait, fail, port, installDialogAutoAccept }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
  await waitFor('auto crop workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('studioFrameNotice') && document.querySelector('[role=tab][aria-selected=true]'))`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__autoCropDownloads = [];
    window.showSaveFilePicker = undefined;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      window.__autoCropDownloads.push(fetch(this.href).then(r => r.blob()).then(createImageBitmap).then(bitmap => {
        const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
      }));
    };
  })()`);
  const examples = [
    ['135-standard', 1.5, 6], ['120-6x6', 1, -5], ['120-6x4.5', 4 / 3, 0],
    ['120-6x7', 7 / 6, 4], ['120-6x8', 4 / 3, 0], ['120-6x9', 1.5, 0],
    ['120-6x12', 2, 3], ['120-6x17', 17 / 6, 0], ['135-half', 4 / 3, 0], ['135-panoramic', 65 / 24, 0]
  ];
  for (const [format, ratio, angle] of examples) {
    await evaluate(`(async () => {
      const format = document.getElementById('autoFrameFormatSelect');
      format.value = ${JSON.stringify(format)};
      format.dispatchEvent(new Event('change', { bubbles: true }));
      const w = Math.round(320 * ${ratio}), h = 320;
      const surface = document.createElement('canvas');
      surface.width = w + 200; surface.height = h + 200;
      const context = surface.getContext('2d');
      context.fillStyle = 'rgb(232,155,91)'; context.fillRect(0, 0, surface.width, surface.height);
      context.translate(surface.width / 2, surface.height / 2); context.rotate(${angle} * Math.PI / 180);
      context.fillStyle = 'rgb(25,22,19)'; context.fillRect(-w / 2, -h / 2, w, h);
      for (let y = 4; y < h - 4; y += 6) for (let x = 4; x < w - 4; x += 6) {
        const n = (x * 17 + y * 23) % 90;
        context.fillStyle = 'rgb(' + (40 + n) + ',' + (22 + n / 2) + ',' + (18 + n / 3) + ')';
        context.fillRect(x - w / 2, y - h / 2, 6, 6);
      }
      const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], ${JSON.stringify(format + '.png')}, { type: 'image/png' }));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      window.__autoCropExpected = { w, h, source: [surface.width, surface.height] };
    })()`);
    await waitFor('auto crop ' + format, `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename').textContent === ${JSON.stringify(format + '.png')}`, 120_000);
    await wait(800);
    const result = await evaluate(`(() => ({
      status: document.getElementById('studioFrameNotice').dataset.status,
      diagnostics: document.getElementById('autoFrameDiagnosticsBox').textContent,
      rotation: Number(document.getElementById('autoFrameDiagnosticsBox').dataset.angle),
      size: [document.getElementById('canvas').width, document.getElementById('canvas').height],
      expected: window.__autoCropExpected
    }))()`);
    console.log('auto crop evidence:', format, JSON.stringify(result));
    if (result.status !== 'crop') fail('import did not automatically crop known image area: ' + format);
    if (Math.abs(result.rotation + angle) > 0.5) fail('auto straighten did not correct the known angle: ' + format);
    if (result.size[0] >= result.expected.source[0] || result.size[1] >= result.expected.source[1]) fail('auto crop did not reduce image bounds: ' + format);
    if (Math.abs(result.size[0] / result.size[1] - ratio) / ratio > 0.12) fail('auto crop aspect ratio is far from the known frame: ' + format);
  }
  await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('studioRestoreFrame').click();`);
  await wait(1500);
  await evaluate(`document.getElementById('exportSingleBtn').click()`);
  await waitFor('restored full image export', `window.__autoCropDownloads.length > 0`, 120_000);
  const restoredSize = (await evaluate(`Promise.all(window.__autoCropDownloads)`)).at(-1);
  const sourceSize = await evaluate('window.__autoCropExpected.source');
  if (JSON.stringify(restoredSize) !== JSON.stringify(sourceSize)) fail('restore full image lost source bounds: ' + JSON.stringify({ restoredSize, sourceSize }));
  console.log('ok: 135 and 120 known image areas automatically crop on import; full image can be restored');
}
