// What the page knows about how it is drawn (#263).
//
// Two facts decide whether a slider drag should start at the reduced preview
// tier: the desktop shell's compositing decision (get_webview_compositing, on
// Linux the effective WEBKIT_* variables) and the WebGL renderer string. A
// renderer that names the GPU says nothing about compositing, and a masked or
// empty string says nothing at all, so both only ever add a reason to start
// reduced; neither proves the host is fast.

const SOFTWARE_RENDERER = /llvmpipe|softpipe|swiftshader|swrast|basic render driver|software rasteri[sz]er/i;

export function isSoftwareRenderer(renderer) {
  return SOFTWARE_RENDERER.test(String(renderer || ''));
}

// One synchronous query per context. #239 and #253 gate their shaders on
// `software`.
export function describeWebglRenderer(gl) {
  if (!gl) return { renderer: '', software: false };
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch {
    renderer = '';
  }
  return { renderer, software: isSoftwareRenderer(renderer) };
}

// The env pairs arrive as [name, value] from Rust. Any value but "0" turns the
// variable on, as in WebKit's own checks.
function compositingVariableSet(compositing, name) {
  const env = Array.isArray(compositing?.env) ? compositing.env : [];
  return env.some((pair) => Array.isArray(pair) && pair[0] === name && pair[1] != null && pair[1] !== '0');
}

// Why sessions should start reduced, or null. Reads the effective env rather
// than the decision label: a user-set WEBKIT_DISABLE_DMABUF_RENDERER=1 is
// recorded as "kept:user-preset" but still disables accelerated compositing.
export function startsReducedReason({ compositing = null, renderer = null } = {}) {
  if (compositingVariableSet(compositing, 'WEBKIT_DISABLE_DMABUF_RENDERER')) return 'software-compositing';
  if (compositingVariableSet(compositing, 'WEBKIT_DISABLE_COMPOSITING_MODE')) return 'compositing-disabled';
  if (renderer?.software) return 'software-gl';
  return null;
}

export function startsReduced(environment = {}) {
  return startsReducedReason(environment) !== null;
}

function quote(value) {
  return JSON.stringify(String(value ?? ''));
}

function compositingSummary(compositing) {
  if (!compositing) return [];
  const parts = [`os=${compositing.os || 'unknown'}`];
  if (compositing.appimage) parts.push(`appimage=${compositing.appimage}`);
  if (compositing.dmabuf) parts.push(`dmabuf=${compositing.dmabuf}`);
  if (compositing.webkitgtk) parts.push(`webkitgtk=${compositing.webkitgtk}`);
  const env = Array.isArray(compositing.env) ? compositing.env : [];
  const set = env.filter((pair) => Array.isArray(pair) && pair[1] != null).map(([name, value]) => `${name}=${value}`);
  if (set.length) parts.push(`env=${set.join(',')}`);
  return parts;
}

// The one line the desktop log and the debug widget show after the first
// WebGL context: renderer, compositing decision, WebKitGTK version and the
// tier the next slider drag starts in.
export function formatRenderEnvironmentLine({ renderer = null, compositing = null, startTier = 'normal', startReason = null } = {}) {
  const parts = [
    renderer ? `renderer=${quote(renderer.renderer || 'masked')}` : 'renderer=unavailable',
    `software=${Boolean(renderer?.software)}`,
    ...compositingSummary(compositing),
    `start=${startTier}${startReason ? `(${startReason})` : ''}`
  ];
  return parts.join(' ');
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}ms` : 'n/a';
}

// A slider or curve session's frame record, for NEGATIVE_CONVERTER_FRAME_LOG
// and the debug widget.
export function formatPreviewSessionLine(summary) {
  if (!summary) return 'session none';
  const size = (backing) => (backing
    ? `${backing.width}x${backing.height}(${(backing.width * backing.height / 1e6).toFixed(2)}MP)`
    : 'n/a');
  return [
    `session kind=${summary.kind}`,
    `tier=${summary.reduced ? 'reduced' : 'normal'}`,
    `start=${summary.startTier}${summary.startReason ? `(${summary.startReason})` : ''}`,
    `trigger=${summary.trigger || 'none'}`,
    `end=${summary.endReason}`,
    `frames=${summary.intervals}`,
    `p50=${formatMs(summary.p50)}`,
    `p95=${formatMs(summary.p95)}`,
    `idle=${formatMs(summary.idleInterval)}`,
    `backing=${size(summary.backing)}`,
    `maxBacking=${size(summary.maxBacking)}`,
    `durationMs=${Math.round(summary.durationMs || 0)}`
  ].join(' ');
}
