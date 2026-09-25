// Raw Chrome DevTools Protocol over Node's built-in WebSocket, with flattened
// sessions (Target.attachToTarget / setAutoAttach with flatten: true), like
// scripts/smoke-test.mjs but connected to the browser target so worker
// sessions, SystemInfo and Tracing are reachable on one socket.

export class CdpError extends Error {
  constructor(method, error) {
    super(`${method}: ${error?.message || JSON.stringify(error)}`);
    this.name = 'CdpError';
    this.code = error?.code;
  }
}

export class CdpTimeoutError extends Error {
  constructor(method, ms) {
    super(`${method}: no reply within ${ms} ms`);
    this.name = 'CdpTimeoutError';
    this.code = 'CDP_TIMEOUT';
  }
}

export class CdpConnection {
  static async connect(url, { defaultTimeoutMs = 120_000 } = {}) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = event => reject(new Error(`CDP connection to ${url} failed: ${event?.message || 'error'}`));
    });
    return new CdpConnection(socket, { defaultTimeoutMs });
  }

  constructor(socket, { defaultTimeoutMs = 120_000 } = {}) {
    this.socket = socket;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    this.closeHandlers = new Set();
    socket.onmessage = event => this.#receive(event.data);
    socket.onclose = () => this.#close(new Error('CDP connection closed'));
    socket.onerror = () => {};
  }

  #receive(data) {
    let message;
    try { message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(entry.method, message.error));
      else entry.resolve(message.result || {});
      return;
    }
    for (const listener of [...this.listeners]) {
      if (listener.method !== '*' && listener.method !== message.method) continue;
      if (listener.sessionId !== undefined && listener.sessionId !== (message.sessionId || null)) continue;
      try { listener.handler(message.params || {}, message); } catch (error) { console.error('CDP listener failed:', error); }
    }
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    for (const handler of this.closeHandlers) { try { handler(error); } catch {} }
  }

  onClose(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Send a command; `sessionId` null or undefined targets the browser. */
  send(method, params = {}, { sessionId = null, timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpTimeoutError(method, timeoutMs));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
    });
  }

  /** Subscribe; sessionId undefined = any session, null = browser only. */
  on(method, handler, { sessionId } = {}) {
    const listener = { method, handler, sessionId };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitFor(method, { sessionId, predicate = () => true, timeoutMs = 30_000 } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, params => {
        if (!predicate(params)) return;
        off();
        clearTimeout(timer);
        resolve(params);
      }, { sessionId });
      const timer = setTimeout(() => { off(); reject(new CdpTimeoutError(`event ${method}`, timeoutMs)); }, timeoutMs);
    });
  }

  session(sessionId) {
    return new CdpSession(this, sessionId);
  }

  close() {
    try { this.socket.close(); } catch {}
    this.#close(new Error('CDP connection closed by the harness'));
  }
}

export class CdpSession {
  constructor(connection, id) {
    this.connection = connection;
    this.id = id;
  }

  send(method, params = {}, options = {}) {
    return this.connection.send(method, params, { ...options, sessionId: this.id });
  }

  on(method, handler) {
    return this.connection.on(method, handler, { sessionId: this.id });
  }

  waitFor(method, options = {}) {
    return this.connection.waitFor(method, { ...options, sessionId: this.id });
  }

  /** Runtime.evaluate returning the value; throws on a page exception. */
  async evaluate(expression, { timeoutMs, awaitPromise = true } = {}) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, { timeoutMs });
    if (response.exceptionDetails) {
      const details = response.exceptionDetails;
      throw new Error(`page evaluate threw: ${details.exception?.description || details.text || JSON.stringify(details)}`);
    }
    return response.result?.value;
  }
}
