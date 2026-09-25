// Command line of `npm run bench:interactive -- …` (docs/performance-benchmark.md).

export const ALL_SCENARIOS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 'h'];
export const QUICK_SCENARIOS = ['s1', 's2', 's4', 's7'];

const VALUE_FLAGS = new Set([
  '--ref', '--head', '--against', '--scenarios', '--fixtures', '--film-type', '--reps', '--dpr',
  '--browser', '--roll-size', '--port', '--cdp-port', '--out', '--fixture', '--label'
]);
const BOOLEAN_FLAGS = new Set([
  '--quick', '--no-profile', '--no-probe', '--headful', '--allow-software-gl', '--inject-hang',
  '--force', '--allow-pixel-change', '--keep-worktree', '--help', '--verbose', '--record-baselines'
]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function list(value) {
  return String(value).split(',').map(part => part.trim()).filter(Boolean);
}

export function parseArgs(argv, env = process.env) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') {
      const base = argv[i + 1], head = argv[i + 2];
      if (!base || !head || base.startsWith('--') || head.startsWith('--')) throw new UsageError('--compare needs <baseRef> <headRef>');
      flags.compare = [base, head];
      i += 2;
    } else if (arg.includes('=') && arg.startsWith('--')) {
      const [name, ...rest] = arg.split('=');
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown option ${name}`);
      flags[name.slice(2)] = rest.join('=');
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length) throw new UsageError(`unexpected argument ${positional[0]}`);

  const quick = Boolean(flags.quick);
  let scenarios = flags.scenarios ? list(flags.scenarios).map(s => s.toLowerCase()) : (quick ? QUICK_SCENARIOS : ALL_SCENARIOS);
  scenarios = scenarios.filter(id => id !== 'm'); // M (memory) is sampled in every scenario
  const unknown = scenarios.filter(id => !ALL_SCENARIOS.includes(id));
  if (unknown.length) throw new UsageError(`unknown scenario ${unknown.join(', ')} (known: ${ALL_SCENARIOS.join(', ')}; m is always on)`);

  const fixtures = flags.fixtures || 'synthetic';
  if (!['synthetic', 'real'].includes(fixtures)) throw new UsageError('--fixtures must be synthetic or real');
  const filmType = flags['film-type'] || 'auto';
  if (!['auto', 'positive', 'bw', 'color'].includes(filmType)) throw new UsageError('--film-type must be auto, positive, bw or color');
  const browser = flags.browser || 'chrome';
  if (!['chrome', 'safari', 'tauri'].includes(browser)) throw new UsageError('--browser must be chrome, safari or tauri');
  const reps = flags.reps === undefined ? 3 : Number(flags.reps);
  if (!Number.isInteger(reps) || reps < 1) throw new UsageError('--reps must be a positive integer');
  const dprs = flags.dpr ? list(flags.dpr).map(Number) : (quick ? [2] : [1, 2]);
  if (dprs.some(dpr => ![1, 2].includes(dpr))) throw new UsageError('--dpr accepts 1 and/or 2');
  if (browser !== 'chrome' && dprs.includes(1) && flags.dpr) throw new UsageError('DPR 1 is Chrome-only; WebKit runs at the display DPR');
  const rollSize = flags['roll-size'] === undefined ? 12 : Number(flags['roll-size']);
  if (!Number.isInteger(rollSize) || rollSize < 2) throw new UsageError('--roll-size must be an integer >= 2');
  if (flags['no-probe'] && scenarios.some(id => !['s1', 's2'].includes(id))) {
    throw new UsageError('--no-probe control runs cover s1 and s2 (their probe-free control.* metrics); pass --scenarios s1,s2');
  }
  if (flags.compare && flags.against) throw new UsageError('use either --compare or --against');
  if (flags.compare && flags.head) throw new UsageError('--head selects the ref of a single run; with --compare pass refs');

  const port = Number(flags.port || env.NC_PERF_PORT || 5297);
  const cdpPort = Number(flags['cdp-port'] || env.NC_PERF_CDP_PORT || 9324);

  return {
    help: Boolean(flags.help),
    mode: flags.compare ? 'compare' : flags.against ? 'against' : 'run',
    ref: flags.ref || 'HEAD',
    headWorktree: flags.head || null,
    compare: flags.compare || null,
    against: flags.against || null,
    scenarios,
    quick,
    fixtures,
    fixture: flags.fixture || null,
    filmType,
    browser,
    reps,
    dprs,
    rollSize,
    profile: !flags['no-profile'],
    probe: !flags['no-probe'],
    headful: Boolean(flags.headful),
    allowSoftwareGl: Boolean(flags['allow-software-gl']),
    injectHang: Boolean(flags['inject-hang']),
    force: Boolean(flags.force),
    allowPixelChange: Boolean(flags['allow-pixel-change']),
    keepWorktree: Boolean(flags['keep-worktree']),
    recordBaselines: Boolean(flags['record-baselines']),
    verbose: Boolean(flags.verbose),
    out: flags.out || null,
    label: flags.label || null,
    port,
    cdpPort
  };
}

export const USAGE = `Usage: npm run bench:interactive -- [options]

  --scenarios s1,s2,…     subset of ${ALL_SCENARIOS.join(', ')} (M memory is always sampled)
  --quick                 S1, S2 at DPR 2, S4, S7; one fixture; 3 repetitions
  --fixtures synthetic|real   synthetic (default) or NC_PERF_RAW_DIR / NC_PERF_ROLL_DIR
  --fixture NAME          only this fixture (a synthetic name or a real basename)
  --film-type auto|positive|bw|color   pin the film type after import
  --reps N                unprofiled repetitions (default 3) plus one profiled
  --no-profile            skip the profiled repetition
  --no-probe              control run without the in-page probe or Debugger.enable
  --dpr 1,2               device pixel ratios (Chrome; default both)
  --ref REF               ref to build (default HEAD)
  --head WORKTREE         measure WORKTREE including uncommitted changes (git stash create)
  --compare BASE HEAD     build both refs, interleave repetitions, print the compare table
  --against results.json  compare this run with a saved one
  --browser chrome|safari|tauri
  --roll-size N           roll scenarios (default 12)
  --headful               headful Chrome
  --allow-software-gl     run (and label) on SwiftShader / software GL
  --inject-hang           prepend a hang self-test (60 s busy loop) to prove the watchdog
  --allow-pixel-change    do not fail --compare on export pixel differences
  --record-baselines      write this run's medians into scripts/perf/budgets.json
  --keep-worktree         keep the temporary worktree and build (debugging)
  --force                 skip the memory-pressure and free-disk pre-flight
  --port N --cdp-port N   preview and CDP ports (defaults 5297 / 9324)
  --out DIR               output directory (default output/perf/<UTC>-<sha>/)
`;
