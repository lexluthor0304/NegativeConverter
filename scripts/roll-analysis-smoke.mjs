// Roll analysis smoke: three synthetic strips are imported together. Two share
// the Ultra Max base (one with denser frames), the third is a Portra strip with
// a different base. "Analyse roll" must lock the two matching frames to one
// film base and one tone analysis, report the exposure offset of the denser
// frame, flag the Portra strip as an outlier with a badge, and "Clear roll
// analysis" must release the lock.
import { join } from 'node:path';

export async function runRollAnalysisSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['negative-strip-dx.png', 'negative-strip-dx-dark.png', 'negative-strip-other.png']
    .map((name) => join(root, 'negative2positive', 'test-fixtures', name));

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('roll analysis workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('analyzeRollBtn')`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__rollToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__rollToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);

  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  if (!input.result?.nodeId) fail('#fileInput not found');
  await send('DOM.setFileInputFiles', { files: fixtures, nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('roll strips imported', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png'`, 150_000);
  await wait(500);

  const before = await evaluate(`(() => ({
    groupVisible: document.getElementById('rollAnalysisGroup').style.display !== 'none',
    analyzeEnabled: !document.getElementById('analyzeRollBtn').disabled,
    clearEnabled: !document.getElementById('clearRollAnalysisBtn').disabled,
    status: document.getElementById('rollAnalysisStatus').textContent,
    selected: document.getElementById('fileListCount').textContent
  }))()`);
  console.log('roll analysis before:', JSON.stringify(before));
  if (!before.groupVisible || !before.analyzeEnabled || before.clearEnabled) fail('roll analysis controls not in the expected initial state: ' + JSON.stringify(before));

  await evaluate(`document.getElementById('analyzeRollBtn').click()`);
  await waitFor('roll analysis finished', `${ready} && /2\\/3 frames/.test(document.getElementById('rollAnalysisStatus').textContent)`, 180_000);
  await wait(1200);

  const after = await evaluate(`(() => ({
    status: document.getElementById('rollAnalysisStatus').textContent,
    frame: document.getElementById('rollAnalysisFrameStatus').textContent,
    filmBase: document.getElementById('filmBaseValues').textContent,
    badges: [...document.querySelectorAll('.file-list-item')].map((el) => [...el.querySelectorAll('.file-list-badge')].map((b) => b.className.replace('file-list-badge', '').trim() + ':' + b.textContent)),
    toasts: window.__rollToasts.slice(),
    clearEnabled: !document.getElementById('clearRollAnalysisBtn').disabled
  }))()`);
  console.log('roll analysis after:', JSON.stringify(after));
  if (!/2\/3 frames share one film base and tone analysis/.test(after.status)) fail('roll summary missing: ' + after.status);
  if (!/1 outlier\(s\): negative-strip-other\.png/.test(after.status)) fail('Portra strip was not flagged as the outlier: ' + after.status);
  if (!/This frame: locked to the roll, [+-]?\d\.\d stop/.test(after.frame)) fail('current frame is not locked to the roll: ' + after.frame);
  if (!after.toasts.some((t) => /Roll analysis: 2 of 3 frames locked, 1 outlier/.test(t))) fail('roll analysis toast missing: ' + JSON.stringify(after.toasts));
  if (!after.badges[2].some((b) => /roll-outlier/.test(b))) fail('outlier badge missing on the Portra strip: ' + JSON.stringify(after.badges));
  if (after.badges[0].some((b) => /roll-outlier/.test(b)) || after.badges[1].some((b) => /roll-outlier/.test(b))) fail('matching strips must not be flagged: ' + JSON.stringify(after.badges));
  if (!after.clearEnabled) fail('clear button stays disabled after an analysis');
  const rollBase = after.filmBase.match(/R: (\d+) G: (\d+) B: (\d+)/);
  if (!rollBase) fail('film base values missing after roll analysis: ' + after.filmBase);

  // The denser strip shares the roll base and carries a negative exposure offset.
  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('dark strip opened', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx-dark.png'`, 150_000);
  await wait(600);
  const dark = await evaluate(`(() => ({
    frame: document.getElementById('rollAnalysisFrameStatus').textContent,
    filmBase: document.getElementById('filmBaseValues').textContent
  }))()`);
  console.log('roll analysis dark strip:', JSON.stringify(dark));
  const darkBase = dark.filmBase.match(/R: (\d+) G: (\d+) B: (\d+)/);
  if (!darkBase || darkBase[1] !== rollBase[1] || darkBase[2] !== rollBase[2] || darkBase[3] !== rollBase[3]) fail('locked frames do not share the roll film base: ' + JSON.stringify({ rollBase: rollBase.slice(1), darkBase: darkBase && darkBase.slice(1) }));
  if (!/locked to the roll, -\d\.\d stop/.test(dark.frame)) fail('denser strip should carry a negative exposure offset: ' + dark.frame);

  // The Portra strip keeps its own analysis and says why.
  await evaluate(`document.querySelectorAll('.file-list-name')[2].click()`);
  await waitFor('other strip opened', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-other.png'`, 150_000);
  await wait(600);
  const other = await evaluate(`document.getElementById('rollAnalysisFrameStatus').textContent`);
  if (!/This frame: outlier \(film base colour\)/.test(other)) fail('outlier frame status missing: ' + other);

  // Clearing releases every frame.
  await evaluate(`document.getElementById('clearRollAnalysisBtn').click()`);
  await wait(800);
  const cleared = await evaluate(`(() => ({
    status: document.getElementById('rollAnalysisStatus').textContent,
    frame: document.getElementById('rollAnalysisFrameStatus').textContent,
    clearEnabled: !document.getElementById('clearRollAnalysisBtn').disabled,
    outlierBadges: document.querySelectorAll('.file-list-badge.roll-outlier').length
  }))()`);
  console.log('roll analysis cleared:', JSON.stringify(cleared));
  if (!/Not analysed yet/.test(cleared.status) || cleared.frame !== '' || cleared.clearEnabled || cleared.outlierBadges !== 0) fail('clear roll analysis did not reset the roll: ' + JSON.stringify(cleared));

  console.log('ok: roll analysis locks two matching strips to one base and tone analysis, offsets the denser strip, flags the Portra strip and clears cleanly');
}
