/*
 * Worker side of the benchmark probe (Chrome only). The harness evaluates it
 * in every auto-attached worker target while the worker waits for the
 * debugger, after Runtime.addBinding('__ncPerfWorkerEmit'). It records when
 * each message starts being handled and when each reply is posted, in epoch
 * milliseconds (performance.timeOrigin + now), which the harness converts to
 * page time. Emscripten pthread workers (LibRaw's internal threads) are
 * skipped: their mailbox traffic is not application work.
 */
(function installNcPerfWorkerProbe(global) {
  'use strict';
  if (global.__ncPerfWorker || typeof global.__ncPerfWorkerEmit !== 'function') return;
  if (global.name === 'em-pthread') return;
  global.__ncPerfWorker = true;
  var emit = global.__ncPerfWorkerEmit;
  var origin = global.performance.timeOrigin;
  function time() { return origin + global.performance.now(); }
  function send(record) { try { emit(JSON.stringify(record)); } catch (e) { /* detached */ } }
  function describe(data) {
    if (!data || typeof data !== 'object') return { id: null, type: null };
    return { id: data.id === undefined ? null : data.id, type: data.type || data.fn || data.cmd || null };
  }
  var wrappers = new WeakMap();
  function wrap(handler) {
    if (typeof handler !== 'function') return handler;
    var existing = wrappers.get(handler);
    if (existing) return existing;
    var wrapped = function (event) {
      var info = describe(event && event.data);
      send({ ph: 'start', id: info.id, type: info.type, t: time() });
      return handler.apply(this, arguments);
    };
    wrappers.set(handler, wrapped);
    return wrapped;
  }
  var add = global.addEventListener;
  var remove = global.removeEventListener;
  global.addEventListener = function (type, listener, options) {
    return add.call(this, type, type === 'message' ? wrap(listener) : listener, options);
  };
  global.removeEventListener = function (type, listener, options) {
    return remove.call(this, type, type === 'message' ? (wrappers.get(listener) || listener) : listener, options);
  };
  var current = null;
  Object.defineProperty(global, 'onmessage', {
    configurable: true,
    get: function () { return current; },
    set: function (handler) {
      if (current) remove.call(global, 'message', wrap(current));
      current = typeof handler === 'function' ? handler : null;
      if (current) add.call(global, 'message', wrap(current));
    }
  });
  var post = global.postMessage;
  global.postMessage = function (message) {
    var info = describe(message);
    send({ ph: 'reply', id: info.id, type: info.type, t: time() });
    return post.apply(this, arguments);
  };
})(self);
