/*
 * NegativeConverter benchmark probe (docs/performance-benchmark.md).
 *
 * One engine-neutral classic script. Chrome gets it through
 * Page.addScriptToEvaluateOnNewDocument; Safari and the Tauri webview get it
 * from the harness preview server (index.html?perf=1). It only observes:
 *
 * - WebGL 1 and 2: texture uploads (sparse pixel hash), draws (state
 *   signature), readPixels/getError calls made by the app.
 * - 2D canvas putImageData/drawImage, toDataURL/toBlob/convertToBlob;
 *   ImageBitmapRenderingContext transfers.
 * - The photo-switch veil (#235): its visibility, its provisional kind and
 *   the target's own pixels on its surfaces (the embedded preview's bitmap,
 *   the retained copy's 2D put, the thumbnail <img> load).
 * - Workers: creation/termination, requests and results classified by
 *   type/fn with timestamps (conversion results hashed like uploads).
 * - File/Blob reads, Tauri invoke calls, trusted input events.
 * - PerformanceObserver: long-animation-frame, longtask, event, first-input,
 *   mark and measure (the app's ?perf=1 hook).
 * - Visibility: loading overlay and studio-ready/busy; transform, file name,
 *   crop overlay and thumbnail mutations.
 * - Measurement windows: rAF-gap and (unless a caller turns it off) 5 ms
 *   timer-gap recorders.
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
  // The ring keeps the last ringMs (at least 4096 events). Old events are
  // dropped by advancing ringHead and compacted only when half the array is
  // dead: a splice per push moved the whole ring every time once it was full
  // (O(n) per event in busy scenarios, #273).
  var ring = [];
  var ringHead = 0;
  var RING_MIN = 4096;
  var dropped = 0;
  var counters = {};
  var windowState = null;
  // The photo-switch veil (#235) and its presentation surfaces.
  var VEIL_ID = 'studioPhotoSwitchFeedback';

  function count(name, n) { counters[name] = (counters[name] || 0) + (n || 1); }

  function push(record) {
    if (log.length < config.logLimit) log.push(record); else dropped++;
    ring.push(record);
    var cutoff = record.t - config.ringMs;
    while (ring.length - ringHead > RING_MIN && ring[ringHead].t < cutoff) ring[ringHead++] = undefined;
    if (ringHead >= RING_MIN && ringHead * 2 >= ring.length) {
      ring = ring.slice(ringHead);
      ringHead = 0;
    }
  }
  function ringEvents() { return ring.slice(ringHead); }

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

  // FNV-1a over the exact bits of a uniform's numbers (no string building).
  var floatScratch = new Float64Array(1);
  var wordScratch = new Uint32Array(floatScratch.buffer);
  function valuesHash(values, seed) {
    var hash = Math.imul(2166136261 ^ seed, 16777619);
    for (var i = 0; i < values.length; i++) {
      floatScratch[0] = values[i];
      hash = Math.imul(hash ^ wordScratch[0], 16777619);
      hash = Math.imul(hash ^ wordScratch[1], 16777619);
    }
    return hash | 0;
  }

  var ids = new WeakMap();
  function objectId(object) {
    if (!object || (typeof object !== 'object' && typeof object !== 'function')) return 0;
    var id = ids.get(object);
    if (!id) { id = ++seq; ids.set(object, id); }
    return id;
  }
  // A canvas without an id is named once: the veil's presentation surfaces
  // (#235) by their data-surface ('studioPhotoSwitchFeedback:bitmap'), other
  // ones 'offscreen' or 'anon<n>'. An id is read on every call, as before.
  var canvasNames = new WeakMap();
  function canvasName(canvas) {
    if (!canvas) return 'none';
    if (canvas.id) return canvas.id;
    var name = canvasNames.get(canvas);
    if (name !== undefined) return name;
    if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) name = 'offscreen';
    else {
      var surface = typeof canvas.getAttribute === 'function' ? canvas.getAttribute('data-surface') : null;
      var owner = surface && typeof canvas.closest === 'function' ? canvas.closest('#' + VEIL_ID) : null;
      name = owner ? VEIL_ID + ':' + surface : 'anon' + objectId(canvas);
    }
    canvasNames.set(canvas, name);
    return name;
  }

  // ---- WebGL 1 and 2 ----
  var TEXTURE_2D = 0x0DE1;
  var glStates = new WeakMap();
  // `uh`: the context's uniform state as an XOR of one hash per location
  // (values and location), updated only when a value changes. `texSig`: the
  // bound textures and their contents as text, rebuilt only after a binding
  // or an upload changed them. A draw's signature covers both without
  // walking every uniform and texture (#273).
  function glState(ctx) {
    var state = glStates.get(ctx);
    if (!state) {
      state = { unit: 0, bound: new Map(), texHash: new Map(), texSig: null, uh: 0, program: 0, ut: null };
      glStates.set(ctx, state);
    }
    return state;
  }
  // Per uniform location: its last values and their hash.
  var uniformSlots = new WeakMap();
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
        if (target === TEXTURE_2D) {
          var s = glState(this);
          var id = objectId(texture);
          if (s.bound.get(s.unit) !== id) { s.bound.set(s.unit, id); s.texSig = null; }
        }
        return original.apply(this, arguments);
      };
    });
    wrapMethod(proto, 'useProgram', function (original) {
      return function (program) { glState(this).program = objectId(program); return original.apply(this, arguments); };
    });
    function upload(fnName, original, sub) {
      var counter = label + '.' + fnName;
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
          state.texSig = null;
          count(counter);
          var format = !sub ? (args.length >= 9 ? args[6] : args[3]) : (args.length >= 9 ? args[6] : args[4]);
          var type = !sub ? (args.length >= 9 ? args[7] : args[4]) : (args.length >= 9 ? args[7] : args[5]);
          push({ k: 'gl.upload', t: t0, c: canvasName(this.canvas), ctx: label, fn: fnName, w: w, h: h, format: format, type: type, hash: contentHash, tex: tex });
        } finally { selfMs += now() - t0; }
        return result;
      };
    }
    wrapMethod(proto, 'texImage2D', function (original) { return upload('texImage2D', original, false); });
    wrapMethod(proto, 'texSubImage2D', function (original) { return upload('texSubImage2D', original, true); });
    // Compares the call's numbers with the location's last ones in place;
    // only a change rehashes the location and moves the context's `uh`.
    // A null location is a no-op in GL and here.
    Object.getOwnPropertyNames(proto).forEach(function (name) {
      if (!/^uniform(Matrix)?[1-4]/.test(name)) return;
      wrapMethod(proto, name, function (original) {
        return function (location) {
          var t0 = now();
          try {
            if (location) {
              var slot = uniformSlots.get(location);
              if (!slot) { slot = { values: [], hash: 0 }; uniformSlots.set(location, slot); }
              var values = slot.values;
              var n = 0;
              var changed = false;
              for (var i = 1; i < arguments.length; i++) {
                var value = arguments[i];
                if (value !== null && typeof value === 'object' && typeof value.length === 'number') {
                  for (var j = 0; j < value.length; j++) {
                    var element = +value[j];
                    if (values[n] !== element && (element === element || values[n] === values[n])) { values[n] = element; changed = true; }
                    n++;
                  }
                } else {
                  var scalar = +value;
                  if (values[n] !== scalar && (scalar === scalar || values[n] === values[n])) { values[n] = scalar; changed = true; }
                  n++;
                }
              }
              if (values.length !== n) { values.length = n; changed = true; }
              if (changed) {
                var state = glState(this);
                var next = valuesHash(values, objectId(location));
                state.uh ^= slot.hash ^ next;
                slot.hash = next;
                state.ut = t0;
              }
            }
          } finally { selfMs += now() - t0; }
          return original.apply(this, arguments);
        };
      });
    });
    function drawWrapper(fnName) {
      var counter = label + '.' + fnName;
      return function (original) {
        return function () {
          var result = original.apply(this, arguments);
          var t0 = now();
          try {
            var state = glState(this);
            if (state.texSig === null) {
              var textures = '';
              state.bound.forEach(function (tex, unit) { textures += ';' + unit + ':' + (state.texHash.get(tex) || tex); });
              state.texSig = textures;
            }
            var text = 'p' + state.program + ';' + this.drawingBufferWidth + 'x' + this.drawingBufferHeight + ';' + state.uh + state.texSig;
            count(counter);
            push({ k: 'gl.draw', t: t0, c: canvasName(this.canvas), ctx: label, fn: fnName, sig: stringHash(text),
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
      var counter = label + '.' + name;
      wrapMethod(proto, name, function (original) {
        return function () {
          var t0 = now();
          count(counter);
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
  // ImageBitmapRenderingContext: the veil's provisional embedded-preview
  // frame (#235) arrives through transferFromImageBitmap. A null bitmap
  // releases the canvas's bitmap when the veil hides.
  function wrapBitmapRenderer(Ctor) {
    if (typeof Ctor !== 'function') return;
    wrapMethod(Ctor.prototype, 'transferFromImageBitmap', function (original) {
      return function (bitmap) {
        var t0 = now();
        // Read before the transfer: it detaches the bitmap (0×0 afterwards).
        var w = bitmap ? bitmap.width : 0;
        var h = bitmap ? bitmap.height : 0;
        var before = now() - t0;
        var result = original.apply(this, arguments);
        var t1 = now();
        try {
          count(bitmap ? 'bmp.transfer' : 'bmp.release');
          push({ k: 'bmp', t: t1, fn: bitmap ? 'transfer' : 'release', c: canvasName(this.canvas), w: w, h: h });
        } finally { selfMs += before + now() - t1; }
        return result;
      };
    });
  }
  wrapBitmapRenderer(global.ImageBitmapRenderingContext);
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
  var workerRecipes = new WeakMap();
  var LIBRAW_FNS = /^(open|metadata|imageData|rawImageData|thumbnailData)$/;
  function classify(message, worker) {
    if (!message || typeof message !== 'object') return null;
    if (typeof message.fn === 'string' && LIBRAW_FNS.test(message.fn) && Array.isArray(message.args)) {
      return { cls: 'libraw', fn: message.fn, id: message.id };
    }
    if (/^(convert|prepare|analyze|roi|commit|displayNegative)$/.test(message.type || '')) {
      var recipe = message.settings ? {
        ft: message.settings.filmType || 'color', pe: message.settings.positiveEngine || null,
        geometry: { rotationAngle: message.settings.rotationAngle || 0, mirrored: !!message.settings.mirrored,
          cropRegion: message.settings.cropRegion ? Object.assign({}, message.settings.cropRegion) : null }
      } : workerRecipes.get(worker);
      if (message.settings && worker) workerRecipes.set(worker, recipe);
      return { cls: message.type, fn: message.type === 'convert' ? null : message.type, id: message.id,
        cache: !!message.cacheInput, reuse: !!message.reuseSource, w: message.width, h: message.height,
        ft: recipe ? recipe.ft : null, pe: recipe ? recipe.pe : null, geometry: recipe ? recipe.geometry : null };
    }
    if (message.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format || '')) return { cls: 'decode', fn: message.format };
    if (message.image && message.image.data && !message.type) return { cls: 'semantic' };
    if (typeof message.type === 'string') {
      var type = message.type;
      var cls = /^(applyAdjustments|applyAdjustments16|encode|encodePng16|encodeTiff|encodeJpeg)/.test(type) ? 'export'
        : /^(detect|inpaint|stroke|plane|maskDelta)$/.test(type) ? 'dust' : type;
      return { cls: cls, fn: type, id: message.id, w: message.width, h: message.height };
    }
    return { cls: 'other' };
  }
  // Structured-clone payload estimate: exact backing-buffer lengths, small
  // scalar metadata, shared planes separately (no pixel traversal/copy).
  function messageBytes(value, seen) {
    if (value == null) return { bytes: 0, sharedBytes: 0 };
    if (typeof value === 'number') return { bytes: 8, sharedBytes: 0 };
    if (typeof value === 'boolean') return { bytes: 4, sharedBytes: 0 };
    if (typeof value === 'string') return { bytes: value.length * 2, sharedBytes: 0 };
    if (typeof value !== 'object') return { bytes: 0, sharedBytes: 0 };
    seen = seen || new Set();
    if (seen.has(value)) return { bytes: 0, sharedBytes: 0 };
    seen.add(value);
    var buffer = ArrayBuffer.isView(value) ? value.buffer : value;
    var shared = typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || shared) {
      // Cloning a subarray retains its whole backing buffer. Multiple views
      // of one buffer clone it only once, and SAB never copies its storage.
      if (buffer !== value && seen.has(buffer)) return { bytes: 0, sharedBytes: 0 };
      seen.add(buffer);
      return { bytes: shared ? 0 : buffer.byteLength, sharedBytes: shared ? buffer.byteLength : 0 };
    }
    var result = { bytes: 0, sharedBytes: 0 };
    Object.keys(value).forEach(function (key) {
      var part = messageBytes(value[key], seen);
      result.bytes += key.length * 2 + part.bytes; result.sharedBytes += part.sharedBytes;
    });
    return result;
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
      if (request.cls === 'dust') Object.assign(record, messageBytes(data));
      if (request.cls === 'convert') {
        record.cache = request.cache; record.ft = request.ft;
        if (data && data.rgba) { var bytes = viewBytes(data.rgba); record.hash = sparseHash(bytes); }
        record.w = data && data.width; record.h = data && data.height;
      } else if (out && out.width) {
        record.w = out.width; record.h = out.height;
      } else if (data && data.width) {
        record.w = data.width; record.h = data.height;
      }
      // 'analyze-import' (#251): frame detection and film edge in one reply,
      // with each part's own time in the worker (#273).
      var frameResult = request.cls === 'analyze-frame' ? data && data.result
        : request.cls === 'analyze-import' ? data && data.result && data.result.frame : null;
      if (frameResult) {
        record.crop = frameResult.cropRegion ? { w: frameResult.cropRegion.width, h: frameResult.cropRegion.height } : null;
        record.angle = frameResult.angle;
      }
      if (request.cls === 'analyze-import' && data && data.result) {
        if (typeof data.result.frameMs === 'number') record.frameMs = data.result.frameMs;
        if (typeof data.result.filmEdgeMs === 'number') record.filmEdgeMs = data.result.filmEdgeMs;
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
          var info = classify(message, this);
          var pending = workerPending.get(this);
          if (info && pending) {
            info.t = t0;
            if (info.id !== undefined) pending.byId.set(info.id, info); else pending.fifo.push(info);
            count('req.' + info.cls);
            if (info.cls === 'libraw' && info.fn === 'open') count('libraw.decodes');
            var size = info.cls === 'dust' ? messageBytes(message) : {};
            push({ k: 'req', t: t0, wid: workerIds.get(this), cls: info.cls, fn: info.fn || null, id: info.id,
              cache: info.cache, reuse: info.reuse, w: info.w, h: info.h, ft: info.ft, pe: info.pe, geometry: info.geometry,
              bytes: size.bytes, sharedBytes: size.sharedBytes });
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
    var writes = new Map();
    var wrapped = function (cmd) {
      var t0 = now();
      var args = arguments[1];
      var writeStart = cmd === 'finish_export_write' && args ? writes.get(args.id) : null;
      count('invoke');
      push({ k: 'invoke', t: t0, cmd: String(cmd) });
      selfMs += now() - t0;
      var result = original.apply(this, arguments);
      // Observe completion without replacing the app's promise or recording
      // destination paths, native capability ids or command arguments.
      if (result && typeof result.then === 'function') result.then(function (value) {
        if (cmd === 'begin_export_write') writes.set(value, t0);
        if (cmd === 'finish_export_write' || cmd === 'abort_export_write') writes.delete(args && args.id);
        push({ k: 'invoke.end', t: now(), rt: t0, cmd: String(cmd), writeStart: writeStart, error: false });
      }, function () {
        if (cmd === 'finish_export_write' || cmd === 'abort_export_write') writes.delete(args && args.id);
        push({ k: 'invoke.end', t: now(), rt: t0, cmd: String(cmd), writeStart: writeStart, error: true });
      });
      return result;
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
  // No pointer* listeners: every pointer event the harness causes (CDP mouse
  // input, WebDriver mouse actions) is a mouse one and is recorded once, as
  // its mouse event, and a capturing pointermove listener only doubled the
  // probe's cost per move (#273). Mouse moves record no modifiers.
  ['mousedown', 'mouseup', 'mousemove', 'wheel', 'keydown', 'keyup', 'input', 'change', 'click', 'dblclick'].forEach(function (type) {
    var value = type === 'input' || type === 'change';
    var key = type === 'keydown' || type === 'keyup';
    var mouse = !value && !key;
    global.addEventListener(type, function (event) {
      var t0 = now();
      try {
        var record = { k: 'input', t: event.timeStamp, h: t0, type: type, id: targetId(event.target), tr: event.isTrusted };
        if (value) {
          var target = event.target;
          if (target && 'value' in target && target.type !== 'file') record.v = target.value;
          if (target && target.type === 'file') record.files = target.files ? target.files.length : 0;
        } else if (mouse) {
          record.x = Math.round(event.clientX); record.y = Math.round(event.clientY); record.b = event.buttons;
          if (type === 'wheel') record.dy = event.deltaY;
          else if (type === 'mousedown') record.mod = (event.metaKey ? 'M' : '') + (event.ctrlKey ? 'C' : '');
        } else {
          record.key = event.key; record.mod = (event.metaKey ? 'M' : '') + (event.ctrlKey ? 'C' : '') + (event.shiftKey ? 'S' : '') + (event.altKey ? 'A' : '');
        }
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
    if (!element || observers[name] || typeof MutationObserver !== 'function') return false;
    observers[name] = new MutationObserver(function (records) {
      var t0 = now();
      try { handler(records, t0); } finally { selfMs += now() - t0; }
    });
    observers[name].observe(element, options);
    return true;
  }
  // The photo-switch veil (#235): shown or hidden, its provisional kind
  // (cached, thumbnail, embedded) and the surface on show. It covers the
  // viewer, so exact pixels drawn under it are not visible yet.
  var lastVeil = '';
  function readVeil(veil, t) {
    var shown = !veil.hidden;
    var kind = veil.getAttribute('data-provisional') || null;
    var surface = null;
    if (shown && kind) {
      var nodes = veil.querySelectorAll('[data-surface]');
      for (var i = 0; i < nodes.length; i++) if (!nodes[i].hidden) { surface = nodes[i].getAttribute('data-surface'); break; }
    }
    var key = shown + ':' + kind + ':' + surface;
    if (key === lastVeil) return;
    lastVeil = key;
    push({ k: 'veil', t: t, shown: shown, kind: kind, surface: surface });
  }
  // A thumbnail shown on the veil is visible once its <img> has loaded.
  // Load events do not bubble; a capturing listener on the document sees
  // them (the window is not on a load event's path).
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('load', function (event) {
      var target = event.target;
      if (!target || target.tagName !== 'IMG' || typeof target.hasAttribute !== 'function' || !target.hasAttribute('data-surface')) return;
      var t0 = now();
      try {
        var veil = target.closest('#' + VEIL_ID);
        if (!veil) return;
        push({ k: 'veil.load', t: t0, surface: target.getAttribute('data-surface'), kind: veil.getAttribute('data-provisional') || null,
          shown: !veil.hidden && !target.hidden, w: target.naturalWidth, h: target.naturalHeight });
      } finally { selfMs += now() - t0; }
    }, true);
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
    var veil = document.getElementById(VEIL_ID);
    if (watch('veil', veil, { attributes: true, subtree: true, attributeFilter: ['hidden', 'data-provisional', 'src'] }, function (records, t0) {
      readVeil(veil, t0);
    })) readVeil(veil, now());
    wrapTauri();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachObservers);
    else attachObservers();
    var attachTimer = setInterval(function () {
      attachObservers();
      if (observers.body && observers.transform && observers.filename && observers.crop && observers.thumbs && observers.veil) clearInterval(attachTimer);
    }, 1000);
  }

  // ---- measurement windows: rAF and timer gaps ----
  // `options.ticks: false` skips the 5 ms heartbeat: it is WebKit's long-task
  // proxy, Chrome has the Long Tasks API, and its 200 timer tasks a second
  // were main-thread time no selfMs counted (#273). WebKit callers keep the
  // default. The heartbeat's own callback time counts as probe time.
  function beginWindow(label, options) {
    if (windowState) endWindow();
    attachObservers();
    var ticks = !(options && options.ticks === false);
    var state = { label: label || '', start: now(), frames: [], ticks: ticks ? [] : null, active: true };
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
    if (ticks) state.timer = setInterval(function () { var t0 = now(); state.ticks.push(t0); selfMs += now() - t0; }, 5);
    readVis();
    return state.start;
  }
  function endWindow() {
    var state = windowState;
    if (!state) return null;
    state.active = false;
    if (state.timer) clearInterval(state.timer);
    windowState = null;
    var out = { label: state.label, start: state.start, end: now(), frames: state.frames };
    if (state.ticks) out.ticks = state.ticks;
    return out;
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
    return decodedJpegBlobSha256(blob);
  }
  function decodedJpegBytesSha256(base64) {
    var text = atob(base64);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return decodedJpegBlobSha256(new Blob([bytes], { type: 'image/jpeg' }));
  }
  function decodedJpegBlobSha256(blob) {
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
      part.snapshot = snapshot();
      element.value = initial;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return sleepMs(1500);
    }).then(function () { return waitUntil(studioReady, 120000); }).then(function () { return part; });
  }
  function driveSwitch(index, cls, target) {
    var part = { name: 'switch:' + cls, cls: cls, index: index, target: target };
    var button = document.querySelector('.file-list-name[data-index="' + index + '"]');
    if (!button) return Promise.reject(new Error('no tile ' + index));
    drain();
    beginWindow('switch:' + cls);
    part.keyT = now();
    button.click();
    return waitUntil(function () {
      return studioReady() && (document.getElementById('studioFilename') || {}).textContent === target;
    }, 600000).then(function () { return sleepMs(1500); }).then(function () {
      part.window = endWindow();
      part.events = drain().events;
      part.snapshot = snapshot();
      return part;
    });
  }
  function driveExport(spec) {
    var part = { name: 'export:' + spec.id, spec: spec };
    var menu = document.getElementById('exportDropdownMenu');
    if (!menu.classList.contains('show')) document.getElementById('exportBtn').click();
    document.querySelector('.format-btn[data-format="' + spec.format + '"]').click();
    if (spec.lanes) localStorage.setItem('nc_batch_lanes_v1', String(spec.lanes));
    return nextFrame().then(function () {
      if (spec.format === 'png' || spec.format === 'tiff') {
        document.querySelector('.bitdepth-btn[data-bitdepth="' + spec.bitDepth + '"]').click();
      } else if (spec.format === 'jpeg') {
        var gain = document.getElementById('exportHdrGainMap');
        if (gain.checked !== !!spec.gainMap) gain.click();
      }
      if (spec.zip) {
        var current = document.querySelector('.file-list-name[aria-current="true"]');
        document.querySelectorAll('.file-list-item').forEach(function (row) {
          var box = row.querySelector('.file-list-checkbox');
          var name = row.querySelector('.file-list-name');
          var isCurrent = current && name && name.dataset.index === current.dataset.index;
          if (box && box.checked === !!isCurrent) box.click();
        });
      }
      return sleepMs(300);
    }).then(function () {
      drain();
      beginWindow(spec.id);
      part.start = now();
      document.getElementById(spec.zip ? 'exportZipBtn' : 'exportSingleBtn').click();
      // Tauri retains its real save dialog. A native writer completion is
      // required; dismissing the dialog cannot silently count as an export.
      return waitUntil(function () {
        for (var i = ringHead; i < ring.length; i++) {
          var event = ring[i];
          if (event.k === 'invoke.end' && event.t >= part.start
            && (event.cmd === 'finish_export_write' || event.cmd === 'abort_export_write')) return true;
        }
        return false;
      }, 1800000);
    }).then(function () {
      part.window = endWindow();
      part.events = drain().events;
      if (part.events.some(function (event) { return event.k === 'invoke.end'
        && (event.error || event.cmd === 'abort_export_write'); })) throw new Error('native export failed: ' + spec.id);
      return part;
    });
  }
  function waitForAdmission(spec) {
    if (spec.admission === undefined) return Promise.resolve();
    if (!/^[a-f\d]{32}$/.test(spec.admission || '')) return Promise.reject(new Error('missing native workload admission claim'));
    var deadline = now() + (spec.scopeTimeoutMs || 30000);
    function poll() {
      if (now() >= deadline) throw new Error('native workload admission timed out before fixture import');
      return fetch('/__perf/admission?token=' + spec.admission, { cache: 'no-store' }).then(function (response) {
        if (!response.ok) throw new Error('native workload admission unavailable');
        return response.json();
      }).then(function (state) {
        if (state.state === 'admitted') return;
        if (state.state !== 'pending') throw new Error('native workload admission revoked');
        return sleepMs(100).then(poll);
      });
    }
    return Promise.resolve().then(poll);
  }
  function selfDrive(spec) {
    var report = { scenario: spec.scenario, synthetic: true, engine: navigator.userAgent, dpr: global.devicePixelRatio, parts: [], startedAt: now() };
    return waitForAdmission(spec)
      .then(function () { return waitUntil(function () { return document.getElementById('studioImportAutoCrop') && document.body.classList.contains('studio'); }, 120000); })
      .then(function () { return sleepMs(1500); })
      .then(function () {
        report.bootMs = now();
        drain();
        beginWindow('import');
        var part = { name: 'import', before: now(), index: 0, target: spec.fixtures[0] };
        report.parts.push(part);
        return importFixtures(spec.fixtures).then(function () { return waitUntil(studioReady, 600000); })
          .then(function () { return sleepMs(3000); })
          .then(function () { part.window = endWindow(); part.events = drain().events; part.snapshot = snapshot(); });
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
      .then(function () {
        if (spec.scenario !== 's9' && spec.scenario !== 's9-parallel') return null;
        return waitUntil(function () { return studioReady()
          && document.querySelectorAll('.file-list-settings-badge').length >= spec.fixtures.length; }, 3600000)
          .then(function () {
            var chain = Promise.resolve();
            (spec.exports || []).forEach(function (entry) {
              chain = chain.then(function () { return driveExport(entry); }).then(function (part) { report.parts.push(part); });
            });
            return chain;
          });
      })
      .then(function () {
        // Extra visits follow every measured window, including exports.
        var seen = new Set([0]);
        report.parts.forEach(function (part) { if (part.name.indexOf('switch:') === 0) seen.add(part.index); });
        var chain = Promise.resolve();
        spec.fixtures.forEach(function (target, index) {
          if (seen.has(index)) return;
          chain = chain.then(function () { return driveSwitch(index, 'route', target); })
            .then(function (part) { part.name = 'route:' + index; report.parts.push(part); });
        });
        return chain;
      })
      .catch(function (error) { endWindow(); report.error = String(error && error.message || error); })
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
      memory: global.__ncMemory && typeof global.__ncMemory.snapshot === 'function' ? global.__ncMemory.snapshot() : null,
      // The zoom detail layer (#248): whether it covers the view and at what density.
      detail: global.__ncDetailLayer && typeof global.__ncDetailLayer.state === 'function' ? global.__ncDetailLayer.state() : null
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
    dump: function () { return { ring: ringEvents(), counters: counters, selfMs: selfMs, window: windowState && { label: windowState.label, start: windowState.start } }; },
    beginWindow: beginWindow,
    endWindow: endWindow,
    snapshot: snapshot,
    counters: function () { return Object.assign({}, counters); },
    selfMs: function () { return selfMs; },
    clearUserTiming: function () { if (perf.clearMarks) perf.clearMarks(); if (perf.clearMeasures) perf.clearMeasures(); },
    exports: { install: installExportCapture, list: exportList, upload: uploadExport, jpegSha256: decodedJpegSha256, jpegBytesSha256: decodedJpegBytesSha256, clear: clearExports },
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
        exports: JSON.parse(params.get('exports') || '[]'),
        admission: params.get('admission') || '',
        scopeTimeoutMs: Number(params.get('scopeTimeoutMs')) || 30000,
        results: location.origin + '/__perf/results'
      };
      var start = function () { selfDrive(spec); };
      if (document.readyState === 'complete') setTimeout(start, 0); else global.addEventListener('load', start);
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
