// Every type/mode, ownership and pending/applied crop event with rescue OFF.
const priorCase = process.env.NC229_HISTORY_CASE;
const priorRescue = process.env.NC229_HISTORY_CROP_RESCUE;
process.env.NC229_HISTORY_CASE = 'crop-events';
process.env.NC229_HISTORY_CROP_RESCUE = 'off';
try {
  await import('./interpretationHistory.test.mjs');
} finally {
  if (priorCase === undefined) delete process.env.NC229_HISTORY_CASE;
  else process.env.NC229_HISTORY_CASE = priorCase;
  if (priorRescue === undefined) delete process.env.NC229_HISTORY_CROP_RESCUE;
  else process.env.NC229_HISTORY_CROP_RESCUE = priorRescue;
}
