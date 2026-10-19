import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Browser adapter for exercising the real mobile runtime across navigation.
// Only this tiny-fixture test store uses localStorage/base64. Production uses
// Rust files and binary IPC (mobileRecovery.test.mjs + native unit tests).
function installRecoveryBridge() {
  const key = 'nc_test_mobile_recovery';
  const disk = JSON.parse(localStorage.getItem(key) || '{"revision":0,"sources":{},"checkpoint":null}');
  const lease = crypto.randomUUID(), pending = new Map();
  const persist = () => localStorage.setItem(key, JSON.stringify(disk));
  window.__recoverySmoke = { disk, failCommit: false };
  window.__TAURI__ = { core: { invoke: async (command, args = {}, options = {}) => {
    if (command === 'get_platform_info') return { shell: 'tauri', os: 'ios', arch: 'aarch64', capabilities: { externalLinks: true, documentsExport: true, sourceRecovery: true } };
    if (command === 'get_memory_info') return { totalBytes: 8 * 1024 ** 3, availableBytes: 4 * 1024 ** 3, engine: 'wkwebview', os: 'ios' };
    if (command === 'get_app_version') return 'recovery-smoke';
    if (command === 'native_raw_info') return { available: false };
    if (command === 'take_web_content_termination') return null;
    if (command === 'get_webview_compositing') return {};
    if (command === 'log_webview_diagnostics' || command === 'stop_watch_import_folder') return null;
    if (command === 'mobile_recovery_open') return { session: lease, revision: disk.revision, checkpoint: disk.checkpoint,
      sources: disk.checkpoint?.sourceIds.map(id => disk.sources[id].info) || [] };
    if (command.startsWith('mobile_recovery_')) {
      if ((options.headers?.['x-recovery-session'] || args.session) !== lease) throw new Error('expired lease');
      switch (command) {
        case 'mobile_recovery_begin': { const id = crypto.randomUUID(); pending.set(id, { info: args.info, parts: [], size: 0 }); return id; }
        case 'mobile_recovery_append': {
          const p = pending.get(options.headers['x-source-id']);
          if (p.size !== Number(options.headers['x-source-offset']) || args.byteLength > 1024 ** 2) throw new Error('bad chunk');
          p.parts.push(args.slice()); p.size += args.byteLength; return;
        }
        case 'mobile_recovery_finish': {
          const p = pending.get(args.id);
          if (p.size !== p.info.size) throw new Error('incomplete source');
          const bytes = new Uint8Array(await new Blob(p.parts).arrayBuffer());
          let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
          disk.sources[args.id] = { info: p.info, data: btoa(text) }; pending.delete(args.id); persist(); return;
        }
        case 'mobile_recovery_abort': pending.delete(args.id); return;
        case 'mobile_recovery_verify': if (!disk.sources[args.id]) throw new Error('missing source'); return;
        case 'mobile_recovery_read': {
          const bytes = Uint8Array.from(atob(disk.sources[args.id].data), char => char.charCodeAt(0));
          return bytes.slice(args.offset, args.offset + args.length).buffer;
        }
        case 'mobile_recovery_commit': {
          if (window.__recoverySmoke.failCommit) { window.__recoverySmoke.failCommit = false; throw new Error('injected full disk'); }
          if (args.expectedRevision !== disk.revision) throw new Error('stale checkpoint');
          disk.checkpoint = { ...args, revision: ++disk.revision, savedAt: Date.now() }; persist(); return disk.checkpoint;
        }
        case 'mobile_recovery_clear': {
          if (args.expectedRevision !== disk.revision) throw new Error('stale clear');
          disk.sources = {};
          disk.checkpoint = { revision: disk.revision += 2, savedAt: Date.now(), sourceIds: [], queueIds: [], activeIndex: 0,
            project: JSON.stringify({ kind: 'neoanaloglab-roll', version: 1, files: [], roll: {} }) };
          persist(); return disk.checkpoint;
        }
      }
    }
    throw new Error('Unavailable in browser recovery smoke: ' + command);
  } } };
}

export async function runMobileRecoverySmoke({ send, evaluate, waitFor, wait, fail, port, root, fixtures, installDialogAutoAccept }) {
  const output = join(root, 'output', 'mobile-shell');
  mkdirSync(output, { recursive: true });
  await evaluate(`localStorage.removeItem('nc_test_mobile_recovery')`);
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installRecoveryBridge.toString()})()` });
  const url = `http://127.0.0.1:${port}/?lang=en&mobileRecoverySmoke=1`;
  const saved = `document.getElementById('mobileRecoveryStatus')?.dataset.status === 'saved'`;
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  const tap = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})`);
    const p = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect();
      const x = r.x+r.width/2, y = r.y+r.height/2, hit = document.elementFromPoint(x,y);
      return { x,y,width:r.width,height:r.height,hit:hit?.className,ok:r.width>0&&r.height>0&&!e.disabled&&e.contains(hit) }; })()`);
    if (!p.ok) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(output, 'recovery-unreachable.png'), Buffer.from(shot.result.data, 'base64'));
      fail('Recovery control cannot be reached: ' + selector + ' ' + JSON.stringify(p));
    }
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const edit = async value => evaluate(`(() => { const e=document.getElementById('coreExposure'); e.value=${value}; e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  try {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url });
    await waitFor('native recovery boot', `!!document.getElementById('mobileRecoveryStatus')`);
    await installDialogAutoAccept();
    // Duplicate display names must survive as two independent source IDs.
    await evaluate(`(async () => {
      const dt=new DataTransfer();
      for (const path of ${JSON.stringify(fixtures.map(file => '/test-fixtures/' + file.split('/').at(-1)))}) {
        const blob=await (await fetch(path)).blob(); dt.items.add(new File([blob],'same.jpg',{type:'image/jpeg',lastModified:1}));
      }
      const input=document.getElementById('fileInput'); input.files=dt.files; input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await waitFor('recovery import', ready, 120000);
    await edit(17);
    await waitFor('durable edit', `${saved} && JSON.parse(__recoverySmoke.disk.checkpoint.project).files[0].settings?.coreExposure === 17`);
    await tap('#studioToggleStrip');
    await waitFor('recovery photos expanded', `document.getElementById('studioToggleStrip').getAttribute('aria-expanded')==='true'`);
    await tap('.file-list-name[data-index="1"]');
    await waitFor('active frame checkpoint', `${ready} && ${saved} && __recoverySmoke.disk.checkpoint.activeIndex===1`);
    await tap('.file-list-name[data-index="0"]');
    await waitFor('warm navigation checkpoint without an edit', `${ready} && ${saved} && __recoverySmoke.disk.checkpoint.activeIndex===0`);
    await tap('#studioToggleStrip');
    const identity = await evaluate(`({ ids:__recoverySmoke.disk.checkpoint.queueIds, sources:__recoverySmoke.disk.checkpoint.sourceIds })`);
    if (new Set(identity.ids).size !== 2 || new Set(identity.sources).size !== 2) fail('Same-name native originals were collapsed');
    await send('Page.navigate', { url });
    await waitFor('recovery offered after reload', `!!document.getElementById('mobileRecoveryStatus') && document.getElementById('studioRestoreProject')?.hidden === false`);
    await installDialogAutoAccept();
    await tap('#studioMenu > summary');
    await wait(200);
    await tap('#studioRestoreProject');
    await waitFor('originals restored without picking again', ready, 120000);
    await waitFor('restored roll checkpoint', saved);
    const restored = await evaluate(`({ exposure:Number(document.getElementById('coreExposure').value), count:document.querySelectorAll('.file-list-item').length, ids:__recoverySmoke.disk.checkpoint.queueIds })`);
    if (restored.exposure !== 17 || restored.count !== 2 || JSON.stringify(restored.ids) !== JSON.stringify(identity.ids)) fail('Recovery lost edits/identities: ' + JSON.stringify(restored));
    // A failed edit checkpoint must leave the previous durable recipe.
    await evaluate(`__recoverySmoke.failCommit=true`); await edit(29);
    await waitFor('save failure visible', `document.getElementById('mobileRecoveryStatus').dataset.status==='error'`);
    if (await evaluate(`JSON.parse(__recoverySmoke.disk.checkpoint.project).files[0].settings.coreExposure`) !== 17) fail('Failed save replaced the checkpoint');
    const notices = await evaluate(`Array.from(document.querySelectorAll('.toast-visible'), el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,scroll:el.scrollWidth,width:el.clientWidth}; })`);
    if (!notices.length || notices.some(r => r.left < 0 || r.right > 390 || r.scroll > r.width + 1)) fail('Recovery notice is clipped: ' + JSON.stringify(notices));
    const failureShot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'iphone-recovery-failure.png'), Buffer.from(failureShot.result.data, 'base64'));
    await edit(31); await waitFor('save retry', `${saved} && JSON.parse(__recoverySmoke.disk.checkpoint.project).files[0].settings.coreExposure === 31`);
    await waitFor('recovery notifications settle', `!document.querySelector('.toast-visible')`);
    await tap('#studioMenu > summary'); await wait(200);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(output, 'iphone-recovery.png'), Buffer.from(shot.result.data, 'base64'));
    await tap('#studioNewSession');
    await waitFor('new session clears native originals', `Object.keys(__recoverySmoke.disk.sources).length===0 && document.getElementById('mobileRecoveryStatus').dataset.status==='idle'`);
    await send('Page.navigate', { url });
    await waitFor('empty recovery boot', `!!document.getElementById('mobileRecoveryStatus')`);
    await wait(300);
    if (await evaluate(`document.getElementById('studioRestoreProject').hidden`) !== true) fail('Deleted roll reappeared after reload');
    console.log('ok: mobile recovery import/edit/reload/restore, duplicate names, failure/retry and clear; browser bridge adapter');
  } finally {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.result.identifier });
    await evaluate(`localStorage.removeItem('nc_test_mobile_recovery')`);
  }
}
