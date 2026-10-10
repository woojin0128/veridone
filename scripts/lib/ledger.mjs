// Veridone — session ledger: an append-only JSONL event log per session.
//
// Hooks for parallel tool calls run concurrently, so state is never
// read-modify-written. Each hook appends small single-line events (O_APPEND
// writes of < 4 KB are atomic on local filesystems) and readers replay the log.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, ensureDir, nowIso, truncate } from './util.mjs';

const MAX_TEXT = 600;

export function sessionsDir() {
  return ensureDir(path.join(dataDir(), 'sessions'));
}

function safeId(id) {
  return String(id || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

export class Ledger {
  /** @param {string} sessionId */
  constructor(sessionId, dir = sessionsDir()) {
    this.sessionId = sessionId || 'unknown';
    this.file = path.join(dir, `${safeId(this.sessionId)}.jsonl`);
    this._events = null;
  }

  append(event) {
    const e = { at: nowIso(), ...event };
    for (const k of ['text', 'cmd', 'message', 'reason', 'detail', 'prompt']) {
      if (typeof e[k] === 'string') e[k] = truncate(e[k], MAX_TEXT);
    }
    let line = JSON.stringify(e);
    if (line.length > 3800) {
      // keep writes below PIPE_BUF so concurrent appends never interleave
      for (const k of Object.keys(e)) if (typeof e[k] === 'string' && e[k].length > 200) e[k] = truncate(e[k], 200);
      line = JSON.stringify(e);
    }
    try {
      fs.appendFileSync(this.file, line + '\n');
    } catch {
      try { ensureDir(path.dirname(this.file)); fs.appendFileSync(this.file, line + '\n'); } catch { /* ignore */ }
    }
    if (this._events) this._events.push(e);
    return e;
  }

  events() {
    if (this._events) return this._events;
    let raw = '';
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { raw = ''; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* torn line: skip */ }
    }
    this._events = out;
    return out;
  }

  exists() {
    try { return fs.statSync(this.file).isFile(); } catch { return false; }
  }

  /** Derived session state. */
  state() {
    return deriveState(this.events());
  }
}

export function deriveState(events) {
  const s = {
    startedAt: null,
    projectRoot: null,
    cwd: null,
    baselineHead: null,
    mode: null,
    prompts: [],
    edits: [],
    files: new Map(),
    bash: [],
    verifications: [],
    pending: [],
    findings: [],
    guards: [],
    stops: [],
    failures: [],
    condensed: { count: 0, before: 0, after: 0 },
    compactions: 0,
    lastPromptId: null,
    loopNotices: new Set(),
    reported: new Set(),
  };
  for (const e of events) {
    switch (e.t) {
      case 'start':
        if (!s.startedAt) s.startedAt = e.at;
        s.projectRoot = e.projectRoot || s.projectRoot;
        s.cwd = e.cwd || s.cwd;
        if (e.baselineHead && !s.baselineHead) s.baselineHead = e.baselineHead;
        if (e.source === 'compact') s.compactions++;
        break;
      case 'prompt':
        s.prompts.push(e);
        s.lastPromptId = e.promptId || s.lastPromptId;
        break;
      case 'mode':
        s.mode = e.mode;
        break;
      case 'edit': {
        s.edits.push(e);
        const f = s.files.get(e.path) || { path: e.path, kind: e.kind, edits: 0, added: 0, removed: 0, firstAt: e.at, lastAt: e.at };
        f.edits++;
        f.added += e.added || 0;
        f.removed += e.removed || 0;
        f.lastAt = e.at;
        f.kind = e.kind || f.kind;
        s.files.set(e.path, f);
        break;
      }
      case 'bash':
        s.bash.push(e);
        break;
      case 'verify':
        s.verifications.push(e);
        break;
      case 'pending':
        s.pending.push(e);
        break;
      case 'finding':
        s.findings.push(e);
        if (e.key) s.reported.add(e.key);
        break;
      case 'guard':
        s.guards.push(e);
        break;
      case 'stop':
        s.stops.push(e);
        break;
      case 'fail':
        s.failures.push(e);
        break;
      case 'loop':
        s.loopNotices.add(e.sig);
        break;
      case 'condense':
        s.condensed.count++;
        s.condensed.before += e.before || 0;
        s.condensed.after += e.after || 0;
        break;
      default:
        break;
    }
  }
  return s;
}

/** Fast-path session mode (read by every PreToolUse without replaying the ledger). */
export function readSessionMode(sessionId) {
  try {
    const v = fs.readFileSync(path.join(sessionsDir(), `${safeId(sessionId)}.mode`), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

export function writeSessionMode(sessionId, mode) {
  const p = path.join(sessionsDir(), `${safeId(sessionId)}.mode`);
  if (!mode) { try { fs.unlinkSync(p); } catch { /* none */ } return; }
  fs.writeFileSync(p, mode);
}

/** Remove session logs older than maxAgeDays. Runs at most once per day. */
export function gcSessions(maxAgeDays = 14) {
  const dir = sessionsDir();
  const marker = path.join(dir, '.gc');
  try {
    const st = fs.statSync(marker);
    if (Date.now() - st.mtimeMs < 24 * 3600 * 1000) return 0;
  } catch { /* first run */ }
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl') && !f.endsWith('.mode')) continue;
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
    fs.writeFileSync(marker, nowIso());
  } catch { /* ignore */ }
  return removed;
}

/** List recent session files (newest first). */
export function listSessions(limit = 50) {
  const dir = sessionsDir();
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ''), file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);
  } catch {
    return [];
  }
}
