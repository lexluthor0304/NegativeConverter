// The renderer-wide memory budget (#258), on the real app with small fixtures
// in Chrome (`?debug=1` exposes window.__ncMemory):
//
// 1. With localStorage nc_memory_ram_gib_v1 = 32 the budget is sized from
//    that RAM (14 GiB). Importing three negatives and switching photos
//    reserves each opened photo in the foreground and every lane frame in the
//    background. Replaying the grant/release log: no user or background grant
//    while a foreground reservation is out, and none that takes reserved +
//    retained over the budget except under the progress rule. Once the page
//    settles nothing is reserved or waiting, the ledger counts the open photo,
//    and the idle check (run by hand; Chrome has no WebKit purge) keeps the
//    open photo.
// 2. With a budget far below one frame (nc_memory_ram_gib_v1 = 0.0005), the
//    same import still finishes every conversion and tile: the progress rule
//    admits one user or background item at a time, never two, never none.
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const FIXTURES = ['negative-textured.png', 'negative-vignetted.png', 'negative-plain.png'];
const RAM_KEY = 'nc_memory_ram_gib_v1';
const GIB = 1024 ** 3;

// Replays the budget's event log; returns the violations.
function checkMemoryLog(events) {
  const problems = [];
  let foreground = 0;
  let jobs = 0;
  let peakJobs = 0;
  for (const event of events) {
    if (event.type === 'grant') {
      if (event.priority === 'foreground') foreground += 1;
      else {
        if (foreground > 0) problems.push(`job granted during a foreground reservation: ${event.label}`);
        jobs += 1;
        peakJobs = Math.max(peakJobs, jobs);
        if (event.rule !== 'progress' && event.reserved + event.retained > event.budget) {
          problems.push(`grant over budget without the progress rule: ${JSON.stringify(event)}`);
        }
        if (event.rule === 'progress' && jobs > 1) problems.push(`progress grant with other jobs out: ${event.label}`);
      }
    } else if (event.type === 'release') {
      if (event.priority === 'foreground') foreground -= 1;
      else jobs -= 1;
    }
  }
  return { problems, peakJobs, foregroundGrants: events.filter(e => e.type === 'grant' && e.priority === 'foreground').length,
    jobGrants: events.filter(e => e.type === 'grant' && e.priority !== 'foreground').length };
}

export async function runMemoryBudgetSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const paths = FIXTURES.map(name => join(root, 'negative2positive', 'test-fixtures', name));
  const boot = async (ramGib) => {
    await evaluate(`localStorage.setItem('${RAM_KEY}', '${ramGib}')`);
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
    await waitFor('memory-budget workspace boot', `performance.timeOrigin !== ${origin} && document.readyState === 'complete'
      && !!document.getElementById('studioImportAutoCrop') && !!window.__ncMemory`);
    await installDialogAutoAccept();
  };
  const importFixtures = async (label) => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    await waitFor(label, `${ready} && document.querySelectorAll('.file-list-name').length === 3
      && document.querySelectorAll('.file-list-name[data-preview-state="ready"]').length === 3`, 180_000);
  };
  const settled = `(() => { const s = window.__ncMemory.snapshot(); return !s.outstanding.length && !s.waiting.length; })()`;

  try {
    // ---- 1. 32 GiB: sizing, reservations, the log, the ledger, the idle check ----
    await boot(32);
    const sized = await evaluate(`window.__ncMemory.snapshot()`);
    if (sized.ramSource !== 'override' || sized.ramBytes !== 32 * GIB) fail('the RAM override was not read: ' + JSON.stringify(sized));
    if (sized.baseBudget !== 14 * GIB || sized.budget !== 14 * GIB) fail('32 GiB must give a 14 GiB budget: ' + JSON.stringify(sized));
    await evaluate(`window.__ncMemory.clearLog()`);
    await importFixtures('three negatives converted (32 GiB)');
    await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
    await waitFor('second photo open', `${ready} && document.getElementById('studioFilename').textContent === '${FIXTURES[1]}'`, 60_000);
    await evaluate(`document.querySelector('.file-list-name[data-index="0"]').click()`);
    await waitFor('first photo open again', `${ready} && document.getElementById('studioFilename').textContent === '${FIXTURES[0]}'`, 60_000);
    await waitFor('memory budget settled', settled, 60_000);
    const log = await evaluate(`window.__ncMemory.log()`);
    const replay = checkMemoryLog(log);
    const snapshot = await evaluate(`window.__ncMemory.snapshot()`);
    console.log('memory-budget 32 GiB:', JSON.stringify({ ...replay, events: log.length, ledger: snapshot.ledger, reserved: snapshot.reserved }));
    if (replay.problems.length) fail('memory log violations:\n' + replay.problems.join('\n'));
    if (replay.foregroundGrants < 1) fail('opening a photo reserved nothing in the foreground');
    if (!(snapshot.ledger?.editor > 0)) fail('the ledger does not count the open photo: ' + JSON.stringify(snapshot.ledger));
    for (const key of ['editor', 'sessions', 'previews', 'history', 'stores', 'jobs', 'workers']) {
      if (!(key in (snapshot.ledger || {}))) fail(`the ledger has no ${key} consumer`);
    }
    if (snapshot.reserved !== 0) fail('reservations left behind: ' + JSON.stringify(snapshot.outstanding));
    const idle = await evaluate(`(() => { const result = window.__ncMemory.runIdleCheck(); return { result, name: document.getElementById('studioFilename').textContent,
      editor: window.__ncMemory.snapshot().ledger.editor }; })()`);
    console.log('memory-budget idle check:', JSON.stringify(idle));
    if (idle.name !== FIXTURES[0] || !(idle.editor > 0)) fail('the idle check touched the open photo: ' + JSON.stringify(idle));
    console.log('ok: the budget is sized from RAM, photos reserve in the foreground, lanes wait for them and fit the budget, and nothing stays reserved');

    // ---- 2. A budget below one frame: one item at a time, never a stall ----
    await boot(0.0005);
    await evaluate(`window.__ncMemory.clearLog()`);
    await importFixtures('three negatives converted (tiny budget)');
    await waitFor('memory budget settled (tiny)', settled, 60_000);
    const tiny = checkMemoryLog(await evaluate(`window.__ncMemory.log()`));
    console.log('memory-budget tiny:', JSON.stringify(tiny));
    if (tiny.problems.length) fail('memory log violations under a tiny budget:\n' + tiny.problems.join('\n'));
    if (tiny.peakJobs > 1) fail('a budget below one frame must admit one job item at a time: ' + tiny.peakJobs);
    console.log('ok: under a budget below one frame every photo still converts, one job item at a time');
  } finally {
    await evaluate(`localStorage.removeItem('${RAM_KEY}')`).catch(() => {});
  }
}
