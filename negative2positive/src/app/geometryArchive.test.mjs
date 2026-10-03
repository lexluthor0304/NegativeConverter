import assert from 'node:assert/strict';
import { createDustHistoryArchive } from './dustHistoryArchive.js';
import { archiveDatabaseFixture } from './dustHistoryArchiveHarness.mjs';
import { createHarness, makeBase, samePixels, exportChain } from './geometryTestHarness.mjs';
import { encodeTiffBlob, encodePng16Blob } from './exportImageEncoders.js';
import { decodeTiffBuffer } from './tiffFileLoader.js';
import { markDerivedEightBit, hasDerivedEightBit } from './crossOriginIsolation.js';

// Actual geometry construction and frame-sampling callers, including real
// low sample bits which cannot survive an 8-bit round trip.
for (const angle of [90, 17.3]) {
  for (const materialized of [false, true]) {
    const base = makeBase(8, 6, 37), h = createHarness(base), c = h.context;
    const settings = { rotationAngle: angle, mirrored: true, cropRegion: { left: 1, top: 1, width: 4, height: 3 } };
    c.restoreSettings(settings); await h.state.geometryReady;
    const frame = h.state.originalImageData, cropped = h.state.croppedImageData;
    assert.ok(frame.__geometryFrame, 'a crop keeps a real lazy frame');
    const sample = c.renderFrameSample(12, { with16: true });
    const pixels = materialized ? c.materializeGeometryFrame(frame.__geometryFrame) : null;
    const syncReads = h.target.geometryDiagnostics.frameSyncReads;
    const tiff = await encodeTiffBlob(cropped, 16).arrayBuffer();
    const png = await encodePng16Blob(cropped).arrayBuffer();
    const db = archiveDatabaseFixture();
    const archive = createDustHistoryArchive({ indexedDB: db.indexedDB, chunkBytes: 32,
      createGeometryFrame: (...args) => c.createGeometryFrame(...args),
      geometryKeyOf: image => h.target.geometryMemo.get(image),
      restoreGeometryKey: (image, key) => h.target.geometryMemo.set(image, key) });
    const key = await archive.save({ frame, alias: frame, recipe: frame.__geometryFrame, pixels, cropped }, { base });
    assert.equal(h.target.geometryDiagnostics.frameSyncReads, syncReads, 'storage never materializes a lazy frame');
    const restored = await archive.load(key, { base });
    assert.ok(restored.frame.__geometryFrame, 'restore retains the geometry descriptor');
    assert.equal(restored.frame, restored.alias);
    assert.equal(restored.frame.__geometryFrame, restored.recipe, 'recipe aliases are preserved too');
    assert.equal(restored.recipe.base, base, 'the retained base is never duplicated');
    assert.equal(restored.recipe.pixels, restored.pixels, 'existing pixels keep their aliases');
    assert.equal(Object.getOwnPropertyDescriptor(restored.frame, '__image16').enumerable, false);
    h.state.originalImageData = restored.frame; h.state.croppedImageData = restored.cropped;
    samePixels(c.renderFrameSample(12, { with16: true }), sample, 'restored with16 frame sample');
    samePixels(restored.cropped, exportChain(base, settings), 'restored rotated/mirrored/cropped export source');
    assert.equal(c.sameGeometryKey(c.installedGeometryKey(), restored.recipe.key), true, 'installed geometry memo survives');
    assert.deepEqual(await encodeTiffBlob(restored.cropped, 16).arrayBuffer(), tiff, 'TIFF16 encoded bytes are exact');
    assert.deepEqual(await encodePng16Blob(restored.cropped).arrayBuffer(), png, 'PNG16 encoded bytes are exact');
    // The existing 16-bit file format exports RGB with opaque alpha. Every
    // colour sample, including its low bits, must round-trip unchanged.
    const decoded = decodeTiffBuffer(tiff);
    assert.deepEqual([...decoded.__image16.data], [...cropped.__image16.data].map((v, i) => i % 4 === 3 ? 65535 : v),
      'TIFF16 decodes all colour sample bits exactly');
    assert.equal(h.target.geometryDiagnostics.frameSyncReads, syncReads, 'sample and crop export do not materialize the whole frame');
    if (materialized) {
      samePixels(c.materializeGeometryFrame(restored.recipe), pixels, 'pre-existing full frame planes');
      assert.equal(restored.frame.data, restored.pixels.data);
      assert.equal(restored.frame.__image16, restored.pixels.__image16);
    } else assert.equal(restored.recipe.pixels, null);
    assert.ok([...db.records.values()].filter(ArrayBuffer.isView).every(chunk => chunk.byteLength <= 32));
    await archive.remove(key);
  }
}
{
  const db = archiveDatabaseFixture(), h = createHarness(makeBase(8, 6));
  const c = h.context, base = h.state.loadedBaseImageData;
  const before = { rotationAngle: 17.3, mirrored: false, cropRegion: { left: 1, top: 1, width: 4, height: 3 } };
  c.restoreSettings(before); await h.state.geometryReady;
  await c.applyMirror();
  await h.state.geometryReady;
  const after = { rotationAngle: h.state.rotationAngle, mirrored: h.state.mirrored, cropRegion: { ...h.state.cropRegion } };
  const archive = createDustHistoryArchive({ indexedDB: db.indexedDB,
    createGeometryFrame: (...args) => c.createGeometryFrame(...args),
    geometryKeyOf: image => h.target.geometryMemo.get(image),
    restoreGeometryKey: (image, key) => h.target.geometryMemo.set(image, key) });
  const key = await archive.save({ current: c.captureSnapshot('park'), undo: h.target.undoStack, redo: h.target.redoStack }, { base });
  const restored = await archive.load(key, { base });
  h.target.undoStack.splice(0, h.target.undoStack.length, ...restored.undo);
  h.target.redoStack.splice(0, h.target.redoStack.length, ...restored.redo);
  await c.restoreSnapshot(restored.current, { reprocess: false });
  const jobs = h.jobs();
  await c.performUndo();
  samePixels(h.state.croppedImageData, exportChain(base, before), 'archived geometry undo');
  await c.performRedo();
  samePixels(h.state.croppedImageData, exportChain(base, after), 'archived geometry redo');
  assert.equal(h.jobs(), jobs, 'hot geometry history remains reference swaps');
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0);
  await archive.remove(key);
}
{
  const frame = makeBase(4, 3, 43), plane = frame.__image16;
  Object.defineProperty(frame, '__image16', { value: plane, enumerable: false, configurable: true });
  markDerivedEightBit(frame);
  const db = archiveDatabaseFixture(), archive = createDustHistoryArchive({ indexedDB: db.indexedDB });
  const key = await archive.save({ frame, plane, bytes: plane.data, view: new Uint8Array(plane.data.buffer, 2, 4) });
  const restored = await archive.load(key);
  samePixels(restored.frame, frame, 'ordinary nonenumerable precision');
  assert.equal(restored.frame.__image16, restored.plane);
  assert.equal(restored.plane.data, restored.bytes);
  assert.equal(restored.view.buffer, restored.bytes.buffer);
  assert.equal(Object.getOwnPropertyDescriptor(restored.frame, '__image16').enumerable, false);
  assert.equal(hasDerivedEightBit(restored.frame), true, 'the geometry sampling rule is preserved');
  await archive.remove(key);
}
{
  const h = createHarness(makeBase(8, 6)), c = h.context;
  c.restoreSettings({ rotationAngle: 90, cropRegion: { left: 1, top: 1, width: 4, height: 3 } });
  await h.state.geometryReady;
  const db = archiveDatabaseFixture(), archive = createDustHistoryArchive({ indexedDB: db.indexedDB });
  await assert.rejects(archive.save({ frame: h.state.originalImageData }), /Geometry history restoration is unavailable/);
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0, 'unsupported restoration must fail without touching lazy pixels');
  assert.equal(db.records.size, 0);
}
console.log('geometryArchive: lazy rotated/mirrored/cropped 16-bit samples, exact export sources and materialized aliases passed');
