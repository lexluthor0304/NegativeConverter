// Exact order statistics without a full sort.
//
// An order statistic (the k-th smallest value) is unique, so reading it by
// selection returns exactly what sorting and indexing would; the film
// statistics use this where they need only one or two quantiles of a column.
// Values must be comparable numbers (no NaN).

/**
 * k-th smallest (0-based) of values[0..n), partially reordering `values`:
 * afterwards everything before k is <= values[k] and everything after is >=.
 * Hoare partitioning with a median-of-three pivot.
 */
export function selectKth(values, k, n = values.length) {
  let left = 0;
  let right = n - 1;
  while (right > left) {
    const mid = (left + right) >> 1;
    const a = values[left], b = values[mid], c = values[right];
    const pivot = a < b ? (b < c ? b : (a < c ? c : a)) : (a < c ? a : (b < c ? c : b));
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const t = values[i]; values[i] = values[j]; values[j] = t;
        i++; j--;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return values[k];
  }
  return values[k];
}

/**
 * Smallest value in values[from..n), or undefined when the range is empty.
 * After selectKth(values, k, n) this is the (k + 1)-th smallest.
 */
export function minFrom(values, from, n = values.length) {
  if (from >= n) return undefined;
  let min = values[from];
  for (let i = from + 1; i < n; i++) if (values[i] < min) min = values[i];
  return min;
}
