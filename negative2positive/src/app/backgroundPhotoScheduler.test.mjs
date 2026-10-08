import assert from 'node:assert/strict';
import { pickBackgroundJob, travelDirection, displayDistance, BACKGROUND_RANK } from './backgroundPhotoScheduler.js';
import { orderedFileIndices } from './fileListOrder.js';

// A folder import in APFS hash order, shown newest first (modified-desc), which
// on the M11 roll matches descending names: L1000686 opens first (queue[0]).
const names = [];
for (let n = 640; n < 700; n++) names.push(`L1000${n}.DNG`);
// Deterministic "hash" order of the directory listing.
const hashed = names.map((name, i) => ({ name, key: (i * 7919 + 13) % 104729 })).sort((a, b) => a.key - b.key).map(entry => entry.name);
const opened = hashed.indexOf('L1000686.DNG');
hashed.splice(opened, 1);
hashed.unshift('L1000686.DNG');
const queue = hashed.map(name => ({ file: { name, lastModified: 1_700_000_000_000 + Number(name.slice(1, 8)) * 1000 } }));
const order = orderedFileIndices(queue, 'modified-desc');
const displayName = position => queue[order[position]].file.name;
assert.equal(displayName(0), 'L1000699.DNG', 'newest first');
const current = 0; // queue[0] = L1000686
const k = order.indexOf(current);
assert.equal(displayName(k), 'L1000686.DNG');

// Run the lane: every photo needs analysis until it is picked.
function drain({ direction = 1, visible = new Set(), limit = Infinity, start = current, remaining = null } = {}) {
  const pending = remaining || new Set(queue.map((_, index) => index).filter(index => index !== start));
  const picked = [];
  while (picked.length < limit) {
    const job = pickBackgroundJob({ order, current: start, direction, visible, needs: index => (pending.has(index) ? ['analysis'] : []) });
    if (!job) break;
    pending.delete(job.index);
    picked.push(job);
  }
  return { picked, pending };
}

// Direction +1 (towards older frames): k+1, k-1, visible tiles, then by distance.
{
  const visible = new Set([order[20], order[21], order[40]]);
  const { picked } = drain({ direction: 1, visible });
  const names = picked.map(job => queue[job.index].file.name);
  assert.equal(names[0], 'L1000685.DNG', 'priority 1: the next photo in the direction of travel');
  assert.equal(names[1], 'L1000687.DNG', 'priority 2: the other neighbour');
  assert.deepEqual(names.slice(2, 5), [displayName(20), displayName(21), displayName(40)].sort((a, b) => {
    const da = Math.abs(order.indexOf(queue.findIndex(q => q.file.name === a)) - k);
    const db = Math.abs(order.indexOf(queue.findIndex(q => q.file.name === b)) - k);
    return da - db;
  }), 'priority 3: visible tiles, nearest first');
  assert.deepEqual(picked.slice(0, 5).map(job => job.rank), [BACKGROUND_RANK.next, BACKGROUND_RANK.previous, 3, 3, 3]);
  const rest = picked.slice(5);
  for (let i = 1; i < rest.length; i++) assert.ok(rest[i].distance >= rest[i - 1].distance, 'the rest in ascending display distance');
  // Equal distance: the direction of travel first.
  const two = rest.filter(job => job.distance === 2).map(job => queue[job.index].file.name);
  assert.deepEqual(two, ['L1000684.DNG', 'L1000688.DNG']);
  assert.equal(picked.length, queue.length - 1, 'every photo is picked once');
  // Import order would have put the neighbours far down the list.
  assert.ok(queue.findIndex(q => q.file.name === 'L1000685.DNG') > 2 || queue.findIndex(q => q.file.name === 'L1000687.DNG') > 2);
}

// Direction -1 swaps the neighbours.
{
  const { picked } = drain({ direction: -1, limit: 4 });
  assert.deepEqual(picked.map(job => queue[job.index].file.name), ['L1000687.DNG', 'L1000685.DNG', 'L1000688.DNG', 'L1000684.DNG']);
}

// Re-prioritises on the next pick after the current photo changes (and the
// direction flips mid-run).
{
  const pending = new Set(queue.map((_, index) => index).filter(index => index !== current));
  const first = drain({ direction: 1, limit: 3, remaining: pending });
  assert.equal(queue[first.picked[0].index].file.name, 'L1000685.DNG');
  const newCurrent = queue.findIndex(q => q.file.name === 'L1000660.DNG');
  pending.delete(newCurrent);
  const after = drain({ direction: -1, limit: 3, start: newCurrent, remaining: pending });
  assert.deepEqual(after.picked.map(job => queue[job.index].file.name), ['L1000661.DNG', 'L1000659.DNG', 'L1000662.DNG']);
}

// The prefetch need: the next photo without a session, priority 1; the busy
// file is skipped; analysis and prefetch of the same photo are one job.
{
  const next = order[k + 1];
  const afterNext = order[k + 2];
  const job = pickBackgroundJob({ order, current, direction: 1, needs: () => [], hasSession: index => index === next, canPrefetch: () => true });
  assert.equal(job.index, afterNext, 'a neighbour with a session is skipped for prefetch');
  assert.deepEqual(job.needs, ['prefetch']);
  assert.equal(job.rank, BACKGROUND_RANK.next);
  const both = pickBackgroundJob({ order, current, direction: 1, needs: index => (index === next ? ['analysis'] : []), canPrefetch: () => true });
  assert.equal(both.index, next);
  assert.deepEqual(both.needs, ['analysis', 'prefetch'], 'one decode serves both needs');
  const skipped = pickBackgroundJob({ order, current, direction: 1, needs: () => ['tile'], busy: index => index === next });
  assert.equal(skipped.index, order[k - 1], 'never a second job on a file a lane is working on');
  // canPrefetch false (low memory, unsettled photo, slot already holds it): no prefetch need.
  assert.equal(pickBackgroundJob({ order, current, direction: 1, needs: () => [], canPrefetch: () => false }), null);
  // At the end of the order there is no next photo.
  const last = order.at(-1);
  const edge = pickBackgroundJob({ order, current: last, direction: 1, needs: () => ['tile'], canPrefetch: () => true });
  assert.equal(edge.index, order.at(-2));
  assert.deepEqual(edge.needs, ['tile']);
}

// A current photo outside the order (review filter): visible first, then display order.
{
  const job = pickBackgroundJob({ order: [5, 3, 9], current: 7, needs: () => ['tile'], visible: new Set([9]) });
  assert.equal(job.index, 9);
  const plain = pickBackgroundJob({ order: [5, 3, 9], current: 7, needs: () => ['tile'] });
  assert.equal(plain.index, 5);
}

assert.equal(travelDirection([4, 2, 8], 4, 8), 1);
assert.equal(travelDirection([4, 2, 8], 8, 2), -1);
assert.equal(travelDirection([4, 2, 8], 8, 99, -1), -1, 'unknown keeps the previous direction');
assert.equal(travelDirection([4, 2, 8], 8, 8), 1);
assert.equal(displayDistance([4, 2, 8], 4, 8), 2);
assert.equal(displayDistance([4, 2, 8], 4, 99), Infinity);

console.log('backgroundPhotoScheduler tests passed');
