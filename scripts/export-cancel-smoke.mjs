// Exercise the real export click handler, substituting only the native IPC.
// Cancellation must happen before full-resolution rendering, not after encoding.
export async function runExportCancelSmoke({ evaluate, waitFor, fail }) {
  await evaluate(`(() => {
    const snapshot = () => {
      const c = document.getElementById('canvas');
      const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let hash = 2166136261;
      for (const value of pixels) hash = Math.imul(hash ^ value, 16777619);
      return JSON.stringify({ hash, width: c.width, height: c.height,
        file: document.getElementById('studioFilename').textContent,
        cyan: document.getElementById('cyan').value,
        exposure: document.getElementById('coreExposure').value,
        active: [...document.querySelectorAll('.file-list-item')].findIndex(el => el.classList.contains('active')) });
    };
    const probe = window.__exportCancelProbe = {
      snapshot, before: snapshot(), calls: [], work: [], bytes: 0,
      originalTauri: window.__TAURI__,
      consoleError: console.error,
      postMessage: Worker.prototype.postMessage,
      toBlob: HTMLCanvasElement.prototype.toBlob
    };
    console.error = (...args) => {
      if (args[0] === 'Export failed:' && args[1]?.message === 'Test save picker failure') {
        probe.expectedErrorReported = true;
        return;
      }
      probe.consoleError.apply(console, args);
    };
    Worker.prototype.postMessage = function(...args) { probe.work.push('worker'); return probe.postMessage.apply(this, args); };
    HTMLCanvasElement.prototype.toBlob = function(...args) { probe.work.push('encode'); return probe.toBlob.apply(this, args); };
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      probe.calls.push(command);
      if (command === 'pick_export_file_path') {
        probe.name = args.suggestedName;
        return new Promise((resolve, reject) => { probe.resolve = resolve; probe.reject = reject; });
      }
      if (command === 'begin_export_write') { probe.destination = args.path; probe.expectedBytes = args.expectedBytes; return 'test-export'; }
      if (command === 'append_export_chunk') { probe.bytes += args.byteLength; return; }
      if (command === 'finish_export_write') return { saved: true, path: probe.destination };
      throw new Error('Unexpected desktop command: ' + command);
    } } };
  })()`);
  try {
    for (const format of ['png', 'jpeg', 'tiff', 'dng', 'png']) {
      const pending = await evaluate(`(() => {
        const p = window.__exportCancelProbe; p.calls = []; p.work = [];
        document.querySelector('.format-btn[data-format="${format}"]').click();
        document.getElementById('exportSingleBtn').click();
        // A rapid second activation must not create another dialog/export.
        document.getElementById('exportSingleBtn').dispatchEvent(new Event('click'));
        return { calls: p.calls, work: p.work, locked: document.getElementById('exportSingleBtn').disabled };
      })()`);
      if (JSON.stringify(pending.calls) !== '["pick_export_file_path"]' || pending.work.length || !pending.locked) {
        fail('export did work before save confirmation or opened duplicate dialogs: ' + JSON.stringify(pending));
      }
      await evaluate(`window.__exportCancelProbe.resolve(null)`);
      await waitFor('cancel releases export controls', `!document.getElementById('exportSingleBtn').disabled`);
      const cancelled = await evaluate(`(() => { const p = window.__exportCancelProbe; return {
        unchanged: p.snapshot() === p.before, ready: document.body.classList.contains('studio-ready'), calls: p.calls, work: p.work
      }; })()`);
      if (!cancelled.unchanged || !cancelled.ready || cancelled.calls.length !== 1 || cancelled.work.length) {
        fail('cancel changed the photo or rendered/wrote an export: ' + JSON.stringify(cancelled));
      }
    }
    // Native picker failures also release the guard so the user can retry.
    await evaluate(`document.getElementById('exportSingleBtn').click(); window.__exportCancelProbe.reject(new Error('Test save picker failure'));`);
    await waitFor('picker error releases export controls', `!document.getElementById('exportSingleBtn').disabled`);
    if (!await evaluate(`window.__exportCancelProbe.expectedErrorReported`)) fail('picker failure was not reported');
    await evaluate(`(() => { const p = window.__exportCancelProbe; p.calls = []; document.getElementById('exportSingleBtn').click(); p.resolve('/chosen/export.png'); })()`);
    await waitFor('confirmed native export finishes', `!document.getElementById('exportSingleBtn').disabled && window.__exportCancelProbe.calls.includes('finish_export_write')`, 120_000);
    // A confirmed save may replace the screen preview with the completed
    // full-resolution render; the selected photo and edit values must survive.
    const saved = await evaluate(`(() => { const p = window.__exportCancelProbe; return {
      pickers: p.calls.filter(c => c === 'pick_export_file_path').length,
      destination: p.destination, bytes: p.bytes, expected: p.expectedBytes,
      name: p.name, before: JSON.parse(p.before), after: JSON.parse(p.snapshot())
    }; })()`);
    if (saved.pickers !== 1 || saved.destination !== '/chosen/export.png' || saved.bytes <= 0 || saved.bytes !== saved.expected || ['file', 'cyan', 'exposure', 'active'].some(key => saved.before[key] !== saved.after[key]) || !saved.after.width || !saved.after.height || !/negative-gradient-16/.test(saved.name)) {
      fail('save after cancellation failed: ' + JSON.stringify(saved));
    }
    console.log('ok: desktop cancellation skips rendering/encoding/writes, preserves photo and adjustments, and allows retry/save');
  } finally {
    await evaluate(`(() => { const p = window.__exportCancelProbe;
      Worker.prototype.postMessage = p.postMessage; HTMLCanvasElement.prototype.toBlob = p.toBlob;
      console.error = p.consoleError;
      if (p.originalTauri === undefined) delete window.__TAURI__; else window.__TAURI__ = p.originalTauri;
      delete window.__exportCancelProbe;
    })()`);
  }
}
