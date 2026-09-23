// Light table smoke: the film strip toggles into a thumbnail grid, the grid
// row grows, arrow keys move between tiles, badges stay visible, and the strip
// view comes back. A 39-photo roll also checks the actual scrollport: measuring
// the outer row alone missed the inherited 200px cap and unused lower half.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runLightTableSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['negative-strip-dx.png', 'negative-strip-dx-dark.png', 'negative-strip-other.png', 'negative-plain.png']
    .map((name) => join(root, 'negative2positive', 'test-fixtures', name));

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('light table workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('studioToggleLightTable'))`);
  await installDialogAutoAccept();
  await wait(300);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  if (!input.result?.nodeId) fail('#fileInput not found');
  await send('DOM.setFileInputFiles', { files: fixtures, nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('light table strips imported', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png'`, 150_000);
  await waitFor('thumbnails decoded', `document.querySelectorAll('img.file-list-thumbnail').length === 4`, 30_000);

  const measure = `(() => {
    const items = document.getElementById('fileListItems');
    const strip = document.getElementById('studioFilmstrip');
    const button = document.getElementById('studioToggleLightTable');
    const tile = items.querySelector('.file-list-item');
    return {
      lightTable: document.body.classList.contains('studio-lighttable'),
      display: getComputedStyle(items).display,
      columns: getComputedStyle(items).gridTemplateColumns.split(' ').filter(Boolean).length,
      stripHeight: strip.getBoundingClientRect().height,
      tileWidth: tile.getBoundingClientRect().width,
      tileHeight: tile.getBoundingClientRect().height,
      buttonText: button.textContent,
      pressed: button.getAttribute('aria-pressed'),
      badges: document.querySelectorAll('.file-list-badge.film-stock').length,
      thumbnails: document.querySelectorAll('img.file-list-thumbnail').length
    };
  })()`;
  const strip = await evaluate(measure);
  console.log('light table strip view:', JSON.stringify(strip));
  if (strip.lightTable || strip.display !== 'flex' || strip.buttonText !== 'Light table' || strip.pressed !== 'false') fail('strip view is not the default: ' + JSON.stringify(strip));
  if (strip.badges < 1) fail('film stock badge missing on the open strip: ' + JSON.stringify(strip));

  await evaluate(`document.getElementById('studioToggleLightTable').click()`);
  await wait(600);
  const grid = await evaluate(measure);
  console.log('light table grid view:', JSON.stringify(grid));
  if (!grid.lightTable || grid.display !== 'grid' || grid.buttonText !== 'Film strip' || grid.pressed !== 'true') fail('light table did not switch on: ' + JSON.stringify(grid));
  if (grid.columns < 4) fail('light table grid has too few columns for a 1440 px window: ' + JSON.stringify(grid));
  if (grid.stripHeight < strip.stripHeight + 60) fail('light table row did not grow: ' + JSON.stringify({ before: strip.stripHeight, after: grid.stripHeight }));
  if (grid.tileWidth < strip.tileWidth + 30 || grid.tileHeight < strip.tileHeight + 30) fail('light table tiles are not larger: ' + JSON.stringify(grid));
  if (grid.badges < 1 || grid.thumbnails !== 4) fail('badges or thumbnails lost in the grid: ' + JSON.stringify(grid));

  // Keyboard: focus the first tile, ArrowRight moves to the second, End to the last, Home back.
  const keyboard = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.file-list-name')];
    const items = document.getElementById('fileListItems');
    const press = (key) => items.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    buttons[0].focus();
    press('ArrowRight');
    const afterRight = buttons.indexOf(document.activeElement);
    press('End');
    const afterEnd = buttons.indexOf(document.activeElement);
    press('Home');
    const afterHome = buttons.indexOf(document.activeElement);
    press('ArrowLeft');
    const afterLeftAtStart = buttons.indexOf(document.activeElement);
    return { afterRight, afterEnd, afterHome, afterLeftAtStart, count: buttons.length };
  })()`);
  console.log('light table keyboard:', JSON.stringify(keyboard));
  if (keyboard.afterRight !== 1 || keyboard.afterEnd !== keyboard.count - 1 || keyboard.afterHome !== 0 || keyboard.afterLeftAtStart !== 0) fail('arrow key navigation failed: ' + JSON.stringify(keyboard));

  // Hiding the strip and turning the light table on again brings the strip back.
  await evaluate(`document.getElementById('studioToggleStrip').click()`);
  await wait(300);
  const hidden = await evaluate(`document.body.classList.contains('studio-strip-hidden')`);
  if (!hidden) fail('strip toggle stopped working with the light table on');
  await evaluate(`document.getElementById('studioToggleLightTable').click(); document.getElementById('studioToggleLightTable').click();`);
  await wait(400);
  const restored = await evaluate(measure);
  if (!restored.lightTable) fail('light table did not re-enable: ' + JSON.stringify(restored));
  const stripShown = await evaluate(`!document.body.classList.contains('studio-strip-hidden')`);
  if (!stripShown) fail('turning the light table on did not show the hidden strip');

  await evaluate(`document.getElementById('studioToggleLightTable').click()`);
  await wait(400);
  const back = await evaluate(measure);
  if (back.lightTable || back.display !== 'flex') fail('strip view did not come back: ' + JSON.stringify(back));

  // Import real, small files through the same input as a 39-frame roll. Keep
  // layout coverage independent of RAW decode cost; the existing photo-session
  // smoke checks the canonical thumbnail pixels and whole-roll regeneration.
  await evaluate(`(async () => {
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const input = document.getElementById(id); if (input?.checked) input.click();
    }
    const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 160;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 240, 160);
    gradient.addColorStop(0, '#d09165'); gradient.addColorStop(1, '#36241c');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 240, 160);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const transfer = new DataTransfer();
    for (let index = 1; index <= 39; index++) {
      transfer.items.add(new File([blob], 'light-table-' + String(index).padStart(2, '0') + '.png', { type: 'image/png', lastModified: index }));
    }
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('39 light-table photos imported', `${ready} && document.getElementById('studioFilename').textContent === 'light-table-01.png' && document.querySelectorAll('#fileListItems .file-list-item').length === 39`, 120_000);
  await waitFor('39 light-table thumbnails ready', `document.querySelectorAll('#fileListItems .file-list-thumbnail').length === 39 && [...document.querySelectorAll('#fileListItems .file-list-thumbnail')].every(img => img.complete && img.naturalWidth > 0) && !document.querySelector('#fileListItems .file-list-placeholder')`, 120_000);
  await evaluate(`document.getElementById('studioToggleLightTable').click()`);

  const fillMeasure = `(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const strip = document.getElementById('studioFilmstrip');
    const header = strip.querySelector('.studio-strip-header');
    const section = document.getElementById('fileListSection');
    const items = document.getElementById('fileListItems');
    const stripRect = strip.getBoundingClientRect(), headerRect = header.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect(), itemsRect = items.getBoundingClientRect();
    const stripStyle = getComputedStyle(strip), sectionStyle = getComputedStyle(section);
    const itemsStyle = getComputedStyle(items);
    const tiles = [...items.querySelectorAll('.file-list-item')];
    const firstRect = tiles[0].getBoundingClientRect();
    const bottom = stripRect.bottom - parseFloat(stripStyle.paddingBottom) - parseFloat(stripStyle.borderBottomWidth);
    const top = headerRect.bottom + parseFloat(sectionStyle.marginTop);
    return {
      width: innerWidth, height: innerHeight, count: tiles.length,
      panelHidden: document.body.classList.contains('studio-panel-hidden'),
      display: itemsStyle.display, maxHeight: sectionStyle.maxHeight,
      position: sectionStyle.position, sectionOverflow: sectionStyle.overflowY,
      itemsOverflow: itemsStyle.overflowY, stripHeight: stripRect.height,
      availableHeight: bottom - top, itemsHeight: itemsRect.height,
      bottomGap: bottom - itemsRect.bottom, headerOverlap: top - itemsRect.top,
      sectionHeight: sectionRect.height, sectionScrollHeight: section.scrollHeight,
      itemsClientHeight: items.clientHeight, itemsScrollHeight: items.scrollHeight,
      itemsClientWidth: items.clientWidth, itemsScrollWidth: items.scrollWidth,
      tileWidth: firstRect.width, tileHeight: firstRect.height,
      columnWidth: parseFloat(itemsStyle.gridTemplateColumns),
      lowerAreaHasTiles: tiles.some(tile => {
        const rect = tile.getBoundingClientRect();
        return rect.bottom > itemsRect.top + itemsRect.height * .75 && rect.top < itemsRect.bottom;
      }),
      withinViewport: itemsRect.top >= 0 && itemsRect.bottom <= innerHeight + 1,
    };
  })()`;
  const assertFilledGrid = async label => {
    const result = await evaluate(fillMeasure);
    console.log('light table 39-photo layout ' + label + ':', JSON.stringify(result));
    if (result.count !== 39 || result.display !== 'grid'
      || result.maxHeight !== 'none' || result.position !== 'static'
      || result.sectionOverflow !== 'hidden' || result.itemsOverflow !== 'auto'
      || Math.abs(result.bottomGap) > 1 || Math.abs(result.headerOverlap) > 1
      || Math.abs(result.itemsHeight - result.availableHeight) > 1
      || result.sectionScrollHeight > result.sectionHeight + 1
      || result.itemsScrollHeight <= result.itemsClientHeight
      || result.itemsScrollWidth > result.itemsClientWidth + 1
      || Math.abs(result.tileWidth - result.columnWidth) > 1
      || result.tileHeight !== (result.width <= 700 ? 100 : 122)
      || !result.lowerAreaHasTiles || !result.withinViewport) {
      fail('light table leaves unused space, clips tiles or has nested scrolling at ' + label + ': ' + JSON.stringify(result));
    }
    // Reach the last frame through actual keyboard navigation, not a test-only
    // scrollTop assignment. It must fit inside both the list and the viewport.
    await evaluate(`(() => {
      const items = document.getElementById('fileListItems');
      items.querySelector('.file-list-name').focus();
      items.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    })()`);
    const lastVisible = await waitFor('last light-table tile visible at ' + label, `(() => {
      const items = document.getElementById('fileListItems');
      const section = document.getElementById('fileListSection');
      const last = items.querySelector('.file-list-item:last-child');
      const rect = last.getBoundingClientRect(), viewport = items.getBoundingClientRect();
      return last.contains(document.activeElement) && items.scrollTop > 0 && section.scrollTop === 0
        && rect.top >= Math.max(0, viewport.top) - 1 && rect.bottom <= Math.min(innerHeight, viewport.bottom) + 1;
    })()`, 10_000, { soft: true });
    const scrollState = await evaluate(`(() => {
      const items = document.getElementById('fileListItems');
      const section = document.getElementById('fileListSection');
      const tiles = [...items.querySelectorAll('.file-list-item')];
      const last = tiles.at(-1), button = last.querySelector('.file-list-name');
      const bounds = element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
      };
      const ancestors = [];
      for (let node = items; node; node = node.parentElement) {
        ancestors.push({ id: node.id, tag: node.tagName, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, overflow: getComputedStyle(node).overflowY, bounds: bounds(node) });
      }
      return { activeIndex: tiles.findIndex(tile => tile.contains(document.activeElement)), activeClass: document.activeElement?.className,
        itemScrollTop: items.scrollTop, sectionScrollTop: section.scrollTop,
        viewportHeight: innerHeight, lastTile: bounds(last), lastButton: bounds(button), list: bounds(items), ancestors };
    })()`);
    console.log('light table final tile ' + label + ':', JSON.stringify(scrollState));
    if (!lastVisible) fail('last light-table tile is not fully visible at ' + label + ': ' + JSON.stringify(scrollState));
    await evaluate(`document.getElementById('fileListItems').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
    await waitFor('first light-table row restored at ' + label, `document.getElementById('fileListItems').scrollTop <= 1`, 10_000);
  };

  const evidenceDir = join(root, 'output', 'playwright');
  mkdirSync(evidenceDir, { recursive: true });
  try {
    for (const [width, height] of [[2048, 1166], [1440, 900], [390, 844], [320, 844], [844, 390]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 700 });
      const label = width + 'x' + height;
      await assertFilledGrid(label);
      if (width === 2048 || width === 390) {
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(evidenceDir, 'light-table-39-' + label + '.png'), Buffer.from(shot.result.data, 'base64'));
      }
      await evaluate(`document.getElementById('studioTogglePanel').click()`);
      await assertFilledGrid(label + ' panel hidden');
      await evaluate(`document.getElementById('studioTogglePanel').click()`);
      await assertFilledGrid(label + ' panel restored');
      await evaluate(`document.getElementById('studioToggleLightTable').click()`);
      const compact = await evaluate(measure);
      if (compact.display !== 'flex' || compact.tileWidth !== (width <= 700 ? 88 : 100)
        || compact.tileHeight !== (width <= 700 ? 63 : 72)) {
        fail('compact strip dimensions changed at ' + label + ': ' + JSON.stringify(compact));
      }
      await evaluate(`document.getElementById('studioToggleLightTable').click()`);
      await assertFilledGrid(label + ' grid restored');
    }
  } finally {
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }

  // A new session keeps the user's light-table preference. Cancelling its
  // picker must still leave the empty welcome screen, not a ghost grid row.
  await evaluate(`(() => {
    const input = document.getElementById('fileInput');
    const original = Object.getOwnPropertyDescriptor(input, 'click');
    window.__lightTablePickerCancelled = false;
    input.click = () => { window.__lightTablePickerCancelled = true; };
    window.__restoreLightTablePicker = () => {
      if (original) Object.defineProperty(input, 'click', original);
      else delete input.click;
      delete window.__restoreLightTablePicker;
    };
    document.getElementById('studioNewSession').click();
  })()`);
  try {
    await waitFor('new session cancels its picker after light table', `window.__lightTablePickerCancelled && !document.body.classList.contains('studio-loaded')`, 30_000);
    const empty = await evaluate(`(() => {
      const main = document.querySelector('.app-main');
      return {
        loaded: document.body.classList.contains('studio-loaded'),
        lightTable: document.body.classList.contains('studio-lighttable'),
        stripDisplay: getComputedStyle(document.getElementById('studioFilmstrip')).display,
        itemCount: document.querySelectorAll('#fileListItems .file-list-item').length,
        rows: getComputedStyle(main).gridTemplateRows.trim().split(/\\s+/).length,
        feedbackHidden: document.getElementById('studioPhotoSwitchFeedback').hidden,
        welcomeVisible: getComputedStyle(document.getElementById('uploadPlaceholder')).display !== 'none',
      };
    })()`);
    console.log('light table empty workspace:', JSON.stringify(empty));
    if (empty.loaded || !empty.lightTable || empty.stripDisplay !== 'none' || empty.itemCount !== 0 || empty.rows !== 1
      || !empty.feedbackHidden || !empty.welcomeVisible) {
      fail('cancelled new session leaves a light-table row or stale switch feedback: ' + JSON.stringify(empty));
    }
  } finally {
    await evaluate(`window.__restoreLightTablePicker?.()`);
  }

  console.log('ok: light table fills the available height for 39 photos at five viewport sizes, the final tile is reachable, keyboard/badges/thumbnails survive and compact strip dimensions return');
}
