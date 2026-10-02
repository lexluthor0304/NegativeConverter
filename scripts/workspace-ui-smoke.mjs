import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_CODE_POINTS, UI_FACES } from './ui-font-glyphs.mjs';
import { i18n } from '../negative2positive/src/app/i18n.js';

const LATIN_POSTSCRIPT = 'NCStudioLatin';
const UI_POSTSCRIPT = Object.fromEntries(UI_FACES.map(face => [face.id, face.postScriptName]));
const UI_FAMILIES = ['NC Studio Latin', ...UI_FACES.map(face => face.family)];
const FULL_FACE_FILE = /fusion-pixel-12px-proportional-/;
const FULL_FAMILIES = ['Fusion Pixel SC', 'Fusion Pixel TC', 'Fusion Pixel JP', 'Fusion Pixel KR'];
// Cold UI font budget for zh and ja (#262): the subsets, not a 0.66 MB face.
const COLD_UI_FONT_BUDGET = 50 * 1024;

export async function runWorkspaceUiSmoke({ send, sendTo, evaluate, waitFor, fail, port, root }) {
  await send('DOM.enable'); await send('CSS.enable');
  for (const query of ['workspace=classic&lang=zh', 'workspace=studio&lang=en', 'lang=ja']) {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?${query}` });
    await waitFor('single workspace', `!!document.getElementById('studioBasic')`);
    if (!await evaluate(`document.body.classList.contains('studio') && !document.querySelector('.app-header,.app-footer,#studioPreviewLink,#noviceGuideSection,#controlStageBar,#panelModeToggle,#frontierGuidePopupOverlay,.upload-seo-summary,#studioHeaderSource,#studioExportSource')`)) fail('old workspace markup remains');
    if (!await evaluate(`document.querySelector('.studio-mark')?.textContent === 'NeoAnalogLab' && !document.querySelector('.studio-mark').hasAttribute('aria-hidden')`)) fail('brand name is missing or inaccessible');
    // The menu's notices link is created after the first setLanguage ran.
    const lang = new URLSearchParams(query).get('lang');
    const label = await evaluate(`document.getElementById('studioNotices')?.textContent`);
    if (label !== i18n[lang].navThirdPartyNotices) fail('third-party notices label in ' + lang + ': ' + JSON.stringify(label));
  }
  await runNoticesLinkSmoke({ send, sendTo, evaluate, fail });
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
  // The probe uses the stack the page itself resolves. Loading "Fusion Pixel
  // SC" by name would fetch the full face and hide a gap in a UI subset.
  for (const [lang, label, expected] of [
    ['zh', '负片裁切颜色 批量照片', [LATIN_POSTSCRIPT, UI_POSTSCRIPT.sc]], ['en', 'Negative Converter RGB 123', [LATIN_POSTSCRIPT]],
    ['ja', '写真の色を調整 カーブ', [UI_POSTSCRIPT.jp]], ['ko', '사진 색상 조정', null], ['zh-Hant', '負片裁切顏色 批量照片', null]
  ]) {
    await evaluate(`(async()=>{
      document.documentElement.lang=${JSON.stringify(lang)};
      document.getElementById('fontProbe')?.remove();
      const probe=document.createElement('div'); probe.id='fontProbe';probe.textContent=${JSON.stringify(label)};
      probe.style.cssText='position:fixed;left:20px;top:150px;font-size:24px;background:#242424;color:white;padding:16px;z-index:50';
      document.body.append(probe);
      probe.getBoundingClientRect();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await document.fonts.ready;
    })()`);
    const fonts = await platformFonts(send, '#fontProbe');
    if (!fonts.length || fonts.some(font => !font.isCustomFont
        || !(font.familyName.toLowerCase().includes('fusion') || font.postScriptName === LATIN_POSTSCRIPT))) fail('pixel font fallback: '+lang+' '+JSON.stringify(fonts));
    if (expected && fonts.map(font => font.postScriptName).sort().join() !== [...expected].sort().join()) {
      fail('UI subset not used: '+lang+' expected '+expected.join('+')+' '+JSON.stringify(fonts));
    }
    console.log('ok: actual pixel glyphs', lang, JSON.stringify(fonts.map(f=>({family:f.familyName,postScript:f.postScriptName,glyphs:f.glyphCount}))));
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
  await runRenderedUiFontSmoke({ send, evaluate, waitFor, fail, port, root });
}

// The RAW decoder's licence notices (LibRaw's CDDL-1.0, musl, libomp): the
// menu entry opens them in a new tab, so the session stays, and that tab shows
// the file. Its label follows a language switch. The page is on ja here.
async function runNoticesLinkSmoke({ send, sendTo, evaluate, fail }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const link = await evaluate(`(async () => {
    document.getElementById('studioMenu').open = true;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const link = document.getElementById('studioNotices');
    const box = link.getBoundingClientRect();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    return { href: link.href, target: link.target, x, y, width: box.width, visible: link.checkVisibility(),
      inMenu: !!link.closest('#studioMenu[open] .studio-menu-content'), hit: link.contains(document.elementFromPoint(x, y)), app: location.href };
  })()`);
  if (!link.visible || !link.inMenu || !link.hit || link.width < 20 || link.target !== '_blank' || !link.href.endsWith('/licenses/raw-decoder-notices.txt')) {
    fail('third-party notices link not usable in the open menu: ' + JSON.stringify(link));
  }
  const pages = async () => (await sendTo(undefined, 'Target.getTargets')).result?.targetInfos?.filter(info => info.type === 'page') || [];
  const known = new Set((await pages()).map(info => info.targetId));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x: link.x, y: link.y, button: 'left', clickCount: 1 });
  }
  let tab = null;
  for (let i = 0; i < 40 && !tab; i++) {
    tab = (await pages()).find(info => !known.has(info.targetId) && info.url === link.href) || null;
    if (!tab) await wait(250);
  }
  if (!tab) fail('clicking the third-party notices link opened no tab with ' + link.href);
  // The tab starts on about:blank: read it once it shows the notices' URL.
  let shown = '', seen = '';
  const sessionId = (await sendTo(undefined, 'Target.attachToTarget', { targetId: tab.targetId, flatten: true })).result?.sessionId;
  for (let i = 0; i < 40 && sessionId && !shown; i++) {
    const response = await sendTo(sessionId, 'Runtime.evaluate', { returnByValue: true,
      expression: `[location.href, document.readyState, document.contentType, document.body?.innerText || ''].join('\\n')` });
    seen = response.result?.result?.value || '';
    const [href, readyState, ...rest] = seen.split('\n');
    if (href === link.href && readyState === 'complete') shown = rest.join('\n');
    else await wait(250);
  }
  if (sessionId) await sendTo(undefined, 'Target.detachFromTarget', { sessionId });
  await sendTo(undefined, 'Target.closeTarget', { targetId: tab.targetId });
  if (!shown.startsWith('text/plain\n') || !['RAW decoder notices', 'COMMON DEVELOPMENT AND DISTRIBUTION LICENSE', 'https://github.com/LibRaw/LibRaw', 'Arm Limited', 'Sun Microsystems'].every(text => shown.includes(text))) {
    fail('the third-party notices tab does not show the notices: ' + JSON.stringify(seen.slice(0, 300)));
  }
  if (await evaluate(`location.href`) !== link.app || !await evaluate(`!!document.getElementById('studioBasic')`)) fail('opening the third-party notices left the app');
  // A language switch relabels it; the remembered language is put back.
  const relabelled = await evaluate(`(() => {
    const stored = localStorage.getItem('nc_lang_v1');
    document.querySelector('.lang-btn[data-lang="zh"]').click();
    const label = document.getElementById('studioNotices').textContent;
    document.querySelector('.lang-btn[data-lang="ja"]').click();
    if (stored === null) localStorage.removeItem('nc_lang_v1'); else localStorage.setItem('nc_lang_v1', stored);
    document.getElementById('studioMenu').open = false;
    return label;
  })()`);
  if (relabelled !== i18n.zh.navThirdPartyNotices) fail('third-party notices label after switching to zh: ' + JSON.stringify(relabelled));
  console.log('ok: the Studio menu opens the third-party notices in a new tab (' + shown.length + ' characters of text/plain), labelled in zh, en and ja');
}

async function platformFonts(send, selector) {
  const doc = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
  if (!node.result?.nodeId) return null;
  const result = await send('CSS.getPlatformFontsForNode', { nodeId: node.result.nodeId });
  return result.result?.fonts || [];
}

// Everything the Studio draws in en, zh and ja, with a photo loaded, every
// pane shown and the menu open, must lie in the UI subsets it is served from
// (or be − / ≠, which no face has and monospace draws); no full 0.66 MB face
// may be requested, and ja must never fetch an SC file (#262). This reads
// rendered text, so it also catches UI strings the static glyph scan misses.
async function runRenderedUiFontSmoke({ send, evaluate, waitFor, fail, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  // The dev server's modules overflow the default 250-entry resource buffer,
  // and a memory-cache hit from an earlier scenario would leave no entry.
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'performance.setResourceTimingBufferSize(100000)' });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // Which @font-face rules this document actually used, independent of caching.
  const usedFaces = `[...document.fonts].filter(face => face.status !== 'unloaded').map(face => face.family.trim().replace(/^["']|["']$/g, ''))`;
  const fontRequests = `performance.getEntriesByType('resource').filter(entry => /(nc-studio-latin|fusion-pixel)[^/]*\\.woff2(\\?|$)/.test(entry.name))
    .map(entry => ({ file: decodeURIComponent(new URL(entry.name).pathname.split('/').pop()), bytes: entry.encodedBodySize || entry.decodedBodySize }))`;
  const settle = `document.body.getBoundingClientRect();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await document.fonts.ready;`;
  try {
    // zh last: the page is left in the language the scenario used to end with.
    for (const lang of ['en', 'ja', 'zh']) {
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=${lang}` });
      await waitFor('studio ' + lang, `!!document.getElementById('studioBasic') && document.documentElement.lang === ${JSON.stringify(lang)}`);
      const { requests: cold, faces: coldFaces } = await evaluate(`(async () => { ${settle} return { requests: ${fontRequests}, faces: ${usedFaces} }; })()`);
      if (cold.some(request => FULL_FACE_FILE.test(request.file)) || coldFaces.some(family => FULL_FAMILIES.includes(family))) {
        fail('cold ' + lang + ' load requested a full face: ' + JSON.stringify({ cold, coldFaces }));
      }
      const coldBytes = cold.reduce((sum, request) => sum + request.bytes, 0);
      if (lang !== 'en' && coldBytes > COLD_UI_FONT_BUDGET) fail('cold ' + lang + ' UI fonts exceed 50 KB: ' + JSON.stringify(cold));
      // en draws only Latin until the menu opens. At 4fdd9db the closed menu
      // still laid out its 中文/日本語 buttons, so a cold en load fetched both
      // CJK subsets; en has no byte budget that would catch that.
      if (lang === 'en' && (!cold.length || cold.some(request => !request.file.startsWith('nc-studio-latin'))
          || coldFaces.some(family => family !== 'NC Studio Latin' && [...UI_FAMILIES, ...FULL_FAMILIES].includes(family)))) {
        fail('cold en load fetched more than NC Studio Latin: ' + JSON.stringify({ cold, coldFaces }));
      }
      // The welcome text; its language-tagged discovery links use system-ui on purpose.
      for (const selector of ['.studio-welcome h1', '.studio-welcome p']) {
        const fonts = await platformFonts(send, selector);
        if (!fonts?.length) fail('welcome text not rendered: ' + lang + ' ' + selector);
        checkPixelFonts(fail, lang + ' ' + selector, fonts, await evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`));
      }

      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
      await waitFor('photo ready ' + lang, `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 150_000);
      const report = await evaluate(`(async () => {
        const fallback = ${JSON.stringify(FALLBACK_CODE_POINTS)};
        const uiFamilies = ${JSON.stringify(UI_FAMILIES)};
        const unquote = family => family.trim().replace(/^["']|["']$/g, '');
        const parseRange = value => value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
          const [first, last = first] = part.replace(/^U\\+/i, '').split('-');
          return [parseInt(first, 16), parseInt(last, 16)];
        });
        const served = new Map();
        for (const face of document.fonts) {
          const family = unquote(face.family);
          if (uiFamilies.includes(family)) served.set(family, [...(served.get(family) || []), ...parseRange(face.unicodeRange)]);
        }
        // A roll-outlier badge exactly as the file list draws it (the fixture is no outlier).
        const { i18n } = await import('/src/app/i18n.js');
        const badge = document.createElement('span');
        badge.className = 'file-list-badge roll-outlier';
        badge.textContent = (i18n[document.documentElement.lang] || i18n.en).rollOutlierBadge;
        (document.querySelector('#fileListItems .file-list-name') || document.getElementById('controlsPanel')).append(badge);
        const outside = new Map();
        let scanned = 0;
        const describe = element => element.id ? '#' + element.id : element.tagName.toLowerCase() + [...element.classList].map(name => '.' + name).join('');
        const visit = (text, style, where) => {
          const ui = style.fontFamily.split(',').map(unquote).filter(family => served.has(family));
          if (!ui.length) return; // system-ui links, Inter contact sheets: not the pixel UI font
          const ranges = ui.flatMap(family => served.get(family));
          for (const char of text) {
            const code = char.codePointAt(0);
            if (code < 0x20 || (code >= 0x7f && code < 0xa0) || fallback.includes(code)) continue;
            scanned++;
            if (!ranges.some(([first, last]) => code >= first && code <= last) && !outside.has(char)) outside.set(char, where + ' [' + ui.join(', ') + ']');
          }
        };
        const scan = () => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let node; (node = walker.nextNode());) {
            const element = node.parentElement;
            if (!element || !node.data.trim() || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName) || !element.checkVisibility()) continue;
            visit(node.data, getComputedStyle(element), describe(element));
          }
          for (const element of document.body.querySelectorAll('*')) {
            if (!element.checkVisibility()) continue;
            for (const pseudo of ['::before', '::after']) {
              const style = getComputedStyle(element, pseudo);
              if (style.display === 'none' || !style.content || style.content === 'none' || style.content === 'normal') continue;
              const strings = [...style.content.matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map(match => match[1].replace(/\\\\(.)/g, '$1'));
              visit(strings.join(''), style, describe(element) + pseudo);
            }
            if ((element.tagName === 'INPUT' && ['text', 'search', 'number'].includes(element.type)) || element.tagName === 'TEXTAREA') {
              visit(element.value || element.placeholder || '', getComputedStyle(element), describe(element));
            }
            if (element.tagName === 'SELECT' && element.selectedOptions[0]) visit(element.selectedOptions[0].text, getComputedStyle(element), describe(element));
          }
        };
        const tabs = ['edit', 'composition', 'repair', 'border', 'conversion']
          .map(key => document.getElementById('studioTab-' + key)).filter(tab => tab?.checkVisibility());
        for (const tab of tabs) { tab.click(); ${settle} scan(); }
        document.getElementById('studioTab-edit')?.click();
        // Last: a click outside the menu closes it.
        document.getElementById('studioMenu').open = true;
        ${settle}
        scan();
        return { outside: [...outside].slice(0, 20), scanned, served: [...served.keys()], tabs: tabs.length,
          console: !!document.getElementById('consoleSection')?.checkVisibility(), requests: ${fontRequests}, faces: ${usedFaces} };
      })()`);
      if (!report.console || report.tabs < 2) fail('rendered-text check: console or panes not shown ' + JSON.stringify(report));
      if (UI_FAMILIES.some(family => !report.served.includes(family)) || report.scanned < 200) {
        fail('rendered-text check: UI subsets not served or nothing scanned ' + JSON.stringify(report));
      }
      if (report.outside.length) fail('UI text outside the served UI font ranges (' + lang + '): ' + JSON.stringify(report.outside));
      if (report.requests.some(request => FULL_FACE_FILE.test(request.file)) || report.faces.some(family => FULL_FAMILIES.includes(family))) {
        fail(lang + ' requested a full face after an import: ' + JSON.stringify({ requests: report.requests, faces: report.faces }));
      }
      if (lang === 'ja' && (report.requests.some(request => /fusion-pixel-sc-ui/.test(request.file)) || report.faces.includes('Fusion Pixel SC UI'))) {
        fail('ja requested an SC file: ' + JSON.stringify({ requests: report.requests, faces: report.faces }));
      }
      for (const selector of ['#studioMenu > summary', '#studioLanguages', '#consoleSection', '#controlsPanel .studio-tabs', '#zoomOutBtn']) {
        const fonts = await platformFonts(send, selector);
        if (fonts) checkPixelFonts(fail, lang + ' ' + selector, fonts, await evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent || ''`));
      }
      await evaluate(`document.getElementById('studioMenu').open = false`);
      console.log('ok: ui fonts', lang, `cold ${coldBytes} B`, JSON.stringify(report.faces), JSON.stringify(report.requests.map(request => request.file)),
        `${report.scanned} rendered characters in ${report.served.join(' + ')}`);
    }
  } finally {
    await send('Network.setCacheDisabled', { cacheDisabled: false });
    await send('Network.disable');
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.result.identifier });
  }
}

// Only custom pixel faces, except system monospace for − and ≠, which no
// Fusion Pixel face has (as at HEAD); it may draw at most those characters.
function checkPixelFonts(fail, label, fonts, text) {
  if (!fonts?.length) return;
  const fallbackChars = [...text].filter(char => FALLBACK_CODE_POINTS.includes(char.codePointAt(0))).length;
  const system = fonts.filter(font => !font.isCustomFont);
  const glyphs = system.reduce((sum, font) => sum + font.glyphCount, 0);
  if (fonts.some(font => font.isCustomFont && !/fusion/i.test(font.familyName) && font.postScriptName !== LATIN_POSTSCRIPT)
      || (system.length && glyphs > fallbackChars)) {
    fail('non-pixel font in ' + label + ': ' + JSON.stringify(fonts));
  }
}
