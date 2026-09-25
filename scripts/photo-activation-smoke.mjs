// Latest-wins photo activations and the background photo lanes (#243), in
// Chrome on small 16-bit PNG fixtures (decoded in the scan worker, so every
// decode is a worker post the probe can attribute to its file and route):
// - a burst of clicks faster than the 120 ms dwell never reads a superseded
//   target; only the last one is read and decoded, once;
// - a superseded target whose read is held never reaches the decoder, and
//   is not marked as failed;
// - after the lanes settle, opening a photo a lane already decoded reads
//   nothing (its base is retained), and the lanes never read a file while a
//   switch is running;
// - LibRaw counters (per-file open() calls, live and peak LibRaw workers,
//   terminate times) are recorded for runs on RAW fixtures.
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

function installActivationProbe() {
  const p = window.__activationProbe = { reads: [], decodes: [], terminates: [], opens: {}, liveLibRaw: 0,
    peakLibRaw: 0, switchWindows: [], holdName: null, held: null, release: null, start: performance.now() };
  const oldLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const buffers = new WeakMap();
  const read = File.prototype.arrayBuffer;
  const route = stack => /\bat (?:async )?loadFile \(/.test(stack) ? 'foreground'
    : /\bat (?:async )?open(?:Analysis|Tile|Prefetch)Decode \(/.test(stack) ? 'lane' : 'other';
  async function readWithRoute(...args) {
    const record = { name: this.name, at: performance.now() - p.start, route: route(new Error().stack),
      switching: Boolean(document.body.dataset.photoSwitching) };
    p.reads.push(record);
    if (p.holdName === this.name && record.route === 'foreground') {
      p.holdName = null;
      await new Promise(resolve => { p.held = record; p.release = () => { p.release = null; resolve(); }; });
    }
    const buffer = await read.apply(this, args);
    buffers.set(buffer, record);
    return buffer;
  }
  File.prototype.arrayBuffer = readWithRoute;
  // Pair each RAW post-decode worker with the LibRaw worker loadRawFile
  // created just before it, so its 'process' (defect pass) posts have a file.
  const WorkerConstructor = window.Worker;
  let lastLibRaw = null;
  const pairs = new WeakMap();
  const WorkerWithPairs = new Proxy(WorkerConstructor, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      const url = String(args[0] || '');
      if (/libraw/i.test(url)) lastLibRaw = worker;
      else if (/rawPostDecodeWorker/.test(url)) pairs.set(worker, lastLibRaw);
      return worker;
    }
  });
  window.Worker = WorkerWithPairs;
  const names = new WeakMap();
  p.processPosts = {};
  const post = Worker.prototype.postMessage;
  const libraw = new Set();
  function postWithRoute(message, ...rest) {
    if (message?.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format)) {
      const source = buffers.get(message.buffer);
      p.decodes.push({ name: source?.name ?? null, route: source?.route ?? null, at: performance.now() - p.start });
    }
    if (message?.fn === 'open') {
      const input = message.args?.[0];
      const source = buffers.get(input instanceof ArrayBuffer ? input : input?.buffer);
      const name = source?.name ?? null;
      names.set(this, name);
      p.opens[name] = (p.opens[name] || 0) + 1;
      if (!libraw.has(this)) {
        libraw.add(this);
        p.liveLibRaw = libraw.size;
        p.peakLibRaw = Math.max(p.peakLibRaw, libraw.size);
      }
    }
    if (message?.type === 'process') {
      const name = names.get(pairs.get(this)) ?? null;
      p.processPosts[name] = (p.processPosts[name] || 0) + 1;
    }
    return post.call(this, message, ...rest);
  }
  Worker.prototype.postMessage = postWithRoute;
  const terminate = Worker.prototype.terminate;
  function terminateWithTime(...args) {
    p.terminates.push({ at: performance.now() - p.start, libraw: libraw.has(this), name: names.get(this) ?? null });
    libraw.delete(this);
    p.liveLibRaw = libraw.size;
    return terminate.apply(this, args);
  }
  Worker.prototype.terminate = terminateWithTime;
  // Switch windows, to check that no lane read starts inside one.
  let opened = null;
  const observer = new MutationObserver(() => {
    const switching = Boolean(document.body.dataset.photoSwitching);
    if (switching && opened === null) opened = performance.now() - p.start;
    if (!switching && opened !== null) { p.switchWindows.push([opened, performance.now() - p.start]); opened = null; }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-photo-switching'] });
  p.stop = () => {
    p.release?.();
    observer.disconnect();
    if (File.prototype.arrayBuffer === readWithRoute) File.prototype.arrayBuffer = read;
    if (Worker.prototype.postMessage === postWithRoute) Worker.prototype.postMessage = post;
    if (Worker.prototype.terminate === terminateWithTime) Worker.prototype.terminate = terminate;
    if (window.Worker === WorkerWithPairs) window.Worker = WorkerConstructor;
    Error.stackTraceLimit = oldLimit;
  };
}

// Cold RAW switches 200 ms apart (past the dwell, so each target starts its
// decode): every superseded LibRaw worker is gone within 50 ms of the next
// click, at most one foreground LibRaw worker is alive at a time, and a
// target superseded before its pixels arrived never posts its defect pass.
async function runRawBurst({ send, evaluate, until, expect, wait, rawPaths }) {
  const names = rawPaths.map(path => path.split(/[\\/]/).pop());
  await evaluate(`(() => { const p = window.__activationProbe; p.opens = {}; p.processPosts = {}; p.terminates.length = 0;
    p.peakLibRaw = p.liveLibRaw; p.reads.length = 0; })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: rawPaths, nodeId: input.result.nodeId });
  await until('first RAW ready', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(names[0])}`, 300000);
  await until('RAW lanes settled', `${ready} && [...document.querySelectorAll('.file-list-name')].every(button => button.dataset.previewState === 'ready')`, 900000);
  await wait(3000);
  const clicks = await evaluate(`(async () => {
    const p = window.__activationProbe, clicks = [];
    p.peakLibRaw = p.liveLibRaw;
    const before = p.terminates.length;
    for (const name of ${JSON.stringify(names.slice(1))}) {
      clicks.push({ name, at: performance.now() - p.start, live: p.liveLibRaw });
      [...document.querySelectorAll('.file-list-name')].find(button => button.textContent.includes(name)).click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    return { clicks, before };
  })()`);
  const last = names.at(-1);
  await until('RAW burst target ready', `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(last)}`, 300000);
  const result = await evaluate(`(() => { const p = window.__activationProbe;
    return { opens: p.opens, processPosts: p.processPosts, peakLibRaw: p.peakLibRaw, terminates: p.terminates.slice(${clicks.before}) }; })()`);
  console.log('photo activation RAW burst:', JSON.stringify({ clicks, result }));
  for (const [index, click] of clicks.clicks.slice(0, -1).entries()) {
    const next = clicks.clicks[index + 1];
    const opened = result.opens[click.name] || 0;
    if (!opened) continue;
    const gone = result.terminates.find(entry => entry.libraw && entry.name === click.name);
    expect(gone && gone.at - next.at <= 50, `superseded LibRaw worker for ${click.name} not terminated within 50 ms: ` + JSON.stringify({ click, next, gone }));
  }
  expect(result.peakLibRaw <= 1 + (result.opens[null] || 0), 'more than one foreground LibRaw worker alive: ' + JSON.stringify(result));
  expect((result.opens[last] || 0) <= 1, 'the burst target was opened more than once: ' + JSON.stringify(result));
  console.log('ok: a RAW burst keeps one LibRaw worker and terminates superseded ones within 50 ms');
}

export async function runPhotoActivationSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 60000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  let failure, autoRollBefore;
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await until('activation workspace boot', `!!document.getElementById('autoRollOnImport') && !!document.getElementById('addFilesToolbarBtn')`);
  await installDialogAutoAccept();
  await wait(1500);
  try {
    // Plain imports: no roll analysis, no auto-crop, no film-type decision.
    autoRollBefore = await evaluate(`(() => {
      const key = 'nc_auto_roll_import_v1', before = localStorage.getItem(key);
      localStorage.setItem(key, 'off');
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      return before;
    })()`);
    await evaluate(`(${installActivationProbe.toString()})()`);
    // Newest first is the default order: act-6 ... act-0.
    await evaluate(`window.__activationFile = async (name, n) => {
      const blob = await (await fetch('/test-fixtures/negative-gradient-16.png')).blob();
      return new File([blob], name, { type: 'image/png', lastModified: 1700000000000 + n * 1000 });
    }`);
    await evaluate(`(async () => {
      const transfer = new DataTransfer(); transfer.items.add(await window.__activationFile('act-0.png', 0));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('first activation photo ready', `${ready} && document.getElementById('studioFilename').textContent === 'act-0.png'`, 120000);
    // Adds files through the add-photos picker and returns at once.
    await evaluate(`window.__activationAdd = async names => {
      const transfer = new DataTransfer();
      for (const [name, n] of names) transfer.items.add(await window.__activationFile(name, n));
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function (...args) {
        if (this.type !== 'file' || this.id) return originalClick.apply(this, args);
        this.files = transfer.files; this.dispatchEvent(new Event('change', { bubbles: true }));
      };
      try { document.getElementById('addFilesToolbarBtn').click(); }
      finally { HTMLInputElement.prototype.click = originalClick; }
    }`);
    const tileOf = name => `[...document.querySelectorAll('.file-list-name')].find(button => button.textContent.includes(${JSON.stringify(name)}))`;

    // --- a burst faster than the dwell reads only the last target ---------------
    const burst = await evaluate(`(async () => {
      await window.__activationAdd([['act-1.png', 1], ['act-2.png', 2], ['act-3.png', 3], ['act-4.png', 4]]);
      const start = performance.now() - window.__activationProbe.start;
      for (const name of ['act-1.png', 'act-2.png', 'act-3.png', 'act-4.png']) {
        [...document.querySelectorAll('.file-list-name')].find(button => button.textContent.includes(name)).click();
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      return { start };
    })()`);
    await until('burst target ready', `${ready} && document.getElementById('studioFilename').textContent === 'act-4.png'`, 120000);
    const afterBurst = await evaluate(`(() => {
      const p = window.__activationProbe;
      const foreground = name => p.reads.filter(read => read.name === name && read.route === 'foreground').length;
      const decoded = name => p.decodes.filter(decode => decode.name === name && decode.route === 'foreground').length;
      return { reads: ['act-1.png', 'act-2.png', 'act-3.png', 'act-4.png'].map(foreground),
        decodes: ['act-1.png', 'act-2.png', 'act-3.png', 'act-4.png'].map(decoded),
        errors: document.querySelectorAll('.file-list-status.error').length };
    })()`);
    expect(JSON.stringify(afterBurst.reads) === JSON.stringify([0, 0, 0, 1]),
      'a burst faster than the dwell read superseded targets: ' + JSON.stringify({ burst, afterBurst }));
    expect(JSON.stringify(afterBurst.decodes) === JSON.stringify([0, 0, 0, 1]),
      'a burst decoded superseded targets: ' + JSON.stringify(afterBurst));
    expect(afterBurst.errors === 0, 'a superseded target was marked as failed');
    console.log('ok: a click burst inside the dwell reads and decodes only the last photo');

    // --- a superseded target held in its read never reaches the decoder ------------
    // Added and clicked in one task, before a lane could pick the new files up.
    await evaluate(`(async () => {
      await window.__activationAdd([['act-5.png', 5], ['act-6.png', 6]]);
      window.__activationProbe.holdName = 'act-5.png';
      ${tileOf('act-5.png')}.click();
    })()`);
    await until('superseded read held', `!!window.__activationProbe.held`, 10000);
    await evaluate(`${tileOf('act-6.png')}.click()`);
    await until('newer target ready while the older read waits', `${ready} && document.getElementById('studioFilename').textContent === 'act-6.png'`, 120000);
    await evaluate(`window.__activationProbe.release()`);
    await wait(800);
    const held = await evaluate(`(() => {
      const p = window.__activationProbe;
      return { decodes: p.decodes.filter(decode => decode.name === 'act-5.png' && decode.route === 'foreground').length,
        filename: document.getElementById('studioFilename').textContent,
        errors: document.querySelectorAll('.file-list-status.error').length };
    })()`);
    expect(held.decodes === 0 && held.filename === 'act-6.png' && held.errors === 0,
      'a superseded held read was decoded, replaced the newer photo or marked an error: ' + JSON.stringify(held));
    console.log('ok: a superseded activation stops after its read and never decodes');

    // --- lanes: never inside a switch; a lane-decoded photo opens without a read ---
    await until('lane tiles ready', `${ready} && [...document.querySelectorAll('.file-list-name')].length === 7
      && [...document.querySelectorAll('.file-list-name')].every(button => button.dataset.previewState === 'ready')`, 120000);
    await wait(2500);
    const lane = await evaluate(`(() => {
      const p = window.__activationProbe;
      const inside = p.reads.filter(read => read.route === 'lane' && (read.switching
        || p.switchWindows.some(([from, to]) => read.at > from && read.at < to)));
      return { laneReads: p.reads.filter(read => read.route === 'lane').map(read => read.name), inside,
        unknown: p.reads.filter(read => read.route === 'other').map(read => read.name) };
    })()`);
    expect(lane.inside.length === 0, 'a lane read a file during a photo switch: ' + JSON.stringify(lane));
    expect(lane.laneReads.includes('act-2.png'), 'the lanes did not render the unopened photos: ' + JSON.stringify(lane));
    const readsBefore = await evaluate(`window.__activationProbe.reads.length`);
    await evaluate(`${tileOf('act-2.png')}.click()`);
    await until('lane-decoded photo opened', `${ready} && document.getElementById('studioFilename').textContent === 'act-2.png'`, 120000);
    const reopened = await evaluate(`window.__activationProbe.reads.slice(${readsBefore}).filter(read => read.name === 'act-2.png')`);
    expect(reopened.length === 0, 'opening a photo a lane already decoded read the file again: ' + JSON.stringify(reopened));
    const status = await evaluate(`window.__ncHiddenJobs.status()`);
    expect(Number.isFinite(status.photoPrefetchBytes), 'the prefetch slot is not reported: ' + JSON.stringify(status));
    const librawCounters = await evaluate(`(() => { const p = window.__activationProbe;
      return { opens: p.opens, processPosts: p.processPosts, peakLibRaw: p.peakLibRaw, liveLibRaw: p.liveLibRaw, terminates: p.terminates.length }; })()`);
    console.log('photo activation probe:', JSON.stringify({ burst, afterBurst, held, lane, librawCounters }));
    console.log('ok: lanes never read during a switch, and a lane-decoded photo opens without a read');

    // --- optional: a burst over real RAW files ---------------------------------------
    // PHOTO_ACTIVATION_RAW_FILES='["/abs/a.dng","/abs/b.dng","/abs/c.dng","/abs/d.dng"]'
    // node scripts/smoke-test.mjs --photo-activation-only
    const rawPaths = JSON.parse(process.env.PHOTO_ACTIVATION_RAW_FILES || 'null');
    if (Array.isArray(rawPaths) && rawPaths.length >= 3) await runRawBurst({ send, evaluate, until, expect, wait, rawPaths });
  } catch (error) {
    failure = error;
  } finally {
    await evaluate(`(() => {
      window.__activationProbe?.stop();
      delete window.__activationProbe; delete window.__activationAdd; delete window.__activationFile;
      const key = 'nc_auto_roll_import_v1', before = ${JSON.stringify(autoRollBefore ?? null)};
      if (before === null) localStorage.removeItem(key); else localStorage.setItem(key, before);
    })()`).catch(() => {});
  }
  if (failure) fail(failure.message);
}
