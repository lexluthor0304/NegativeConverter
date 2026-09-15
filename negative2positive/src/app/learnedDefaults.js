// One observation per roll, with per-frame medians to prevent a large roll
// or repeated exports from outweighing the photographer's other rolls.
export const LEARNING_VERSION = 1;
export const LEARNED_NUMERIC_KEYS = ['coreTemperature', 'coreTint', 'coreCyan', 'coreSaturation', 'coreBrightness', 'coreContrast', 'coreShadows', 'coreHighlights', 'temperature', 'tint', 'cyan', 'saturation', 'vibrance', 'exposure', 'contrast', 'shadows', 'highlights'];
export const LEARNED_CATEGORY_KEYS = ['coreFilmPreset', 'corePaper', 'coreEnhancedProfile'];
const median = list => { const sorted = [...list].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
export function learnedDefaultsKey(settings, roll = {}) {
  return JSON.stringify([String(settings.filmEdge?.filmName || roll.stock || settings.coreFilmPreset || 'generic').trim().toUpperCase(), String(roll.lab || '').trim().toLowerCase(), settings.filmType || 'color']);
}
export function learnedDelta(automatic, final, touched = []) {
  const result = {};
  for (const key of touched) {
    if (LEARNED_NUMERIC_KEYS.includes(key) && Number.isFinite(final[key]) && Number.isFinite(automatic[key]) && final[key] !== automatic[key]) result[key] = Math.max(-50, Math.min(50, final[key] - automatic[key]));
    if (LEARNED_CATEGORY_KEYS.includes(key) && typeof final[key] === 'string' && final[key] !== automatic[key]) result[key] = final[key].slice(0, 80);
  }
  return result;
}
export function recordLearnedObservation(record, { key, rollId, frameId, delta }) {
  if (!rollId || !frameId || !Object.keys(delta).length) return record || null;
  const next = sanitizeLearnedRecord(record) || { version: LEARNING_VERSION, key, rolls: [] };
  let roll = next.rolls.find(entry => entry.id === rollId);
  if (!roll) { roll = { id: rollId, frames: {} }; next.rolls.push(roll); }
  roll.frames[frameId] = delta;
  next.rolls = next.rolls.slice(-32);
  return next;
}
export function sanitizeLearnedRecord(record) {
  if (record?.version !== LEARNING_VERSION || typeof record.key !== 'string' || !Array.isArray(record.rolls)) return null;
  const rolls = record.rolls.slice(-32).filter(r => typeof r.id === 'string' && r.frames && typeof r.frames === 'object').map(r => ({ id: r.id.slice(0, 80), frames: Object.fromEntries(Object.entries(r.frames).slice(-72).map(([id, delta]) => [id, Object.fromEntries(Object.entries(delta || {}).filter(([k, v]) => LEARNED_NUMERIC_KEYS.includes(k) ? Number.isFinite(v) && Math.abs(v) <= 50 : LEARNED_CATEGORY_KEYS.includes(k) && typeof v === 'string' && v.length <= 80))])) }));
  return { version: LEARNING_VERSION, key: record.key.slice(0, 500), rolls };
}
export function estimateLearnedDefaults(record, { shrinkage = 3 } = {}) {
  const safe = sanitizeLearnedRecord(record);
  if (!safe) return { n: 0, offsets: {}, choices: {} };
  const offsets = {}, choices = {};
  for (const key of LEARNED_NUMERIC_KEYS) {
    const values = safe.rolls.map(roll => Object.values(roll.frames).map(d => d[key]).filter(Number.isFinite)).filter(v => v.length).map(median);
    if (values.length) offsets[key] = Math.max(-25, Math.min(25, median(values) * values.length / (values.length + shrinkage)));
  }
  for (const key of LEARNED_CATEGORY_KEYS) {
    const votes = safe.rolls.map(roll => {
      const counts = new Map();
      for (const frame of Object.values(roll.frames)) if (typeof frame[key] === 'string') counts.set(frame[key], (counts.get(frame[key]) || 0) + 1);
      const list = [...counts].sort((a, b) => b[1] - a[1]);
      return list.length && list[0][1] > [...counts.values()].reduce((a, b) => a + b, 0) / 2 ? list[0][0] : null;
    }).filter(Boolean);
    if (votes.length < 3) continue;
    const counts = new Map(); for (const vote of votes) counts.set(vote, (counts.get(vote) || 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best[1] >= 3 && best[1] / votes.length >= 0.67) choices[key] = best[0];
  }
  return { n: safe.rolls.length, offsets, choices };
}
export function applyLearnedDefaults(settings, record) {
  const estimate = estimateLearnedDefaults(record);
  if (!estimate.n || settings.learnedDefaults) return settings;
  const next = { ...settings, ...estimate.choices, learnedDefaults: { key: record.key, n: estimate.n } };
  for (const [key, offset] of Object.entries(estimate.offsets)) if (Number.isFinite(next[key])) next[key] += offset;
  return next;
}
