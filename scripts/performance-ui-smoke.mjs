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
      const thumbnailChecks=[];
      const wasStudio=document.body.classList.contains('studio');
      const thumbnailContainer=document.createElement('div'), thumbnailCount=document.createElement('span');
      thumbnailContainer.style.cssText='position:fixed;left:-10000px;top:0';document.body.append(thumbnailContainer);
      try {
        const surface=document.createElement('canvas');surface.width=surface.height=2;
        const context=surface.getContext('2d');context.fillStyle='red';context.fillRect(0,0,2,2);
        const first=surface.toDataURL();context.fillStyle='blue';context.fillRect(0,0,2,2);const second=surface.toDataURL();
        for(const studio of [true,false]) {
          document.body.classList.toggle('studio',studio);
          const target={file:{name:'thumbnail.jpg'},selected:true,status:'pending'};
          const other={file:{name:'other.jpg'},selected:true,status:'pending'};
          const thumbnailItems=[target,other];let thumbnailOpened=-1,thumbnailToggled=-1;
          const thumbnailOptions={...options,container:thumbnailContainer,countEl:thumbnailCount,items:thumbnailItems,
            onOpenFile:i=>{thumbnailOpened=i},onToggleSelected:i=>{thumbnailToggled=i}};
          renderFileList(thumbnailOptions);
          let row=thumbnailContainer.firstElementChild, checkbox=row.querySelector('input'), name=row.querySelector('.file-list-name');
          const verify=(scenario,expected,focus,extra=true)=>{
            const index=thumbnailItems.indexOf(target), preview=name.querySelector('.file-list-thumbnail');
            const placeholder=name.querySelector('.file-list-placeholder');
            const stable=thumbnailContainer.children[index]===row && row.querySelector('input')===checkbox && row.querySelector('.file-list-name')===name;
            const focused=document.activeElement===focus;
            const correct=studio ? expected ? preview?.getAttribute('src')===expected && !placeholder
              : !preview && placeholder?.textContent===String(index+1).padStart(2,'0') && placeholder.getAttribute('aria-hidden')==='true'
              : !preview && !placeholder && name.textContent==='thumbnail.jpg';
            thumbnailChecks.push({scenario,studio,stable,focused,correct,extra,passed:stable&&focused&&correct&&extra});
            // Rebase the next case on the live DOM even when this one fails, so
            // direct updates and out-of-band updates are independently checked.
            row=thumbnailContainer.children[index];checkbox=row.querySelector('input');name=row.querySelector('.file-list-name');
          };
          checkbox.focus();target.thumbnail=first;renderFileList(thumbnailOptions);
          verify('direct addition',first,checkbox);
          const image=name.querySelector('.file-list-thumbnail');
          name.focus();target.thumbnail=second;renderFileList(thumbnailOptions);
          verify('direct replacement',second,name,!studio||name.querySelector('.file-list-thumbnail')===image);
          checkbox.focus();target.thumbnail=null;renderFileList(thumbnailOptions);
          verify('direct removal',null,checkbox);
          if(studio) {
            // Mirror main.js updateFileThumbnail: it writes item.thumbnail and
            // the DOM before the next selection/list render can update its cache.
            target.thumbnail=first;
            const inserted=document.createElement('img');inserted.className='file-list-thumbnail';inserted.alt='';inserted.src=first;
            name.querySelector('.file-list-placeholder')?.replaceWith(inserted);
            name.focus();
            const observer=new MutationObserver(()=>{});observer.observe(name,{attributes:true,subtree:true});
            other.selected=!other.selected;renderFileList(thumbnailOptions);
            const additionWrites=observer.takeRecords().filter(record=>record.attributeName==='src').length;
            verify('out-of-band addition',first,name,name.querySelector('.file-list-thumbnail')===inserted && additionWrites===0);
            observer.disconnect();
            const updatedImage=name.querySelector('.file-list-thumbnail');
            target.thumbnail=second;updatedImage.src=second;
            observer.observe(name,{attributes:true,subtree:true});
            checkbox.focus();renderFileList(thumbnailOptions);
            const replacementWrites=observer.takeRecords().filter(record=>record.attributeName==='src').length;
            verify('out-of-band replacement',second,checkbox,name.querySelector('.file-list-thumbnail')===updatedImage && replacementWrites===0);
            renderFileList(thumbnailOptions);
            verify('unchanged thumbnail',second,checkbox,observer.takeRecords().every(record=>record.attributeName!=='src'));
            observer.disconnect();
          } else {
            target.thumbnail=second;renderFileList(thumbnailOptions);verify('nonstudio thumbnail update',second,checkbox);
          }
          thumbnailItems.reverse();renderFileList({...thumbnailOptions,currentFileIndex:1});
          name.click();checkbox.click();
          verify('reorder with thumbnail',target.thumbnail,checkbox,thumbnailOpened===1 && thumbnailToggled===1
            && checkbox.dataset.index==='1' && name.dataset.index==='1');
          target.thumbnail=null;name.focus();renderFileList(thumbnailOptions);
          verify('removal after reorder',null,name);
        }
      } finally {document.body.classList.toggle('studio',wasStudio);thumbnailContainer.remove();}
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
      return {stable,focusStable,opened,toggled,filtered,restored,updateMs,thumbnailChecks,exact,storeStats,cleaned,scanner,dust};
    } finally {container.remove();}
  })()`);
  console.log('performance UI:', JSON.stringify(result));
  if (!result.stable || !result.focusStable || result.opened !== 199 || result.toggled !== 199
    || result.filtered !== 10 || !result.restored) fail('file-list DOM identity/reorder/filter regression');
  if (!result.thumbnailChecks.every(check=>check.passed)) fail('thumbnail update rebuilt rows or changed focus/src: '+JSON.stringify(result.thumbnailChecks.filter(check=>!check.passed)));
  if (!result.exact || !result.cleaned || result.storeStats.spilledEntries !== 10
    || result.storeStats.droppedSamples !== 0) fail('native IndexedDB spill/precision/cleanup regression');
  if (!result.scanner.every(scan=>scan.transferred && scan.exact)) fail('native PNG16/TIFF worker dispatch/precision regression');
  if (result.dust.width !== 256 || result.dust.height !== 256 || !result.dust.sourceIntact
    || result.dust.particles < 1) fail('bundled dust worker regression');
}
