// Scenario registry. One file per scenario; child issues add theirs here
// (#230 "Related": the true-100 % zoom step, brush strokes, GPU-mode drags,
// export and encoder budgets, dust and merge memory runs, flush counters).
import s1 from './s1-import.mjs';
import s2 from './s2-sliders.mjs';
import s3 from './s3-curve.mjs';
import s4 from './s4-zoom.mjs';
import s5 from './s5-geometry.mjs';
import s6 from './s6-roll.mjs';
import s7 from './s7-navigation.mjs';
import s8 from './s8-lighttable.mjs';
import s9 from './s9-export.mjs';
import h from './h-hang.mjs';
import selftestHang from './selftest-hang.mjs';

export const SCENARIOS = Object.freeze({ s1, s2, s3, s4, s5, s6, s7, s8, s9, h, 'selftest-hang': selftestHang });

/** Scenario objects in run order; the hang self-test first when asked for. */
export function selectScenarios(ids, { injectHang = false } = {}) {
  const list = ids.map(id => {
    const scenario = SCENARIOS[id];
    if (!scenario) throw new Error(`unknown scenario ${id}`);
    return scenario;
  });
  return injectHang ? [selftestHang, ...list] : list;
}
