import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Exercise the actual keyboard handler without a browser-only DOM package or
// exposing a test-only API from the application module.
const source = readFileSync(new URL('./fileListView.js', import.meta.url), 'utf8');
const { installKeyboardNavigation, renderFileList } = await import('data:text/javascript;base64,'
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

// A deliberately small DOM fixture for the real renderer. Moving an attached
// focused row drops focus, as insertBefore can in browsers, so restoration is
// exercised rather than hidden by an always-preserved mock activeElement.
function rendererFixture() {
  let created = 0;
  const focusCalls = [], srcWrites = [];
  class Element {
    constructor(tag) {
      created++;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.attributes = new Map();
      this.events = new Map();
      this.className = '';
      this.scrollLeft = 0;
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
        toggle: (name, enabled) => {
          if (enabled) this.classList.add(name);
          else this.className = this.className.split(/\s+/).filter(value => value !== name).join(' ');
        },
      };
    }
    get firstElementChild() { return this.children[0] || null; }
    get nextElementSibling() {
      return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null;
    }
    set src(value) { srcWrites.push([this, value]); this.setAttribute('src', value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    remove() {
      if (!this.parentElement) return;
      if (this.contains(document.activeElement)) document.activeElement = null;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null;
    }
    insertBefore(node, before) {
      if (node === before) return;
      node.remove();
      const index = before === null ? this.children.length : this.children.indexOf(before);
      assert.ok(index >= 0, 'insertBefore reference must belong to its parent');
      this.children.splice(index, 0, node);
      node.parentElement = this;
    }
    append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
    prepend(node) { this.insertBefore(node, this.firstElementChild); }
    replaceWith(node) { this.parentElement.insertBefore(node, this); this.remove(); }
    addEventListener(name, listener) {
      assert.ok(!this.events.has(name), `duplicate ${name} handler`);
      this.events.set(name, listener);
    }
    matches(selector) {
      const match = /^\.([\w-]+)(?:\[data-index="(\d+)"\])?$/.exec(selector);
      return match ? this.classList.contains(match[1]) && (match[2] === undefined || this.dataset.index === match[2])
        : this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      return this.children.flatMap(child => [
        ...(selectors.some(value => child.matches(value)) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus(options) { focusCalls.push([this, options]); document.activeElement = this; }
  }
  const body = new Element('body');
  body.className = 'studio';
  globalThis.document = { body, activeElement: null, createElement: tag => new Element(tag) };
  return { container: new Element('div'), countEl: new Element('span'), focusCalls, srcWrites, created: () => created };
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

  const dom = rendererFixture();
  const items = [
    { file: { name: 'photo10.png' }, thumbnail: 'blob:settled-preview', selected: false, status: 'done' },
    { file: { name: 'photo2.png' }, selected: true, settings: { exposure: 1 }, status: 'pending' },
    { file: { name: 'photo1.png' }, selected: true, isDirty: true, status: 'pending' },
  ];
  const labels = {
    customSettings: 'Custom', unsaved: 'Unsaved', configured: 'configured', markReviewed: 'Reviewed',
    statusText: status => status, selectFile: name => `Select ${name}`, canReview: () => true,
  };
  const calls = [];
  const options = {
    ...dom, items, labels, currentFileIndex: 1,
    onOpenFile: index => calls.push(['old-open', index]),
    onToggleSelected: (...args) => calls.push(['old-select', ...args]),
    onMarkReviewed: index => calls.push(['old-review', index]),
  };
  assert.deepEqual(renderFileList(options), { selectedCount: 2, settingsCount: 1 });
  const originalRows = [...dom.container.children];
  const originalButtons = originalRows.map(row => row.querySelector('.file-list-name'));
  const originalCheckboxes = originalRows.map(row => row.querySelector('.file-list-checkbox'));
  const originalImage = originalRows[0].querySelector('.file-list-thumbnail');
  const settledNodeCount = dom.created();
  dom.container.scrollLeft = 127;
  document.activeElement = originalButtons[2];
  const reordered = {
    ...options, order: [2, 0, 1],
    onOpenFile: index => calls.push(['open', index]),
    onToggleSelected: (...args) => calls.push(['select', ...args]),
    onMarkReviewed: index => calls.push(['review', index]),
  };
  assert.deepEqual(renderFileList(reordered), { selectedCount: 2, settingsCount: 1 });
  assert.deepEqual(dom.container.children, [originalRows[2], originalRows[0], originalRows[1]]);
  assert.equal(dom.created(), settledNodeCount, 'sorting reuses every settled row and control');
  assert.equal(originalRows[0].querySelector('.file-list-thumbnail'), originalImage);
  assert.equal(dom.srcWrites.length, 1, 'sorting never restarts a settled thumbnail request');
  assert.equal(dom.container.scrollLeft, 127);
  assert.equal(document.activeElement, originalButtons[2], 'focus follows the original photo, not its former position');
  assert.deepEqual(dom.focusCalls, [[originalButtons[2], { preventScroll: true }]]);
  assert.equal(originalRows[2].querySelector('.file-list-placeholder').textContent, '01');
  assert.equal(originalRows[1].querySelector('.file-list-placeholder').textContent, '03');
  for (let index = 0; index < items.length; index++) {
    assert.equal(originalButtons[index].dataset.index, String(index));
    assert.equal(originalCheckboxes[index].dataset.index, String(index));
    assert.equal(originalCheckboxes[index].checked, items[index].selected);
    assert.equal(originalRows[index].classList.contains('active'), index === 1);
    assert.equal(originalButtons[index].getAttribute('aria-current'), index === 1 ? 'true' : null);
  }
  originalRows[2].events.get('click')({ target: originalButtons[2] });
  originalCheckboxes[2].checked = false;
  let stopped = false;
  originalCheckboxes[2].events.get('click')({
    target: originalCheckboxes[2], shiftKey: true, stopPropagation() { stopped = true; },
  });
  originalRows[2].querySelector('.file-review-menu').querySelector('button').events.get('click')();
  assert.ok(stopped);
  assert.deepEqual(calls, [['open', 2], ['select', 2, false, { range: true }], ['review', 2]],
    'reused handlers call the latest callbacks with original source indices');

  items[1].selected = false;
  renderFileList({ ...reordered, currentFileIndex: 2 });
  assert.equal(originalCheckboxes[1].checked, false);
  assert.equal(originalRows[1].classList.contains('active'), false);
  assert.equal(originalButtons[1].getAttribute('aria-current'), null);
  assert.equal(originalRows[2].classList.contains('active'), true);
  assert.equal(originalButtons[2].getAttribute('aria-current'), 'true');
  assert.equal(dom.countEl.textContent, '1/3 (1 configured)');

  assert.deepEqual(renderFileList({ ...reordered, visible: item => item !== items[0] }), { selectedCount: 1, settingsCount: 1 });
  assert.deepEqual(dom.container.children, [originalRows[2], originalRows[1]], 'filtering preserves relative sorted order');
  assert.equal(dom.created(), settledNodeCount);
  renderFileList({ ...reordered, order: [1, 2, 0] });
  assert.deepEqual(dom.container.children, [originalRows[1], originalRows[2], originalRows[0]],
    'unfiltering reattaches the same cached row');
  assert.equal(originalRows[1].querySelector('.file-list-placeholder').textContent, '01');
  assert.equal(originalRows[2].querySelector('.file-list-placeholder').textContent, '02');
  assert.equal(dom.srcWrites.length, 1);
  assert.equal(dom.created(), settledNodeCount);
  console.log('fileListView: sorting reuses rows/thumbnails, keeps original-index callbacks and active/selected state, and restores focus without scrolling');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}
