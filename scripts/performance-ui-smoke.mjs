// Real DOM reuse, native IndexedDB precision/cleanup, and bundled dust worker.
export async function runPerformanceUiSmoke({ evaluate, fail }) {
  const result = await evaluate(`(async () => {
    const { renderFileList } = await import('/src/app/fileListView.js');
    const { createAnalysisSampleStore } = await import('/src/app/analysisSampleStore.js');
    const { detectDustInWorker, inpaintDustInWorker, disposeDustWorker } = await import('/src/app/dustWorkerClient.js');
    const container = document.createElement('div'), countEl = document.createElement('span');
    container.style.cssText = 'position:fixed;left:-10000px;top:0'; document.body.append(container);
    try {
      const items = Array.from({length:200}, (_,i) => ({id:i,file:{name:'frame-'+i+'.jpg'},selected:true,status:'pending'}));
      let opened = -1, toggled = -1;
      const options = {container,countEl,items,currentFileIndex:0,
        labels:{configured:'configured',customSettings:'Custom',unsaved:'Unsaved',statusText:s=>s},
        onOpenFile:i=>{opened=i},onToggleSelected:i=>{toggled=i}};
      renderFileList(options);
      const rows = [...container.children];
      const focus = rows[12].querySelector('input'); focus.focus();
      const start = performance.now();
      for(let i=0;i<100;i++) { items[3].selected=!items[3].selected; renderFileList(options); }
      const updateMs = performance.now()-start;
      const stable = rows.every((row,i)=>row===container.children[i]);
      const focusStable = document.activeElement===focus;
      items.reverse(); renderFileList({...options,currentFileIndex:199});
      rows[0].querySelector('.file-list-name').click();
      rows[0].querySelector('input').click();
      renderFileList({...options,visible:item=>item.id<10});
      const filtered = container.children.length;
      renderFileList(options);
      const restored = container.children.length===200 && container.lastElementChild===rows[0];
      const prior = (await indexedDB.databases()).map(db=>db.name);
      const sample = new ImageData(Uint8ClampedArray.from({length:32*20*4},(_,i)=>i%256),32,20);
      sample.__image16={width:32,height:20,data:Uint16Array.from({length:32*20*4},(_,i)=>(i*37)%65536)};
      const store=createAnalysisSampleStore({maxBytes:32*20*12*2});
      let exact=true, storeStats;
      try {
        for(let i=0;i<12;i++) await store.put('frame-'+i,sample);
        for(let pass=0;pass<2;pass++) for(let i=0;i<12;i++) {
          const read=await store.get('frame-'+i);
          exact &&= read?.width===32 && read.data.every((v,j)=>v===sample.data[j])
            && read.__image16?.data.every((v,j)=>v===sample.__image16.data[j]);
        }
        storeStats=store.stats;
      } finally { await store.clear(); }
      const cleaned = (await indexedDB.databases()).every(db=>prior.includes(db.name));
      const { encodePng16Blob, encodeTiffBlob } = await import('/src/app/exportImageEncoders.js');
      const { loadPngImageData, loadRawImageData } = await import('/src/app/imageFileLoaders.js');
      for(let i=3;i<sample.__image16.data.length;i+=4) sample.__image16.data[i]=65535;
      const scanner = [];
      for (const format of ['png','tiff']) {
        const blob = format==='png' ? encodePng16Blob(sample) : encodeTiffBlob(sample,16);
        const buffer=await blob.arrayBuffer();
        const decoded=format==='png' ? await loadPngImageData(buffer) : await loadRawImageData(buffer,'scan.tiff');
        scanner.push({format,transferred:buffer.byteLength===0,exact:decoded.__image16?.data.every((v,i)=>v===sample.__image16.data[i])});
      }
      const dustSource=new ImageData(new Uint8ClampedArray(256*256*4).fill(128),256,256);
      for(let i=3;i<dustSource.data.length;i+=4)dustSource.data[i]=255;
      for(let y=100;y<103;y++)for(let x=100;x<103;x++) {
        const p=(y*256+x)*4; dustSource.data[p]=dustSource.data[p+1]=dustSource.data[p+2]=255;
      }
      let dust;
      try {
        const detection=await detectDustInWorker(dustSource,{strength:50,maxParticleSize:32});
        const repaired=await inpaintDustInWorker(dustSource,detection.mask);
        dust={particles:detection.particleCount,maskPixels:detection.mask.reduce((n,v)=>n+(v>0),0),
          width:repaired.width,height:repaired.height,sourceIntact:dustSource.data.length===256*256*4};
      } finally {disposeDustWorker();}
      return {stable,focusStable,opened,toggled,filtered,restored,updateMs,exact,storeStats,cleaned,scanner,dust};
    } finally {container.remove();}
  })()`);
  console.log('performance UI:', JSON.stringify(result));
  if (!result.stable || !result.focusStable || result.opened !== 199 || result.toggled !== 199
    || result.filtered !== 10 || !result.restored) fail('file-list DOM identity/reorder/filter regression');
  if (!result.exact || !result.cleaned || result.storeStats.spilledEntries !== 10
    || result.storeStats.droppedSamples !== 0) fail('native IndexedDB spill/precision/cleanup regression');
  if (!result.scanner.every(scan=>scan.transferred && scan.exact)) fail('native PNG16/TIFF worker dispatch/precision regression');
  if (result.dust.width !== 256 || result.dust.height !== 256 || !result.dust.sourceIntact
    || result.dust.particles < 1) fail('bundled dust worker regression');
}
