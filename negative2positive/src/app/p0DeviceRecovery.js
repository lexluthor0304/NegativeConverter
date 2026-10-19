// Opt-in physical-device harness, loaded only by the existing P0 fixture plan.
// The host terminates and relaunches the app between prepared and pass. No
// browser IPC adapter is used; originals and checkpoints go through Rust.
export async function runDeviceRecovery({ plan, mobileRecovery, invoke, report,
  waitFor, studioSettled, importFixtures, exportCurrent, frameFacts, memorySnapshot, takeRawLog, errors }) {
  const id = plan.deviceRecovery;
  const key = `nc_device_recovery_${id}`;
  const timeout = plan.timeoutMs || 120_000;
  const saved = () => document.getElementById('mobileRecoveryStatus')?.dataset.status === 'saved';
  const count = () => document.querySelectorAll('.file-list-item').length;
  const exposure = () => Number(document.getElementById('coreExposure')?.value);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const select = async index => {
    const tile = document.querySelector(`.file-list-name[data-index="${index}"]`);
    assert(tile, `Missing photo ${index}`);
    tile.click();
    await waitFor(`photo ${index} ready`, () => studioSettled()
      && document.body.dataset.photoSwitching !== 'true' && !window.__ncTwoStage?.status?.()?.pending
      && document.querySelector('.file-list-item.active .file-list-name')?.dataset.index === String(index), timeout);
    await waitFor('photo checkpoint', saved, timeout);
  };
  const edit = async value => {
    const input = document.getElementById('coreExposure');
    assert(input, 'Missing exposure control');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(`exposure ${value} saved`, () => studioSettled() && saved() && exposure() === value, timeout);
  };
  try {
    assert(typeof id === 'string' && /^[a-z0-9-]{1,80}$/.test(id), 'Invalid device-test ID');
    const platform = await invoke('get_platform_info');
    assert(platform.os === 'ios' && platform.capabilities?.sourceRecovery && mobileRecovery,
      'This test requires the real iOS recovery bridge');
    // Reuse the editor's open promise. A second native open would revoke its
    // lease and invalidate the very editor this test needs to exercise.
    const record = await mobileRecovery.open();
    const marker = JSON.parse(localStorage.getItem(key) || 'null');
    if (!marker) {
      if (record.checkpoint?.sourceIds.length || count()) {
        const previous = plan.retryOf && JSON.parse(localStorage.getItem(`nc_device_recovery_${plan.retryOf}`) || 'null');
        // The host independently backs up and hashes every stored original
        // before installing this retry. Never clear native storage or accept
        // an arbitrary existing roll, even when a retry was requested.
        const knownSources = record.sources?.length > 0 && record.sources.length === record.checkpoint?.sourceIds.length
          && record.sources.every(source => plan.fixtures.some(f => f.file === source.name && f.size === source.size));
        if (previous?.phase !== 'preparing' || !knownSources || count()) {
          await report('device-recovery-blocked', { id, reason: 'Existing roll does not match the backed-up incomplete fixture test.' });
          return;
        }
        await report('device-recovery-retry', { id, previousId: plan.retryOf, sourceIds: record.checkpoint.sourceIds });
      }
      assert(plan.fixtures?.length >= 2, 'At least two fixtures are required');
      localStorage.setItem(key, JSON.stringify({ phase: 'preparing' }));
      // A file-input change starts a new roll. Import the complete selection
      // once, as the user does, then navigate the existing photo strip.
      const imported = await importFixtures(plan.fixtures, timeout);
      assert(imported.becameCurrent && count() === plan.fixtures.length, 'The complete fixture roll was not imported');
      await waitFor('originals saved', saved, timeout);
      await report('device-roll-imported', { id, ...imported, errors: errors.splice(0) });
      for (let index = 0; index < plan.fixtures.length; index++) {
        const fixture = plan.fixtures[index];
        await select(index);
        assert(document.getElementById('studioFilename')?.textContent === fixture.file, `Wrong active photo: ${fixture.file}`);
        assert(!window.__ncTwoStage?.status?.()?.provisional, `Only an embedded preview is ready: ${fixture.file}`);
        await report('device-imported', { id, index, file: fixture.file, rawLog: takeRawLog(),
          frame: frameFacts(), memory: memorySnapshot(), errors: errors.splice(0) });
        const exported = await exportCurrent(timeout);
        await report('device-exported', { id, index, file: fixture.file, ...exported, errors: errors.splice(0) });
      }
      await select(0); await edit(17);
      await select(1); await edit(31);
      await mobileRecovery.flush();
      const prepared = { phase: 'prepared', count: plan.fixtures.length, activeIndex: 1, exposure: [17, 31] };
      localStorage.setItem(key, JSON.stringify(prepared));
      await report('device-recovery-prepared', { id, ...prepared, memory: memorySnapshot() });
      return;
    }
    assert(marker.phase === 'prepared', `Incomplete or already completed test (${marker.phase}); existing data preserved`);
    assert(record.checkpoint?.sourceIds.length === marker.count, 'Original count changed across app restart');
    const project = JSON.parse(record.checkpoint.project);
    assert(record.checkpoint.activeIndex === marker.activeIndex, 'Active photo was not persisted');
    assert(project.files[0]?.settings?.coreExposure === 17 && project.files[1]?.settings?.coreExposure === 31,
      'Checkpoint lost applied edits');
    await waitFor('restore offered', () => document.getElementById('studioRestoreProject')?.hidden === false, timeout);
    document.getElementById('studioRestoreProject').click();
    await waitFor('restored editor', () => studioSettled() && count() === marker.count && exposure() === 31, timeout);
    await waitFor('restored checkpoint', saved, timeout);
    await select(0);
    assert(exposure() === 17, 'First photo lost its edit');
    const exported = await exportCurrent(timeout);
    await report('device-exported-after-restore', { id, ...exported, errors: errors.splice(0) });
    await select(1);
    assert(exposure() === 31, 'Second photo lost its edit');
    localStorage.setItem(key, JSON.stringify({ ...marker, phase: 'passed' }));
    await report('device-recovery-pass', { id, count: count(), exposure: exposure(),
      sourceIds: record.checkpoint.sourceIds, queueIds: record.checkpoint.queueIds,
      frame: frameFacts(), memory: memorySnapshot(), errors: errors.splice(0),
      interaction: 'Programmatic DOM controls on physical iOS; manual touch and WebContent termination remain separate.' });
  } catch (error) {
    await report('device-recovery-failed', { id, message: String(error?.message || error), stack: String(error?.stack || ''),
      photos: count(), filename: document.getElementById('studioFilename')?.textContent,
      errors: errors.splice(0) });
  }
}
