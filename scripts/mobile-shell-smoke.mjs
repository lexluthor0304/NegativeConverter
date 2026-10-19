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
  const tap = async id => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
    const point = await evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)}), r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, reachable: r.width > 0 && r.height > 0 && !el.disabled && el.contains(document.elementFromPoint(x, y)) };
    })()`);
    if (!point.reachable) fail('mobile control is covered or unreachable: ' + id + ' ' + JSON.stringify(point));
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: point.x, y: point.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const sizes = [
    ['iphone-small', 375, 667, 20, 0],
    ['iphone', 390, 844, 59, 34],
    ['iphone-landscape', 844, 390, 0, 21],
    ['ipad-portrait', 820, 1180, 24, 20],
    ['ipad-landscape', 1180, 820, 24, 20],
    ['ipad-split', 540, 900, 24, 20]
  ];
  for (const lang of ['en', 'zh', 'ja']) {
    for (const [name, width, height, top, bottom] of sizes) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      const url = `http://127.0.0.1:${port}/?shell=mobile&lang=${lang}&mobileSmoke=${name}`;
      await send('Page.navigate', { url });
      await waitFor('mobile boot', `location.href === ${JSON.stringify(url)} && !!document.getElementById('studioAdd') && document.documentElement.classList.contains('shell-mobile')`);
      await evaluate(`document.documentElement.style.setProperty('--safe-top', '${top}px'); document.documentElement.style.setProperty('--safe-bottom', '${bottom}px')`);
      await wait(250);
      const hidden = await evaluate(`['uploadFolderBtn', 'studioLoupe', 'studioWatchControls', 'desktopUpdateBanner'].every(id => !document.getElementById(id)?.getClientRects().length)`);
      if (!hidden) fail('mobile shows an unsupported control');
      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
      await waitFor('mobile photo converted', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`);
      await wait(300);
      const layout = await evaluate(`(() => {
        const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return { x:r.x, y:r.y, width:r.width, height:r.height, bottom:r.bottom }; };
        return { viewport:[innerWidth,innerHeight], scrollWidth:document.documentElement.scrollWidth,
          canvas:rect('canvasContainer'), panel:rect('controlsPanel'), add:rect('studioAdd'), export:rect('exportBtn') };
      })()`);
      if (layout.scrollWidth > width + 1 || layout.canvas.height < 60 || layout.panel.height < 100 || layout.panel.bottom > height - bottom + 1) fail('mobile layout clips the editor: ' + JSON.stringify({ name, lang, ...layout }));
      for (const control of ['add', 'export']) if (layout[control].height < 44 || layout[control].width < 44) fail('mobile primary touch target too small: ' + control);
      await tap('studioTab-composition');
      await waitFor('composition tab', `document.getElementById('studioTab-composition').getAttribute('aria-selected') === 'true'`);
      await tap('studioTab-edit');
      await capture(`${name}-${lang}`);
      console.log('ok: mobile layout/import/touch tabs', name, lang, JSON.stringify(layout.viewport));
    }
  }
}
