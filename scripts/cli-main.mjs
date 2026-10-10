// Veridone CLI — used by the plugin's skills, by CI, and directly by humans.
//   node scripts/veridone.mjs <command> [options]

import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot, loadConfig, writeProjectConfig, MODES, configPaths, usesCustomRules, applyEntitlements } from './lib/config.mjs';
import { hasFeature } from './lib/license.mjs';
import { Ledger, listSessions, writeSessionMode, readSessionMode, deriveState } from './lib/ledger.mjs';
import { detectProject, describeCommands, fileKind } from './lib/project.mjs';
import { readTextSafe, toPosix, formatNumber, approxTokens, oneLine, dataDir, pluginRoot, fileExists, readJsonFile } from './lib/util.mjs';

import { version } from './lib/version.mjs';

const VERSION = version();

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { args[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

// With --exit-zero (used by skills), diagnostics go to stdout so they are always shown.
let errToStdout = false;
function out(s = '') { process.stdout.write(String(s) + '\n'); }
function err(s = '') { (errToStdout ? process.stdout : process.stderr).write(String(s) + '\n'); }
/** A string option that was actually given a non-empty value. */
function strOpt(v) { return typeof v === 'string' && v.trim() !== '' ? v.trim() : null; }

function context(args) {
  const cwd = path.resolve(strOpt(args.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const root = findProjectRoot(cwd);
  const sessionId = resolveSession(args, root);
  const sessionMode = sessionId ? readSessionMode(sessionId) : null;
  const policyAllowed = fileExists(configPaths(root).policy) ? hasFeature('org-policy') : null;
  const loaded = loadConfig({ projectRoot: root, sessionMode, policyAllowed });
  if (usesCustomRules(loaded.config)) {
    const w = applyEntitlements(loaded.config, hasFeature('custom-rules'));
    if (w) loaded.warnings.push(w);
  }
  const project = detectProject(root, { overrides: loaded.config.verify?.commands || {} });
  return { cwd, root, sessionId, ...loaded, project };
}

function resolveSession(args, root) {
  const s = args.session;
  if (s && s !== true && !/^\$\{/.test(String(s))) return String(s);
  // most recent session for this project
  for (const x of listSessions(40)) {
    const st = new Ledger(x.id).state();
    if (st.projectRoot && path.resolve(st.projectRoot) === path.resolve(root)) return x.id;
  }
  return null;
}

const HELP = `Veridone ${VERSION} — verification, integrity and safety guardrails for Claude Code

Usage: veridone <command> [options]

Session
  status [--session ID] [--json]      What changed, what was verified, open findings
  handoff [--session ID] [--out FILE] Markdown handoff note for the next session
  mode <strict|standard|relaxed|off|reset> [--session ID | --project]
  report [--days N] [--json] [--html FILE]   Value report across sessions (HTML: Pro)

Project
  detect [--json]                     Detected languages and verification commands
  init [--write] [--local]            Create .claude/veridone.json from detection
  map [--path DIR] [--focus a,b] [--max-tokens N]   Ranked repository map
  outline <files...>                  Symbols with line ranges
  symbol <query> [--kind K]           Find definitions
  impact [files...]                   Dependents and related tests of changed files
  changes [--stat] [--log N] [--base REF]   Branch, uncommitted files, diff stat, history

Checks
  scan [--base REF | --staged | --files a,b] [--format text|json|github|sarif|markdown]
       [--fail-on high|medium|low|none] [--mode strict|standard|relaxed]
                                      Integrity + secret scan of a diff (CI friendly)
  check-command "<cmd>" [--json]      Explain what the command guard would decide

Other
  doctor                              Environment and installation checks
  license [status | activate KEY | trial | refresh | deactivate]
  version | help
`;

// ---------------------------------------------------------------------------

async function cmdStatus(args) {
  const c = context(args);
  if (!c.sessionId) { out('No Veridone session found for this project yet. Start a Claude Code session with the plugin enabled.'); return 0; }
  const st = new Ledger(c.sessionId).state();
  const { statusReport, verificationStatus, openFindings } = await import('./lib/brief.mjs');
  const { entitlement } = await import('./lib/license.mjs');
  const readFile = (p) => readTextSafe(path.resolve(c.root, p));
  if (args.json) {
    out(JSON.stringify({
      session: c.sessionId, mode: c.config.mode, project: c.project,
      files: [...st.files.values()], verification: verificationStatus(st, c.project),
      openFindings: openFindings(st, readFile), guards: st.guards, condensed: st.condensed,
      stops: st.stops,
    }, null, 2));
    return 0;
  }
  out(statusReport(st, c.project, c.config, { readFile, sessionId: c.sessionId, sources: c.sources, warnings: c.warnings, entitlement: entitlement() }));
  return 0;
}

async function cmdHandoff(args) {
  const c = context(args);
  const G = await import('./lib/git.mjs');
  const { verificationStatus, openFindings, repeatedFailures } = await import('./lib/brief.mjs');
  const st = c.sessionId ? new Ledger(c.sessionId).state() : deriveState([]);
  const readFile = (p) => readTextSafe(path.resolve(c.root, p));
  const lines = [];
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  lines.push(`# Handoff — ${path.basename(c.root)} (${date})`);
  lines.push('');
  if (st.prompts.length) {
    lines.push('## Goal');
    lines.push(`- Original request: ${oneLine(st.prompts[0].text, 400)}`);
    if (st.prompts.length > 1) lines.push(`- Latest request: ${oneLine(st.prompts[st.prompts.length - 1].text, 400)}`);
    lines.push('');
  }
  const branch = G.currentBranch(c.root);
  const statusEntries = G.status(c.root, []) || [];
  lines.push('## State of the working tree');
  lines.push(`- Branch: ${branch || '(detached)'}${st.baselineHead ? ` · session started at ${st.baselineHead.slice(0, 10)}` : ''}`);
  lines.push(`- Uncommitted files: ${statusEntries.length}`);
  for (const e of statusEntries.slice(0, 30)) lines.push(`  - \`${e.x}${e.y}\` ${e.path}`);
  lines.push('');
  lines.push('## Verification');
  const vs = verificationStatus(st, c.project);
  for (const [cat, v] of Object.entries(vs)) {
    if (!v.available && !v.last) continue;
    lines.push(`- ${cat} (\`${v.command || v.last?.cmd}\`): ${!v.last ? 'not run' : v.last.ok === true ? 'passed' : v.last.ok === false ? `FAILED${v.last.exit ? ` (exit ${v.last.exit})` : ''}` : 'result unknown (output was filtered)'}${v.stale ? ' — stale, files changed afterwards' : ''}`);
  }
  lines.push('');
  const open = openFindings(st, readFile);
  const rep = repeatedFailures(st);
  const next = [];
  for (const [cat, v] of Object.entries(vs)) {
    if (v.available && (!v.last || v.stale)) next.push(`Run ${cat}: \`${v.command}\``);
    else if (v.last && v.last.ok === false) next.push(`Fix failing ${cat} (\`${v.last.cmd}\`)`);
    else if (v.last && v.last.ok !== true) next.push(`Re-run ${cat} without output filters: \`${v.command || v.last.cmd}\``);
  }
  for (const f of open.slice(0, 10)) next.push(`Resolve [${f.rule}] in ${f.path}${f.line ? ':' + f.line : ''}`);
  for (const r of rep.slice(0, 3)) next.push(`Investigate repeated failure of \`${r.cmd}\` (×${r.count}) — diagnose root cause before retrying`);
  lines.push('## Next steps');
  if (next.length) for (const n of next) lines.push(`- [ ] ${n}`);
  else lines.push('- Nothing outstanding according to the ledger.');
  lines.push('');
  lines.push('## Commands');
  lines.push(describeCommands(c.project) || '_none detected_');
  const md = lines.join('\n') + '\n';
  if (args.out && args.out !== true) {
    fs.mkdirSync(path.dirname(path.resolve(c.cwd, args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(c.cwd, args.out), md);
    out(`Wrote ${path.resolve(c.cwd, args.out)}`);
  } else out(md);
  return 0;
}

async function cmdMode(args) {
  const mode = args._[1];
  const valid = [...MODES, 'reset'];
  if (!valid.includes(mode)) { err(`Usage: veridone mode <${valid.join('|')}> [--session ID | --project]`); return 2; }
  const c = context(args);
  if (args.project) {
    const p = configPaths(c.root).project;
    const current = readJsonFile(p, {}) || {};
    if (mode === 'reset') delete current.mode; else current.mode = mode;
    writeProjectConfig(c.root, current);
    out(`Project mode ${mode === 'reset' ? 'reset to default' : `set to ${mode}`} in ${p}`);
    return 0;
  }
  const sid = args.session && args.session !== true && !/^\$\{/.test(args.session) ? String(args.session) : c.sessionId;
  if (!sid) { err('No session found; pass --session <id> or --project.'); return 2; }
  writeSessionMode(sid, mode === 'reset' ? null : mode);
  new Ledger(sid).append({ t: 'mode', mode: mode === 'reset' ? null : mode });
  out(`Veridone mode for this session: ${mode === 'reset' ? `reset (now ${loadConfig({ projectRoot: c.root }).config.mode})` : mode}.`);
  if (mode === 'off') out('All Veridone checks are disabled for this session. Run `/veridone:mode standard` to turn them back on.');
  return 0;
}

async function cmdDetect(args) {
  const c = context(args);
  if (args.json) { out(JSON.stringify(c.project, null, 2)); return 0; }
  out(`Project root: ${c.root}`);
  out(`Languages: ${c.project.languages.join(', ') || 'unknown'}${c.project.packageManager ? ` · package manager: ${c.project.packageManager}` : ''}${c.project.monorepo ? ' · monorepo' : ''}`);
  if (c.project.frameworks.length) out(`Test frameworks: ${c.project.frameworks.join(', ')}`);
  for (const cat of ['test', 'typecheck', 'lint', 'build']) out(`${cat.padEnd(10)} ${c.project.commands[cat] ? `${c.project.commands[cat]}   (${c.project.sources[cat]})` : '—'}`);
  out(`Mode: ${c.config.mode}${c.sources.length ? ` · config: ${c.sources.join(', ')}` : ' · config: defaults'}`);
  for (const w of c.warnings) out(`warning: ${w}`);
  return 0;
}

async function cmdInit(args) {
  const c = context(args);
  const p = args.local ? configPaths(c.root).local : configPaths(c.root).project;
  const existing = readJsonFile(p, null);
  const commands = {};
  for (const cat of ['test', 'typecheck', 'lint', 'build']) if (c.project.commands[cat]) commands[cat] = c.project.commands[cat];
  const cfg = existing || {
    $schema: 'https://raw.githubusercontent.com/woojin0128/veridone/main/schemas/veridone.schema.json',
    mode: 'standard',
    verify: { commands, require: 'auto' },
    guard: { protectedBranches: ['main', 'master', 'release/*'] },
    integrity: { ignore: [] },
  };
  if (existing) cfg.verify = { ...(existing.verify || {}), commands: { ...commands, ...(existing.verify?.commands || {}) } };
  const text = JSON.stringify(cfg, null, 2) + '\n';
  if (args.write) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    out(`Wrote ${p}`);
    out(`Verification commands: ${describeCommands(c.project) || 'none detected — edit verify.commands'}`);
  } else {
    out(`# Proposed ${path.relative(c.root, p) || p} (run with --write to save)`);
    out(text);
  }
  return 0;
}

async function cmdMap(args) {
  const c = context(args);
  const { repoMap } = await import('./lib/intel/index.mjs');
  const focus = typeof args.focus === 'string' ? args.focus.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const r = repoMap(c.root, { focus, maxTokens: Number(args['max-tokens']) || 2000, subdir: strOpt(args.path) });
  out(r.text);
  return 0;
}

async function cmdOutline(args) {
  const c = context(args);
  const files = args._.slice(1);
  if (!files.length) { err('Usage: veridone outline <files...>'); return 2; }
  const { outline } = await import('./lib/intel/index.mjs');
  out(outline(c.root, files.map((f) => toPosix(path.relative(c.root, path.resolve(c.cwd, f))))));
  return 0;
}

async function cmdSymbol(args) {
  const c = context(args);
  const q = args._[1];
  if (!q) { err('Usage: veridone symbol <query>'); return 2; }
  const { findSymbol } = await import('./lib/intel/index.mjs');
  out(findSymbol(c.root, q, { kind: typeof args.kind === 'string' ? args.kind : null, limit: Number(args.limit) || 25 }));
  return 0;
}

async function cmdImpact(args) {
  const c = context(args);
  const G = await import('./lib/git.mjs');
  const { impact, scopedTestCommand } = await import('./lib/intel/index.mjs');
  let files = args._.slice(1).map((f) => toPosix(path.relative(c.root, path.resolve(c.cwd, f))));
  if (!files.length) files = (G.status(c.root, []) || []).map((e) => e.path);
  if (!files.length) { out('No changed files.'); return 0; }
  const r = impact(c.root, files, { depth: Number(args.depth) || 2 });
  if (args.json) { out(JSON.stringify({ ...r, command: scopedTestCommand(c.project, r.tests) }, null, 2)); return 0; }
  out(`Changed (${r.changed.length}): ${r.changed.join(', ')}`);
  out(`Dependents (${r.dependents.length}): ${r.dependents.slice(0, 50).map(([f, d]) => `${f}${d > 1 ? ` (depth ${d})` : ''}`).join(', ') || 'none'}`);
  out(`Related tests (${r.tests.length}): ${r.tests.join(', ') || 'none'}`);
  const cmd = scopedTestCommand(c.project, r.tests);
  if (cmd) out(`Scoped test command: ${cmd}`);
  return 0;
}

async function cmdChanges(args) {
  const c = context(args);
  const G = await import('./lib/git.mjs');
  if (!G.isGitRepo(c.root)) { out(`Not a git repository (${c.root}); change tracking is unavailable.`); return 0; }
  const branch = G.currentBranch(c.root);
  const head = G.headSha(c.root);
  out(`Branch: ${branch || '(detached HEAD)'}${head ? ` @ ${head.slice(0, 10)}` : ' — no commits yet'}`);
  const entries = G.status(c.root, []) || [];
  out(`Uncommitted files: ${entries.length}`);
  for (const e of entries.slice(0, 80)) out(`  ${`${e.x}${e.y}`.replace(/ /g, '.')} ${e.path}`);
  if (entries.length > 80) out(`  … and ${entries.length - 80} more`);
  if (args.stat && head) {
    const r = G.git(c.root, ['diff', '--stat=100', '--no-color', '--no-ext-diff', 'HEAD']);
    if (r.ok && r.stdout.trim()) { out(''); out('Diff stat against HEAD (tracked files):'); out(r.stdout.trimEnd()); }
  }
  const base = strOpt(args.base);
  if (base && head) {
    const mb = G.mergeBase(c.root, base, 'HEAD');
    if (!mb) out(`\nNo merge base with ${base}.`);
    else {
      const r = G.git(c.root, ['log', '--oneline', '--no-decorate', '--no-color', '-n', '50', `${mb}..HEAD`]);
      const lines = r.ok ? r.stdout.trim().split('\n').filter(Boolean) : [];
      out(''); out(`Commits on this branch since ${base} (${lines.length}${lines.length === 50 ? '+' : ''}):`);
      for (const l of lines) out(`  ${l}`);
    }
  }
  const n = Math.min(Number(args.log) || 0, 100);
  if (n > 0 && head) {
    const r = G.git(c.root, ['log', '--oneline', '--no-decorate', '--no-color', '-n', String(n)]);
    if (r.ok && r.stdout.trim()) { out(''); out(`Recent commits:`); for (const l of r.stdout.trim().split('\n')) out(`  ${l}`); }
  }
  return 0;
}

async function cmdCheckCommand(args) {
  const c = context(args);
  const cmdline = args._.slice(1).join(' ');
  if (!cmdline) { err('Usage: veridone check-command "<command>"'); return 2; }
  const { analyzeBash, makeContext } = await import('./lib/guard.mjs');
  const r = analyzeBash(cmdline, makeContext({ cwd: c.cwd, projectRoot: c.root, config: c.config }));
  if (args.json) { out(JSON.stringify(r, null, 2)); return 0; }
  out(`Decision: ${r.level || 'allow (no finding)'}`);
  for (const f of r.findings) out(`- [${f.level}] ${f.rule}: ${f.detail}${f.fix ? `\n    → ${f.fix}` : ''}`);
  return 0;
}

// --- scan (CI) ----------------------------------------------------------------

async function cmdScan(args) {
  const c = context(args);
  const G = await import('./lib/git.mjs');
  const { parseUnifiedDiff, diffLines } = await import('./lib/diff.mjs');
  const { scanEdit, INTEGRITY_RULES } = await import('./lib/integrity.mjs');
  const { scanSecrets, isSecretStoreFile } = await import('./lib/secrets.mjs');
  const { matchGlob } = await import('./lib/util.mjs');
  const cfg = structuredClone(c.config);
  if (typeof args.mode === 'string' && MODES.includes(args.mode)) cfg.mode = args.mode;
  if (cfg.mode === 'off') cfg.mode = 'standard';
  const format = typeof args.format === 'string' ? args.format : 'text';
  const failOn = typeof args['fail-on'] === 'string' ? args['fail-on'] : 'high';

  if (format === 'sarif') {
    const msg = await paidFeatureBlocked('scan-sarif');
    if (msg) { err(msg); return 3; }
  }

  if (!G.isGitRepo(c.root)) { err(`Not a git repository (${c.root}); veridone scan compares git revisions.`); return 2; }
  const hasHead = !!G.headSha(c.root);
  let diffText = '';
  let baseRev = 'HEAD';
  const addWhole = (rel) => {
    const t = readTextSafe(path.join(c.root, rel), 2 * 1024 * 1024);
    if (t == null || t.includes('\u0000')) return;
    const lines = t.split('\n');
    diffText += `\ndiff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n') + '\n';
  };
  if (!hasHead && !strOpt(args.base)) {
    // No commits yet: everything present in the working tree is new.
    const only = typeof args.files === 'string' ? new Set(args.files.split(',').map((f) => f.trim()).filter(Boolean)) : null;
    for (const e of (G.status(c.root, []) || []).slice(0, 2000)) {
      if (e.x !== 'D' && e.y !== 'D' && (!only || only.has(e.path))) addWhole(e.path);
    }
  } else if (typeof args.files === 'string') {
    const files = args.files.split(',').map((s) => s.trim()).filter(Boolean);
    diffText = G.git(c.root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD', '--', ...files]).stdout;
  } else if (args.staged) {
    diffText = G.git(c.root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--cached']).stdout;
  } else if (typeof args.base === 'string') {
    const mb = G.mergeBase(c.root, args.base, 'HEAD');
    if (!mb) { err(`Cannot find merge base with ${args.base}. In CI, fetch enough history (actions/checkout with fetch-depth: 0).`); return 2; }
    baseRev = mb;
    diffText = G.git(c.root, ['diff', '-U0', '--no-color', '--no-ext-diff', mb, 'HEAD'], { maxBuffer: 256 * 1024 * 1024 }).stdout;
  } else {
    diffText = G.git(c.root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']).stdout;
    // untracked files count as fully added
    const untracked = (G.status(c.root, []) || []).filter((e) => e.x === '?');
    for (const u of untracked.slice(0, 500)) addWhole(u.path);
  }
  const files = parseUnifiedDiff(diffText);
  const findings = [];
  let scanned = 0;
  for (const [file, d] of files) {
    if (d.status === 'deleted' || !file) continue;
    if (matchGlob(file, cfg.integrity?.ignore || [])) continue;
    scanned++;
    // --staged scans what will be committed (the index), not the working tree
    const newContent = args.staged ? G.showFile(c.root, '', file) : readTextSafe(path.join(c.root, file), 4 * 1024 * 1024);
    const oldContent = d.status === 'added' ? null : G.showFile(c.root, baseRev, file);
    let added = d.added;
    let removed = d.removed;
    if ((file.endsWith('package.json') || fileKind(file) === 'test') && oldContent != null && newContent != null) {
      const full = diffLines(oldContent, newContent);
      if (full.added.length || full.removed.length) { added = full.added; removed = full.removed; }
    }
    for (const f of scanEdit({ path: file, added, removed, oldContent, newContent, tool: d.status === 'added' ? 'Write-new' : 'Edit' }, cfg)) {
      findings.push({ file, ...f });
    }
    if (cfg.secrets?.enabled !== false && !isSecretStoreFile(file) && !matchGlob(file, cfg.secrets?.allowFiles || [])) {
      const text = added.map((a) => a.text).join('\n');
      for (const s of scanSecrets(text)) {
        const line = added[s.line - 1]?.line ?? null;
        findings.push({ file, rule: `secret:${s.id}`, severity: s.severity, action: s.severity === 'high' ? 'block' : 'warn', title: `Possible ${s.name}`, line, text: s.preview, message: `${s.name} added (${s.preview}).`, fix: 'Remove the credential, rotate it, and load it from the environment or a secrets manager.' });
      }
    }
  }
  const rank = { none: 99, high: 3, medium: 2, low: 1 };
  const threshold = rank[failOn] ?? 3;
  const sevRank = { high: 3, medium: 2, low: 1 };
  const failing = findings.filter((f) => sevRank[f.severity] >= threshold);

  if (format === 'json') out(JSON.stringify({ version: VERSION, scannedFiles: scanned, findings }, null, 2));
  else if (format === 'github') {
    for (const f of findings) {
      const level = f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'notice';
      const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
      out(`::${level} file=${escProp(f.file)}${f.line ? `,line=${f.line}` : ''},title=${escProp(`Veridone: ${f.title || f.rule}`)}::${esc(`${f.message} ${f.fix ? 'Fix: ' + f.fix : ''} [${f.rule}]`)}`);
    }
    out(summaryLine(scanned, findings, failing));
  } else if (format === 'sarif') {
    out(JSON.stringify(toSarif(findings, INTEGRITY_RULES), null, 2));
  } else if (format === 'markdown') {
    out(`### Veridone integrity scan`);
    out('');
    out(summaryLine(scanned, findings, failing));
    if (findings.length) {
      out('');
      out('| Severity | Rule | Location | Finding |');
      out('|---|---|---|---|');
      for (const f of findings.slice(0, 100)) out(`| ${f.severity} | \`${f.rule}\` | \`${f.file}${f.line ? ':' + f.line : ''}\` | ${String(f.message).replace(/\|/g, '\\|')} |`);
    }
  } else {
    if (!findings.length) out(`✔ Veridone scan: ${scanned} changed file(s), no integrity or secret findings.`);
    for (const f of findings) out(`${f.severity.toUpperCase().padEnd(6)} ${f.file}${f.line ? ':' + f.line : ''}  [${f.rule}] ${f.message}${f.text ? `\n       ${oneLine(f.text, 120)}` : ''}\n       fix: ${f.fix}`);
    if (findings.length) out(summaryLine(scanned, findings, failing));
  }
  return failing.length ? 1 : 0;
}

function summaryLine(scanned, findings, failing) {
  const by = { high: 0, medium: 0, low: 0 };
  for (const f of findings) by[f.severity] = (by[f.severity] || 0) + 1;
  return `Veridone scan: ${scanned} changed file(s) · ${findings.length} finding(s) (high ${by.high}, medium ${by.medium}, low ${by.low}) · ${failing.length ? `FAIL (${failing.length} at or above threshold)` : 'PASS'}`;
}

function toSarif(findings, rules) {
  const ruleIds = [...new Set(findings.map((f) => f.rule))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'Veridone',
          version: VERSION,
          informationUri: 'https://github.com/woojin0128/veridone',
          rules: ruleIds.map((id) => {
            const r = rules[id] || { title: id, severity: id.startsWith('secret:') ? 'high' : 'medium' };
            return { id, name: id, shortDescription: { text: r.title || id }, defaultConfiguration: { level: r.severity === 'high' ? 'error' : r.severity === 'medium' ? 'warning' : 'note' } };
          }),
        },
      },
      results: findings.map((f) => ({
        ruleId: f.rule,
        level: f.severity === 'high' ? 'error' : f.severity === 'medium' ? 'warning' : 'note',
        message: { text: `${f.message}${f.fix ? ` Fix: ${f.fix}` : ''}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: f.file }, region: { startLine: f.line || 1 } } }],
      })),
    }],
  };
}

// --- report -----------------------------------------------------------------------

async function cmdReport(args) {
  const days = Number(args.days) || 30;
  const cutoff = Date.now() - days * 86400e3;
  const sessions = listSessions(500).filter((s) => s.mtime >= cutoff);
  const agg = { sessions: 0, prompts: 0, files: 0, edits: 0, verifications: 0, failedVerifications: 0, stopBlocks: 0, stopKinds: {}, findings: {}, guards: {}, denies: 0, asks: 0, condensed: 0, charsSaved: 0, projects: new Set() };
  for (const s of sessions) {
    const st = new Ledger(s.id).state();
    if (!st.startedAt && !st.prompts.length) continue;
    agg.sessions++;
    if (st.projectRoot) agg.projects.add(st.projectRoot);
    agg.prompts += st.prompts.length;
    agg.files += st.files.size;
    agg.edits += st.edits.length;
    agg.verifications += st.verifications.length;
    agg.failedVerifications += st.verifications.filter((v) => v.ok === false).length;
    for (const b of st.stops.filter((x) => x.decision === 'block')) { agg.stopBlocks++; agg.stopKinds[b.kind || 'other'] = (agg.stopKinds[b.kind || 'other'] || 0) + 1; }
    for (const f of st.findings) agg.findings[f.rule] = (agg.findings[f.rule] || 0) + 1;
    for (const g of st.guards) { agg.guards[g.rule] = (agg.guards[g.rule] || 0) + 1; if (g.level === 'deny') agg.denies++; if (g.level === 'ask') agg.asks++; }
    agg.condensed += st.condensed.count;
    agg.charsSaved += Math.max(0, st.condensed.before - st.condensed.after);
  }
  const data = { ...agg, projects: agg.projects.size, days, tokensSaved: approxTokens(agg.charsSaved) };
  if (args.json) { out(JSON.stringify(data, null, 2)); return 0; }
  if (args.html) {
    const msg = await paidFeatureBlocked('report-html');
    if (msg) { err(msg); return 3; }
    const { renderReportHtml } = await import('./lib/report-html.mjs');
    const file = path.resolve(String(args.html === true ? 'veridone-report.html' : args.html));
    fs.writeFileSync(file, renderReportHtml(data));
    out(`Wrote ${file}`);
    return 0;
  }
  const top = (obj, n = 8) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ×${v}`).join(', ') || '—';
  out(`# Veridone report — last ${days} days`);
  out(`Sessions: ${data.sessions} across ${data.projects} project(s) · prompts: ${data.prompts} · files changed: ${data.files}`);
  out('');
  out(`Premature "done" caught (completion gate): ${data.stopBlocks}  (${top(data.stopKinds)})`);
  out(`Integrity findings (cheats caught at edit time): ${Object.values(data.findings).reduce((a, b) => a + b, 0)}  — ${top(data.findings)}`);
  out(`Risky actions intercepted: ${data.denies} blocked, ${data.asks} sent for confirmation — ${top(data.guards)}`);
  out(`Verification runs recorded: ${data.verifications} (${data.failedVerifications} failing)`);
  out(`Context saved by condensing noisy output: ~${formatNumber(data.tokensSaved)} tokens over ${data.condensed} outputs`);
  const L = await import('./lib/license.mjs');
  const ent = L.entitlement();
  if (!L.hasFeature('report-html', ent)) {
    out('');
    out(`Shareable HTML dashboard (\`veridone report --html\`) is a Pro feature${!ent.trialUsed && ent.kind !== 'trial' ? ' — try it free for 14 days with `/veridone:license trial`' : ''}.`);
  }
  return 0;
}

// --- doctor / license -----------------------------------------------------------------

async function cmdDoctor(args) {
  const checks = [];
  const ok = (name, good, detail) => checks.push({ name, good, detail });
  const major = Number(process.versions.node.split('.')[0]);
  ok('Node.js >= 18', major >= 18, `v${process.versions.node}`);
  const root = pluginRoot();
  ok('Plugin files present', fileExists(path.join(root, 'hooks', 'hooks.json')) && fileExists(path.join(root, 'scripts', 'hook.mjs')), root);
  let hooksOk = false;
  try { hooksOk = !!JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8')).hooks?.PreToolUse; } catch { /* */ }
  ok('hooks.json parses', hooksOk, path.join(root, 'hooks', 'hooks.json'));
  let dataOk = false;
  const dd = dataDir();
  try { fs.writeFileSync(path.join(dd, '.doctor'), 'ok'); fs.unlinkSync(path.join(dd, '.doctor')); dataOk = true; } catch { /* */ }
  ok('Data directory writable', dataOk, dd);
  const G = await import('./lib/git.mjs');
  const gv = G.git(process.cwd(), ['--version']);
  ok('git available', gv.ok, gv.ok ? gv.stdout.trim() : 'git not found — verification tracking still works, uncommitted-work checks are disabled');
  const c = context(args);
  ok('Config valid', !c.warnings.length, c.warnings.join('; ') || (c.sources.join(', ') || 'defaults'));
  ok('Verification commands detected', !!(c.project.commands.test || c.project.commands.typecheck || c.project.commands.build), describeCommands(c.project) || 'none — run /veridone:init and set verify.commands');
  const { entitlement } = await import('./lib/license.mjs');
  const e = entitlement();
  ok('License', true, e.valid
    ? `${e.plan}${e.trial ? ' (trial)' : ''}${e.email ? ` · ${e.email}` : ''}${e.expiresAt ? ` · until ${String(e.expiresAt).slice(0, 10)}` : ''}`
    : `free${e.source && e.reason !== 'no license key' ? ` — ${e.reason}` : ''}`);
  const { loadStore, isConfigured } = await import('./lib/store.mjs');
  const store = loadStore();
  ok('Store connection', true, isConfigured(store) ? `Polar ${store.environment}${store.organizationSlug ? ` (${store.organizationSlug})` : ''}` : 'not connected in this build (paid keys are looked up from the published store.json)');
  // hook smoke test
  const { spawnSync } = await import('node:child_process');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'hook.mjs'), 'PreToolUse'], { input: JSON.stringify({ session_id: 'doctor', cwd: c.root, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_DATA: dd } });
  const denied = /"permissionDecision":"deny"/.test(r.stdout || '');
  ok('Guard hook responds (rm -rf / is denied)', denied || c.config.mode === 'off', `${Date.now() - t0}ms${c.config.mode === 'off' ? ' (mode is off)' : ''}`);
  for (const ch of checks) out(`${ch.good ? '✔' : '✖'} ${ch.name}${ch.detail ? ` — ${ch.detail}` : ''}`);
  const bad = checks.filter((x) => !x.good);
  out(bad.length ? `\n${bad.length} problem(s) found.` : '\nAll checks passed.');
  return bad.length ? 1 : 0;
}

async function cmdLicense(args) {
  const sub = args._[1] || 'status';
  const L = await import('./lib/license.mjs');
  const { STORE_URL } = await import('./lib/brand.mjs');
  const usage = 'Usage: veridone license [status | activate <key> [--label NAME] | trial | refresh | deactivate]';
  if (sub === 'activate') {
    const key = args._[2];
    if (!key || key === true) { err('Usage: veridone license activate <key> [--label NAME]'); return 2; }
    const O = await import('./lib/license-online.mjs');
    const r = await O.activateKey(String(key), { label: strOpt(args.label) });
    if (r.ok) out(r.message); else err(r.message);
    return r.ok ? 0 : 1;
  }
  if (sub === 'deactivate' || sub === 'remove') {
    const O = await import('./lib/license-online.mjs');
    out((await O.deactivateKey()).message);
    return 0;
  }
  if (sub === 'refresh') {
    const O = await import('./lib/license-online.mjs');
    const r = await O.refreshState();
    if (!args.quiet) { if (r.ok) out(r.message); else err(r.message); }
    return r.ok || r.skipped ? 0 : 1;
  }
  if (sub === 'trial') {
    const e = L.entitlement();
    if (e.valid && e.kind !== 'trial') { out(`You already have Veridone ${planTitle(e.plan)}; no trial needed.`); return 0; }
    const r = L.startTrial();
    const until = String(r.trial.endsAt).slice(0, 10);
    if (r.started) {
      out(`Trial started: every paid feature is unlocked on this machine until ${until} (${L.TRIAL_DAYS} days, no card needed).`);
      out('Try: team rules (`guard.customRules` / `integrity.customRules` in .claude/veridone.json), `/veridone:report` as an HTML dashboard, `scan --format sarif` for code scanning, and a locked organization policy.');
      out(`Keep them after the trial: ${STORE_URL}`);
    } else if (Date.now() < Date.parse(r.trial.endsAt)) out(`Your trial is already running; it ends on ${until}.`);
    else out(`The free trial on this machine ended on ${until}. Plans: ${STORE_URL}`);
    return 0;
  }
  if (sub !== 'status') { err(usage); return 2; }
  const O = await import('./lib/license-online.mjs');
  const e = await O.ensureEntitlement();
  out(describeEntitlement(e, STORE_URL));
  return 0;
}

function planTitle(plan) { return `${plan[0].toUpperCase()}${plan.slice(1)}`; }

function describeEntitlement(e, storeUrl) {
  const day = (d) => String(d).slice(0, 10);
  if (e.valid && e.kind === 'trial') {
    const left = Math.max(0, Math.ceil((Date.parse(e.expiresAt) - Date.now()) / 86400e3));
    return `Plan: ${planTitle(e.plan)} (free trial) · ends ${day(e.expiresAt)} (${left} day${left === 1 ? '' : 's'} left). Keep the paid features: ${storeUrl}`;
  }
  if (e.valid && e.kind === 'polar') {
    const st = e.state || {};
    const parts = [`Plan: ${planTitle(e.plan)}`, `key ${maskKeyLazy(e.key)}`];
    if (e.email) parts.push(e.email);
    if (st.label) parts.push(`this machine: "${st.label}"`);
    if (st.validatedAt) parts.push(`verified ${day(st.validatedAt)}`);
    if (e.source && e.source.startsWith('env:')) parts.push('from VERIDONE_LICENSE_KEY');
    return parts.join(' · ') + (st.portalUrl ? `\nManage your subscription and machines: ${st.portalUrl}` : '');
  }
  if (e.valid) {
    return `Plan: ${planTitle(e.plan)} · licensed to ${e.email || e.org || 'you'} · seats ${e.seats || 1} · ${e.expiresAt ? `valid until ${day(e.expiresAt)}` : 'no expiry'} (offline key, ${e.source})`;
  }
  const lines = [];
  if (e.source && e.reason !== 'no license key') lines.push(`Plan: free — the license on this machine is not active: ${e.reason}.`);
  else lines.push('Plan: free.');
  lines.push('Pro adds team rules (your own guard and code rules), the HTML value dashboard and SARIF for GitHub code scanning; Team adds a locked organization policy.');
  if (!e.trialUsed) lines.push('Try them free for 14 days: `/veridone:license trial`.');
  else if (e.trialEndedAt) lines.push(`Your free trial ended on ${day(e.trialEndedAt)}.`);
  lines.push(`Plans: ${storeUrl}`);
  return lines.join('\n');
}

let maskKeyFn = null;
function maskKeyLazy(key) { return maskKeyFn ? maskKeyFn(key) : String(key || '').slice(-6); }

/** null when the paid feature is available (checking the store if needed), else the message to show. */
async function paidFeatureBlocked(feature) {
  const L = await import('./lib/license.mjs');
  const O = await import('./lib/license-online.mjs');
  const e = await O.ensureEntitlement();
  if (L.hasFeature(feature, e)) return null;
  const why = e.source && e.reason && e.reason !== 'no license key' ? ` (Current license: ${e.reason}.)` : '';
  return L.featureMessage(feature, e) + why;
}

// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  errToStdout = !!args['exit-zero'];
  // Skills pass --data "${CLAUDE_PLUGIN_DATA}" because the Bash tool does not export it.
  const dataOpt = strOpt(args.data);
  if (dataOpt && !dataOpt.includes('${')) process.env.CLAUDE_PLUGIN_DATA = dataOpt;
  const cmd = args._[0] || 'help';
  const table = {
    status: cmdStatus, handoff: cmdHandoff, mode: cmdMode, report: cmdReport,
    detect: cmdDetect, init: cmdInit, map: cmdMap, outline: cmdOutline, symbol: cmdSymbol, impact: cmdImpact,
    scan: cmdScan, 'check-command': cmdCheckCommand, check: cmdCheckCommand, changes: cmdChanges,
    doctor: cmdDoctor, license: cmdLicense,
  };
  if (cmd === 'version' || args.version) { out(VERSION); return 0; }
  ({ maskKey: maskKeyFn } = await import('./lib/store.mjs'));
  if (process.env.VERIDONE_LICENSE_KEY && ['scan', 'report', 'status', 'doctor'].includes(cmd)) {
    // CI passes store keys through the environment: validate once so the sync checks below see it.
    try { await (await import('./lib/license-online.mjs')).ensureEntitlement(); } catch (e) { err(`license check failed: ${e.message}`); }
  }
  if (cmd === 'help' || args.help || !table[cmd]) { out(HELP); return table[cmd] || cmd === 'help' || args.help ? 0 : 2; }
  const code = await table[cmd](args);
  // Skills inject CLI output with !`...`; a non-zero exit would abort the skill.
  return args['exit-zero'] ? 0 : code;
}
