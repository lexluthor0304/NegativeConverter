import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { runRealtimePreviewSmoke } from './realtime-preview-smoke.mjs';
const UPNG = createRequire(import.meta.url)('upng-js');

// 実際の読み込み・変換・色同期を検証する。画面を偽の状態で描画しない。
export async function runStudioSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, fixtures, root }) {
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
  await waitFor('studio boot', `!!document.getElementById('studioBasic')`);
  await installDialogAutoAccept();
  await wait(400);
  const output = join(root, 'output', 'playwright');
  mkdirSync(output, { recursive: true });
  const capture = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (!shot.result?.data) fail('studio screenshot failed');
    writeFileSync(join(output, name), Buffer.from(shot.result.data, 'base64'));
  };
  const assertPreviewVisible = async () => {
    const rect = await evaluate(`(() => { const r = document.getElementById('canvasTransformWrapper').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
    let min = 255, max = 0, sum = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const value = (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
      min = Math.min(min, value); max = Math.max(max, value); sum += value;
    }
    if (max - min < 40 || sum / (rgba.length / 4) < 10) fail('studio preview is blank after layout resize');
  };
  await capture('studio-empty.png');
  if (!await evaluate(`document.getElementById('studioImportAutoCrop').checked`)) fail('auto crop is not enabled by default');
  // 既存の裁切・履歴シナリオは自動取景を明示的に無効化。自動取景は末尾で別途検証。
  await evaluate(`document.getElementById('studioImportAutoCrop').click()`);
  if (!await evaluate(`(() => {
    const link = document.querySelector('.studio-header .github-star-btn-main');
    return link?.href === 'https://github.com/lexluthor0304/NegativeConverter' && link.getBoundingClientRect().width > 0;
  })()`)) fail('GitHub link is not visible in the studio header');
  if (!await evaluate(`['toneSection', 'colorSection', 'cmySection', 'histogramContainer', 'additionalSection', 'consoleSection', 'dustRemovalSection', 'filmSettingsSection', 'advancedSection'].every(id => document.getElementById(id)?.isConnected)`)) fail('professional controls were removed');
  // 既存の JPEG は正像なので、既知の反転と色マスクから合成ネガを作る。
  // 実フィルムの色再現評価ではなく、入力→変換→調色の回帰用データ。
  await evaluate(`(async () => {
    const transfer = new DataTransfer();
    for (const [index, path] of ${JSON.stringify(fixtures.map(file => '/test-fixtures/' + file.split('/').at(-1)))}.entries()) {
      const bitmap = await createImageBitmap(await (await fetch(path)).blob());
      const surface = document.createElement('canvas');
      surface.width = bitmap.width; surface.height = bitmap.height;
      if (index === 0) window.__studioSourceSize = [bitmap.width, bitmap.height];
      const context = surface.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, surface.width, surface.height);
      const base = [230, 185, 145];
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let c = 0; c < 3; c++) pixels.data[i + c] = Math.round(base[c] * (1 - pixels.data[i + c] / 255));
      }
      context.putImageData(pixels, 0, 0);
      const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
      transfer.items.add(new File([blob], index ? 'synthetic-negative-sample-2.png' : 'synthetic-negative-sample.png', { type: 'image/png' }));
      if (index === 1) transfer.items.add(new File([blob], 'synthetic-negative-sample-3.png', { type: 'image/png' }));
    }
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('studio auto-conversion', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120_000);
  await wait(1000);
  const startup = await evaluate(`(() => ({
    sliders: document.querySelectorAll('#studioSliders input[type=range]').length,
    model: document.getElementById('coreColorModelStep2').value,
    queue: document.querySelectorAll('.file-list-item').length,
    stageHidden: !document.getElementById('controlStageBar'),
    basicVisible: document.getElementById('studioBasic').getBoundingClientRect().width > 200,
    conversionClosed: document.getElementById('studioPane-conversion').hidden,
    popup: document.querySelector('.frontier-guide-popup-overlay.show') !== null
  }))()`);
  if (startup.sliders !== 5 || startup.model !== 'standard' || startup.queue !== 3 || !startup.stageHidden || !startup.basicVisible || !startup.conversionClosed || startup.popup) {
    fail(`studio initial state: ${JSON.stringify(startup)}`);
  }
  console.log('ok: studio imports three synthetic negatives, automatically converts, shows five controls without guide popup');
  await capture('studio-desktop.png');
  await runRealtimePreviewSmoke({ send, evaluate, wait, fail });

  // 設定 DOM の存在だけでなく、タブから到達でき、実画布に枠が描画されることを確認。
  const clickVisible = async id => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'nearest' })`);
    const point = await evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)}), r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 && !el.disabled };
    })()`);
    if (!point.visible) fail(`studio control inaccessible: ${id}`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  await clickVisible('studioTab-border');
  await clickVisible('sprocketPreviewBtn');
  await waitFor('film border preview', `document.getElementById('sprocketPreviewBtn').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.getElementById('canvas')).display !== 'none'`);
  await clickVisible('sprocketTextEnabledInput');
  await clickVisible('sprocketFrameNumberEnabledInput');
  await clickVisible('sprocketDxEnabledInput');
  await wait(1000);
  const borderPreview = await evaluate(`(() => {
    const canvas = document.getElementById('canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let holes = 0, markings = 0;
    const band = Math.floor((canvas.height - window.__studioSourceSize[1]) / 2);
    for (let i = 0; i < canvas.width * band * 4; i += 4) {
      if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240) holes++;
      if (data[i] > 100 && data[i] > data[i + 1] * 1.2 && data[i + 1] > data[i + 2] * 1.5) markings++;
    }
    return { width: canvas.width, height: canvas.height, source: window.__studioSourceSize, holes, markings };
  })()`);
  if (borderPreview.height <= borderPreview.source[1] || borderPreview.width < borderPreview.source[0] || borderPreview.holes < 100 || borderPreview.markings < 50) fail('film border was not composited: ' + JSON.stringify(borderPreview));
  await assertPreviewVisible();
  await evaluate(`document.getElementById('controlsPanel').scrollTop = 0`);
  await capture('studio-border.png');
  await clickVisible('sprocketPreviewBtn');
  await wait(500);
  await clickVisible('studioTab-edit');
  console.log('ok: default workspace exposes border tab; real clicks render sprockets and enable text, frame numbers and DX');

  // 色・構図・修復・変換の主要コントロールを実際に開く。
  for (const [tab, drawers, ids] of [
    ['edit', ['studioCurves', 'studioLooks', 'studioMore'], ['histogramCanvas', 'consoleKeypad', 'curveCanvas', 'coreColorModelStep2', 'filmPreset', 'coreHighlights']],
    ['composition', ['studioAutoFrame'], ['autoFrameBtn', 'autoFrameSelectedBtn', 'autoFrameEnabledInput']],
    ['repair', ['studioLens'], ['dustRemovalEnabled', 'lensEnableInput', 'lensSearchBtn', 'studioApplyLens']],
    ['conversion', [], ['sampleBaseBtn', 'autoDetectBtn', 'setRollReferenceBtn', 'applyRollReferenceBtn', 'coreCurvePrecision', 'coreUseWebGL', 'studioRetry', 'studioRestart']]
  ]) {
    await clickVisible('studioTab-' + tab);
    await evaluate(`${JSON.stringify(drawers)}.forEach(id => { document.getElementById(id).open = true; })`);
    await wait(150);
    for (const id of ids) {
      if (!await evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`)) fail('professional control has no visible entry: ' + id);
    }
  }
  await clickVisible('studioTab-edit');
  await evaluate(`document.getElementById('studioCurves').scrollIntoView({ block: 'start' })`);
  await wait(200);
  if (!await evaluate(`document.getElementById('curveCanvas').width > 100 && document.getElementById('curveCanvas').height > 100`)) fail('curve canvas did not redraw after opening');
  await capture('studio-curves.png');
  await evaluate(`document.querySelectorAll('.studio-drawer').forEach(el => { el.open = false; }); document.getElementById('controlsPanel').scrollTop = 0;`);
  // スペースを広げても画布が消えず、操作を元に戻せる。
  const previewBeforeHide = await evaluate(`document.getElementById('canvasContainer').getBoundingClientRect().width`);
  await clickVisible('studioTogglePanel');
  await wait(200);
  if (!await evaluate(`document.getElementById('canvasContainer').getBoundingClientRect().width > ${previewBeforeHide}`)) fail('hiding controls did not give space back to the image');
  await assertPreviewVisible();
  await clickVisible('studioTogglePanel');
  await clickVisible('studioToggleStrip');
  await wait(200);
  if (!await evaluate(`getComputedStyle(document.getElementById('fileListSection')).display === 'none'`)) fail('filmstrip did not collapse');
  await assertPreviewVisible();
  await clickVisible('studioToggleStrip');
  await wait(200);
  console.log('ok: all five tool tabs expose professional controls; curves redraw and panels collapse without losing the preview');

  // 調色の非同期更新直後に切り抜きを開始しても、編集中の画布を奪わない。
  await evaluate(`(() => {
    const image = document.getElementById('canvas');
    // 読み込み直後の表示は低解像度でも、切り抜きは元の寸法で評価する。
    window.__cropUncroppedSize = window.__studioSourceSize;
    const slider = document.getElementById('coreTemperature');
    slider.value = '12'; slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('cropBtn').click();
    const canvas = document.getElementById('canvas');
    window.__cropDraftSize = [canvas.width, canvas.height];
  })()`);
  await wait(3500);
  const stableCrop = await evaluate(`(() => {
    const canvas = document.getElementById('canvas');
    return { active: document.getElementById('canvasContainer').classList.contains('crop-mode'),
      canvasVisible: getComputedStyle(canvas).display !== 'none',
      glHidden: getComputedStyle(document.getElementById('glCanvas')).display === 'none',
      sizeStable: JSON.stringify([canvas.width, canvas.height]) === JSON.stringify(window.__cropDraftSize) };
  })()`);
  if (!stableCrop.active || !stableCrop.canvasVisible || !stableCrop.glHidden || !stableCrop.sizeStable) fail(`crop draft overwritten by background render: ${JSON.stringify(stableCrop)}`);
  await evaluate(`document.getElementById('cancelCropBtn').click()`);
  await wait(500);
  if (!await evaluate(`JSON.stringify([document.getElementById('canvas').width, document.getElementById('canvas').height]) === JSON.stringify(window.__cropUncroppedSize)`)) fail('crop cancel did not restore the image dimensions: ' + JSON.stringify(await evaluate(`({ actual: [document.getElementById('canvas').width, document.getElementById('canvas').height], expected: window.__cropUncroppedSize })`)));

  await evaluate(`document.getElementById('cropBtn').click()`);
  const corner = await evaluate(`(() => {
    const r = document.getElementById('cropOverlay').getBoundingClientRect();
    return { x: r.x + 2, y: r.y + 2, toX: r.x + r.width * .2, toY: r.y + r.height * .15 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.toX, y: corner.toY, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.toX, y: corner.toY, button: 'left', clickCount: 1 });
  const expectedCrop = await evaluate(`(() => {
    const rect = document.getElementById('cropOverlay').getBoundingClientRect();
    const image = document.getElementById('canvasTransformWrapper').getBoundingClientRect();
    return [rect.width / image.width * window.__cropUncroppedSize[0], rect.height / image.height * window.__cropUncroppedSize[1]];
  })()`);
  await capture('studio-crop.png');
  await evaluate(`document.getElementById('applyCropBtn').click()`);
  await waitFor('crop applied and converted', `document.body.classList.contains('studio-ready') && !document.getElementById('canvasContainer').classList.contains('crop-mode')`, 120_000);
  // 通常の原寸化は 2500ms のアイドル後。固定 1500ms では高速なプレビューを誤判定する。
  await waitFor('crop full-resolution dimensions', `[document.getElementById('canvas').width, document.getElementById('canvas').height].every((size, index) => Math.abs(size - ${JSON.stringify(expectedCrop)}[index]) <= 2)`, 120_000);
  const appliedCrop = await evaluate(`[document.getElementById('canvas').width, document.getElementById('canvas').height]`);
  if (appliedCrop.some((size, index) => Math.abs(size - expectedCrop[index]) > 2)) fail(`crop dimensions differ from dragged region: ${appliedCrop} vs ${expectedCrop}`);
  await assertPreviewVisible();
  await evaluate(`document.getElementById('undoBtn').click()`);
  await waitFor('undo crop original dimensions', `JSON.stringify([document.getElementById('canvas').width, document.getElementById('canvas').height]) === JSON.stringify(window.__cropUncroppedSize)`, 120_000);
  await evaluate(`document.getElementById('redoBtn').click()`);
  await waitFor('redo crop full-resolution dimensions', `JSON.stringify([document.getElementById('canvas').width, document.getElementById('canvas').height]) === ${JSON.stringify(JSON.stringify(appliedCrop))}`, 120_000);
  const redoneCrop = await evaluate(`[document.getElementById('canvas').width, document.getElementById('canvas').height]`);
  if (JSON.stringify(redoneCrop) !== JSON.stringify(appliedCrop)) fail('redo crop did not restore the crop');
  await evaluate(`document.getElementById('undoBtn').click()`);
  await waitFor('restore uncropped dimensions', `JSON.stringify([document.getElementById('canvas').width, document.getElementById('canvas').height]) === JSON.stringify(window.__cropUncroppedSize)`, 120_000);
  console.log('ok: crop survives background render; real pointer drag, apply, cancel, undo and redo preserve geometry');

  await evaluate(`(() => {
    const slider = document.getElementById('coreTemperature');
    slider.value = '24'; slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(1200);
  await evaluate(`document.getElementById('studioSync').click()`);
  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('studio second photo', `document.getElementById('studioFilename').textContent.includes('negative-sample-2') && document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120_000);
  const restored = await evaluate(`Number(document.getElementById('coreTemperature').value)`);
  if (restored !== 24) fail(`studio synced color was not restored: ${restored}`);
  await wait(500);
  await evaluate(`document.getElementById('studioReset').click()`);
  if (await evaluate(`Number(document.getElementById('coreTemperature').value)`) !== 0) fail('studio reset did not reset color');
  await evaluate(`document.getElementById('undoBtn').click()`);
  await wait(1200);
  if (await evaluate(`Number(document.getElementById('coreTemperature').value)`) !== 24) fail('studio reset is not undoable');
  console.log('ok: studio sync applies color to an unopened photo; reset and undo preserve it');

  // 開いたことがある写真に戻っても、自動変換が保存済みの調色を上書きしない。
  await evaluate(`document.querySelectorAll('.file-list-name')[0].click()`);
  await waitFor('studio first photo restored', `document.getElementById('studioFilename').textContent.endsWith('negative-sample.png') && document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 120_000);
  if (await evaluate(`Number(document.getElementById('coreTemperature').value)`) !== 24) fail('studio switching lost color settings');
  await wait(1000);
  await assertPreviewVisible();
  await capture('studio-batch.png');

  // ダウンロードの起動だけを捕捉し、変換と PNG/ZIP エンコードは実行する。
  await evaluate(`(() => {
    window.__studioDownloads = [];
    const revoke = URL.revokeObjectURL.bind(URL);
    const held = new Set();
    URL.revokeObjectURL = url => { if (!held.has(url)) revoke(url); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      const url = this.href, name = this.download; held.add(url);
      window.__studioDownloads.push(fetch(url).then(response => response.arrayBuffer()).then(buffer => {
        held.delete(url); revoke(url); return { name, size: buffer.byteLength, head: [...new Uint8Array(buffer.slice(0, 8))] };
      }));
    };
    // 保存先の選択ではなく、ブラウザーの互換書き出し経路を検証する。
    window.showSaveFilePicker = undefined;
    document.getElementById('exportBtn').click();
  })()`);
  await capture('studio-export.png');
  await evaluate(`document.getElementById('exportZipBtn').click()`);
  await waitFor('studio batch export', `document.querySelectorAll('.file-list-status.done').length === 3`, 180_000);
  await waitFor('studio downloads', `window.__studioDownloads.length >= 1`, 60_000);
  const files = await evaluate(`Promise.all(window.__studioDownloads)`);
  if (!files.length || files.some(file => file.size < 10000 || !(file.head[0] === 137 || (file.head[0] === 80 && file.head[1] === 75)))) fail('studio batch export did not produce valid images or ZIP');
  console.log('ok: studio batch export encodes all three selected photos, including an unopened synced photo');

  // 枠を書き出しに含める指定が、通常の「書き出し」を押しても解除されない。
  await clickVisible('studioTab-border');
  const beforeBorderDownloads = await evaluate('window.__studioDownloads.length');
  await clickVisible('exportSprocketBtn');
  if (!await evaluate(`document.getElementById('studioExportBorder').checked && document.getElementById('exportDropdownMenu').classList.contains('show')`)) fail('border export action did not open unified export options');
  await clickVisible('exportSingleBtn');
  await waitFor('border export download', `window.__studioDownloads.length > ${beforeBorderDownloads}`, 120_000);
  const framedFile = (await evaluate(`Promise.all(window.__studioDownloads)`)).at(-1);
  if (!framedFile.name.includes('_sprocket') || framedFile.size < 10000) fail('border export missing sprocket output');
  await clickVisible('exportBtn');
  if (!await evaluate(`document.getElementById('studioExportBorder').checked`)) fail('normal export button reset border mode');
  await clickVisible('studioExportBorder');
  if (!await evaluate(`document.getElementById('exportDropdownMenu').classList.contains('show') && !document.getElementById('studioExportBorder').checked`)) fail('export checkbox closed the menu or did not change mode');
  await clickVisible('studioTab-edit');
  console.log('ok: border export produces a sprocket file and unified export retains its explicit border setting');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(500);
  const mobile = await evaluate(`(() => {
    const image = document.getElementById('canvasContainer').getBoundingClientRect();
    const strip = document.getElementById('studioFilmstrip').getBoundingClientRect();
    const panel = document.getElementById('controlsPanel').getBoundingClientRect();
    return { overflow: document.documentElement.scrollWidth > innerWidth, imageHeight: image.height, stripTop: strip.top, panelTop: panel.top, panelBottom: panel.bottom, viewport: innerHeight };
  })()`);
  if (mobile.overflow || mobile.imageHeight < 100 || mobile.panelTop <= mobile.stripTop || mobile.panelBottom > mobile.viewport + 2) fail(`studio mobile layout: ${JSON.stringify(mobile)}`);
  await assertPreviewVisible();
  await capture('studio-mobile.png');
  if (!await evaluate(`document.querySelector('.studio-header .github-star-btn-main').getBoundingClientRect().width > 0`)) fail('GitHub link is not visible on mobile');
  await evaluate(`document.getElementById('cropBtn').click()`);
  const mobileCorner = await evaluate(`(() => {
    const r = document.getElementById('cropOverlay').getBoundingClientRect();
    return { x: r.x + 2, y: r.y + 2, endX: r.x + r.width * .2, endY: r.y + r.height * .2, width: r.width };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mobileCorner.x, y: mobileCorner.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mobileCorner.endX, y: mobileCorner.endY }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const mobileCropWidth = await evaluate(`document.getElementById('cropOverlay').getBoundingClientRect().width`);
  if (mobileCropWidth >= mobileCorner.width - 5) fail('mobile touch did not resize the crop');
  await evaluate(`document.getElementById('cancelCropBtn').click()`);
  await wait(500);
  await assertPreviewVisible();
  console.log('ok: mobile touch crop and cancel work; GitHub and professional controls remain available');
  await send('Emulation.clearDeviceMetricsOverride');
  await wait(300);
  // Step 1 に戻る UI に依存せず、自動取景を実行して調色へ復帰する。
  await clickVisible('studioTab-composition');
  await clickVisible('autoFrameBtn');
  await waitFor('studio auto frame returns to editing', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.getElementById('autoFrameBtn').disabled`, 120_000);
  await assertPreviewVisible();
  await clickVisible('autoFrameSelectedBtn');
  await waitFor('studio batch auto frame returns to editing', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.getElementById('autoFrameSelectedBtn').disabled`, 180_000);
  await assertPreviewVisible();
  await clickVisible('studioTab-edit');
  console.log('ok: single and selected-photo auto frame both finish back in the new workspace');
  console.log(`ok: studio mobile layout has no horizontal overflow; screenshots in ${output}`);
}
