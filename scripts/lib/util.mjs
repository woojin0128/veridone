// Veridone — shared utilities. Zero dependencies, Node >= 18.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const IS_WINDOWS = process.platform === 'win32';

/** Read all of stdin as UTF-8 (synchronous fast path; hooks always receive piped input). */
export function readStdin(timeoutMs = 5000) {
  try {
    return Promise.resolve(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    if (e && (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK')) return readStdinStream(timeoutMs);
    return Promise.resolve('');
  }
}

function readStdinStream(timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

export function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string' || text.trim() === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function readJsonFile(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // Tolerate // line comments and trailing commas in hand-edited config files.
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return fallback;
  }
}

/** Remove // and /* *\/ comments plus trailing commas, respecting strings. */
export function stripJsonComments(src) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return dir;
}

export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Fast non-cryptographic 64-bit hash (FNV-1a variants) as hex — for dedupe keys only. */
export function shortHash(text, len = 12) {
  const s = String(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 13;
  }
  const hex = (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  return hex.slice(0, Math.min(len, 16));
}

export function nowIso() { return new Date().toISOString(); }

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** Normalize a filesystem path to forward slashes (Windows friendly). */
export function toPosix(p) {
  if (!p) return p;
  return String(p).replace(/\\/g, '/');
}

/** Path comparison key: posix separators, and case-folded on Windows/macOS drives. */
export function pathKey(p) {
  let s = toPosix(path.resolve(p));
  if (IS_WINDOWS || process.platform === 'darwin') s = s.toLowerCase();
  return s.replace(/\/+$/, '') || '/';
}

export function isInside(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  return c.startsWith(p === '/' ? '/' : p + '/');
}

export function relPath(root, abs) {
  if (!root || !abs) return abs;
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return toPosix(abs);
  return toPosix(r);
}

export function truncate(text, max = 200) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function oneLine(text, max = 160) {
  return truncate(String(text ?? '').replace(/\s+/g, ' ').trim(), max);
}

export function shannonEntropy(str) {
  if (!str) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------------------
// Glob matching (subset of minimatch): **, *, ?, [abc], {a,b}. Paths use '/'.
// ---------------------------------------------------------------------------
const globCache = new Map();

export function globToRegExp(glob) {
  const key = glob;
  if (globCache.has(key)) return globCache.get(key);
  let g = toPosix(glob);
  let re = '';
  let i = 0;
  const anchoredToRoot = g.startsWith('/');
  if (anchoredToRoot) g = g.slice(1);
  // A pattern without a slash matches the basename anywhere (gitignore-like).
  const basenameOnly = !g.includes('/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // '**/' => zero or more directories; trailing '**' => anything
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i) {
        let cls = g.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end + 1;
        continue;
      }
    }
    if (c === '{') {
      const end = g.indexOf('}', i + 1);
      if (end > i) {
        const alts = g.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
        re += '(?:' + alts.join('|') + ')';
        i = end + 1;
        continue;
      }
    }
    re += c.replace(/[.+^$()|\\]/g, '\\$&');
    i++;
  }
  const full = basenameOnly && !anchoredToRoot ? `(?:^|/)${re}$` : `^${re}$`;
  const rx = new RegExp(full, IS_WINDOWS ? 'i' : '');
  globCache.set(key, rx);
  return rx;
}

/** Match a (relative or absolute) path against globs. */
export function matchGlob(p, globs) {
  if (!globs || !globs.length || !p) return null;
  const s = toPosix(p).replace(/^\.\//, '');
  for (const g of globs) {
    if (!g) continue;
    const rx = globToRegExp(g);
    if (rx.test(s)) return g;
    // Also allow matching of absolute paths against relative '**/' globs
    if (s.startsWith('/') && rx.test(s.slice(1))) return g;
  }
  return null;
}

export function uniq(arr) { return [...new Set(arr)]; }

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function approxTokens(chars) { return Math.round((chars || 0) / 4); }

let fallbackDataDir = null;
/**
 * Plugin data directory (persistent across plugin updates).
 * Hooks and the MCP server receive CLAUDE_PLUGIN_DATA; commands run through the Bash tool do not,
 * so the CLI falls back to the most recently used Veridone data directory under ~/.claude/plugins/data.
 */
export function dataDir() {
  const fromEnv = process.env.VERIDONE_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA;
  if (fromEnv) return ensureDir(fromEnv);
  if (fallbackDataDir) return fallbackDataDir;
  const base = path.join(homeDir(), '.claude', 'plugins', 'data');
  let best = null;
  try {
    for (const name of fs.readdirSync(base)) {
      if (!/^veridone(?:$|-)/.test(name)) continue;
      let m = 0;
      try { m = fs.statSync(path.join(base, name, 'sessions')).mtimeMs; } catch { continue; }
      if (!best || m > best.m) best = { dir: path.join(base, name), m };
    }
  } catch { /* no data dir yet */ }
  fallbackDataDir = ensureDir(best ? best.dir : path.join(base, 'veridone'));
  return fallbackDataDir;
}

export function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  // scripts/lib/util.mjs -> plugin root is two levels up from lib/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function readTextSafe(p, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function isProbablyBinary(text) {
  if (!text) return false;
  const sample = text.slice(0, 8000);
  return sample.includes('\u0000');
}

/** Split text into lines without trailing empty element. */
export function splitLines(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function debugLog(...args) {
  if (!process.env.VERIDONE_DEBUG) return;
  try {
    const file = path.join(dataDir(), 'debug.log');
    fs.appendFileSync(file, `[${nowIso()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`);
  } catch { /* ignore */ }
}
