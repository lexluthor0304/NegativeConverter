import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runWorkspaceUiSmoke({ send, evaluate, waitFor, fail, port, root }) {
  await send('DOM.enable'); await send('CSS.enable');
  for (const query of ['workspace=classic&lang=zh', 'workspace=studio&lang=en', 'lang=ja']) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?${query}` });
    await waitFor('single workspace', `!!document.getElementById('studioBasic')`);
    if (!await evaluate(`document.body.classList.contains('studio') && !document.querySelector('.app-header,.app-footer,#studioPreviewLink,#noviceGuideSection,#controlStageBar,#panelModeToggle,#frontierGuidePopupOverlay,.upload-seo-summary,#studioHeaderSource,#studioExportSource')`)) fail('old workspace markup remains');
    if (!await evaluate(`document.querySelector('.studio-mark')?.textContent === 'NeoAnalogLab' && !document.querySelector('.studio-mark').hasAttribute('aria-hidden')`)) fail('brand name is missing or inaccessible');
  }
  // 空画布による片寄り・狭幅での押しつぶしを DOM 座標で回帰検証する。
  for (const [width, height] of [[2048, 1166], [1440, 900], [390, 844], [320, 568], [844, 390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 900 });
    const layout = await evaluate(`(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const bounds = id => document.getElementById(id).getBoundingClientRect();
      const container = bounds('canvasContainer'), upload = bounds('uploadPlaceholder');
      const a = bounds('uploadBtn'), b = bounds('uploadFolderBtn');
      return { centered: Math.abs(upload.x + upload.width / 2 - container.x - container.width / 2) < 1,
        canvasHidden: getComputedStyle(document.getElementById('canvasTransformWrapper')).display === 'none',
        titleVisible: document.querySelector('.studio-welcome').getBoundingClientRect().top >= container.top,
        buttonsAligned: Math.abs(a.top - b.top) < 1 && b.left >= a.right,
        buttonsUsable: a.width >= 90 && b.width >= 90 && a.height >= 44 && b.height >= 44,
        square: getComputedStyle(document.getElementById('uploadBtn')).borderRadius === '0px',
        noOverflow: document.documentElement.scrollWidth <= innerWidth,
        multiple: document.getElementById('fileInput').multiple };
    })()`);
    if (Object.values(layout).some(value => !value)) fail('empty 8-bit layout '+width+'x'+height+': '+JSON.stringify(layout));
  }
  await send('Emulation.clearDeviceMetricsOverride');
  const motion = await evaluate(`(async () => {
    const { getLoadingOverlay } = await import('/src/ui/LoadingOverlay.js');
    const overlay = getLoadingOverlay(); await overlay.show({ title: 'Loading' });
    overlay.updateProgress(42, 'Preview');
    const result = { reel: getComputedStyle(document.querySelector('.loading-reel')).animationTimingFunction,
      film: getComputedStyle(document.querySelector('.studio-negative-icon span')).animationTimingFunction };
    overlay.hide(); return result;
  })()`);
  if (!motion.reel.startsWith('steps(') || !motion.film.startsWith('steps(')) fail('8-bit animation is not stepped: '+JSON.stringify(motion));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  if (!await evaluate(`getComputedStyle(document.querySelector('.studio-negative-icon span')).animationName === 'none' && getComputedStyle(document.querySelector('.loading-reel')).animationName === 'none'`)) fail('reduced motion not respected');
  await send('Emulation.setEmulatedMedia', { features: [] });
  console.log('ok: centered empty layout at five sizes; square controls, batch inputs, stepped animation and reduced motion');
  for (const [lang, label, family] of [
    ['zh', '负片裁切颜色 批量照片', 'SC'], ['en', 'Negative Converter RGB 123', 'SC'],
    ['ja', '写真の色を調整 カーブ', 'JP'], ['ko', '사진 색상 조정', 'KR'], ['zh-Hant', '負片裁切顏色 批量照片', 'TC']
  ]) {
    await evaluate(`(async()=>{
      document.documentElement.lang=${JSON.stringify(lang)};
      document.getElementById('fontProbe')?.remove();
      const probe=document.createElement('div'); probe.id='fontProbe';probe.textContent=${JSON.stringify(label)};
      probe.style.cssText='position:fixed;left:20px;top:150px;font-size:24px;background:#242424;color:white;padding:16px;z-index:50';
      document.body.append(probe);
      await document.fonts.load('12px "Fusion Pixel ${family}"',probe.textContent);await document.fonts.ready;
    })()`);
    const doc = await send('DOM.getDocument');
    const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fontProbe' });
    const result = await send('CSS.getPlatformFontsForNode', { nodeId: node.result.nodeId });
    const fonts = result.result?.fonts || [];
    if (!fonts.length || fonts.some(font => !font.isCustomFont || !font.familyName.toLowerCase().includes('fusion'))) fail('pixel font fallback: '+lang+' '+JSON.stringify(fonts));
    console.log('ok: actual pixel glyphs', lang, JSON.stringify(fonts.map(f=>({family:f.familyName,glyphs:f.glyphCount}))));
  }
  for (const className of ['zoom-indicator', 'loupe-info', 'autoframe-diagnostics', 'film-base-values', 'debug-widget', 'loading-phase-text']) {
    const family = await evaluate(`(() => {
      const probe = document.getElementById('fontProbe'); probe.className = ${JSON.stringify(className)};
      return getComputedStyle(probe).fontFamily;
    })()`);
    if (!family.includes('Fusion Pixel')) fail('readout font fallback: ' + className + ' ' + family);
  }
  await evaluate(`document.getElementById('fontProbe').remove(); document.documentElement.lang='ja'`);
  const shot = await send('Page.captureScreenshot',{format:'png'});
  mkdirSync(join(root,'output','playwright'),{recursive:true});
  writeFileSync(join(root,'output','playwright','studio-pixel-ja.png'),Buffer.from(shot.result.data,'base64'));
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=zh` });
  await waitFor('mobile brand', `!!document.getElementById('studioBasic')`);
  await evaluate(`document.fonts.ready.then(() => true)`);
  for (const width of [320, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    if (!await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.studio-mark').getBoundingClientRect().right <= innerWidth`)) fail('mobile brand or page overflows at ' + width);
    if (!await evaluate(`(() => {
      const labels = [...document.querySelectorAll('.studio-public-links .header-link-btn > span[data-i18n]:not(.header-shop-badge)')];
      return labels.length === 4 && labels.every(label => label.getBoundingClientRect().width > 10 && getComputedStyle(label).clip === 'auto');
    })()`)) fail('mobile public-link labels are hidden at ' + width);
  }
  const mobile = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(root,'output','playwright','studio-pixel-mobile.png'),Buffer.from(mobile.result.data,'base64'));
  await send('Emulation.clearDeviceMetricsOverride');
  console.log('ok: old workspace links open the only UI; Latin, SC, TC, Japanese and Korean render custom pixel fonts');
}
