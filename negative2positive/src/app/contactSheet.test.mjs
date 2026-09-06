// Standalone Node test for contactSheet.js - run with:
// node negative2positive/src/app/contactSheet.test.mjs

import assert from 'node:assert/strict';
import {
  CONTACT_SHEET_PAGES, CONTACT_SHEET_LAYOUTS, layoutContactSheet, pagesFor, fitInto, contactSheetHeader,
  renderContactSheetPage, normalizeLayoutId, normalizePageId
} from './contactSheet.js';

// 36 frames of 35mm fill one A4 page in a 6 × 6 grid inside the margins.
{
  const sheet = layoutContactSheet({ pageId: 'a4', layoutId: '35mm', count: 36 });
  assert.equal(sheet.cells.length, 36);
  assert.equal(sheet.pageCount, 1);
  assert.deepEqual(sheet.page, CONTACT_SHEET_PAGES.a4);
  const first = sheet.cells[0]; const last = sheet.cells[35];
  assert.ok(first.x >= sheet.header.x && first.y >= sheet.header.y + sheet.header.height, 'grid starts below the header');
  assert.ok(last.x + last.width <= sheet.page.width - sheet.header.x + 1, 'grid stays inside the right margin');
  assert.ok(last.y + last.height <= sheet.footer.y + 1, 'grid stays above the footer');
  assert.ok(Math.abs(first.frame.width / first.frame.height - 1.5) < 0.02, '35mm frames keep 3:2');
  assert.ok(first.caption.y >= first.frame.y + first.frame.height, 'caption sits under the frame');
  const columns = new Set(sheet.cells.map((c) => c.x)).size;
  const rows = new Set(sheet.cells.map((c) => c.y)).size;
  assert.equal(columns, 6); assert.equal(rows, 6);
  // No two cells overlap.
  for (let i = 1; i < sheet.cells.length; i++) {
    const a = sheet.cells[i - 1]; const b = sheet.cells[i];
    assert.ok(b.x >= a.x + a.width || b.y >= a.y + a.height, `cells ${i - 1} and ${i} overlap`);
  }
}

// More frames than a page holds spill onto further pages, in roll order.
{
  assert.equal(pagesFor(37, '35mm'), 2);
  assert.equal(pagesFor(12, '120-6x6'), 1);
  assert.equal(pagesFor(0, '35mm'), 1);
  const second = layoutContactSheet({ layoutId: '35mm', count: 40, pageIndex: 1 });
  assert.equal(second.cells.length, 4);
  assert.equal(second.cells[0].index, 36);
  assert.equal(second.pageCount, 2);
}

// Every layout fits its page, on Letter too.
for (const [layoutId, layout] of Object.entries(CONTACT_SHEET_LAYOUTS)) {
  for (const pageId of Object.keys(CONTACT_SHEET_PAGES)) {
    const sheet = layoutContactSheet({ pageId, layoutId, count: layout.columns * layout.rows });
    assert.equal(sheet.cells.length, layout.columns * layout.rows, `${layoutId} on ${pageId}`);
    for (const cell of sheet.cells) {
      assert.ok(cell.frame.width > 40 && cell.frame.height > 40, `${layoutId} frames are large enough on ${pageId}`);
      assert.ok(Math.abs(cell.frame.width / cell.frame.height - layout.aspect) < 0.03, `${layoutId} keeps its aspect`);
      assert.ok(cell.frame.x >= cell.x && cell.frame.x + cell.frame.width <= cell.x + cell.width + 1);
    }
  }
}

// Fitting keeps aspect and centres; header text comes from the roll metadata.
{
  const fit = fitInto(3000, 2000, { x: 100, y: 100, width: 300, height: 300 });
  assert.deepEqual(fit, { x: 100, y: 150, width: 300, height: 200 });
  assert.deepEqual(contactSheetHeader({ rollName: 'Roll 12', stock: 'Ultra Max 400', iso: '400', lab: 'Corner Lab', date: '2026-09-06' }), { title: 'Roll 12', detail: 'Ultra Max 400 · ISO 400 · Corner Lab · 2026-09-06' });
  assert.deepEqual(contactSheetHeader({ stock: 'Portra 400' }), { title: 'Portra 400', detail: '' });
  assert.deepEqual(contactSheetHeader({}), { title: 'Contact sheet', detail: '' });
  assert.equal(normalizeLayoutId('nope'), '35mm');
  assert.equal(normalizePageId('nope'), 'a4');
}

// The renderer draws every frame and caption through the context it is given.
{
  const calls = { images: 0, texts: [], rects: 0 };
  const ctx = {
    save() {}, restore() {}, fillRect() { calls.rects++; }, fillText(text) { calls.texts.push(text); }, drawImage() { calls.images++; },
    set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {}
  };
  const sheet = layoutContactSheet({ layoutId: '120-6x6', count: 3 });
  const frames = [{ image: {}, width: 600, height: 600, label: '1' }, null, { image: {}, width: 600, height: 400, label: '3' }];
  renderContactSheetPage(ctx, sheet, frames, { header: { title: 'Roll 12', detail: 'ISO 400' }, footer: 'NeoAnalogLab' });
  assert.equal(calls.images, 2, 'null frames draw no image');
  assert.ok(calls.texts.includes('Roll 12') && calls.texts.includes('ISO 400') && calls.texts.includes('1') && calls.texts.includes('3') && calls.texts.includes('NeoAnalogLab'));
  assert.equal(calls.rects, 1 + 3, 'background plus one frame box per cell');
}

console.log('contactSheet.test.mjs passed');
