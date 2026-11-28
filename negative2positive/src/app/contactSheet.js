// Contact sheet layout and rendering: a printable page of the roll with a
// header (roll name, stock, ISO, camera, lab, date), the frames in roll order
// and a frame number under each. The layout maths is pure (tested); the
// renderer draws onto any 2D context the caller provides.

// Page sizes at 300 dpi, portrait.
export const CONTACT_SHEET_PAGES = Object.freeze({
  a4: { width: 2480, height: 3508 },
  letter: { width: 2550, height: 3300 }
});

// Frame grids: columns × rows per page and the frame aspect (width / height).
export const CONTACT_SHEET_LAYOUTS = Object.freeze({
  '35mm': { columns: 6, rows: 6, aspect: 3 / 2 },
  'half-frame': { columns: 8, rows: 9, aspect: 3 / 4 },
  '120-6x6': { columns: 4, rows: 5, aspect: 1 },
  '120-6x7': { columns: 4, rows: 4, aspect: 7 / 6 },
  '120-6x9': { columns: 3, rows: 4, aspect: 3 / 2 },
  panoramic: { columns: 2, rows: 6, aspect: 65 / 24 }
});

export function normalizeLayoutId(id) {
  return Object.hasOwn(CONTACT_SHEET_LAYOUTS, id) ? id : '35mm';
}

export function normalizePageId(id) {
  return Object.hasOwn(CONTACT_SHEET_PAGES, id) ? id : 'a4';
}

export function pagesFor(count, layoutId) {
  const layout = CONTACT_SHEET_LAYOUTS[normalizeLayoutId(layoutId)];
  return Math.max(1, Math.ceil(count / (layout.columns * layout.rows)));
}

/**
 * Cells for one page. Margins, gutter, header and footer are fractions of the
 * page so A4 and Letter come out alike; each cell holds the frame box (the
 * frame aspect fitted into the cell above a caption line) and the caption.
 */
export function layoutContactSheet({ pageId = 'a4', layoutId = '35mm', count, pageIndex = 0, marginRatio = 0.06, gutterRatio = 0.014, headerRatio = 0.08, footerRatio = 0.035 } = {}) {
  const page = CONTACT_SHEET_PAGES[normalizePageId(pageId)];
  const layout = CONTACT_SHEET_LAYOUTS[normalizeLayoutId(layoutId)];
  const margin = Math.round(page.width * marginRatio);
  const gutter = Math.round(page.width * gutterRatio);
  const headerHeight = Math.round(page.height * headerRatio);
  const footerHeight = Math.round(page.height * footerRatio);
  const areaX = margin;
  const areaY = margin + headerHeight;
  const areaWidth = page.width - margin * 2;
  const areaHeight = page.height - margin * 2 - headerHeight - footerHeight;
  const cellWidth = (areaWidth - gutter * (layout.columns - 1)) / layout.columns;
  const cellHeight = (areaHeight - gutter * (layout.rows - 1)) / layout.rows;
  const captionHeight = Math.max(24, Math.round(cellHeight * 0.14));
  const perPage = layout.columns * layout.rows;
  const first = pageIndex * perPage;
  const cells = [];
  for (let i = first; i < Math.min(count, first + perPage); i++) {
    const slot = i - first;
    const column = slot % layout.columns;
    const row = Math.floor(slot / layout.columns);
    const x = areaX + column * (cellWidth + gutter);
    const y = areaY + row * (cellHeight + gutter);
    const boxHeight = cellHeight - captionHeight;
    let frameWidth = cellWidth;
    let frameHeight = frameWidth / layout.aspect;
    if (frameHeight > boxHeight) {
      frameHeight = boxHeight;
      frameWidth = frameHeight * layout.aspect;
    }
    cells.push({
      index: i,
      x: Math.round(x), y: Math.round(y), width: Math.round(cellWidth), height: Math.round(cellHeight),
      frame: {
        x: Math.round(x + (cellWidth - frameWidth) / 2),
        y: Math.round(y + (boxHeight - frameHeight) / 2),
        width: Math.round(frameWidth),
        height: Math.round(frameHeight)
      },
      caption: { x: Math.round(x), y: Math.round(y + boxHeight), width: Math.round(cellWidth), height: captionHeight }
    });
  }
  return {
    page: { ...page },
    layout: { ...layout, id: normalizeLayoutId(layoutId) },
    pageIndex,
    pageCount: pagesFor(count, layoutId),
    header: { x: margin, y: margin, width: areaWidth, height: headerHeight },
    footer: { x: margin, y: page.height - margin - footerHeight, width: areaWidth, height: footerHeight },
    cells
  };
}

// ---- Film strips --------------------------------------------------------
//
// The roll cut into strips as a lab cuts it: six frames a strip (twelve
// half-frames), each strip one length of 135 film (frames 38 mm apart, a
// 34.98 mm wide film, the cuts half-way between frames), laid out top to
// bottom at one scale that fits a strip to the page's width, left-aligned.
// A page holds as many strips as fit; the last strip of a roll is as long as
// its frames. Only 135 layouts have strips.

export const STRIP_LAYOUTS = Object.freeze({
  '35mm': { perStrip: 6, frameMm: 36, pitchMm: 38, halfFrame: false },
  'half-frame': { perStrip: 12, frameMm: 18, pitchMm: 19, halfFrame: true }
});
const FILM_WIDTH_MM = 34.98;
const PICTURE_HEIGHT_MM = 24;

export function hasStripLayout(layoutId) {
  return Object.hasOwn(STRIP_LAYOUTS, layoutId);
}

/**
 * Strips for one page: { page, header, footer, pageIndex, pageCount, scale
 * (page px per mm), perStrip, stripsPerPage, strips: [{ x, y, width, height,
 * indices }] } where each strip's box is the whole film (cuts included).
 */
export function layoutContactSheetStrips({ pageId = 'a4', layoutId = '35mm', count, pageIndex = 0, marginRatio = 0.06, headerRatio = 0.08, footerRatio = 0.035, stripGapRatio = 0.12 } = {}) {
  const page = CONTACT_SHEET_PAGES[normalizePageId(pageId)];
  const strip = STRIP_LAYOUTS[hasStripLayout(layoutId) ? layoutId : '35mm'];
  const margin = Math.round(page.width * marginRatio);
  const headerHeight = Math.round(page.height * headerRatio);
  const footerHeight = Math.round(page.height * footerRatio);
  const areaX = margin, areaY = margin + headerHeight;
  const areaWidth = page.width - margin * 2;
  const areaHeight = page.height - margin * 2 - headerHeight - footerHeight;
  const scale = areaWidth / (strip.perStrip * strip.pitchMm);
  const stripHeight = FILM_WIDTH_MM * scale;
  const gap = stripHeight * stripGapRatio;
  const stripsPerPage = Math.max(1, Math.floor((areaHeight + gap) / (stripHeight + gap)));
  const perPage = stripsPerPage * strip.perStrip;
  const total = Math.max(0, Math.floor(count) || 0);
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const strips = [];
  for (let s = 0; s < stripsPerPage; s++) {
    const first = pageIndex * perPage + s * strip.perStrip;
    if (first >= total) break;
    const indices = [];
    for (let i = first; i < Math.min(total, first + strip.perStrip); i++) indices.push(i);
    strips.push({
      x: areaX, y: Math.round(areaY + s * (stripHeight + gap)),
      width: Math.round(indices.length * strip.pitchMm * scale), height: Math.round(stripHeight),
      indices
    });
  }
  return {
    page: { ...page },
    layout: { id: hasStripLayout(layoutId) ? layoutId : '35mm', ...strip },
    pageIndex,
    pageCount,
    scale,
    perStrip: strip.perStrip,
    stripsPerPage,
    header: { x: margin, y: margin, width: areaWidth, height: headerHeight },
    footer: { x: margin, y: page.height - margin - footerHeight, width: areaWidth, height: footerHeight },
    strips
  };
}

/**
 * The size frames are rendered at for a sheet: twice their size on the page
 * (a strip is composed at twice its printed size and scaled down, so the
 * markings and perforations come out clean). For strips, the picture height
 * in pixels (24 mm) is `windowHeight`; `target` is the long side to render.
 */
export function contactSheetFrameTarget({ pageId = 'a4', layoutId = '35mm', strips = false } = {}) {
  if (strips && hasStripLayout(layoutId)) {
    const sheet = layoutContactSheetStrips({ pageId, layoutId, count: 1 });
    const windowHeight = Math.round(PICTURE_HEIGHT_MM * sheet.scale * 2);
    const windowWidth = Math.round(sheet.layout.frameMm * sheet.scale * 2);
    return { windowHeight, target: Math.max(windowHeight, windowWidth) };
  }
  const cell = layoutContactSheet({ pageId, layoutId, count: 1 }).cells[0].frame;
  return { windowHeight: null, target: Math.max(cell.width, cell.height) * 2 };
}

function drawSheetHeader(ctx, sheet, header, fontFamily, ink) {
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  const titleSize = Math.round(sheet.header.height * 0.42);
  const detailSize = Math.round(sheet.header.height * 0.22);
  ctx.font = `700 ${titleSize}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.fillText(header.title || '', sheet.header.x, sheet.header.y + titleSize);
  if (header.detail) {
    ctx.font = `400 ${detailSize}px ${fontFamily}`;
    ctx.fillText(header.detail, sheet.header.x, sheet.header.y + titleSize + Math.round(detailSize * 1.6));
  }
  if (sheet.pageCount > 1) {
    ctx.font = `400 ${detailSize}px ${fontFamily}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${sheet.pageIndex + 1} / ${sheet.pageCount}`, sheet.header.x + sheet.header.width, sheet.header.y + titleSize);
  }
}

function drawSheetFooter(ctx, sheet, footer, fontFamily, ink) {
  if (!footer) return;
  const footerSize = Math.round(sheet.footer.height * 0.45);
  ctx.font = `400 ${footerSize}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = ink;
  ctx.fillText(footer, sheet.footer.x, sheet.footer.y + Math.round(sheet.footer.height * 0.8));
}

/**
 * Draws one page of strips. `strips` are this page's strip images in order:
 * { image: CanvasImageSource, width, height } (a whole strip, composed by
 * sprocketFrame's composeFilmStripAsync), or null for a strip that failed.
 */
export function renderContactSheetStripsPage(ctx, sheet, strips, { header = { title: '', detail: '' }, footer = '', fontFamily = 'sans-serif', background = '#f3f0e8', ink = '#1c1a17' } = {}) {
  const { page } = sheet;
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, page.width, page.height);
  drawSheetHeader(ctx, sheet, header, fontFamily, ink);
  ctx.imageSmoothingEnabled = true;
  if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  sheet.strips.forEach((box, i) => {
    const strip = strips[i];
    // One scale for the whole strip: the box's width, the strip's own proportions.
    if (strip?.image) ctx.drawImage(strip.image, box.x, box.y, box.width, Math.round(strip.height * box.width / strip.width));
  });
  drawSheetFooter(ctx, sheet, footer, fontFamily, ink);
  ctx.restore();
}

/** Fits an image of `width × height` into `box`, centred, preserving aspect. */
export function fitInto(width, height, box) {
  const scale = Math.min(box.width / width, box.height / height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  return { x: Math.round(box.x + (box.width - w) / 2), y: Math.round(box.y + (box.height - h) / 2), width: w, height: h };
}

/** Header lines from the roll metadata: a title and a detail line. */
export function contactSheetHeader(roll = {}, { fallbackTitle = 'Contact sheet' } = {}) {
  const title = roll.rollName || roll.stock || fallbackTitle;
  const details = [];
  if (roll.rollName && roll.stock) details.push(roll.stock);
  if (roll.iso) details.push(`ISO ${roll.iso}`);
  if (roll.camera) details.push(roll.camera);
  if (roll.lens) details.push(roll.lens);
  if (roll.process) details.push(roll.process);
  if (roll.lab) details.push(roll.lab);
  if (roll.date) details.push(roll.date);
  return { title, detail: details.join(' · ') };
}

/**
 * Draws one page. `frames` are the images for this page's cells in order:
 * { image: CanvasImageSource, width, height, label }. `image` may be null for
 * a frame that failed to render; its cell shows the label only.
 */
export function renderContactSheetPage(ctx, sheet, frames, { header = { title: '', detail: '' }, footer = '', fontFamily = 'sans-serif', background = '#f3f0e8', ink = '#1c1a17', frameBackground = '#111111' } = {}) {
  const { page } = sheet;
  ctx.save();
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, page.width, page.height);
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  const titleSize = Math.round(sheet.header.height * 0.42);
  const detailSize = Math.round(sheet.header.height * 0.22);
  ctx.font = `700 ${titleSize}px ${fontFamily}`;
  ctx.textAlign = 'left';
  ctx.fillText(header.title || '', sheet.header.x, sheet.header.y + titleSize);
  if (header.detail) {
    ctx.font = `400 ${detailSize}px ${fontFamily}`;
    ctx.fillText(header.detail, sheet.header.x, sheet.header.y + titleSize + Math.round(detailSize * 1.6));
  }
  if (sheet.pageCount > 1) {
    ctx.font = `400 ${detailSize}px ${fontFamily}`;
    ctx.textAlign = 'right';
    ctx.fillText(`${sheet.pageIndex + 1} / ${sheet.pageCount}`, sheet.header.x + sheet.header.width, sheet.header.y + titleSize);
  }
  ctx.textAlign = 'center';
  sheet.cells.forEach((cell, i) => {
    const frame = frames[i];
    ctx.fillStyle = frameBackground;
    ctx.fillRect(cell.frame.x, cell.frame.y, cell.frame.width, cell.frame.height);
    if (frame && frame.image) {
      const fit = fitInto(frame.width, frame.height, cell.frame);
      ctx.drawImage(frame.image, fit.x, fit.y, fit.width, fit.height);
    }
    const captionSize = Math.round(cell.caption.height * 0.55);
    ctx.fillStyle = ink;
    ctx.font = `500 ${captionSize}px ${fontFamily}`;
    ctx.fillText(frame?.label || '', cell.caption.x + cell.caption.width / 2, cell.caption.y + Math.round(cell.caption.height * 0.78));
  });
  if (footer) {
    const footerSize = Math.round(sheet.footer.height * 0.45);
    ctx.font = `400 ${footerSize}px ${fontFamily}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = ink;
    ctx.fillText(footer, sheet.footer.x, sheet.footer.y + Math.round(sheet.footer.height * 0.8));
  }
  ctx.restore();
}
