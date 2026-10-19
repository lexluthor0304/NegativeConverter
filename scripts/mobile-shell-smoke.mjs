import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Browser coverage of the shared UI only; it is not native Photos/Files,
// WebKit, iOS memory or physical-device acceptance.
export async function runMobileShellSmoke({ send, evaluate, waitFor, wait, fail, port, root, fixture }) {
  const output = join(root, 'output', 'mobile-shell');
  mkdirSync(output, { recursive: true });
  const capture = async name => {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, name + '.png'), Buffer.from(shot.result.data, 'base64'));
  };
  const tap = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })`);
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, reachable: r.width > 0 && r.height > 0 && !el.disabled && el.contains(document.elementFromPoint(x, y)) };
    })()`);
    if (!point.reachable) fail('mobile control is covered or unreachable: ' + selector + ' ' + JSON.stringify(point));
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const sizes = [
    ['iphone-small', 375, 667, 20, 0],
    ['iphone', 390, 844, 59, 34],
    ['iphone-landscape', 844, 390, 0, 21, 59, 59],
    ['ipad-portrait', 820, 1180, 24, 20],
    ['ipad-landscape', 1180, 820, 24, 20],
    ['ipad-split', 540, 900, 24, 20]
  ];
  for (const lang of ['en', 'zh', 'ja']) {
    for (const [name, width, height, top, bottom, left = 0, right = 0] of sizes) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const url = `http://127.0.0.1:${port}/?shell=mobile&lang=${lang}&mobileSmoke=${name}`;
      await send('Page.navigate', { url });
      await waitFor('mobile boot', `location.href === ${JSON.stringify(url)} && !!document.getElementById('studioAdd') && document.documentElement.classList.contains('shell-mobile')`);
      await evaluate(`for (const [edge, value] of Object.entries(${JSON.stringify({ top, bottom, left, right })})) document.documentElement.style.setProperty('--safe-' + edge, value + 'px')`);
      await wait(250);
      const hidden = await evaluate(`['uploadFolderBtn', 'studioLoupe', 'studioWatchControls', 'desktopUpdateBanner'].every(id => !document.getElementById(id)?.getClientRects().length)`);
      if (!hidden) fail('mobile shows an unsupported control');
      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
      await waitFor('mobile photo converted', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`);
      await wait(300);
      await waitFor('import notifications settle', `!document.querySelector('.toast-visible')`);
      const layout = await evaluate(`(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
        return { viewport:[innerWidth,innerHeight], scrollWidth:document.documentElement.scrollWidth,
          canvas:rect('canvasContainer'), panel:rect('controlsPanel'), add:rect('studioAdd'), export:rect('exportBtn') };
      })()`);
      if (layout.scrollWidth > width + 1 || layout.canvas.height < 60 || layout.panel.height < 100 || layout.panel.bottom > height - bottom + 1) fail('mobile layout clips the editor: ' + JSON.stringify({ name, lang, ...layout }));
      for (const control of ['add', 'export']) if (layout[control].height < 44 || layout[control].width < 44) fail('mobile primary touch target too small: ' + control);
      const withinScreen = async selector => {
        await waitFor('visible ' + selector, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity === '1'`);
        const rect = await evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
          return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height, clientWidth:el.clientWidth, scrollWidth:el.scrollWidth };
        })()`);
        if (rect.width <= 0 || rect.height <= 0 || rect.x < left - 1 || rect.right > width - right + 1 || rect.y < top - 1 || rect.bottom > height - bottom + 1 || rect.scrollWidth > rect.clientWidth + 1) {
          await capture(`${name}-${lang}-clipped`);
          fail('mobile control or menu is clipped: ' + JSON.stringify({ name, lang, selector, ...rect }));
        }
      };
      await withinScreen('#studioMenu > summary');
      await tap('#studioMenu > summary');
      await waitFor('help menu opens', `document.getElementById('studioMenu').open`);
      await withinScreen('.studio-menu-content');
      if (lang === 'en') await capture(`${name}-help`);
      await tap('#studioMenu > summary');
      await tap('#exportBtn');
      await waitFor('export menu opens', `document.getElementById('exportDropdownMenu').classList.contains('show')`);
      await withinScreen('#exportDropdownMenu');
      if (lang === 'en') await capture(`${name}-export`);
      await tap('#exportBtn');
      if (width <= 700 || height <= 540) {
        await tap('#studioToggleStrip');
        await waitFor('photos expand', `document.getElementById('studioToggleStrip').getAttribute('aria-expanded') === 'true'`);
        await withinScreen('#controlsPanel');
        await withinScreen('#fileListSection');
        const viewerHeight = await evaluate(`document.getElementById('canvasContainer').getBoundingClientRect().height`);
        if (viewerHeight < 40) {
          await capture(`${name}-${lang}-viewer-clipped`);
          fail('expanded Photos leaves no usable viewer: ' + JSON.stringify({ name, lang, viewerHeight }));
        }
        if (lang === 'en') await capture(`${name}-photos`);
        await tap('#studioBatchMenu > summary');
        await waitFor('batch tools open', `document.getElementById('studioBatchMenu').open`);
        await withinScreen('.studio-batch-content');
        if (lang === 'en') await capture(`${name}-batch`);
        await tap('.studio-mark');
        await waitFor('batch tools close', `!document.getElementById('studioBatchMenu').open`);
        await tap('#studioToggleLightTable');
        await waitFor('light table opens', `document.getElementById('studioToggleLightTable').getAttribute('aria-pressed') === 'true'`);
        await withinScreen('#controlsPanel');
        await withinScreen('#fileListSection');
        if (lang === 'en') await capture(`${name}-lighttable`);
        await tap('#studioToggleLightTable');
        await tap('#studioToggleStrip');
      }
      await tap('#studioTab-composition');
      await waitFor('composition tab', `document.getElementById('studioTab-composition').getAttribute('aria-selected') === 'true'`);
      await tap('#studioTab-edit');
      await capture(`${name}-${lang}`);
      console.log('ok: mobile layout/import/touch tabs', name, lang, JSON.stringify(layout.viewport));
    }
  }
}
