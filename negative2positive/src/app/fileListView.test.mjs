import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual keyboard handler without a browser-only DOM package or
// exposing a test-only API from the application module.
const source = readFileSync(new URL('./fileListView.js', import.meta.url), 'utf8');
const { installKeyboardNavigation } = await import('data:text/javascript;base64,'
  + Buffer.from(source + '\nexport { installKeyboardNavigation };').toString('base64'));
const previousDocument = globalThis.document;
globalThis.document = { activeElement: null };

function fixture({ columns = 10, count = 39, height = 464, width = 1631, tileHeight = 122, tileWidth = 154, border = 0 } = {}) {
  const events = new Map(), calls = [];
  const container = {
    dataset: {}, scrollTop: 0, scrollLeft: 0, clientTop: border, clientLeft: border,
    clientHeight: height, clientWidth: width,
    scrollHeight: Math.ceil(count / columns) * (tileHeight + 10),
    scrollWidth: columns * (tileWidth + 10) - 10,
    addEventListener(name, handler) { assert.ok(!events.has(name)); events.set(name, handler); },
    getBoundingClientRect() { return { top: 696, left: 12 }; },
    querySelectorAll() { return buttons; },
    scrollTo(options) {
      calls.push(options);
      this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, options.top));
      this.scrollLeft = Math.max(0, Math.min(this.scrollWidth - this.clientWidth, options.left));
    },
  };
  const buttons = Array.from({ length: count }, (_, index) => {
    const tile = {
      getBoundingClientRect() {
        const top = 696 + border + 4 + Math.floor(index / columns) * (tileHeight + 10) - container.scrollTop;
        const left = 12 + border + (index % columns) * (tileWidth + 10) - container.scrollLeft;
        return { top, bottom: top + tileHeight, left, right: left + tileWidth };
      },
    };
    return {
      closest(selector) { assert.equal(selector, '.file-list-item'); return tile; },
      getBoundingClientRect() { const rect = tile.getBoundingClientRect(); return { ...rect, top: rect.top + 5, bottom: rect.bottom - 5 }; },
      focus(options) { assert.deepEqual(options, { preventScroll: true }); document.activeElement = this; },
      scrollIntoView() { assert.fail('native scrollIntoView can move editor ancestors'); },
      tile,
    };
  });
  installKeyboardNavigation(container);
  installKeyboardNavigation(container); // Rendering again must not duplicate the handler.
  const press = (key, index = buttons.indexOf(document.activeElement)) => {
    document.activeElement = buttons[index];
    let prevented = false;
    events.get('keydown')({ key, preventDefault() { prevented = true; } });
    return { index: buttons.indexOf(document.activeElement), prevented };
  };
  return { container, buttons, calls, press };
}

try {
  const grid = fixture();
  assert.deepEqual(grid.press('End', 0), { index: 38, prevented: true });
  assert.equal(grid.container.scrollTop, 64, 'End reveals the final tile and list padding');
  assert.ok(grid.buttons[38].tile.getBoundingClientRect().bottom <= 696 + 464);
  assert.deepEqual(grid.press('Home'), { index: 0, prevented: true });
  assert.equal(grid.container.scrollTop, 0, 'Home restores the complete first row including padding');
  assert.deepEqual(grid.press('ArrowDown', 20), { index: 30, prevented: true });
  assert.equal(grid.container.scrollTop, 58, 'nearest scrolling includes the tile border, not the inset button');
  assert.deepEqual(grid.press('ArrowUp', 10), { index: 0, prevented: true });
  assert.equal(grid.container.scrollTop, 4, 'arrow navigation moves only enough to reveal the tile');
  const callCount = grid.calls.length;
  assert.deepEqual(grid.press('ArrowLeft', 0), { index: 0, prevented: false });
  assert.deepEqual(grid.press('ArrowRight', 38), { index: 38, prevented: false });
  assert.deepEqual(grid.press('Enter', 0), { index: 0, prevented: false });
  assert.equal(grid.calls.length, callCount, 'unsupported keys and boundary navigation do not scroll');

  const compact = fixture({ columns: 39, height: 82, width: 300, tileHeight: 72, tileWidth: 100 });
  assert.deepEqual(compact.press('ArrowRight', 1), { index: 2, prevented: true });
  assert.equal(compact.container.scrollLeft, 20, 'compact strip reveals the whole right edge');
  assert.equal(compact.container.scrollTop, 0);
  compact.press('End');
  assert.equal(compact.container.scrollLeft, compact.container.scrollWidth - compact.container.clientWidth);
  compact.press('Home');
  assert.equal(compact.container.scrollLeft, 0);

  const bordered = fixture({ border: 2 });
  bordered.press('ArrowDown', 20);
  assert.equal(bordered.container.scrollTop, 58, 'scrollport borders do not change visible content bounds');
  console.log('fileListView: keyboard navigation reveals complete grid/compact tiles, keeps scrolling local, and preserves Home/End padding');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
