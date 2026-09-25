/**
 * Which photo a free background lane works on next (#243).
 *
 * Roll analysis and the lane tiles used to walk the import order: for a
 * folder import that is directory enumeration order (APFS hash order), so the
 * opened photo's display neighbours could sit anywhere in the pass. A lane now
 * pulls one job at a time, and the pick is recomputed every time, so it
 * follows navigation at once. For current display position k and direction of
 * travel d (+1 when unknown):
 *   1. k+d, the next photo in the direction of travel; for the prefetch need,
 *      the next photo in that direction without a retained session;
 *   2. k-d, the neighbour on the other side;
 *   3. photos whose tiles are visible;
 *   4. everything else, by display distance (the direction of travel first).
 *
 * Pure: the caller supplies the display order and the per-photo predicates.
 */

export const BACKGROUND_RANK = Object.freeze({ next: 1, previous: 2, visible: 3, rest: 4 });

/**
 * @param {object} input
 * @param {number[]} input.order queue indices in display order (review filter applied; photos it hides go last)
 * @param {number} input.current queue index of the current photo, or -1
 * @param {number} [input.direction] sign of the last display-order step, +1 when unknown
 * @param {Set<number>|{has(index: number): boolean}} [input.visible] queue indices with a visible tile
 * @param {(index: number) => string[]} input.needs a photo's decode needs other than prefetch ('analysis', 'tile')
 * @param {(index: number) => boolean} [input.hasSession] the photo's base is already retained (a session)
 * @param {(index: number) => boolean} [input.canPrefetch] the photo may be prefetched now
 * @param {(index: number) => boolean} [input.busy] another lane's job is on this photo's file
 * @returns {{ index: number, needs: string[], rank: number, distance: number } | null}
 */
export function pickBackgroundJob({
  order,
  current = -1,
  direction = 1,
  visible = null,
  needs,
  hasSession = () => false,
  canPrefetch = () => false,
  busy = () => false
}) {
  if (!Array.isArray(order) || !order.length || typeof needs !== 'function') return null;
  const d = direction < 0 ? -1 : 1;
  const k = order.indexOf(current);
  const at = position => (position >= 0 && position < order.length ? order[position] : undefined);

  // The prefetch target: the first photo past k in the direction of travel
  // that has no retained session.
  let prefetch;
  if (k >= 0) {
    for (let position = k + d; position >= 0 && position < order.length; position += d) {
      const index = order[position];
      if (hasSession(index)) continue;
      if (canPrefetch(index)) prefetch = index;
      break;
    }
  }
  const next = k >= 0 ? at(k + d) : undefined;
  const previous = k >= 0 ? at(k - d) : undefined;

  let best = null;
  for (let position = 0; position < order.length; position++) {
    const index = order[position];
    if (index === current || busy(index)) continue;
    const wanted = [...(needs(index) || [])];
    if (index === prefetch) wanted.push('prefetch');
    if (!wanted.length) continue;
    const distance = k >= 0 ? Math.abs(position - k) : position;
    const rank = index === next || index === prefetch ? BACKGROUND_RANK.next
      : index === previous ? BACKGROUND_RANK.previous
        : visible?.has?.(index) ? BACKGROUND_RANK.visible
          : BACKGROUND_RANK.rest;
    // Equal distance: the side the user is heading to first.
    const behind = k >= 0 && Math.sign(position - k) !== d ? 1 : 0;
    const key = [rank, distance, behind, position];
    if (!best || compareKeys(key, best.key) < 0) best = { index, needs: wanted, rank, distance, key };
  }
  if (!best) return null;
  const { key, ...job } = best;
  return job;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Direction of travel from one activation to the next: the sign of the
 * display-order step, or the previous direction when either photo is not in
 * the order (or they are the same).
 */
export function travelDirection(order, fromIndex, toIndex, previous = 1) {
  const from = order.indexOf(fromIndex);
  const to = order.indexOf(toIndex);
  if (from < 0 || to < 0 || from === to) return previous < 0 ? -1 : 1;
  return to > from ? 1 : -1;
}

/**
 * Display distance between two photos, Infinity when either is not shown.
 */
export function displayDistance(order, a, b) {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  return from < 0 || to < 0 ? Infinity : Math.abs(to - from);
}
