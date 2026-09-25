/*
 * NegativeConverter benchmark probe (docs/performance-benchmark.md).
 *
 * One engine-neutral classic script. Chrome gets it through
 * Page.addScriptToEvaluateOnNewDocument; Safari and the Tauri webview get it
 * from the harness preview server (index.html?perf=1). It only observes:
 *
 * - WebGL 1 and 2: texture uploads (sparse pixel hash), draws (state
 *   signature), readPixels/getError calls made by the app.
 * - 2D canvas putImageData/drawImage, toDataURL/toBlob/convertToBlob.
 * - Workers: creation/termination, requests and results classified by
 *   type/fn with timestamps (conversion results hashed like uploads).
 * - File/Blob reads, Tauri invoke calls, trusted input events.
 * - PerformanceObserver: long-animation-frame, longtask, event, first-input,
 *   mark and measure (the app's ?perf=1 hook).
 * - Visibility: loading overlay and studio-ready/busy; transform, file name,
 *   crop overlay and thumbnail mutations.
 * - Measurement windows: rAF-gap and 5 ms timer-gap recorders.
 *
 * It never calls readPixels, getError or getImageData itself (GPU / raster
 * sync points); "visible" is decided from upload hashes. Its own time is
 * reported as selfMs. The last 30 s of events stay in a ring buffer that a
 * hang dump reads while the page is paused.
 */
(function installNcPerfProbe(global) {
  'use strict';
  if (global.__ncPerf || typeof global.performance === 'undefined') return;

  var config = Object.assign({ ringMs: 30000, maxHashSamples: 200000, logLimit: 400000 }, global.__ncPerfConfig || {});
  var perf = global.performance;
  var now = function () { return perf.now(); };
  var selfMs = 0;
  var seq = 0;
  var log = [];
  var ring = [];
  var dropped = 0;
  var counters = {};
  var windowState = null;

  function count(name, n) { counters[name] = (counters[name] || 0) + (n || 1); }

  function push(record) {
    if (log.length < config.logLimit) log.push(record); else dropped++;
    ring.push(record);
    if (ring.length > 4096 && ring[0].t < record.t - config.ringMs) {
      var cut = 0;
      while (cut < ring.length && ring[cut].t < record.t - config.ringMs) cut++;
      ring.splice(0, cut);
    }
  }

  // ---- hashing ----
  // Sparse FNV-1a over at most maxHashSamples samples. The stride depends only
  // on the length, so an upload and the conversion result it came from hash
  // equally.
  function sparseHash(view) {
    if (!view || typeof view.length !== 'number') return null;
    var len = view.length;
    var step = Math.max(113, Math.floor(len / config.maxHashSamples)) | 0;
    var hash = 2166136261;
    for (var i = 0; i < len; i += step) hash = Math.imul(hash ^ view[i], 16777619);
    hash = Math.imul(hash ^ len, 16777619);
    return (hash >>> 0).toString(16);
  }
  function stringHash(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return (hash >>> 0).toString(16);
  }
  function viewBytes(value) {
    if (!value) return null;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  var ids = new WeakMap();
  function objectId(object) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return 0;
    var id = ids.get(object);
    if (!id) { id = ++seq; ids.set(object, id); }
    return id;
  }
  function canvasName(canvas) {
    if (!canvas) return 'none';
    if (canvas.id) return canvas.id;
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) return 'offscreen';
    return 'anon' + objectId(canvas);
  }

  // ---- WebGL 1 and 2 ----
  var TEXTURE_2D = 0x0DE1;
  var glStates = new WeakMap();
  function glState(ctx) {
    var state = glStates.get(ctx);
    if (!state) {
      state = { unit: 0, bound: new Map(), texHash: new Map(), uniforms: new Map(), program: 0, ut: null };
      glStates.set(ctx, state);
    }
    return state;
  }
  function sourceSize(source) {
    if (!source) return [0, 0];
    var w = source.videoWidth || source.naturalWidth || source.displayWidth || source.width || 0;
    var h = source.videoHeight || source.naturalHeight || source.displayHeight || source.height || 0;
    return [w, h];
  }
  // Own properties only: a derived prototype must not wrap an inherited,
  // already wrapped method a second time.
  function wrapMethod(proto, name, make) {
    if (!proto || !Object.prototype.hasOwnProperty.call(proto, name) || typeof proto[name] !== 'function') return;
    var original = proto[name];
    proto[name] = make(original);
  }
  function wrapGl(Ctor, label) {
    if (typeof Ctor !== 'function') return;
    var proto = Ctor.prototype;
    wrapMethod(proto, 'activeTexture', function (original) {
      return function (unit) { glState(this).unit = unit - 0x84C0; return original.apply(this, arguments); };
    });
    wrapMethod(proto, 'bindTexture', function (original) {
      return function (target, texture) {
        if (target === TEXTURE_2D) { var s = glState(this); s.bound.set(s.unit, objectId(texture)); }
        return original.apply(this, arguments);
      };
    });
    wrapMethod(proto, 'useProgram', function (original) {
      return function (program) { glState(this).program = objectId(program); return original.apply(this, arguments); };
    });
    function upload(fnName, original, sub) {
      return function () {
        var result = original.apply(this, arguments);
        var t0 = now();
        try {
          var args = arguments;
          if (args[0] !== TEXTURE_2D || args[1] !== 0) return result;
          var w, h, pixels = null;
          if (!sub) {
            if (args.length >= 9) { w = args[3]; h = args[4]; pixels = args[8]; }
            else { var size = sourceSize(args[5]); w = size[0]; h = size[1]; pixels = args[5] && args[5].data; }
          } else if (args.length >= 9) { w = args[4]; h = args[5]; pixels = args[8]; }
          else { var s2 = sourceSize(args[6]); w = s2[0]; h = s2[1]; pixels = args[6] && args[6].data; }
          var hash = ArrayBuffer.isView(pixels) ? sparseHash(pixels) : 'u' + (++seq);
          var state = glState(this);
          var tex = state.bound.get(state.unit) || 0;
          var contentHash = sub ? stringHash((state.texHash.get(tex) || '') + ':' + hash) : hash;
          state.texHash.set(tex, contentHash);
          count(label + '.' + fnName);
          push({ k: 'gl.upload', t: t0, c: canvasName(this.canvas), ctx: label, fn: fnName, w: w, h: h, hash: contentHash, tex: tex });
        } finally { selfMs += now() - t0; }
        return result;
      };
    }
    wrapMethod(proto, 'texImage2D', function (original) { return upload('texImage2D', original, false); });
    wrapMethod(proto, 'texSubImage2D', function (original) { return upload('texSubImage2D', original, true); });
    Object.getOwnPropertyNames(proto).forEach(function (name) {
      if (!/^uniform(Matrix)?[1-4]/.test(name)) return;
      wrapMethod(proto, name, function (original) {
        return function (location) {
          var t0 = now();
          try {
            var parts = [];
            for (var i = 1; i < arguments.length; i++) {
              var value = arguments[i];
              parts.push(ArrayBuffer.isView(value) || Array.isArray(value) ? Array.prototype.join.call(value, ',') : String(value));
            }
            var state = glState(this);
            var key = objectId(location);
            var text = parts.join('|');
            if (state.uniforms.get(key) !== text) { state.uniforms.set(key, text); state.ut = t0; }
          } finally { selfMs += now() - t0; }
          return original.apply(this, arguments);
        };
      });
    });
    function drawWrapper(fnName) {
      return function (original) {
        return function () {
          var result = original.apply(this, arguments);
          var t0 = now();
          try {
            var state = glState(this);
            var parts = ['p' + state.program, this.drawingBufferWidth + 'x' + this.drawingBufferHeight];
            state.bound.forEach(function (tex, unit) { parts.push(unit + ':' + (state.texHash.get(tex) || tex)); });
            state.uniforms.forEach(function (value, key) { parts.push(key + '=' + value); });
            count(label + '.' + fnName);
            push({ k: 'gl.draw', t: t0, c: canvasName(this.canvas), ctx: label, fn: fnName, sig: stringHash(parts.join(';')),
              w: this.drawingBufferWidth, h: this.drawingBufferHeight, ut: state.ut });
          } finally { selfMs += now() - t0; }
          return result;
        };
      };
    }
    ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements'].forEach(function (name) {
      wrapMethod(proto, name, drawWrapper(name));
    });
    ['readPixels', 'getError'].forEach(function (name) {
      wrapMethod(proto, name, function (original) {
        return function () {
          var t0 = now();
          count(label + '.' + name);
          push({ k: 'gl.sync', t: t0, c: canvasName(this.canvas), ctx: label, fn: name });
          selfMs += now() - t0;
          return original.apply(this, arguments);
        };
      });
    });
  }
  wrapGl(global.WebGLRenderingContext, 'webgl');
  wrapGl(global.WebGL2RenderingContext, 'webgl2');

  // ---- 2D canvas and encoders ----
  var canvasContent = new WeakMap();
  function wrap2d(Ctor) {
    if (typeof Ctor !== 'function') return;
    var proto = Ctor.prototype;
    wrapMethod(proto, 'putImageData', function (original) {
      return function (imageData) {
        var result = original.apply(this, arguments);
        var t0 = now();
        try {
          var hash = sparseHash(imageData && imageData.data);
          canvasContent.set(this.canvas, hash);
          count('c2d.putImageData');
          push({ k: 'c2d', t: t0, fn: 'putImageData', c: canvasName(this.canvas), w: imageData.width, h: imageData.height, hash: hash });
        } finally { selfMs += now() - t0; }
        return result;
      };
    });
    wrapMethod(proto, 'drawImage', function (original) {
      return function (source) {
        var result = original.apply(this, arguments);
        var t0 = now();
        try {
          var w, h;
          if (arguments.length >= 9) { w = arguments[7]; h = arguments[8]; }
          else if (arguments.length >= 5) { w = arguments[3]; h = arguments[4]; }
          else { var size = sourceSize(source); w = size[0]; h = size[1]; }
          var name = canvasName(this.canvas);
          count('c2d.drawImage');
          if (this.canvas && (this.canvas.id || w * h > 65536)) {
            // `src` carries the source's pixel hash (from putImageData), so a
            // conversion result drawn through a scratch canvas still counts
            // as a positive on the CPU display path.
            var known = canvasContent.get(source);
            var token = known || ('s' + objectId(source) + ':' + (++seq));
            canvasContent.set(this.canvas, stringHash(token + ':' + w + 'x' + h));
            push({ k: 'c2d', t: t0, fn: 'drawImage', c: name, w: Math.round(w), h: Math.round(h), cw: this.canvas.width, ch: this.canvas.height, sig: canvasContent.get(this.canvas), src: known || null });
          }
        } finally { selfMs += now() - t0; }
        return result;
      };
    });
  }
  wrap2d(global.CanvasRenderingContext2D);
  wrap2d(global.OffscreenCanvasRenderingContext2D);
  function wrapEncoder(Ctor, name) {
    if (typeof Ctor !== 'function') return;
    wrapMethod(Ctor.prototype, name, function (original) {
      return function () {
        var t0 = now();
        count('enc.' + name);
        var type = name === 'toBlob' ? arguments[1] : name === 'convertToBlob' ? (arguments[0] && arguments[0].type) : arguments[0];
        push({ k: 'enc', t: t0, fn: name, c: canvasName(this), w: this.width, h: this.height, type: type || 'image/png' });
        selfMs += now() - t0;
        return original.apply(this, arguments);
      };
    });
  }
  wrapEncoder(global.HTMLCanvasElement, 'toDataURL');
  wrapEncoder(global.HTMLCanvasElement, 'toBlob');
  wrapEncoder(global.OffscreenCanvas, 'convertToBlob');

  // ---- workers ----
  var workerIds = new WeakMap();
  var workerPending = new WeakMap();
  var LIBRAW_FNS = /^(open|metadata|imageData|rawImageData|thumbnailData)$/;
  function classify(message) {
    if (!message || typeof message !== 'object') return null;
    if (typeof message.fn === 'string' && LIBRAW_FNS.test(message.fn) && Array.isArray(message.args)) {
      return { cls: 'libraw', fn: message.fn, id: message.id };
    }
    if (message.type === 'convert') {
      var settings = message.settings || {};
      return { cls: 'convert', id: message.id, cache: !!message.cacheInput, reuse: !!message.reuseSource,
        w: message.width, h: message.height, ft: settings.filmType || 'color', pe: settings.positiveEngine || null };
    }
    if (message.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format || '')) return { cls: 'decode', fn: message.format };
    if (message.image && message.image.data && !message.type) return { cls: 'semantic' };
    if (typeof message.type === 'string') {
      var type = message.type;
      var cls = /^(applyAdjustments|applyAdjustments16|encode|encodePng16|encodeTiff|encodeJpeg)/.test(type) ? 'export'
        : /^(detect|inpaint|refine)$/.test(type) && typeof message.reuseSource === 'boolean' ? 'dust' : type;
      return { cls: cls, fn: type, id: message.id, w: message.width, h: message.height };
    }
    return { cls: 'other' };
  }
  function onWorkerMessage(worker, event) {
    var t0 = now();
    try {
      var data = event.data;
      var wid = workerIds.get(worker);
      if (data && data.ready === true && Object.keys(data).length === 1) { push({ k: 'w.ready', t: t0, wid: wid }); return; }
      if (data && data.type === 'progress') return;
      var pending = workerPending.get(worker);
      if (!pending) return;
      var request = null;
      if (data && data.id !== undefined && pending.byId.has(data.id)) {
        request = pending.byId.get(data.id);
        pending.byId.delete(data.id);
      } else if (pending.fifo.length) {
        request = pending.fifo.shift();
      }
      if (!request) return;
      var out = data && data.out;
      var record = { k: 'res', t: t0, wid: wid, cls: request.cls, fn: request.fn || null, id: request.id, rt: request.t,
        err: !!(data && (data.error || data.type === 'error')) };
      if (request.cls === 'convert') {
        record.cache = request.cache; record.ft = request.ft;
        if (data && data.rgba) { var bytes = viewBytes(data.rgba); record.hash = sparseHash(bytes); }
        record.w = data && data.width; record.h = data && data.height;
      } else if (out && out.width) {
        record.w = out.width; record.h = out.height;
      } else if (data && data.width) {
        record.w = data.width; record.h = data.height;
      }
      // 'analyze-import' (#251): frame detection and film edge in one reply.
      var frameResult = request.cls === 'analyze-frame' ? data && data.result
        : request.cls === 'analyze-import' ? data && data.result && data.result.frame : null;
      if (frameResult) {
        record.crop = frameResult.cropRegion ? { w: frameResult.cropRegion.width, h: frameResult.cropRegion.height } : null;
        record.angle = frameResult.angle;
      }
      push(record);
    } finally { selfMs += now() - t0; }
  }
  if (typeof global.Worker === 'function' && typeof Proxy === 'function') {
    var OriginalWorker = global.Worker;
    var workerProto = OriginalWorker.prototype;
    global.Worker = new Proxy(OriginalWorker, {
      construct: function (target, args, newTarget) {
        var worker = Reflect.construct(target, args, newTarget === global.Worker ? target : newTarget);
        var t0 = now();
        var wid = ++seq;
        workerIds.set(worker, wid);
        workerPending.set(worker, { byId: new Map(), fifo: [] });
        worker.addEventListener('message', function (event) { onWorkerMessage(worker, event); });
        count('worker.new');
        push({ k: 'w.new', t: t0, wid: wid, url: String(args[0]).slice(-160), name: args[1] && args[1].name || null });
        selfMs += now() - t0;
        return worker;
      }
    });
    wrapMethod(workerProto, 'postMessage', function (original) {
      return function (message) {
        var t0 = now();
        try {
          var info = classify(message);
          var pending = workerPending.get(this);
          if (info && pending) {
            info.t = t0;
            if (info.id !== undefined) pending.byId.set(info.id, info); else pending.fifo.push(info);
            count('req.' + info.cls);
            if (info.cls === 'libraw' && info.fn === 'open') count('libraw.decodes');
            push({ k: 'req', t: t0, wid: workerIds.get(this), cls: info.cls, fn: info.fn || null, id: info.id,
              cache: info.cache, reuse: info.reuse, w: info.w, h: info.h, ft: info.ft, pe: info.pe });
          }
        } finally { selfMs += now() - t0; }
        return original.apply(this, arguments);
      };
    });
    wrapMethod(workerProto, 'terminate', function (original) {
      return function () {
        var t0 = now();
        count('worker.terminate');
        push({ k: 'w.end', t: t0, wid: workerIds.get(this) });
        var pending = workerPending.get(this);
        if (pending) { pending.byId.clear(); pending.fifo.length = 0; }
        selfMs += now() - t0;
        return original.apply(this, arguments);
      };
    });
  }

  // ---- file reads and desktop IPC ----
  if (typeof global.Blob === 'function') {
    ['arrayBuffer', 'slice', 'stream', 'text'].forEach(function (name) {
      wrapMethod(global.Blob.prototype, name, function (original) {
        return function () {
          var t0 = now();
          var isFile = typeof global.File === 'function' && this instanceof global.File;
          if (isFile) {
            count('read.' + name);
            push({ k: 'read', t: t0, fn: name, name: this.name, size: this.size });
          }
          selfMs += now() - t0;
          return original.apply(this, arguments);
        };
      });
    });
  }
  if (typeof global.FileReader === 'function') {
    wrapMethod(global.FileReader.prototype, 'readAsArrayBuffer', function (original) {
      return function (blob) {
        count('read.fileReader');
        push({ k: 'read', t: now(), fn: 'readAsArrayBuffer', name: blob && blob.name || null, size: blob && blob.size });
        return original.apply(this, arguments);
      };
    });
  }
  function wrapTauri() {
    var internals = global.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== 'function' || internals.invoke.__ncPerf) return;
    var original = internals.invoke;
    var wrapped = function (cmd) {
      var t0 = now();
      count('invoke');
      push({ k: 'invoke', t: t0, cmd: String(cmd) });
      selfMs += now() - t0;
      return original.apply(this, arguments);
    };
    wrapped.__ncPerf = true;
    try { internals.invoke = wrapped; } catch (e) { /* frozen */ }
  }
  wrapTauri();

  // ---- input ----
  function targetId(target) {
    if (!target || target.nodeType !== 1) return '';
    if (target.id) return target.id;
    var withId = target.closest && target.closest('[id]');
    return withId ? withId.id : '';
  }
  ['mousedown', 'mouseup', 'mousemove', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'keydown', 'keyup',
    'input', 'change', 'click', 'dblclick'].forEach(function (type) {
    global.addEventListener(type, function (event) {
      var t0 = now();
      try {
        if (/^pointer/.test(type) && event.pointerType === 'mouse') return;
        var record = { k: 'input', t: event.timeStamp, h: t0, type: type, id: targetId(event.target), tr: event.isTrusted };
        if (type === 'input' || type === 'change') {
          var target = event.target;
          if (target && 'value' in target && target.type !== 'file') record.v = target.value;
          if (target && target.type === 'file') record.files = target.files ? target.files.length : 0;
        }
        if ('clientX' in event) { record.x = Math.round(event.clientX); record.y = Math.round(event.clientY); record.b = event.buttons; }
        if (type === 'wheel') record.dy = event.deltaY;
        if (type === 'keydown' || type === 'keyup') { record.key = event.key; record.mod = (event.metaKey ? 'M' : '') + (event.ctrlKey ? 'C' : '') + (event.shiftKey ? 'S' : '') + (event.altKey ? 'A' : ''); }
        if (type === 'mousedown' || type === 'mousemove') record.mod = (event.metaKey ? 'M' : '') + (event.ctrlKey ? 'C' : '');
        push(record);
      } finally { selfMs += now() - t0; }
    }, { capture: true, passive: true });
  });

  // ---- performance observers ----
  var supported = (global.PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
  function observe(type, handler, options) {
    if (supported.indexOf(type) < 0) return false;
    try {
      new PerformanceObserver(function (list) {
        var t0 = now();
        try { list.getEntries().forEach(handler); } finally { selfMs += now() - t0; }
      }).observe(Object.assign({ type: type, buffered: true }, options || {}));
      return true;
    } catch (e) { return false; }
  }
  var observed = {
    loaf: observe('long-animation-frame', function (entry) {
      push({ k: 'loaf', t: entry.startTime, s: entry.startTime, d: entry.duration, bd: entry.blockingDuration,
        rs: entry.renderStart, sl: entry.styleAndLayoutStart,
        scripts: (entry.scripts || []).map(function (script) {
          return { u: script.sourceURL, fn: script.sourceFunctionName, cp: script.sourceCharPosition, d: script.duration,
            inv: script.invoker, it: script.invokerType, fsl: script.forcedStyleAndLayoutDuration };
        }) });
    }),
    longtask: observe('longtask', function (entry) { push({ k: 'lt', t: entry.startTime, s: entry.startTime, d: entry.duration }); }),
    event: observe('event', function (entry) {
      push({ k: 'et', t: entry.startTime, n: entry.name, s: entry.startTime, ps: entry.processingStart, pe: entry.processingEnd,
        d: entry.duration, id: entry.interactionId || 0, tg: targetId(entry.target) });
    }, { durationThreshold: 16 }),
    firstInput: observe('first-input', function (entry) {
      push({ k: 'et', t: entry.startTime, n: 'first-input:' + entry.name, s: entry.startTime, ps: entry.processingStart, pe: entry.processingEnd, d: entry.duration });
    }),
    measure: observe('measure', function (entry) {
      push({ k: 'um', t: entry.startTime, n: entry.name, s: entry.startTime, d: entry.duration, detail: entry.detail || null });
    }),
    mark: observe('mark', function (entry) {
      var detail = entry.detail && typeof entry.detail === 'object' ? Object.assign({}, entry.detail) : null;
      push({ k: 'umk', t: entry.startTime, n: entry.name, detail: detail });
    })
  };

  // ---- visibility and DOM mutations ----
  var overlay = null;
  var overlayChangedAt = -Infinity;
  var lastVis = '';
  function readVis(opacity) {
    var body = document.body;
    if (!body) return;
    var vis = {
      ov: !!(overlay && overlay.classList.contains('visible')),
      ready: body.classList.contains('studio-ready'),
      busy: !!body.dataset.studioBusy
    };
    if (Number.isFinite(opacity)) vis.op = opacity;
    var key = vis.ov + ':' + vis.ready + ':' + vis.busy + ':' + (Number.isFinite(opacity) ? opacity.toFixed(2) : '');
    if (key === lastVis) return;
    lastVis = key;
    vis.k = 'vis'; vis.t = now();
    push(vis);
  }
  var observers = {};
  function watch(name, element, options, handler) {
    if (!element || observers[name] || typeof MutationObserver !== 'function') return;
    observers[name] = new MutationObserver(function (records) {
      var t0 = now();
      try { handler(records, t0); } finally { selfMs += now() - t0; }
    });
    observers[name].observe(element, options);
  }
  function findOverlay() {
    if (overlay) return;
    overlay = document.querySelector('.loading-overlay');
    if (overlay) watch('overlay', overlay, { attributes: true, attributeFilter: ['class'] }, function () { overlayChangedAt = now(); readVis(); });
  }
  function attachObservers() {
    if (!document.body) return;
    findOverlay();
    watch('body', document.body, { attributes: true, attributeFilter: ['class', 'data-studio-busy'], childList: true }, function () {
      findOverlay();
      readVis();
    });
    var wrapper = document.getElementById('canvasTransformWrapper');
    watch('transform', wrapper, { attributes: true, attributeFilter: ['style'] }, function (records, t0) {
      push({ k: 'mut', t: t0, what: 'transform', v: wrapper.style.transform });
    });
    var filename = document.getElementById('studioFilename');
    watch('filename', filename, { childList: true, characterData: true, subtree: true }, function (records, t0) {
      push({ k: 'mut', t: t0, what: 'filename', v: filename.textContent });
    });
    var crop = document.getElementById('cropOverlay');
    watch('crop', crop, { attributes: true, attributeFilter: ['style'] }, function (records, t0) {
      push({ k: 'mut', t: t0, what: 'cropOverlay' });
    });
    var items = document.getElementById('fileListItems');
    watch('thumbs', items, { attributes: true, subtree: true, attributeFilter: ['src', 'data-preview-state'] }, function (records, t0) {
      records.forEach(function (record) {
        var target = record.target;
        var row = target.closest && target.closest('[data-index]');
        push({ k: 'mut', t: t0, what: record.attributeName === 'src' ? 'thumb' : 'previewState',
          idx: row ? row.dataset.index : null, v: record.attributeName === 'src' ? null : target.dataset.previewState });
      });
    });
    wrapTauri();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachObservers);
    else attachObservers();
    var attachTimer = setInterval(function () {
      attachObservers();
      if (observers.body && observers.transform && observers.filename && observers.crop && observers.thumbs) clearInterval(attachTimer);
    }, 1000);
  }

  // ---- measurement windows: rAF and timer gaps ----
  function beginWindow(label) {
    if (windowState) endWindow();
    attachObservers();
    var state = { label: label || '', start: now(), frames: [], ticks: [], active: true };
    windowState = state;
    function frame(time) {
      if (!state.active) return;
      var t0 = now();
      state.frames.push(time);
      if (overlay && t0 - overlayChangedAt < 600) readVis(Number(getComputedStyle(overlay).opacity));
      selfMs += now() - t0;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    state.timer = setInterval(function () { state.ticks.push(now()); }, 5);
    readVis();
    return state.start;
  }
  function endWindow() {
    var state = windowState;
    if (!state) return null;
    state.active = false;
    clearInterval(state.timer);
    windowState = null;
    return { label: state.label, start: state.start, end: now(), frames: state.frames, ticks: state.ticks };
  }

  // ---- export capture (S9) ----
  var exportsCaptured = [];
  var exportInstalled = false;
  var blobsByUrl = new Map();
  function installExportCapture() {
    if (exportInstalled) return;
    exportInstalled = true;
    var createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (object) {
      var url = createObjectURL.apply(URL, arguments);
      if (object instanceof Blob) blobsByUrl.set(url, object);
      return url;
    };
    var revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = function (url) {
      setTimeout(function () { blobsByUrl.delete(url); }, 60000);
      return revoke.apply(URL, arguments);
    };
    var click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && blobsByUrl.has(this.href)) {
        var blob = blobsByUrl.get(this.href);
        exportsCaptured.push({ t: now(), name: this.download, size: blob.size, type: blob.type, kind: 'download', blob: blob });
        return undefined;
      }
      return click.apply(this, arguments);
    };
    // Streaming ZIP export writes through the File System Access API.
    global.showSaveFilePicker = function (options) {
      var name = (options && options.suggestedName) || 'export.bin';
      var capture = { t: now(), name: name, size: 0, kind: 'stream', chunks: config.keepExportChunks ? [] : null, done: false };
      exportsCaptured.push(capture);
      return Promise.resolve({
        name: name,
        createWritable: function () {
          return Promise.resolve({
            write: function (chunk) {
              var data = chunk && chunk.data !== undefined ? chunk.data : chunk;
              var size = data instanceof Blob ? data.size : data.byteLength || 0;
              capture.size += size;
              if (capture.chunks) capture.chunks.push(data instanceof Blob ? data : new Blob([data]));
              return Promise.resolve();
            },
            close: function () { capture.done = true; capture.end = now(); return Promise.resolve(); },
            abort: function () { capture.aborted = true; return Promise.resolve(); }
          });
        }
      });
    };
  }
  function exportList() {
    return exportsCaptured.map(function (entry, index) {
      return { index: index, t: entry.t, end: entry.end || null, name: entry.name, size: entry.size, type: entry.type || null, kind: entry.kind, done: entry.kind === 'download' || entry.done };
    });
  }
  function exportBlob(index) {
    var entry = exportsCaptured[index];
    if (!entry) return null;
    return entry.blob || (entry.chunks ? new Blob(entry.chunks) : null);
  }
  function uploadExport(index, url) {
    var blob = exportBlob(index);
    if (!blob) return Promise.resolve({ ok: false, reason: 'no bytes kept' });
    return fetch(url, { method: 'POST', body: blob }).then(function (response) { return { ok: response.ok, size: blob.size }; });
  }
  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }
  // Decoded-pixel hash of a JPEG export, taken after the measurement window.
  function decodedJpegSha256(index) {
    var blob = exportBlob(index);
    if (!blob || typeof createImageBitmap !== 'function') return Promise.resolve(null);
    return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }).then(function (bitmap) {
      var canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
      var context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      var pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      return crypto.subtle.digest('SHA-256', pixels).then(function (digest) { return { width: canvas.width, height: canvas.height, sha256: hex(digest) }; });
    });
  }
  function clearExports() { exportsCaptured.length = 0; }

  // ---- fixture import without WebDriver file upload (WebKit modes) ----
  function importFixtures(names, base) {
    var root = base || (location.origin + '/__perf/fixtures/');
    return Promise.all(names.map(function (name) {
      return fetch(root + encodeURIComponent(name)).then(function (response) {
        if (!response.ok) throw new Error('fixture ' + name + ': HTTP ' + response.status);
        return response.blob();
      }).then(function (blob) { return new File([blob], name, { type: blob.type || 'application/octet-stream', lastModified: 0 }); });
    })).then(function (files) {
      var input = document.getElementById('fileInput');
      var transfer = new DataTransfer();
      files.forEach(function (file) { transfer.items.add(file); });
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return files.map(function (file) { return { name: file.name, size: file.size }; });
    });
  }

  // ---- WebKit main-thread watch: a worker notices when pings stop ----
  var watchWorker = null;
  function startMainWatch(reportUrl, silentMs) {
    if (watchWorker || typeof Worker !== 'function' || typeof Blob !== 'function') return false;
    var source = 'var last=Date.now(),reported=0,limit=' + (silentMs || 2000) + ';'
      + 'onmessage=function(){last=Date.now();reported=0;};'
      + 'setInterval(function(){var gap=Date.now()-last;if(gap>limit&&!reported){reported=1;'
      + 'fetch(' + JSON.stringify(reportUrl) + ',{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({silentSince:last,gapMs:gap})}).catch(function(){});}},500);';
    try {
      var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      watchWorker = new (global.Worker)(url);
      setInterval(function () { watchWorker.postMessage(0); }, 250);
      return true;
    } catch (e) { return false; }
  }

  // ---- self-driven scenarios (the Tauri webview has no WebDriver on macOS) ----
  // Range sliders only react to value changes, so the drive sets `value` and
  // dispatches `input` on a rAF schedule. Results are labelled synthetic input
  // and compared only with the same mode. Raw events go to the harness, which
  // computes the metrics with the same definitions as the Chrome mode.
  function sleepMs(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function nextFrame() { return new Promise(function (resolve) { requestAnimationFrame(resolve); }); }
  function studioReady() {
    var body = document.body;
    return !!(body && body.classList.contains('studio-ready') && !body.dataset.studioBusy && !document.querySelector('.loading-overlay.visible'));
  }
  function waitUntil(test, timeoutMs) {
    var started = now();
    return new Promise(function (resolve, reject) {
      (function poll() {
        var ok = false;
        try { ok = test(); } catch (e) { ok = false; }
        if (ok) return resolve(now());
        if (now() - started > timeoutMs) return reject(new Error('self-drive timeout'));
        setTimeout(poll, 100);
      })();
    });
  }
  function revealControl(id) {
    var element = document.getElementById(id);
    if (!element) return Promise.resolve(false);
    var pane = element.closest('.studio-pane');
    if (pane && pane.hidden) { var tab = document.getElementById('studioTab-' + pane.id.replace('studioPane-', '')); if (tab) tab.click(); }
    for (var details = element.closest('details'); details; details = details.parentElement && details.parentElement.closest('details')) details.open = true;
    element.scrollIntoView({ block: 'center' });
    return nextFrame().then(nextFrame).then(function () { return true; });
  }
  function driveSlider(id) {
    var element = document.getElementById(id);
    var min = Number(element.min || 0), max = Number(element.max || 100), initial = element.value;
    var fraction = (Number(initial) - min) / Math.max(1e-9, max - min);
    var direction = fraction <= 0.5 ? 1 : -1;
    var part = { name: 'drag:' + id, id: id, initial: initial };
    return revealControl(id).then(function () { return sleepMs(500); }).then(function () {
      drain();
      beginWindow('drag:' + id);
      part.start = now();
      var i = 0;
      return new Promise(function (resolve) {
        (function step() {
          if (i >= 180) return resolve();
          i++;
          element.value = String(min + (fraction + direction * 0.4 * i / 180) * (max - min));
          element.dispatchEvent(new Event('input', { bubbles: true }));
          requestAnimationFrame(step);
        })();
      });
    }).then(function () {
      part.release = now();
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return sleepMs(500);
    }).then(function () {
      part.window = endWindow();
      return sleepMs(2500);
    }).then(function () {
      part.events = drain().events;
      element.value = initial;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return sleepMs(1500);
    }).then(function () { return waitUntil(studioReady, 120000); }).then(function () { return part; });
  }
  function driveSwitch(index, cls, target) {
    var part = { name: 'switch:' + cls, cls: cls, index: index, target: target };
    var button = document.querySelector('.file-list-name[data-index="' + index + '"]');
    if (!button) return Promise.resolve(Object.assign(part, { error: 'no tile ' + index }));
    drain();
    beginWindow('switch:' + cls);
    part.keyT = now();
    button.click();
    return waitUntil(function () {
      return studioReady() && (document.getElementById('studioFilename') || {}).textContent === target;
    }, 600000).then(function () { return sleepMs(1500); }).then(function () {
      part.window = endWindow();
      part.events = drain().events;
      return part;
    });
  }
  function selfDrive(spec) {
    var report = { scenario: spec.scenario, synthetic: true, engine: navigator.userAgent, dpr: global.devicePixelRatio, parts: [], startedAt: now() };
    return waitUntil(function () { return document.getElementById('studioImportAutoCrop') && document.body.classList.contains('studio'); }, 120000)
      .then(function () { return sleepMs(1500); })
      .then(function () {
        report.bootMs = now();
        drain();
        beginWindow('import');
        var part = { name: 'import', before: now() };
        report.parts.push(part);
        return importFixtures(spec.fixtures).then(function () { return waitUntil(studioReady, 600000); })
          .then(function () { return sleepMs(3000); })
          .then(function () { part.window = endWindow(); part.events = drain().events; });
      })
      .then(function () {
        if (spec.scenario !== 's2') return null;
        var chain = Promise.resolve();
        (spec.sliders || []).forEach(function (id) {
          chain = chain.then(function () { return driveSlider(id); }).then(function (part) { report.parts.push(part); });
        });
        return chain;
      })
      .then(function () {
        if (spec.scenario !== 's7') return null;
        var names = spec.fixtures;
        var count = names.length;
        var chain = driveSwitch(1, 'coldUnanalysed', names[1]).then(function (part) { report.parts.push(part); return driveSwitch(0, 'warm1Back', names[0]); })
          .then(function (part) { report.parts.push(part); return waitUntil(function () { return document.querySelectorAll('.file-list-settings-badge').length >= count; }, 3600000); });
        if (count > 2) chain = chain.then(function () { return driveSwitch(2, 'coldAnalysed', names[2]); }).then(function (part) { report.parts.push(part); return driveSwitch(0, 'warm1Back', names[0]); }).then(function (part) { report.parts.push(part); });
        return chain;
      })
      .catch(function (error) { report.error = String(error && error.message || error); })
      .then(function () {
        report.snapshot = snapshot();
        report.counters = Object.assign({}, counters);
        report.selfMs = selfMs;
        return fetch(spec.results || '/__perf/results', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
      });
  }

  function snapshot() {
    var body = document.body;
    var gl = document.getElementById('glCanvas');
    var container = document.getElementById('canvasContainer');
    var wrapper = document.getElementById('canvasTransformWrapper');
    var activeType = document.querySelector('.film-type-btn.active');
    var resources = perf.getEntriesByType ? perf.getEntriesByType('resource') : [];
    var navigation = perf.getEntriesByType ? perf.getEntriesByType('navigation')[0] : null;
    return {
      t: now(),
      dpr: global.devicePixelRatio,
      ready: !!(body && body.classList.contains('studio-ready')),
      busy: !!(body && body.dataset.studioBusy),
      filename: (document.getElementById('studioFilename') || {}).textContent || null,
      filmType: activeType ? activeType.dataset.type : null,
      filmTypeStatus: (document.getElementById('filmTypeDetectionStatus') || {}).textContent || null,
      glCanvas: gl ? { width: gl.width, height: gl.height, display: getComputedStyle(gl).display, rect: gl.getBoundingClientRect().toJSON() } : null,
      container: container ? container.getBoundingClientRect().toJSON() : null,
      transform: wrapper ? wrapper.style.transform : null,
      files: document.querySelectorAll('.file-list-item').length,
      badges: document.querySelectorAll('.file-list-settings-badge').length,
      thumbnails: document.querySelectorAll('img.file-list-thumbnail').length,
      previewReady: document.querySelectorAll('[data-preview-state="ready"]').length,
      previewPending: document.querySelectorAll('[data-preview-state="pending"]').length,
      transferBytes: resources.reduce(function (sum, entry) { return sum + (entry.transferSize || 0); }, navigation ? navigation.transferSize || 0 : 0),
      decodedBytes: resources.reduce(function (sum, entry) { return sum + (entry.decodedBodySize || 0); }, navigation ? navigation.decodedBodySize || 0 : 0),
      memory: global.__ncMemory && typeof global.__ncMemory.snapshot === 'function' ? global.__ncMemory.snapshot() : null
    };
  }

  function drain() {
    var t0 = now();
    var events = log;
    log = [];
    var out = { events: events, selfMs: selfMs, counters: Object.assign({}, counters), dropped: dropped, now: t0,
      timeOrigin: perf.timeOrigin, observed: observed };
    selfMs += now() - t0;
    return out;
  }

  global.__ncPerf = {
    version: 1,
    drain: drain,
    dump: function () { return { ring: ring.slice(), counters: counters, selfMs: selfMs, window: windowState && { label: windowState.label, start: windowState.start } }; },
    beginWindow: beginWindow,
    endWindow: endWindow,
    snapshot: snapshot,
    counters: function () { return Object.assign({}, counters); },
    selfMs: function () { return selfMs; },
    clearUserTiming: function () { if (perf.clearMarks) perf.clearMarks(); if (perf.clearMeasures) perf.clearMeasures(); },
    exports: { install: installExportCapture, list: exportList, upload: uploadExport, jpegSha256: decodedJpegSha256, clear: clearExports },
    importFixtures: importFixtures,
    startMainWatch: startMainWatch,
    selfDrive: selfDrive,
    hash: sparseHash
  };

  // WebKit modes: the preview server injects this script with ?mode=webkit.
  // `scenario` in the page URL starts a self-driven run (Tauri); the main
  // thread watch reports silences to the harness in both WebKit modes.
  var params = (function () { try { return new URLSearchParams(location.search); } catch (e) { return null; } })();
  var scriptSrc = document.currentScript && document.currentScript.src || '';
  if (/[?&]mode=webkit/.test(scriptSrc) && params) {
    startMainWatch(location.origin + '/__perf/heartbeat', 2000);
    if (params.get('perf') === '1' && params.get('scenario')) {
      var spec = {
        scenario: params.get('scenario'),
        fixtures: (params.get('fixtures') || '').split(',').filter(Boolean),
        sliders: (params.get('sliders') || 'coreExposure,coreContrast,coreTemperature,wbR,cyan').split(',').filter(Boolean),
        results: location.origin + '/__perf/results'
      };
      var start = function () { selfDrive(spec); };
      if (document.readyState === 'complete') setTimeout(start, 0); else global.addEventListener('load', start);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
