#!/usr/bin/env node
// Veridone — Claude Code hook dispatcher.
// Usage (from hooks/hooks.json): node scripts/hook.mjs <EventName>
//
// Contract: this process must never block the user's work because of its own
// bugs. Any internal error is logged (VERIDONE_DEBUG=1) and the hook exits 0
// with no decision, which lets Claude Code's normal permission flow proceed.

import path from 'node:path';
import fs from 'node:fs';
import { readStdin, safeJsonParse, debugLog, relPath, readTextSafe, splitLines, shortHash, dataDir, ensureDir, oneLine, fileExists } from './lib/util.mjs';
import { findProjectRoot, loadConfig, usesCustomRules, applyEntitlements } from './lib/config.mjs';
import { Ledger, readSessionMode, gcSessions } from './lib/ledger.mjs';
import { parse as parseShell } from './lib/shell.mjs';

const EVENT = process.argv[2] || '';
const started = Date.now();

function emit(obj) {
  if (!obj) return;
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  const raw = await readStdin();
  const input = safeJsonParse(raw, {}) || {};
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const sessionId = input.session_id || 'unknown';
  const sessionMode = readSessionMode(sessionId);
  const policyAllowed = await policyGate();
  const { config: cfg } = loadConfig({ projectRoot, sessionMode, policyAllowed });
  if (cfg.mode === 'off') return;
  if (usesCustomRules(cfg)) {
    const { hasFeature } = await import('./lib/license.mjs');
    applyEntitlements(cfg, hasFeature('custom-rules'));
  }
  const base = { input, cwd, projectRoot, sessionId, cfg };

  switch (EVENT) {
    case 'SessionStart': return onSessionStart(base);
    case 'UserPromptSubmit': return onPrompt(base);
    case 'PreToolUse': return onPreToolUse(base);
    case 'PostToolUse': return onPostToolUse(base);
    case 'PostToolUseFailure': return onPostToolUseFailure(base);
    case 'Stop': return onStop(base);
    default: return;
  }
}

async function policyGate() {
  // Only pay for license verification when an org policy file actually exists.
  const { configPaths } = await import('./lib/config.mjs');
  const p = configPaths(process.cwd()).policy;
  if (!fileExists(p)) return null;
  const { hasFeature } = await import('./lib/license.mjs');
  return hasFeature('org-policy');
}

async function projectProfile(projectRoot, cfg) {
  const { detectProject } = await import('./lib/project.mjs');
  return detectProject(projectRoot, { overrides: cfg.verify?.commands || {} });
}

// ---------------------------------------------------------------------------
// SessionStart
// ---------------------------------------------------------------------------
async function onSessionStart({ input, cwd, projectRoot, sessionId, cfg }) {
  const ledger = new Ledger(sessionId);
  const source = input.source || 'startup';
  const G = await import('./lib/git.mjs');
  const baselineHead = source === 'startup' ? G.headSha(projectRoot) : null;
  ledger.append({ t: 'start', source, cwd, projectRoot, baselineHead, model: input.model || null });
  gcSessions();
  const project = await projectProfile(projectRoot, cfg);
  const { describeCommands } = await import('./lib/project.mjs');
  let context = '';
  if ((source === 'compact' || source === 'resume') && cfg.context?.afterCompact !== false) {
    const state = ledger.state();
    if (state.prompts.length || state.edits.length) {
      const { sessionBrief } = await import('./lib/brief.mjs');
      context = sessionBrief(state, project, cfg, {
        readFile: (p) => readTextSafe(path.resolve(projectRoot, p)),
        heading: source === 'compact' ? 'Veridone session brief, restored after context compaction' : 'Veridone session brief, restored on resume',
      });
    }
  }
  if (!context && cfg.context?.onStart !== false) {
    const cmds = describeCommands(project);
    context = `Veridone guardrails are active (mode: ${cfg.mode}).${cmds ? ` This repository's verification commands — ${cmds}.` : ' No test/typecheck command was detected for this repository.'} Veridone records which checks actually ran after each change, flags skipped tests, suppressed checks and placeholder code at edit time, and confirms before destructive commands.`;
  }
  // License upkeep: re-check a store activation in the background when it is due (never blocks the
  // session), and show the user one-time notices such as "your trial ends in 2 days".
  let notice = null;
  if (source === 'startup' || source === 'resume') {
    try {
      const L = await import('./lib/license.mjs');
      L.maybeRefreshInBackground();
      notice = L.pendingNotice();
    } catch (e) { debugLog('license upkeep failed', e?.message || String(e)); }
  }
  if (!context && !notice) return;
  emit({
    ...(notice ? { systemMessage: notice } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } } : {}),
  });
}

// ---------------------------------------------------------------------------
// UserPromptSubmit
// ---------------------------------------------------------------------------
async function onPrompt({ input, sessionId }) {
  const ledger = new Ledger(sessionId);
  const text = String(input.prompt || '').replace(/<pasted_content[\s\S]*?<\/pasted_content[^>]*>/g, '[pasted]');
  ledger.append({ t: 'prompt', promptId: input.prompt_id || null, text: oneLine(text, 500) });
}

// ---------------------------------------------------------------------------
// PreToolUse
// ---------------------------------------------------------------------------
async function onPreToolUse({ input, cwd, projectRoot, sessionId, cfg }) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const { makeContext, analyzeBash, analyzeFileWrite, analyzeFileRead, formatReason } = await import('./lib/guard.mjs');
  const ctx = makeContext({ cwd, projectRoot, config: cfg, scratchpad: input.scratchpad_dir });
  let result = null;
  let subject = '';
  if (tool === 'Bash' || tool === 'PowerShell') {
    subject = String(ti.command || '');
    result = analyzeBash(subject, ctx);
  } else if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    subject = ti.file_path || ti.notebook_path || '';
    const newText = tool === 'Write' ? ti.content
      : tool === 'Edit' ? ti.new_string
        : tool === 'MultiEdit' ? (ti.edits || []).map((e) => e.new_string || '').join('\n')
          : ti.new_source;
    const isNewFile = tool === 'Write' && !fileExists(path.resolve(cwd, subject));
    result = analyzeFileWrite({ tool, filePath: subject, newText: newText || '', isNewFile }, ctx);
  } else if (tool === 'Read') {
    subject = ti.file_path || '';
    result = analyzeFileRead(subject, ctx);
  } else if (tool === 'Grep') {
    // Grep prints matching lines: searching a secrets file reveals its values
    subject = ti.path || ti.glob || '';
    for (const candidate of [ti.path, typeof ti.glob === 'string' ? ti.glob.replace(/[*?{}]/g, '') : null]) {
      if (!candidate) continue;
      const r = analyzeFileRead(candidate, ctx);
      if (r.level) { result = r; break; }
    }
  }
  if (!result || !result.level) return;
  const ledger = new Ledger(sessionId);
  for (const f of result.findings) ledger.append({ t: 'guard', rule: f.rule, level: f.level, tool, cmd: tool === 'Bash' || tool === 'PowerShell' ? subject : undefined, path: tool !== 'Bash' && tool !== 'PowerShell' ? relPath(projectRoot, path.resolve(cwd, subject)) : undefined });

  if (result.level === 'deny') {
    const reason = `Veridone blocked this ${tool === 'Bash' || tool === 'PowerShell' ? 'command' : 'file operation'}.\n${formatReason(result.findings, 'deny')}\nIf this action is genuinely required, explain why to the user and let them run it themselves or adjust .claude/veridone.json.`;
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
    return;
  }
  if (result.level === 'ask') {
    const reason = `Veridone: ${formatReason(result.findings, 'ask')}`;
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } });
    return;
  }
  if (result.level === 'warn') {
    const note = result.findings.filter((f) => f.level === 'warn').map((f) => `Veridone note (${f.rule}): ${f.detail}${f.fix ? ` ${f.fix}` : ''}`).join('\n');
    emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note } });
  }
}

// ---------------------------------------------------------------------------
// PostToolUse
// ---------------------------------------------------------------------------
async function onPostToolUse(base) {
  const tool = base.input.tool_name || '';
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') return afterEdit(base);
  if (tool === 'Bash' || tool === 'PowerShell') return afterBash(base);
}

async function afterEdit({ input, cwd, projectRoot, sessionId, cfg }) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const tr = (input.tool_response && typeof input.tool_response === 'object') ? input.tool_response : {};
  const filePath = ti.file_path || ti.notebook_path || tr.filePath;
  if (!filePath) return;
  const abs = path.resolve(cwd, filePath);
  const rel = relPath(projectRoot, abs);
  const { fileKind } = await import('./lib/project.mjs');
  const { diffLines, fromStructuredPatch } = await import('./lib/diff.mjs');
  const kind = fileKind(rel);
  const oldContent = typeof tr.originalFile === 'string' ? tr.originalFile : null;
  let newContent = tool === 'Write' && typeof ti.content === 'string' ? ti.content : readTextSafe(abs, 4 * 1024 * 1024);
  let d;
  if (Array.isArray(tr.structuredPatch) && tr.structuredPatch.length) d = fromStructuredPatch(tr.structuredPatch);
  else if (tool === 'Write' && oldContent === null) d = { added: splitLines(newContent || '').map((t, i) => ({ line: i + 1, text: t })), removed: [] };
  else if (oldContent !== null && newContent !== null) d = diffLines(oldContent, newContent);
  else if (tool === 'Edit' && typeof ti.new_string === 'string') {
    const sub = diffLines(ti.old_string || '', ti.new_string);
    const idx = newContent ? newContent.indexOf(ti.new_string) : -1;
    const offset = idx >= 0 ? newContent.slice(0, idx).split('\n').length - 1 : 0;
    d = { added: sub.added.map((a) => ({ line: a.line + offset, text: a.text })), removed: sub.removed };
  } else d = { added: [], removed: [] };

  const ledger = new Ledger(sessionId);
  ledger.append({ t: 'edit', path: rel, kind, tool, added: d.added.length, removed: d.removed.length, promptId: input.prompt_id || null, agent: input.agent_type || null });

  if (tool === 'NotebookEdit') return;
  const { scanEdit, formatFindings } = await import('./lib/integrity.mjs');
  const findings = scanEdit({ path: rel, added: d.added, removed: d.removed, oldContent, newContent, tool: tool === 'Write' && oldContent === null ? 'Write-new' : tool }, cfg);
  if (!findings.length) return;
  const state = ledger.state();
  const fresh = [];
  for (const f of findings) {
    const key = `${f.rule}|${rel}|${shortHash(f.text || f.message)}`;
    if (state.reported.has(key)) continue;
    fresh.push(f);
    ledger.append({ t: 'finding', key, rule: f.rule, severity: f.severity, action: f.action, path: rel, line: f.line, text: f.text, message: f.message });
  }
  const block = fresh.filter((f) => f.action === 'block');
  const warn = fresh.filter((f) => f.action === 'warn');
  if (!block.length && !warn.length) return;
  const out = {};
  if (block.length) {
    out.decision = 'block';
    const why = block.every((f) => f.rule.startsWith('custom:'))
      ? 'These changes break rules your team configured for this repository.'
      : 'These patterns make checks pass without the code working.';
    out.reason = `Veridone integrity check found ${block.length} issue${block.length > 1 ? 's' : ''} in ${rel}:\n${formatFindings(block, rel)}\n${why} Fix them now. If one is genuinely intended, keep it with an inline \`veridone-allow: <rule> <reason>\` comment and tell the user about it.`;
    out.systemMessage = `Veridone flagged ${[...new Set(block.map((f) => f.rule))].join(', ')} in ${rel}`;
  }
  if (warn.length) {
    out.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: `Veridone integrity notes for ${rel}:\n${formatFindings(warn, rel)}` };
  }
  emit(out);
}

async function afterBash({ input, cwd, projectRoot, sessionId, cfg }) {
  const ti = input.tool_input || {};
  const tr = (input.tool_response && typeof input.tool_response === 'object') ? input.tool_response : {};
  const cmd = String(ti.command || '');
  if (!cmd) return;
  const { classifyCommand, isNoisyCommand, judgeSuccessfulRun, maskLabel } = await import('./lib/verify.mjs');
  const project = await projectProfile(projectRoot, cfg);
  const cats = classifyCommand(cmd, project);
  const background = !!(ti.run_in_background || tr.backgroundTaskId || tr.backgroundedByUser || tr.assistantAutoBackgrounded);
  const ledger = new Ledger(sessionId);
  if (tr.interrupted) {
    ledger.append({ t: 'bash', cmd, ok: false, interrupted: true });
    return;
  }
  let full = null;
  const output = () => {
    if (full !== null) return full;
    full = String(tr.stdout || '');
    if (tr.stderr) full += (full ? '\n' : '') + String(tr.stderr);
    if (tr.persistedOutputPath) {
      const persisted = readTextSafe(tr.persistedOutputPath, 64 * 1024 * 1024);
      if (persisted) full = persisted;
    }
    return full;
  };
  const notes = [];
  if (background) {
    for (const c of cats) ledger.append({ t: 'pending', category: c.category, cmd, taskId: tr.backgroundTaskId || null });
  } else {
    for (const c of cats) {
      const j = judgeSuccessfulRun({ commandLine: cmd, index: c.index, output: output(), category: c.category });
      const baseline = ranOnStash(cmd, c.index) || undefined;
      ledger.append({ t: 'verify', category: c.category, scope: c.scope, ok: j.ok, basis: j.basis, masked: j.masked || undefined, note: j.note, baseline, cmd, exit: 0, promptId: input.prompt_id || null });
      if (baseline) continue;
      if (j.ok === false) notes.push(`Veridone: the command exited 0, but the output of \`${oneLine(c.cmd, 80)}\` reports a failure (\`${j.note}\`)${j.masked ? ` — its own exit status was ${maskLabel(j.masked)}` : ''}. This ${c.category} run counts as FAILED.`);
      else if (j.ok === null) notes.push(`Veridone: the result of \`${oneLine(c.cmd, 80)}\` is not visible — its exit status was ${maskLabel(j.masked)} and the output shown has no pass/fail summary. This run does not count as ${c.category} evidence; re-run it without the filter (or with \`set -o pipefail\`).`);
    }
    if (!cats.length) ledger.append({ t: 'bash', cmd, ok: true });
  }
  // Files changed by the command (Claude Code records these in auto/bypass modes or with bashEditDiffEnabled)
  const changed = tr.bashEditDiff?.changedFiles;
  if (Array.isArray(changed) && changed.length) {
    const { fileKind } = await import('./lib/project.mjs');
    for (const f of changed.slice(0, 200)) {
      const rel = relPath(projectRoot, path.resolve(cwd, f));
      ledger.append({ t: 'edit', path: rel, kind: fileKind(rel), tool: 'Bash', added: 0, removed: 0, promptId: input.prompt_id || null });
    }
  }
  const hso = { hookEventName: 'PostToolUse' };
  if (notes.length) hso.additionalContext = notes.join('\n');
  // Output condensation
  const condensable = cfg.condense?.enabled !== false && !background && !tr.isImage && (cats.length || isNoisyCommand(cmd));
  if (condensable && output().length >= (cfg.condense?.minChars ?? 6000)) {
    const logPath = saveLog(input, output());
    const { condense } = await import('./lib/condense.mjs');
    const c = condense(output(), { minChars: cfg.condense?.minChars, targetChars: cfg.condense?.targetChars, logPath });
    if (c) {
      const replacement = { ...tr, stdout: c.text, stderr: '' };
      delete replacement.persistedOutputPath;
      delete replacement.persistedOutputSize;
      ledger.append({ t: 'condense', before: c.before, after: c.after, cmd, log: logPath });
      hso.updatedToolOutput = replacement;
    }
  }
  if (hso.additionalContext || hso.updatedToolOutput) emit({ hookSpecificOutput: hso });
}

/**
 * `git stash && npm test; git stash pop` runs the checks against the pre-change tree:
 * useful as a baseline, but not evidence about the current changes.
 */
function ranOnStash(cmd, index) {
  if (index == null || !/\bstash\b/.test(cmd)) return false;
  let commands;
  try { commands = parseShell(cmd).commands; } catch { return false; }
  let stashed = false;
  for (let i = 0; i < Math.min(index, commands.length); i++) {
    const w = commands[i].argv.map((x) => x.value);
    if (w[0] !== 'git') continue;
    const k = w.indexOf('stash');
    if (k < 1) continue;
    const sub = w.slice(k + 1).find((a) => !a.startsWith('-')) || 'push';
    if (sub === 'push' || sub === 'save') stashed = true;
    else if (sub === 'pop' || sub === 'apply') stashed = false;
  }
  return stashed;
}

function saveLog(input, text) {
  try {
    const dir = input.scratchpad_dir ? path.join(input.scratchpad_dir, 'veridone-logs') : path.join(dataDir(), 'logs', String(input.session_id || 'unknown').slice(0, 64));
    ensureDir(dir);
    const file = path.join(dir, `${String(input.tool_use_id || Date.now()).replace(/[^\w.-]/g, '_')}.log`);
    fs.writeFileSync(file, text);
    return file;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PostToolUseFailure
// ---------------------------------------------------------------------------
async function onPostToolUseFailure({ input, projectRoot, sessionId, cfg }) {
  const tool = input.tool_name || '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return;
  if (input.is_interrupt) return;
  const cmd = String(input.tool_input?.command || '');
  if (!cmd) return;
  const { classifyCommand, exitCodeOf, failureSignature, judgeFailedRun } = await import('./lib/verify.mjs');
  const project = await projectProfile(projectRoot, cfg);
  const cats = classifyCommand(cmd, project);
  const exit = exitCodeOf(input.error);
  const sig = failureSignature(input.error);
  const ledger = new Ledger(sessionId);
  for (const c of cats) {
    // `npm test && npm run lint` failing in lint must not record the passing tests as failed.
    const j = judgeFailedRun({ output: input.error, category: c.category, categories: cats.length });
    const baseline = ranOnStash(cmd, c.index) || undefined;
    ledger.append({ t: 'verify', category: c.category, scope: c.scope, ok: j.ok, basis: j.basis, baseline, cmd, exit, sig: j.ok ? undefined : sig, promptId: input.prompt_id || null });
  }
  if (!cats.length) ledger.append({ t: 'fail', cmd, exit, sig });

  if (cfg.loopBreaker?.enabled === false) return;
  const threshold = cfg.loopBreaker?.threshold ?? 3;
  const state = ledger.state();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const key = norm(cmd);
  const history = [
    ...state.verifications.map((v) => ({ at: v.at, cmd: v.cmd, ok: v.ok, sig: v.sig })),
    ...state.failures.map((f) => ({ at: f.at, cmd: f.cmd, ok: false, sig: f.sig })),
    ...state.bash.filter((b) => b.ok).map((b) => ({ at: b.at, cmd: b.cmd, ok: true })),
  ].filter((e) => norm(e.cmd) === key).sort((a, b) => (a.at < b.at ? -1 : 1));
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (!history[i].ok && history[i].sig === sig) streak++;
    else break;
  }
  const noticeKey = `${shortHash(key)}:${sig}`;
  if (streak >= threshold && !state.loopNotices.has(noticeKey)) {
    ledger.append({ t: 'loop', sig: noticeKey, cmd, count: streak });
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure',
        additionalContext: `Veridone loop check: \`${oneLine(cmd, 100)}\` has now failed ${streak} times in a row with the same error signature. Repeating similar fixes is unlikely to work. Stop and diagnose: re-read the full error, reproduce it in the smallest possible case, state a concrete hypothesis about the root cause, and confirm it (e.g. with a targeted print or a minimal test) before changing code again. The veridone:debug skill describes this procedure.`,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------
async function onStop({ input, projectRoot, sessionId, cfg }) {
  const ledger = new Ledger(sessionId);
  const state = ledger.state();
  const project = await projectProfile(projectRoot, cfg);
  const { evaluateStop } = await import('./lib/verify.mjs');
  const lastPrompt = state.prompts[state.prompts.length - 1];
  const turnStartAt = lastPrompt ? lastPrompt.at : state.startedAt;

  // Changes made through Bash (sed -i, codegen, scripts) are invisible to Edit hooks:
  // attribute dirty files modified during this turn when the turn ran Bash commands.
  const turnBash = [...state.bash, ...state.verifications, ...state.failures].some((e) => !turnStartAt || e.at >= turnStartAt);
  if (turnBash && turnStartAt) {
    const G = await import('./lib/git.mjs');
    const { fileKind } = await import('./lib/project.mjs');
    const since = Date.parse(turnStartAt);
    const changed = G.changedSince(projectRoot, since) || [];
    const known = new Map(state.edits.map((e) => [e.path, e.at]));
    for (const c of changed) {
      const at = new Date(c.mtimeMs).toISOString();
      const prev = known.get(c.path);
      if (!prev || prev < at) state.edits.push({ t: 'edit', at, path: c.path, kind: fileKind(c.path), tool: 'Bash(detected)' });
    }
    state.edits.sort((a, b) => (a.at < b.at ? -1 : 1));
  }

  const r = evaluateStop({ state, project, cfg, input, turnStartAt });
  const promptId = input.prompt_id || state.lastPromptId || null;
  if (r.decision !== 'block') {
    if (r.kind === 'released' || r.kind === 'cap') ledger.append({ t: 'stop', decision: 'allow', kind: r.kind, promptId });
    return;
  }
  ledger.append({ t: 'stop', decision: 'block', kind: r.kind, promptId, reason: r.summary });
  emit({ systemMessage: r.summary, hookSpecificOutput: { hookEventName: 'Stop', additionalContext: r.reason } });
}

main()
  .catch((err) => {
    debugLog('hook error', EVENT, String(err && err.stack ? err.stack : err));
  })
  .finally(() => {
    debugLog('hook', EVENT, `${Date.now() - started}ms`);
    process.exitCode = 0;
  });
