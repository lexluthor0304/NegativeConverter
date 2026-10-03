import assert from 'node:assert/strict';
import { ChromeSession } from './session.mjs';

for (const captureStacks of [false, true]) {
  const sent = [], listeners = new Map();
  const target = name => ({
    on() {},
    send: async (method, params) => { sent.push({ name, method, params }); return {}; }
  });
  const page = target('page'), worker = target('worker');
  const connection = {
    onClose() {}, close() {},
    on: (method, fn) => listeners.set(method, fn),
    session: id => id === 'page' ? page : worker,
    send: async method => method === 'Target.getTargets' ? { targetInfos: [{ type: 'page', targetId: 'p' }] }
      : method === 'Target.attachToTarget' ? { sessionId: 'page' } : {}
  };
  const session = await ChromeSession.open({ probe: true, captureStacks, dpr: 2 }, {
    launchChrome: async () => ({ version: { webSocketDebuggerUrl: 'fake' }, kill: async () => {} }),
    connect: async () => connection, startMemory: async () => {}
  });
  await listeners.get('Target.attachedToTarget')({ sessionId: 'worker', targetInfo: { type: 'worker', url: 'libraw.wasm.js' }, waitingForDebugger: true });
  assert.equal(sent.filter(call => call.method === 'Debugger.enable').length, captureStacks ? 2 : 0,
    'timing runs do not debug page or Wasm workers; diagnostic runs debug both');
  assert.ok(sent.some(call => call.name === 'worker' && call.method === 'Runtime.runIfWaitingForDebugger'));
  await session.close();
}

console.log('session: timing and diagnostic page/worker debugger wiring passed');
