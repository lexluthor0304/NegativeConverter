// A short-lived headless Chrome that encodes the synthetic DNGs' JPEG
// previews (the repo has no JPEG encoder). The encoder label carries the
// Chrome version, because the JPEG bytes are only stable per version.

import { CdpConnection } from './cdp.mjs';
import { findChrome, launchChrome } from './chrome.mjs';

export async function attachPage(connection) {
  const { targetInfos } = await connection.send('Target.getTargets');
  let target = targetInfos.find(info => info.type === 'page');
  if (!target) {
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    target = { targetId };
  }
  const { sessionId } = await connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  return connection.session(sessionId);
}

export async function openJpegEncoderBrowser({ port = Number(process.env.NC_PERF_CDP_PORT) || 9324, log = () => {} } = {}) {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found (set CHROME_BIN); it encodes the DNG previews');
  const chrome = await launchChrome({ bin, port, log });
  const connection = await CdpConnection.connect(chrome.version.webSocketDebuggerUrl);
  const page = await attachPage(connection);
  await page.send('Runtime.enable');
  const { chromeJpegEncoder } = await import('../fixtures.mjs');
  return {
    encodeJpeg: chromeJpegEncoder(page),
    encoderLabel: `chrome-${chrome.version.Browser?.replace(/^.*\//, '') || 'unknown'}`,
    async close() {
      connection.close();
      await chrome.kill();
    }
  };
}
