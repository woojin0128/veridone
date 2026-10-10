// Veridone — human/agent readable summaries of a session ledger.

import { oneLine, approxTokens, formatNumber } from './util.mjs';
import { describeCommands } from './project.mjs';
import { CATEGORIES } from './verify.mjs';

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 90e3) return `${Math.max(1, Math.round(ms / 1e3))}s ago`;
  if (ms < 90 * 60e3) return `${Math.round(ms / 60e3)} min ago`;
  if (ms < 48 * 3600e3) return `${Math.round(ms / 3600e3)} h ago`;
  return `${Math.round(ms / 86400e3)} d ago`;
}

/** Was a file edited between two verification runs? */
function lastEditAfter(state, fromAt, toAt) {
  return state.edits.some((e) => e.at > fromAt && e.at <= toAt);
}

export function verificationStatus(state, project) {
  const out = {};
  const lastEdit = state.edits.length ? state.edits[state.edits.length - 1].at : null;
  for (const cat of CATEGORIES) {
    const runs = state.verifications.filter((v) => v.category === cat);
    // newest conclusive run; an inconclusive (filtered) run only if nothing newer or conclusive exists
    let last = runs[runs.length - 1] || null;
    if (last && last.ok !== true && last.ok !== false) {
      for (let i = runs.length - 2; i >= 0; i--) {
        if ((runs[i].ok === true || runs[i].ok === false) && !(lastEditAfter(state, runs[i].at, last.at))) { last = runs[i]; break; }
      }
    }
    out[cat] = {
      available: !!project?.commands?.[cat],
      command: project?.commands?.[cat] || null,
      last,
      stale: !!(last && lastEdit && last.at < lastEdit),
    };
  }
  return out;
}

/**
 * Outstanding integrity findings: reported, not suppressed, whose offending line text still exists.
 */
export function openFindings(state, readFile) {
  const out = [];
  const seen = new Set();
  for (const f of state.findings) {
    if (!f.path || seen.has(f.key)) continue;
    seen.add(f.key);
    if (f.action === 'info') continue;
    let still = true;
    if (readFile && f.text) {
      const content = readFile(f.path);
      if (content != null) still = content.includes(f.text.slice(0, 80).trim());
    }
    if (still) out.push(f);
  }
  return out;
}

/**
 * Compact brief injected after compaction / on resume (kept under ~2.5k chars).
 */
export function sessionBrief(state, project, cfg, { readFile, heading = 'Veridone session brief' } = {}) {
  const lines = [`${heading} (mode: ${cfg.mode}):`];
  const first = state.prompts[0];
  const last = state.prompts[state.prompts.length - 1];
  if (first) lines.push(`- Original request: "${oneLine(first.text, 280)}"`);
  if (last && last !== first) lines.push(`- Latest request: "${oneLine(last.text, 280)}"`);
  const files = [...state.files.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
  if (files.length) {
    const shown = files.slice(0, 12).map((f) => `${f.path}${f.added || f.removed ? ` (+${f.added}/-${f.removed})` : ''}`).join(', ');
    lines.push(`- Files changed this session (${files.length}): ${shown}${files.length > 12 ? ', …' : ''}`);
  }
  const vs = verificationStatus(state, project);
  const vparts = [];
  for (const cat of CATEGORIES) {
    const v = vs[cat];
    if (!v.available && !v.last) continue;
    if (!v.last) vparts.push(`${cat}: not run`);
    else vparts.push(`${cat}: ${v.last.ok === true ? 'passed' : v.last.ok === false ? `FAILED${v.last.exit ? ` (exit ${v.last.exit})` : ''}` : 'result unknown (output filtered)'} ${ago(v.last.at)}${v.stale ? ', before later edits' : ''}`);
  }
  if (vparts.length) lines.push(`- Verification: ${vparts.join(' · ')}`);
  const open = openFindings(state, readFile);
  if (open.length) {
    lines.push(`- Open integrity findings (${open.length}): ${open.slice(0, 5).map((f) => `[${f.rule}] ${f.path}${f.line ? ':' + f.line : ''}`).join('; ')}${open.length > 5 ? '; …' : ''}`);
  }
  const repeated = repeatedFailures(state);
  if (repeated.length) lines.push(`- Repeated failures: ${repeated.slice(0, 3).map((r) => `\`${oneLine(r.cmd, 60)}\` ×${r.count}`).join(', ')}`);
  const denies = state.guards.filter((g) => g.level === 'deny');
  if (denies.length) lines.push(`- Blocked risky actions this session: ${denies.length} (${[...new Set(denies.map((g) => g.rule))].slice(0, 4).join(', ')})`);
  const desc = describeCommands(project);
  if (desc) lines.push(`- Verification commands: ${desc}`);
  let text = lines.join('\n');
  if (text.length > 2600) text = text.slice(0, 2590) + '…';
  return text;
}

export function repeatedFailures(state) {
  const byCmd = new Map();
  const events = [
    ...state.verifications.map((v) => ({ at: v.at, cmd: v.cmd, ok: v.ok })),
    ...state.failures.map((f) => ({ at: f.at, cmd: f.cmd, ok: false })),
  ].sort((a, b) => (a.at < b.at ? -1 : 1));
  for (const e of events) {
    const k = String(e.cmd || '').replace(/\s+/g, ' ').trim();
    if (!k) continue;
    const cur = byCmd.get(k) || { cmd: k, count: 0 };
    cur.count = e.ok ? 0 : cur.count + 1;
    byCmd.set(k, cur);
  }
  return [...byCmd.values()].filter((r) => r.count >= 2).sort((a, b) => b.count - a.count);
}

/** Longer human report for /veridone:status. */
export function statusReport(state, project, cfg, { readFile, sessionId, sources = [], warnings = [], entitlement } = {}) {
  const out = [];
  out.push(`# Veridone status`);
  out.push(`Mode: **${cfg.mode}**${sessionId ? ` · session \`${sessionId.slice(0, 8)}\`` : ''}${entitlement ? ` · plan: ${entitlement.plan}` : ''}`);
  if (project?.languages?.length) out.push(`Project: ${project.languages.join(', ')}${project.packageManager ? ` (${project.packageManager})` : ''}${project.monorepo ? ', monorepo' : ''}`);
  const desc = describeCommands(project);
  out.push(`Verification commands: ${desc || '_none detected — set them with /veridone:init_'}`);
  out.push('');
  const vs = verificationStatus(state, project);
  out.push('## Verification');
  for (const cat of CATEGORIES) {
    const v = vs[cat];
    if (!v.available && !v.last) continue;
    const status = !v.last ? '— not run this session' : v.last.ok === true ? `✅ passed ${ago(v.last.at)}` : v.last.ok === false ? `❌ failed ${ago(v.last.at)}${v.last.exit ? ` (exit ${v.last.exit})` : ''}` : `❔ result unknown ${ago(v.last.at)} (exit status hidden, no summary in output)`;
    out.push(`- ${cat}: ${status}${v.stale ? ' — stale: files changed afterwards' : ''}${v.last?.scope === 'partial' ? ' — partial run' : ''}`);
  }
  out.push('');
  const files = [...state.files.values()];
  out.push(`## Changes (${files.length} file${files.length === 1 ? '' : 's'})`);
  for (const f of files.slice(-25)) out.push(`- ${f.path} (${f.kind}, ${f.edits} edit${f.edits > 1 ? 's' : ''}, +${f.added}/-${f.removed})`);
  if (!files.length) out.push('- none');
  out.push('');
  const open = openFindings(state, readFile);
  out.push(`## Integrity findings (${state.findings.length} reported, ${open.length} still open)`);
  for (const f of open.slice(0, 15)) out.push(`- [${f.rule}] ${f.path}${f.line ? ':' + f.line : ''} — ${oneLine(f.message, 140)}`);
  out.push('');
  const g = state.guards;
  out.push(`## Guard decisions (${g.length})`);
  for (const x of g.slice(-10)) out.push(`- ${x.level.toUpperCase()} ${x.rule}: ${oneLine(x.cmd || x.path || '', 100)}`);
  out.push('');
  const saved = state.condensed.before - state.condensed.after;
  const stops = state.stops.filter((s) => s.decision === 'block');
  const blocked = g.filter((x) => x.level === 'deny').length;
  out.push(`## Session impact`);
  out.push(`- ${stops.length} premature "done" caught by the completion gate`);
  out.push(`- ${state.findings.length} integrity finding${state.findings.length === 1 ? '' : 's'} flagged at edit time`);
  out.push(`- ${blocked} risky action${blocked === 1 ? '' : 's'} blocked, ${g.length - blocked} sent for confirmation or noted`);
  out.push(`- ${state.condensed.count} noisy output${state.condensed.count === 1 ? '' : 's'} condensed, ~${formatNumber(approxTokens(saved))} tokens of context saved`);
  if (warnings.length) {
    out.push('');
    out.push('## Config warnings');
    for (const w of warnings) out.push(`- ${w}`);
  }
  if (sources.length) {
    out.push('');
    out.push(`Config sources: ${sources.join(', ')}`);
  }
  return out.join('\n');
}
