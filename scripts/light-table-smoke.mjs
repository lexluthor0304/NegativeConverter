// Light table smoke: the film strip toggles into a thumbnail grid, the grid
// row grows, arrow keys move between tiles, badges stay visible, and the strip
// view comes back. Uses the same three synthetic strips as the roll smoke.
import { join } from 'node:path';

export async function runLightTableSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['negative-strip-dx.png', 'negative-strip-dx-dark.png', 'negative-strip-other.png', 'negative-plain.png']
    .map((name) => join(root, 'negative2positive', 'test-fixtures', name));

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('light table workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('studioToggleLightTable')`);
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

  console.log('ok: light table toggles the strip into a larger grid with badges and thumbnails, arrow keys move between tiles, and the strip view returns');
}
