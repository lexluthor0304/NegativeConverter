// report.md for one benchmark run (results.json is the source of truth).

import { findMetricDef, formatTarget, meetsTarget, renderCompareMarkdown } from './compare.mjs';
import { formatSummary } from './stats.mjs';

function conditionsTable(conditions) {
  const rows = [
    ['Machine', `${conditions.cpuModel || ''} (${conditions.cores} cores, ${conditions.memoryGB} GB)`],
    ['OS', conditions.os],
    ['Browser', `${conditions.browser?.name || ''} ${conditions.browser?.version || ''}${conditions.browser?.headless ? ' headless' : ''}`],
    ['GPU', `${conditions.gpu || 'unknown'}${conditions.softwareGl ? ' (software GL)' : ''}`],
    ['DPR', (conditions.dprs || []).join(', ')],
    ['Fixtures', `${conditions.fixtureSet} — ${(conditions.fixtures || []).map(f => `${f.name} (${f.sha256 ? f.sha256.slice(0, 12) : 'no hash'})`).join(', ')}`],
    ['Load average (start / end)', `${(conditions.loadStart || []).map(v => v.toFixed(1)).join(' ')} / ${(conditions.loadEnd || []).map(v => v.toFixed(1)).join(' ')}${conditions.noisy ? ' — **noisy**' : ''}`],
    ['Power', conditions.power?.battery ? `${conditions.power.battery.source} (${conditions.power.battery.percent} %)` : 'unknown'],
    ['Thermal', conditions.power?.thermal ? `thermal ${conditions.power.thermal.thermalWarningLevel ?? '?'}, performance ${conditions.power.thermal.performanceWarningLevel ?? '?'}${conditions.power.thermal.cpuSpeedLimit ? `, CPU limit ${conditions.power.thermal.cpuSpeedLimit} %` : ''}` : 'unknown'],
    ['Swap used (start / end)', `${mb(conditions.swapStart)} / ${mb(conditions.swapEnd)} MB`],
    ['Probe', conditions.probe ? 'on' : 'off (control run)']
  ];
  return ['| item | value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}

function mb(bytes) {
  return Number.isFinite(bytes) ? Math.round(bytes / 1024 / 1024) : '?';
}

function metricTable(summary, budgets) {
  const lines = ['| metric | median (min–max) | target | vs target |', '|---|---|---|---|'];
  for (const [key, value] of Object.entries(summary || {})) {
    const def = findMetricDef(budgets, key);
    const met = value && 'median' in value ? meetsTarget(def, value.median) : null;
    lines.push(`| \`${key}\` | ${formatSummary(value)} | ${formatTarget(def)} | ${met === null ? '–' : met ? 'meets' : 'fails'} |`);
  }
  return lines.join('\n');
}

function hotTable(profile) {
  if (!profile?.threads?.length) return '';
  const lines = [`Profiled repetition: wall ${profile.wallMs} ms, Σ thread busy ${profile.busyTotalMs} ms, cores used ${profile.coresUsed ?? '–'}.`, ''];
  for (const thread of profile.threads.slice(0, 8)) {
    lines.push(`- **${thread.label || thread.name || `tid ${thread.tid}`}** (busy ${thread.busyMs} ms): ${thread.hot.slice(0, 8).map(entry => `\`${entry.label}\` ${entry.selfMs}`).join('; ') || '–'}`);
  }
  return lines.join('\n');
}

export function renderReport(results, budgets) {
  const out = [`# Interactive benchmark (${results.label || results.mode})`, ''];
  out.push(`Started ${results.startedAt}, finished ${results.finishedAt}. Harness v${results.harnessVersion}. Mode \`${results.mode}\`, browser \`${results.browser}\`, ${results.reps} repetitions + ${results.profile ? 'one profiled' : 'no profiled'} repetition.`, '');
  out.push('## Conditions', '', conditionsTable(results.conditions || {}), '');
  for (const run of results.runs || []) {
    out.push(`## ${run.label}: \`${run.sha?.slice(0, 12)}\`${run.dirty ? ' (uncommitted changes)' : ''}`, '');
    for (const [id, scenario] of Object.entries(run.scenarios || {})) {
      out.push(`### ${id.toUpperCase()} ${scenario.title || ''}`, '');
      if (scenario.status && scenario.status !== 'ok') out.push(`Status: **${scenario.status}**${scenario.detail ? ` — ${scenario.detail}` : ''}`, '');
      for (const [fixture, group] of Object.entries(scenario.fixtures || {})) {
        out.push(`#### ${fixture}`, '');
        const statuses = (group.reps || []).map(rep => rep.status).filter(status => status && status !== 'ok');
        if (statuses.length) out.push(`Repetition statuses: ${statuses.join(', ')}.`, '');
        if (group.routes?.length) out.push(`Film type / route per photo: ${group.routes.map(route => `${route.photo}: ${route.filmType ?? '?'} → ${route.route ?? '?'}`).join('; ')}.`, '');
        out.push(metricTable(group.summary, budgets), '');
        if (group.profile) out.push(hotTable(group.profile), '');
        if (group.loaf?.length) out.push(`Long animation frame scripts (first repetition): ${group.loaf.slice(0, 8).map(entry => `\`${entry.label}\` ${entry.ms} ms ×${entry.count}`).join('; ')}.`, '');
        if (group.workerTiming) out.push(`Worker queue / handling p50 (ms): ${Object.entries(group.workerTiming).map(([cls, entry]) => `${cls} ${entry.queueP50Ms} / ${entry.handleP50Ms}`).join('; ')}.`, '');
        if (group.notes?.length) out.push(...group.notes.map(note => `- ${note}`), '');
      }
    }
  }
  if (results.compare) {
    out.push('## Compare', '', renderCompareMarkdown(results.compare, { baseLabel: results.compare.baseLabel, headLabel: results.compare.headLabel }), '');
  }
  if (results.hangs?.length) {
    out.push('## Hang dumps', '', ...results.hangs.map(hang => `- ${hang.label}: silent ${Math.round(hang.info?.silentMs / 1000)} s; top frame ${hang.topFrame || 'none'} (\`${hang.file}\`)`), '');
  }
  return out.join('\n');
}
