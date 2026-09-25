import {writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

// The dev-server smoke deliberately uses named caller frames, not elapsed-time
// guesses: a canonical thumbnail can overlap the automatic analysis. Unknown
// paths fail closed so a new decoder route cannot silently escape the budget.
// Background lanes (#243) open their one decode per job through a function
// named by the job's first need; a foreground activation that adopts a lane's
// decode reads nothing itself.
export function classifyFolderReadStack(stack = '') {
  const calls = name => new RegExp('\\bat (?:async )?' + name + ' \\(').test(stack);
  if (calls('openTileDecode') || calls('openHalfSizeTileDecode')) return 'thumbnail';
  if (calls('openAnalysisDecode') || (calls('attempt') && calls('runRollAnalysis'))) return 'analysis';
  if (calls('openPrefetchDecode')) return 'prefetch';
  if (calls('loadFile')) return 'foreground';
  return 'unknown';
}

function installFolderImportProbe(classify) {
  const p = window.__folderProbe = { reads: [], decodes: [], thumbs: [], embedded: [], firstReady: null,
    busyAfterReady: 0, start: performance.now() };
  const embeddedWorkers = new WeakSet();
  const buffers = new WeakMap(), blobs = new WeakMap(), rawWorkers = new WeakMap();
  const oldStackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stamp = () => ({ at: performance.now() - p.start,
    beforeReady: !document.body.classList.contains('studio-ready') || !!document.body.dataset.studioBusy });
  const read = File.prototype.arrayBuffer;
  function readWithOrigin(...args) {
    if (!this.name.startsWith('folder-')) return read.apply(this, args);
    const stack = new Error().stack;
    const record = { id: p.reads.length, name: this.name, route: classify(stack), ...stamp(), stack };
    p.reads.push(record);
    if (record.route === 'thumbnail') p.thumbs.push({ name: record.name, ...stamp() });
    return read.apply(this, args).then(buffer => { buffers.set(buffer, record); return buffer; });
  }
  File.prototype.arrayBuffer = readWithOrigin;
  // Native 8-bit PNGs wrap the known buffer in a Blob before browser decode;
  // retain that identity through the wrapper without copying its bytes.
  const BlobConstructor = window.Blob;
  const BlobWithOrigin = new Proxy(BlobConstructor, {
    construct(target, args, newTarget) {
      const blob = Reflect.construct(target, args, newTarget);
      const source = Array.from(args[0] || [], part => buffers.get(part) || buffers.get(part?.buffer) || blobs.get(part)).find(Boolean);
      if (source) blobs.set(blob, source);
      return blob;
    }
  });
  window.Blob = BlobWithOrigin;
  const post = Worker.prototype.postMessage;
  function postWithOrigin(message, ...args) {
    // Embedded-preview jobs carry the File itself and read Blob slices inside
    // the worker, so File.prototype.arrayBuffer never sees them. Count them as
    // their own route, with the bytes each job reports having read.
    if (message?.type === 'embedded-preview') {
      if (!embeddedWorkers.has(this)) {
        embeddedWorkers.add(this);
        this.addEventListener('message', ({ data }) => {
          const job = p.embedded.find(entry => entry.worker === this && entry.id === data?.id && entry.bytesRead === null);
          if (job) Object.assign(job, { bytesRead: data.bytesRead ?? 0, preview: data.preview?.length ?? null,
            empty: Boolean(data.empty), error: data.error || null, doneAt: performance.now() - p.start });
        });
      }
      p.embedded.push({ worker: this, id: message.id, name: message.file?.name ?? null, purpose: message.purpose,
        bytesRead: null, preview: null, ...stamp() });
    }
    // LibRaw serializes open/metadata/imageData separately. Carry the origin
    // from the actual transferred input buffer, never from the later stack.
    if (message?.fn === 'open') {
      const input = message.args?.[0];
      rawWorkers.set(this, buffers.get(input instanceof ArrayBuffer ? input : input?.buffer));
    }
    const scan = message?.buffer instanceof ArrayBuffer && /^(png|tiff)$/.test(message.format);
    if (scan || message?.fn === 'imageData') {
      const source = scan ? buffers.get(message.buffer) : rawWorkers.get(this);
      p.decodes.push({ name: source?.name ?? null, route: source?.route ?? 'unknown',
        readId: source?.id ?? null, kind: scan ? message.format : 'raw', ...stamp() });
    }
    return post.call(this, message, ...args);
  }
  Worker.prototype.postMessage = postWithOrigin;
  const bitmap = window.createImageBitmap;
  function bitmapWithOrigin(file, ...args) {
    const source = blobs.get(file);
    if (source) p.decodes.push({ name: source.name, route: source.route,
      readId: source.id, kind: 'png-bitmap', ...stamp() });
    else if (file?.name?.startsWith('folder-')) p.decodes.push({ name: file.name,
      route: classify(new Error().stack), readId: null, kind: 'bitmap', ...stamp() });
    return bitmap.call(this, file, ...args);
  }
  window.createImageBitmap = bitmapWithOrigin;
  p.timer = setInterval(() => {
    const ready = document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy;
    if (ready && p.firstReady === null) p.firstReady = performance.now() - p.start;
    if (p.firstReady !== null && document.body.dataset.studioBusy) p.busyAfterReady++;
  }, 10);
  p.stop = () => {
    clearInterval(p.timer);
    if (File.prototype.arrayBuffer === readWithOrigin) File.prototype.arrayBuffer = read;
    if (Worker.prototype.postMessage === postWithOrigin) Worker.prototype.postMessage = post;
    if (window.createImageBitmap === bitmapWithOrigin) window.createImageBitmap = bitmap;
    if (window.Blob === BlobWithOrigin) window.Blob = BlobConstructor;
    Error.stackTraceLimit = oldStackLimit;
  };
}

export function assertFolderDecodeBudget(result, count, rawFixture, fail) {
  const names = Array.from({ length: count }, (_, i) => `folder-${i + 1}.${rawFixture ? 'dng' : 'png'}`);
  if (result.selected !== count) fail('folder import changed selection');
  if (result.firstReady === null) fail('folder editor never became ready');
  if (result.reads.some(read => read.route === 'unknown') || result.decodes.some(decode => decode.route === 'unknown')) {
    fail('folder decoder origin was not classified');
  }
  if (result.thumbs.some(thumb => thumb.beforeReady) || result.reads.some(read => read.route !== 'foreground' && read.beforeReady)) {
    fail('folder background work competes with first photo');
  }
  // Default recipes (#247): the roll import gives every analysed frame its
  // final tile from its sample, so the thumbnail lane reads and decodes
  // nothing and its reads count: one read and one decode per photo. The
  // prefetch of the next photo is a separate, later decode of a frame (#243
  // keeps it to one per job) and is not counted.
  for (const [index, name] of names.entries()) {
    const route = index === 0 ? 'foreground' : 'analysis';
    const reads = result.reads.filter(read => read.name === name && read.route !== 'prefetch');
    const decodes = result.decodes.filter(decode => decode.name === name && decode.route !== 'prefetch');
    if (reads.length !== 1 || reads[0]?.route !== route) fail(`folder must read ${name} exactly once for ${route}; got ${reads.length} (${reads.map(read => read.route)})`);
    if (decodes.length !== 1 || decodes[0]?.route !== route || !(rawFixture ? ['raw'] : ['png', 'png-bitmap']).includes(decodes[0]?.kind)
      || decodes[0]?.readId !== reads[0]?.id) fail(`folder must decode ${name} exactly once for ${route}; got ${decodes.length}`);
  }
  if (result.thumbs.length) fail(`the thumbnail lane read ${result.thumbs.length} file(s) after roll analysis`);
  // Every read has a known input and no read hides duplicate decodes.
  if (result.reads.length !== result.decodes.length
    || result.reads.some(read => result.decodes.filter(decode => decode.readId === read.id).length !== 1)) {
    fail('folder source reads and decoder requests are not one-to-one');
  }
  // The embedded route is separate from foreground/analysis/thumbnail reads
  // and may run before the editor is ready. It never reads a whole file:
  // tiles stay within 200 KB per DNG, the viewer within its preview + 32 KB.
  for (const job of result.embedded || []) {
    if (!job.name || !names.includes(job.name)) fail('embedded preview job for an unknown file: ' + JSON.stringify(job));
    if (job.bytesRead === null) fail('embedded preview job never answered: ' + JSON.stringify(job));
    if (job.purpose === 'tile' && job.bytesRead > 200 * 1024) fail('embedded tile read exceeds 200 KB: ' + JSON.stringify(job));
    if (job.purpose === 'viewer' && job.bytesRead > (job.preview || 0) + 32 * 1024) fail('embedded viewer read exceeds preview + 32 KB: ' + JSON.stringify(job));
  }
  if (rawFixture && !(result.embedded || []).some(job => job.purpose === 'tile')) fail('RAW folder import queued no embedded tiles');
  const early = result.decodes.filter(decode => decode.beforeReady);
  if (early.length !== 1 || early[0].name !== names[0] || early[0].route !== 'foreground') {
    fail('folder must decode the first active photo before background work');
  }
  if (result.busyAfterReady) fail('automatic roll locks the ready editor');
}

export async function runFolderImportSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port,root}) {
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/?lang=en`});
  await waitFor('folder import boot',`!!document.getElementById('autoRollOnImport')`);
  await installDialogAutoAccept();
  await wait(1500); // Static controls exist before asynchronous app startup finishes.
  await evaluate(`(${installFolderImportProbe})(${classifyFolderReadStack})`);
  const rawFixture = process.env.NC_FOLDER_RAW_FIXTURE;
  const count = rawFixture ? 3 : 12;
  if (rawFixture) {
    await evaluate(`(()=>{const input=document.createElement('input');input.type='file';input.id='rawFixture';document.body.append(input)})()`);
    const {result:{root:doc}}=await send('DOM.getDocument');
    const {result:{nodeId}}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'#rawFixture'});
    await send('DOM.setFileInputFiles',{nodeId,files:[rawFixture]});
  }
  await evaluate(`(async()=>{
    const raw=${Boolean(rawFixture)};const bytes=raw?document.getElementById('rawFixture').files[0]:await(await fetch('/test-fixtures/negative-strip-dx.png')).arrayBuffer();const dt=new DataTransfer();
    for(let i=1;i<=${count};i++)dt.items.add(new File([bytes],'folder-'+i+(raw?'.dng':'.png'),{type:raw?'':'image/png',lastModified:i}));
    window.__folderProbe.start=performance.now();
    const input=document.getElementById('folderInput');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await waitFor('folder automatic roll',`!document.body.dataset.studioBusy&&document.getElementById('rollAnalysisStatus').textContent.includes('${count}/${count}')`,600000);
  // A canonical RAW preview can still be decoding after roll measurements
  // finish. Observe the complete lane, not an arbitrary 800ms prefix of it.
  await waitFor('folder canonical previews',`(() => {const tiles=[...document.querySelectorAll('.file-list-name[data-preview-state]')];return tiles.length===${count}&&tiles.every(tile=>tile.dataset.previewState==='ready')})()`,600000);
  const result=await evaluate(`(()=>{const p=window.__folderProbe;const embedded=p.embedded.map(({worker,...job})=>job);return {...p,embedded,reads:[...p.reads],decodes:[...p.decodes],thumbs:[...p.thumbs],timer:undefined,stop:undefined,totalMs:performance.now()-p.start,selected:document.querySelectorAll('.file-list-checkbox:checked').length,counts:p.reads.reduce((a,r)=>(a[r.name]=(a[r.name]||0)+1,a),{}),countsByRoute:p.reads.reduce((a,r)=>{const route=a[r.route]||={};route[r.name]=(route[r.name]||0)+1;return a},{})}})()`);
  mkdirSync(join(root,'output','verification'),{recursive:true});
  writeFileSync(join(root,'output','verification','folder-import.json'),JSON.stringify(result,null,2));
  console.log('folder import:',JSON.stringify({...result,reads:result.reads.map(({stack,...read})=>read)}));
  if(result.embedded?.length)console.log('folder embedded route:',JSON.stringify(result.embedded));
  assertFolderDecodeBudget(result, count, rawFixture, fail);
  console.log('ok: first photo has priority; automatic roll reuses samples without duplicate decodes or locking the editor');
  // Sync colours over unchanged geometry (#247 2d): every other tile renders
  // again from its retained tile source, with no file read and no decode.
  await evaluate(`(()=>{const el=document.getElementById('coreExposure');el.value='15';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  await waitFor('exposure edited',`document.getElementById('coreExposureValue').value==='15'&&!document.body.dataset.studioBusy`,30000);
  await wait(800);
  await waitFor('sync enabled',`!document.getElementById('studioSync').disabled`,30000);
  const tileSources=`[...document.querySelectorAll('.file-list-name')].map(tile=>tile.querySelector('.file-list-thumbnail')?.getAttribute('src')||'')`;
  // The prefetch of the next photo (#243) is not a tile read.
  const counted=`{reads:p.reads.filter(r=>r.route!=='prefetch').length,decodes:p.decodes.filter(d=>d.route!=='prefetch').length}`;
  const synced=await evaluate(`(()=>{const p=window.__folderProbe;window.__syncTiles=${tileSources};window.__syncStart=performance.now();const before=${counted};document.getElementById('studioSync').click();return before})()`);
  await waitFor('synced tiles ready',`(() => {const tiles=[...document.querySelectorAll('.file-list-name[data-preview-state]')];const now=${tileSources};return tiles.length===${count}&&tiles.every(tile=>tile.dataset.previewState==='ready')&&now.filter((src,i)=>src&&src!==window.__syncTiles[i]).length>=${count - 1}})()`,120000);
  const afterSync=await evaluate(`(()=>{const p=window.__folderProbe;const out={...${counted},ms:Math.round(performance.now()-window.__syncStart)};p.stop();return out})()`);
  console.log('folder sync colours:',JSON.stringify({before:synced,after:afterSync}));
  if(afterSync.reads!==synced.reads||afterSync.decodes!==synced.decodes)fail('Sync colours re-read or re-decoded photos: '+JSON.stringify({synced,afterSync}));
  console.log(`ok: Sync colours re-rendered ${count - 1} tiles from their tile sources in ${afterSync.ms} ms without reading or decoding a photo`);
  if (!rawFixture) {
    // Compare actual exported pixels with a fresh, uncached manual analysis.
    await evaluate(`(()=>{
      window.__folderExports=[];const revoke=URL.revokeObjectURL.bind(URL),pending=new Set();
      URL.revokeObjectURL=url=>{if(!pending.has(url))revoke(url)};
      HTMLAnchorElement.prototype.click=function(){if(this.download&&this.href.startsWith('blob:')){const url=this.href;pending.add(url);window.__folderExports.push((async()=>{const bitmap=await createImageBitmap(await(await fetch(url)).blob());const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;const ctx=c.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();const digest=await crypto.subtle.digest('SHA-256',ctx.getImageData(0,0,c.width,c.height).data);pending.delete(url);revoke(url);return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')})())}};
      document.querySelector('.format-btn[data-format="png"]').click();
    })()`);
    const exportHash=async()=>{
      await evaluate(`document.getElementById('exportSingleBtn').click()`);
      await waitFor('folder PNG export',`window.__folderExports.length>0&&!document.getElementById('exportSingleBtn').disabled`,120000);
      return evaluate(`window.__folderExports.shift()`);
    };
    const cached=await exportHash();
    await evaluate(`document.getElementById('analyzeRollBtn').click()`);
    await waitFor('uncached roll starts',`!!document.body.dataset.studioBusy`);
    await waitFor('uncached roll finishes',`!document.body.dataset.studioBusy`,120000);
    await wait(500);
    const uncached=await exportHash();
    if(cached!==uncached)fail('sample reuse changed exported PNG pixels: '+JSON.stringify({cached,uncached}));
    console.log('ok: cached and freshly decoded roll analysis export identical PNG pixels',cached);
  }

}
