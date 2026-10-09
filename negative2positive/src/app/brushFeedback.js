// Live stroke feedback for the dust, AI-repair and dodge-and-burn brushes
// (#254 A): one canvas over the whole view (#brushFeedback, outside the zoom
// transform), sized to the container at device resolution, never to the image.
// Each animation frame strokes only the segments added since the last one, in
// an opaque colour; the element's CSS opacity makes the trail translucent, so
// the joins of consecutive frames do not darken. The photo canvases are not
// touched while a stroke is painted.

// Per tool: the element opacity and the stroke colours.
export const BRUSH_FEEDBACK_STYLES = {
  dust: { opacity: 0.4, colors: { intelligent: '#ffff00', direct: '#ff0000', remove: '#0066ff' } },
  ai: { opacity: 0.55, colors: { repair: 'rgb(244, 180, 105)' } },
  dodge: { opacity: 0.45, colors: { dodge: 'rgb(120, 200, 255)', burn: 'rgb(255, 170, 0)' } },
};

// A stroke keeps every point it records up to this many (#280): strokes of up
// to 400 points are stored exactly as they were recorded.
export const DENSE_STROKE_POINTS = 400;

// At most `max` points, taken with sanitizeRepairStrokes's index formula, so a
// long stroke keeps its end instead of losing its tail to a truncation.
export function resampleStrokePoints(points, max = DENSE_STROKE_POINTS) {
  if (!Array.isArray(points) || points.length <= max) return points;
  return Array.from({ length: max }, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
}

/**
 * The points a dodge-and-burn stroke keeps while it is painted (#280). The live
 * effect paints the points kept and the pen-up stores them, so the settled
 * frame is the last live frame. Every point is kept up to DENSE_STROKE_POINTS,
 * so such a stroke is stored as it always was. Past that, a pen stroke
 * (`decimate`) keeps a point only once it is at least `spacing` (an eighth of
 * the brush radius, in the points' working pixels) from the last one kept:
 * resampling the whole stroke at pen-up could not carry pen pressure that
 * changes within a few hundred samples, and its feather edge jumped by up to
 * 19-31/255. A stroke of one pressure (mouse, touch) keeps every point and is
 * resampled at pen-up as before; that stays within 1/255 of the live frame.
 */
export function createStrokeRecorder({ spacing = 0, decimate = false } = {}) {
  const points = [];
  let skipped = null;
  return {
    points,
    decimate,
    // Records a point; true when it is kept (to be painted and stored).
    add(point) {
      if (decimate && points.length >= DENSE_STROKE_POINTS) {
        const last = points[points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) < spacing) {
          skipped = point;
          return false;
        }
      }
      points.push(point);
      skipped = null;
      return true;
    },
    // At pen-up, the last point recorded ends the stroke even when it was
    // skipped. Returns it (to be painted too) or null.
    finish() {
      const end = skipped;
      skipped = null;
      if (end) points.push(end);
      return end;
    },
  };
}

// The pointer samples an event stands for: its coalesced samples where the
// browser reports them (Chrome 58+, Safari and WKWebView 18.2+), else itself.
export function pointerSamples(event) {
  const coalesced = typeof event?.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : null;
  return coalesced && coalesced.length ? coalesced : [event];
}

// Whether a sample at clientX/clientY moved at least `minDevicePx` device
// pixels from the last kept one (`last` = { clientX, clientY } or null).
export function movedEnough(last, clientX, clientY, dpr, minDevicePx = 1) {
  if (!last) return true;
  return Math.hypot(clientX - last.clientX, clientY - last.clientY) * dpr >= minDevicePx;
}

/**
 * The map from working-frame pixels to the overlay's device pixels: the image
 * area on screen (`surface`, a client rect that already includes the zoom and
 * pan transform) relative to the overlay's box (`box`, the container's padding
 * box in client pixels), times the overlay's device pixels per CSS pixel.
 */
export function overlayMapping({ surface, box, backingWidth, backingHeight, frameWidth, frameHeight }) {
  const deviceX = box.width > 0 ? backingWidth / box.width : 1;
  const deviceY = box.height > 0 ? backingHeight / box.height : 1;
  const sx = frameWidth > 0 ? (surface.width / frameWidth) * deviceX : 1;
  const sy = frameHeight > 0 ? (surface.height / frameHeight) * deviceY : 1;
  return {
    offsetX: (surface.left - box.left) * deviceX,
    offsetY: (surface.top - box.top) * deviceY,
    sx, sy,
    scale: Math.min(sx, sy),
  };
}

export function mapToOverlay(mapping, point) {
  return { x: mapping.offsetX + point.x * mapping.sx, y: mapping.offsetY + point.y * mapping.sy };
}

/**
 * The overlay controller. `canvas` is #brushFeedback, `measure()` returns
 * { width, height, dpr, box } for the container (CSS size, device pixel ratio
 * and its padding box in client pixels).
 */
export function createBrushFeedback({ canvas, measure, requestFrame = (fn) => requestAnimationFrame(fn), cancelFrame = (id) => cancelAnimationFrame(id) }) {
  let context = null;
  let active = false;
  let stroke = null;
  let frame = 0;
  const counters = { frames: 0, segments: 0, redraws: 0, resizes: 0, clears: 0, maxBacking: 0 };

  function ctx() {
    if (!context) context = canvas.getContext('2d');
    return context;
  }

  function setBacking(width, height) {
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    counters.resizes++;
    counters.maxBacking = Math.max(counters.maxBacking, width * height);
    return true;
  }

  // Container x DPR while a brush tool is active, 1 x 1 otherwise. An active
  // overlay is measured again only on `resize` (a container or DPR change).
  function sync(on, { resize = false } = {}) {
    const was = active;
    active = Boolean(on);
    if (!active) {
      cancel();
      setBacking(1, 1);
      canvas.style.display = 'none';
      return;
    }
    if (was && !resize) return;
    const { width, height, dpr } = measure();
    const resized = setBacking(Math.max(1, Math.round(width * dpr)), Math.max(1, Math.round(height * dpr)));
    canvas.style.display = 'block';
    if (resized && stroke) redrawStroke();
  }

  function scheduleDraw() {
    if (frame || !stroke) return;
    frame = requestFrame(() => {
      frame = 0;
      draw();
    });
  }

  function extendBounds(a, b) {
    const pad = stroke.lineWidth / 2 + 2;
    const x0 = Math.floor(Math.min(a.x, b.x) - pad); const y0 = Math.floor(Math.min(a.y, b.y) - pad);
    const x1 = Math.ceil(Math.max(a.x, b.x) + pad); const y1 = Math.ceil(Math.max(a.y, b.y) + pad);
    const bounds = stroke.bounds;
    if (!bounds) stroke.bounds = { x0, y0, x1, y1 };
    else {
      bounds.x0 = Math.min(bounds.x0, x0); bounds.y0 = Math.min(bounds.y0, y0);
      bounds.x1 = Math.max(bounds.x1, x1); bounds.y1 = Math.max(bounds.y1, y1);
    }
  }

  // Strokes the segments added since the last frame, from the last point drawn.
  function draw() {
    if (!stroke || !active) return;
    const { points } = stroke;
    if (stroke.drawn >= points.length) return;
    const c = ctx();
    const from = stroke.drawn === 0 ? 0 : stroke.drawn - 1;
    let previous = mapToOverlay(stroke.mapping, points[from]);
    c.save();
    c.globalAlpha = 1;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.lineWidth = stroke.lineWidth;
    c.strokeStyle = stroke.color;
    c.beginPath();
    c.moveTo(previous.x, previous.y);
    if (stroke.drawn === 0) {
      // A round-capped zero-length line is the pen-down dab.
      c.lineTo(previous.x + 0.01, previous.y);
      extendBounds(previous, previous);
    }
    for (let i = from + 1; i < points.length; i++) {
      const next = mapToOverlay(stroke.mapping, points[i]);
      c.lineTo(next.x, next.y);
      extendBounds(previous, next);
      previous = next;
      counters.segments++;
    }
    c.stroke();
    c.restore();
    stroke.drawn = points.length;
    counters.frames++;
  }

  function clearStroke() {
    if (!stroke || !stroke.bounds) return;
    const { x0, y0, x1, y1 } = stroke.bounds;
    ctx().clearRect(x0, y0, x1 - x0, y1 - y0);
    stroke.bounds = null;
    counters.clears++;
  }

  function redrawStroke() {
    if (!stroke) return;
    clearStroke();
    stroke.drawn = 0;
    counters.redraws++;
    scheduleDraw();
  }

  function mappingFor(surface, frameWidth, frameHeight) {
    const { box } = measure();
    return overlayMapping({ surface, box, backingWidth: canvas.width, backingHeight: canvas.height, frameWidth, frameHeight });
  }

  /**
   * Starts a stroke: `tool` names the style, `color` its colour, `radius` the
   * brush radius in working pixels of a frameWidth x frameHeight frame shown in
   * `surface` (the image area's client rect).
   */
  function begin({ tool, color, radius, frameWidth, frameHeight, surface }) {
    cancel();
    if (!active) sync(true);
    const style = BRUSH_FEEDBACK_STYLES[tool] || BRUSH_FEEDBACK_STYLES.dust;
    canvas.style.opacity = String(style.opacity);
    const mapping = mappingFor(surface, frameWidth, frameHeight);
    stroke = { tool, color, radius, frameWidth, frameHeight, mapping, lineWidth: Math.max(1, 2 * radius * mapping.scale),
      points: [], drawn: 0, bounds: null };
  }

  function add(points) {
    if (!stroke) return;
    for (const point of points) stroke.points.push(point);
    scheduleDraw();
  }

  // Zoom or pan moved the image under a stroke: map it again and redraw it once.
  function remap(surface) {
    if (!stroke) return;
    stroke.mapping = mappingFor(surface, stroke.frameWidth, stroke.frameHeight);
    stroke.lineWidth = Math.max(1, 2 * stroke.radius * stroke.mapping.scale);
    redrawStroke();
  }

  // Pen-up or cancel: only the stroke's own box is cleared.
  function end() {
    if (frame) { cancelFrame(frame); frame = 0; }
    clearStroke();
    stroke = null;
  }

  function cancel() {
    end();
  }

  return {
    sync,
    begin,
    add,
    remap,
    end,
    cancel,
    drawNow: draw,
    get active() { return active; },
    get drawing() { return Boolean(stroke); },
    state: () => ({ active, width: canvas.width, height: canvas.height, drawing: Boolean(stroke),
      points: stroke ? stroke.points.length : 0, drawn: stroke ? stroke.drawn : 0, bounds: stroke?.bounds ? { ...stroke.bounds } : null,
      opacity: canvas.style.opacity, counters: { ...counters } }),
  };
}
