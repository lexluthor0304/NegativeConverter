import assert from 'node:assert/strict';
import {
  routeCoreConversion, keepsFullPlaneOnDowngrade, fullResolutionIsStale,
  restoredFrameFlags, viewportRefreshBranch, repairsNeedSettling
} from './fullResolutionRouting.js';

// The routing predicate over its whole domain: large or small image, full or
// exact request, repairs on or off, separate display preview or not.
for (const large of [false, true]) {
  for (const wantsFull of [false, true]) {
    for (const exact of [false, true]) {
      for (const repairs of [false, true]) {
        for (const separatePreview of [false, true]) {
          const route = routeCoreConversion({ wantsFull, exact: wantsFull && exact, large, repairs, separatePreview });
          const label = JSON.stringify({ large, wantsFull, exact, repairs, separatePreview });
          // Only an exact request converts a >16 MP frame in full; repairs
          // escalate only a frame that is display-sized already.
          const expected = (wantsFull && (exact || !large)) || (repairs && !separatePreview);
          assert.equal(route.full, expected, label);
          assert.equal(route.downgraded, wantsFull && !expected, label);
        }
      }
    }
  }
}
// The cases the issue names.
assert.deepEqual(routeCoreConversion({ wantsFull: true, large: true, separatePreview: true }), { full: false, downgraded: true },
  'Undo, Reset and the engine controls above 16 MP convert the display preview');
assert.deepEqual(routeCoreConversion({ wantsFull: true, large: false, separatePreview: true }), { full: true, downgraded: false },
  '16 MP or less keeps today\'s routing');
assert.deepEqual(routeCoreConversion({ wantsFull: true, exact: true, large: true, separatePreview: true }), { full: true, downgraded: false },
  'export and the repair barriers still render the original');
assert.deepEqual(routeCoreConversion({ wantsFull: false, repairs: true, separatePreview: true }), { full: false, downgraded: false },
  'a slider tick with repairs on converts the preview');
assert.deepEqual(routeCoreConversion({ wantsFull: false, repairs: true, separatePreview: false }), { full: true, downgraded: false },
  'a display-sized frame with repairs still converts in full');
assert.deepEqual(routeCoreConversion(), { full: false, downgraded: false });

// Which downgraded requests keep the full plane.
assert.equal(keepsFullPlaneOnDowngrade({ repairs: false, aiBrush: false }), false);
assert.equal(keepsFullPlaneOnDowngrade({ repairs: true, aiBrush: false }), true);
assert.equal(keepsFullPlaneOnDowngrade({ repairs: false, aiBrush: true }), true);
assert.equal(keepsFullPlaneOnDowngrade({ repairs: true, aiBrush: true }), true);

// fullResolutionIsStale: flags, then the size guard.
const source = { width: 9536, height: 6336 };
const full = { width: 9536, height: 6336 };
const display = { width: 1809, height: 1202 };
assert.equal(fullResolutionIsStale({}), false);
assert.equal(fullResolutionIsStale({ processedImageDataIsPreview: true }), true);
assert.equal(fullResolutionIsStale({ fullResolutionPending: true }), true);
assert.equal(fullResolutionIsStale({ processedImageData: full, conversionSourceImageData: source }), false);
assert.equal(fullResolutionIsStale({ processedImageData: display, conversionSourceImageData: source }), true,
  'a display-sized plane flagged full resolution is stale');
assert.equal(fullResolutionIsStale({ processedImageData: full, conversionSourceImageData: null }), false);

// restoredFrameFlags: explicit previewOnly, then captured flags, then size.
assert.deepEqual(restoredFrameFlags({ frame: { previewOnly: false, fullResolutionPending: false },
  processedImageData: full, conversionSourceImageData: source }), { previewOnly: false, fullResolutionPending: false });
assert.deepEqual(restoredFrameFlags({ frame: { previewOnly: false, fullResolutionPending: true },
  processedImageData: full, conversionSourceImageData: source }), { previewOnly: false, fullResolutionPending: true },
'a full plane captured while a reprocess was pending stays owed');
assert.deepEqual(restoredFrameFlags({ frame: { previewOnly: true, fullResolutionPending: true },
  processedImageData: display, conversionSourceImageData: source }), { previewOnly: true, fullResolutionPending: true });
// A photo session swapped the plane for its preview: the caller's flag wins
// over flags captured before the swap, and the size agrees.
assert.deepEqual(restoredFrameFlags({ frame: { previewOnly: false, fullResolutionPending: true }, previewOnly: true,
  processedImageData: display, conversionSourceImageData: source }), { previewOnly: true, fullResolutionPending: true });
// Flags that contradict the size never restore a display-sized plane as full.
assert.deepEqual(restoredFrameFlags({ frame: { previewOnly: false, fullResolutionPending: false },
  processedImageData: display, conversionSourceImageData: source }), { previewOnly: true, fullResolutionPending: true });
assert.deepEqual(restoredFrameFlags({ previewOnly: false, processedImageData: display, conversionSourceImageData: source }),
  { previewOnly: true, fullResolutionPending: true });
// A snapshot without flags is inferred from its size.
assert.deepEqual(restoredFrameFlags({ processedImageData: full, conversionSourceImageData: source }),
  { previewOnly: false, fullResolutionPending: false });
assert.deepEqual(restoredFrameFlags({ processedImageData: display, conversionSourceImageData: source }),
  { previewOnly: true, fullResolutionPending: true });

// The three-way viewport refresh.
assert.equal(viewportRefreshBranch({ processedImageData: full }), 'resample');
assert.equal(viewportRefreshBranch({ processedImageData: full, repairs: true }), 'resample', 'settled repairs are resampled');
assert.equal(viewportRefreshBranch({ processedImageData: full, fullResolutionPending: true, repairs: true }), 'repair-pass');
assert.equal(viewportRefreshBranch({ processedImageData: display, processedImageDataIsPreview: true, repairs: true }), 'repair-pass');
assert.equal(viewportRefreshBranch({ processedImageData: full, fullResolutionPending: true }), 'reconvert');
assert.equal(viewportRefreshBranch({ processedImageData: display, processedImageDataIsPreview: true }), 'reconvert');
assert.equal(viewportRefreshBranch({}), 'reconvert');

// When an export waits for repairs.
const mask = new Uint8Array(4);
assert.equal(repairsNeedSettling({ repairs: false }), false);
assert.equal(repairsNeedSettling({ repairs: true, mask }), false);
assert.equal(repairsNeedSettling({ repairs: true, mask: null }), true, 'no mask yet');
assert.equal(repairsNeedSettling({ repairs: true, mask, maskStale: true }), true);
assert.equal(repairsNeedSettling({ repairs: true, mask, detectionScheduled: true }), true);
assert.equal(repairsNeedSettling({ repairs: true, mask, processing: true }), true);
assert.equal(repairsNeedSettling({ repairs: true, mask, pendingBrushRepairs: 1 }), true);

console.log('fullResolutionRouting: routing matrix, kept planes, stale flags and size guard, restored flags, viewport branches and export repair waits passed');
