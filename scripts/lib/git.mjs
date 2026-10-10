// Veridone — minimal, time-boxed git helpers. Never throws; returns null on failure.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
let spawnSyncImpl = null;
function spawnSync(...args) {
  // child_process is loaded lazily: most hook invocations never shell out.
  if (!spawnSyncImpl) spawnSyncImpl = require_('node:child_process').spawnSync;
  return spawnSyncImpl(...args);
}

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

export function git(cwd, args, { timeout = 4000, maxBuffer = 32 * 1024 * 1024, input } = {}) {
  try {
    const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', timeout, maxBuffer, input, windowsHide: true });
    if (r.error || r.status === null) return { ok: false, stdout: '', stderr: String(r.error || 'timeout'), status: -1 };
    return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e), status: -1 };
  }
}

export function isGitRepo(cwd) {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree'], { timeout: 2000 });
  return r.ok && r.stdout.trim() === 'true';
}

export function gitTopLevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 2000 });
  return r.ok ? path.resolve(r.stdout.trim()) : null;
}

export function currentBranch(cwd) {
  const r = git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 2000 });
  if (r.ok) return r.stdout.trim();
  return null; // detached HEAD
}

export function headSha(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD'], { timeout: 2000 });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Porcelain status entries.
 * @returns {{x:string, y:string, path:string}[]|null}
 */
export function status(cwd, pathspecs = [], { untracked = true } = {}) {
  const args = ['status', '--porcelain=v1', '-z', untracked ? '--untracked-files=all' : '--untracked-files=no'];
  if (pathspecs.length) args.push('--', ...pathspecs);
  const r = git(cwd, args, { timeout: 5000 });
  if (!r.ok) return null;
  const out = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec || rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3);
    out.push({ x, y, path: p });
    if (x === 'R' || x === 'C') i++; // skip rename source
  }
  return out;
}

export function isTracked(cwd, file) {
  const r = git(cwd, ['ls-files', '--error-unmatch', '--', file], { timeout: 2000 });
  return r.ok;
}

export function isIgnored(cwd, file) {
  const r = git(cwd, ['check-ignore', '-q', '--', file], { timeout: 2000 });
  return r.status === 0;
}

export function showFile(cwd, rev, relFile) {
  const r = git(cwd, ['show', `${rev}:${relFile}`], { timeout: 4000 });
  return r.ok ? r.stdout : null;
}

export function mergeBase(cwd, a, b = 'HEAD') {
  const r = git(cwd, ['merge-base', a, b], { timeout: 4000 });
  return r.ok ? r.stdout.trim() : null;
}

export function refExists(cwd, ref) {
  return git(cwd, ['rev-parse', '--verify', '--quiet', ref], { timeout: 2000 }).ok;
}

/** Changed files between base and working tree (or HEAD when staged). */
export function changedFiles(cwd, base = 'HEAD', { staged = false } = {}) {
  const args = ['diff', '--name-status', '-z', '--no-renames'];
  if (staged) args.push('--cached');
  if (base) args.push(base);
  const r = git(cwd, args, { timeout: 8000 });
  if (!r.ok) return null;
  const parts = r.stdout.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push({ status: parts[i], path: parts[i + 1] });
  return out;
}

export function listFiles(cwd, { others = true, maxFiles = 50000 } = {}) {
  const args = ['ls-files', '-z', '--cached'];
  if (others) args.push('--others', '--exclude-standard');
  const r = git(cwd, args, { timeout: 10000, maxBuffer: 128 * 1024 * 1024 });
  if (!r.ok) return null;
  const files = r.stdout.split('\0').filter(Boolean);
  return [...new Set(files)].slice(0, maxFiles);
}

/**
 * Dirty or untracked files whose mtime is at or after `sinceMs` (catches edits made through Bash).
 * @returns {{path:string, mtimeMs:number}[]|null}
 */
export function changedSince(root, sinceMs, { limit = 400 } = {}) {
  const st = status(root, [], { untracked: true });
  if (!st) return null;
  const out = [];
  for (const e of st.slice(0, 5000)) {
    if (e.x === '!' || e.y === 'D' || e.x === 'D') continue;
    try {
      const m = fs.statSync(path.join(root, e.path)).mtimeMs;
      if (m >= sinceMs) out.push({ path: e.path, mtimeMs: m });
    } catch { /* deleted or unreadable */ }
    if (out.length >= limit) break;
  }
  return out;
}

export function defaultBaseRef(cwd) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    if (refExists(cwd, ref)) return ref;
  }
  return null;
}
