// Veridone — pre-execution guard for shell commands and file operations.
//
// analyzeBash() parses the command line (see shell.mjs), unwraps wrappers
// (sudo, env, xargs, npx, bash -c, ssh, find -exec, scripts on disk, ...) and
// applies semantic rules with path awareness (project root, home, system dirs,
// disposable build dirs, uncommitted work). Decisions: deny | ask | warn.

import path from 'node:path';
import os from 'node:os';
import { parse, nestedSources } from './shell.mjs';
import { ruleLevel } from './config.mjs';
import * as G from './git.mjs';
import { matchGlob, isInside, homeDir, readTextSafe, toPosix, oneLine, pathKey, fileExists, dirExists, IS_WINDOWS } from './util.mjs';
import { scanSecrets, isSecretStoreFile } from './secrets.mjs';

export const LEVEL_RANK = { off: 0, info: 0, warn: 1, ask: 2, deny: 3 };

/** Rule table: default level per mode. */
export const GUARD_RULES = {
  'rm-catastrophic': { all: 'deny', title: 'Catastrophic delete' },
  'rm-dynamic-path': { strict: 'ask', standard: 'ask', relaxed: 'ask', title: 'Recursive delete of an unresolved path' },
  'rm-outside-project': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Recursive delete outside the project' },
  'rm-uncommitted-work': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Delete would destroy uncommitted work' },
  'rm-tests': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Deleting tests' },
  'git-force-push-protected': { strict: 'deny', standard: 'ask', relaxed: 'ask', title: 'Force-push to a protected branch' },
  'git-push-delete': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Deleting remote refs' },
  'git-discard-changes': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Discarding uncommitted changes' },
  'git-branch-force-delete': { strict: 'ask', standard: 'ask', relaxed: 'off', title: 'Force-deleting a branch' },
  'git-history-rewrite': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Rewriting or pruning git history' },
  'git-hooks-bypass': { strict: 'deny', standard: 'ask', relaxed: 'warn', title: 'Bypassing repository hooks' },
  'disk-destroy': { all: 'deny', title: 'Disk/partition destruction' },
  'system-power': { all: 'deny', title: 'Shutdown/reboot' },
  'fork-bomb': { all: 'deny', title: 'Fork bomb' },
  'reverse-shell': { all: 'deny', title: 'Reverse shell' },
  'dangerous-permissions': { strict: 'deny', standard: 'ask', relaxed: 'ask', title: 'Dangerous permission change' },
  'remote-script-exec': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Piping a download into a shell' },
  'secret-file-read': { strict: 'deny', standard: 'ask', relaxed: 'warn', title: 'Reading a secrets file' },
  'secret-exfiltration': { all: 'deny', title: 'Sending secrets over the network' },
  'secret-env-dump': { strict: 'ask', standard: 'ask', relaxed: 'off', title: 'Printing secret environment values' },
  'publish-release': { strict: 'ask', standard: 'ask', relaxed: 'ask', title: 'Publishing a package or release' },
  'infra-destroy': { strict: 'deny', standard: 'ask', relaxed: 'ask', title: 'Destroying infrastructure' },
  'infra-change': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Changing live infrastructure' },
  'db-destructive': { strict: 'ask', standard: 'ask', relaxed: 'ask', title: 'Destructive database operation' },
  'container-data-loss': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Deleting container volumes' },
  'kill-broad': { strict: 'ask', standard: 'ask', relaxed: 'off', title: 'Killing processes broadly' },
  'system-file-write': { strict: 'deny', standard: 'deny', relaxed: 'ask', title: 'Writing a system or credential file' },
  'shell-profile-write': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Modifying shell startup files' },
  'guardrail-tamper': { strict: 'deny', standard: 'ask', relaxed: 'ask', title: 'Modifying safety configuration' },
  'snapshot-update': { strict: 'ask', standard: 'warn', relaxed: 'off', title: 'Rewriting test snapshots' },
  'env-file-clobber': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Overwriting a secrets file' },
  // file tools
  'protected-file': { strict: 'deny', standard: 'ask', relaxed: 'warn', title: 'Editing a protected file' },
  'git-internals': { all: 'deny', title: 'Editing .git internals' },
  'generated-file': { strict: 'ask', standard: 'ask', relaxed: 'warn', title: 'Editing a generated file' },
  'migration-edit': { strict: 'deny', standard: 'ask', relaxed: 'warn', title: 'Editing an applied migration' },
  'hardcoded-secret': { strict: 'deny', standard: 'deny', relaxed: 'ask', title: 'Hard-coded credential' },
  'possible-secret': { strict: 'ask', standard: 'warn', relaxed: 'off', title: 'Possible hard-coded credential' },
  'secret-not-ignored': { strict: 'ask', standard: 'warn', relaxed: 'warn', title: 'Secrets file is not git-ignored' },
};

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'pwsh', 'powershell', 'iex', 'Invoke-Expression']);
const NET_FETCH = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c', 'iwr', 'irm', 'Invoke-WebRequest', 'Invoke-RestMethod']);
const PRINTERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'bat', 'batcat', 'nl', 'tac', 'strings', 'xxd', 'hexdump', 'od', 'base64', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'awk', 'gawk', 'mawk', 'sed', 'cut', 'sort', 'uniq', 'jq', 'yq', 'diff', 'openssl', 'column', 'fold', 'paste', 'pr', 'tee', 'type', 'Get-Content', 'gc', 'view', 'vim', 'vi', 'nano', 'code']);
const NET_SEND = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'scp', 'sftp', 'rsync', 'ssh', 'ftp', 'http', 'xh', 'aws', 'gsutil', 'rclone', 'gh']);
const TEST_PATH_RE = /(^|\/)(__tests__|__test__|tests?|specs?|e2e|integration-tests?)(\/|$)|\.(test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py|rb|exs|dart)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(java|kt|cs|swift|scala)$|\.(test|spec)\.(py|rb|php|rs|dart|vue|svelte)$|Test\.php$/i;

export function isTestPath(p) {
  return TEST_PATH_RE.test(toPosix(p || ''));
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * @param {{cwd:string, projectRoot:string, config:any, scratchpad?:string}} base
 */
export function makeContext(base) {
  const cwd = base.cwd || base.projectRoot || process.cwd();
  const projectRoot = base.projectRoot || cwd;
  const memo = new Map();
  const once = (k, fn) => {
    if (!memo.has(k)) memo.set(k, fn());
    return memo.get(k);
  };
  return {
    cwd,
    projectRoot,
    home: homeDir(),
    config: base.config,
    scratchpad: base.scratchpad || null,
    depth: 0,
    remote: false,
    visitedScripts: new Set(),
    git: {
      isRepo: () => once('isRepo', () => G.isGitRepo(projectRoot)),
      branch: () => once('branch', () => G.currentBranch(cwd)),
      status: (paths = []) => once('status:' + paths.join('\0'), () => G.status(cwd, paths)),
      isTracked: (f) => once('tracked:' + f, () => G.isTracked(projectRoot, f)),
      isIgnored: (f) => once('ignored:' + f, () => G.isIgnored(projectRoot, f)),
    },
  };
}

function lvl(ctx, ruleId) {
  const cfg = ctx.config;
  return ruleLevel(GUARD_RULES, ruleId, cfg, cfg?.guard?.rules || {});
}

function add(out, ctx, ruleId, detail, fix, extra = {}) {
  const level = lvl(ctx, ruleId);
  if (level === 'off') return;
  out.push({ rule: ruleId, level, title: GUARD_RULES[ruleId]?.title || ruleId, detail, fix: fix || '', ...extra });
}

export function combine(findings) {
  let level = null;
  for (const f of findings) if (!level || LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level;
  return level;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const SYSTEM_DIRS_POSIX = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/boot', '/dev', '/proc', '/sys', '/var', '/root', '/opt', '/snap', '/srv', '/System', '/Library', '/Applications', '/private', '/cores', '/Volumes', '/nix', '/home', '/Users'];
const SYSTEM_EXCEPTIONS = ['/var/tmp', '/var/folders', '/private/tmp', '/private/var/folders', '/tmp'];

function tempDirs(ctx) {
  const list = ['/tmp', '/var/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()];
  if (ctx.scratchpad) list.push(ctx.scratchpad);
  if (process.env.TMPDIR) list.push(process.env.TMPDIR);
  return list.filter(Boolean);
}

/**
 * Resolve a word used as a path.
 * @returns {{abs:string|null, dynamic:boolean, glob:boolean, raw:string, base:string|null}}
 */
export function resolvePathWord(word, cwd, ctx) {
  const raw = word.value;
  let v = raw;
  const home = ctx.home;
  if ((word.tilde || v.startsWith('~')) && (v === '~' || v.startsWith('~/'))) v = home + v.slice(1);
  else if (!word.quoted) {
    // ~user: another account's home directory
    const m = /^~([A-Za-z_][\w.-]*)(?=\/|$)/.exec(v);
    if (m) v = (m[1] === 'root' ? '/root' : path.join(path.dirname(home), m[1])) + v.slice(m[0].length);
  }
  v = v.replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^\$\{?PWD\}?(?=\/|$)/, cwd || '');
  v = v.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?(?=\/|$)/, ctx.projectRoot);
  const dynamic = /[`$]/.test(v) || (word.dynamic && /[`$]/.test(v)) || cwd === null;
  const glob = !!word.glob;
  if (IS_WINDOWS) v = v.replace(/^\/([a-zA-Z])\//, '$1:/');
  let base = v;
  if (dynamic) {
    const idx = v.search(/[`$]/);
    base = idx >= 0 ? v.slice(0, idx) : v;
  }
  if (glob) {
    const gi = base.search(/[*?[]/);
    if (gi >= 0) base = base.slice(0, gi);
  }
  const resolveIt = (p) => {
    if (p === '' || p === null) return null;
    if (cwd === null && !path.isAbsolute(p)) return null;
    return path.resolve(cwd || '/', p);
  };
  let target;
  if (dynamic || glob) {
    if (base === '') target = dynamic ? null : '.';
    else if (base.endsWith('/')) target = base;
    else if (base.includes('/')) target = base.replace(/\/[^/]*$/, '/');
    else target = glob && !dynamic ? '.' : base;
  } else {
    target = v;
  }
  const abs = target === null ? null : resolveIt(target);
  return { abs, dynamic, glob, raw, base: base || null };
}

function isSystemPath(abs) {
  const k = toPosix(abs);
  if (SYSTEM_EXCEPTIONS.some((e) => k === e || k.startsWith(e + '/'))) return false;
  if (IS_WINDOWS && /^[a-z]:\/(windows|program files|program files \(x86\)|programdata)(\/|$)/i.test(k)) return true;
  return SYSTEM_DIRS_POSIX.some((d) => k === d || k.startsWith(d + '/'));
}

function isHomeTopLevel(abs, ctx) {
  const parent = pathKey(path.dirname(abs));
  return parent === pathKey(ctx.home);
}

/**
 * Classify a delete target.
 * @returns {{cls:'catastrophic'|'dynamic'|'protected'|'outside'|'inside'|'disposable'|'temp', why:string, rel?:string}}
 */
export function classifyDeleteTarget(t, ctx, recursive) {
  const home = ctx.home;
  if (t.dynamic) {
    const baseAbs = t.abs;
    if (!baseAbs || pathKey(baseAbs) === '/' || pathKey(baseAbs) === pathKey(home) || t.base === '' || t.base === '/' || t.base === '~/' || t.base === home + '/') {
      return { cls: 'dynamic', why: `\`${t.raw}\` contains an unresolved variable/substitution; if it expands to empty the command targets ${t.base || '/'}` };
    }
  }
  const abs = t.abs;
  if (!abs) return { cls: 'dynamic', why: `\`${t.raw}\` cannot be resolved` };
  const k = pathKey(abs);
  const pr = pathKey(ctx.projectRoot);
  if (k === '/' || /^[a-z]:\/?$/i.test(k)) return { cls: 'catastrophic', why: 'targets the filesystem root' };
  if (k === pathKey(home)) return { cls: 'catastrophic', why: 'targets your home directory' };
  if (t.glob && (k === pathKey(home) || k === '/')) return { cls: 'catastrophic', why: 'glob over the root or home directory' };
  if (pr !== '/' && (k === pr || pr.startsWith(k + '/'))) return { cls: 'catastrophic', why: 'would delete the entire project (or a parent of it)' };
  if (isInside(abs, ctx.projectRoot)) {
    const rel = toPosix(path.relative(ctx.projectRoot, abs));
    if (rel === '.git' || (rel.startsWith('.git/') && !/\.lock$/.test(rel) && recursive)) return { cls: 'catastrophic', why: 'destroys the git repository and its history', rel };
    const segs = rel.split('/');
    const disposable = ctx.config?.guard?.disposableDirs || [];
    if (segs.some((s) => disposable.includes(s))) return { cls: 'disposable', why: 'build/cache directory', rel };
    if (t.glob && !rel.includes('/') && (t.raw.startsWith('*') || t.raw.startsWith('./*') || /\/\*$/.test(t.raw))) {
      return { cls: 'protected', why: 'glob over the top level of the project', rel };
    }
    return { cls: 'inside', why: '', rel };
  }
  if (tempDirs(ctx).some((d) => isInside(abs, d))) return { cls: 'temp', why: 'temporary directory' };
  if (isSystemPath(abs)) return { cls: 'catastrophic', why: `system path ${toPosix(abs)}` };
  if (isInside(abs, home) && isHomeTopLevel(abs, ctx) && recursive) return { cls: 'catastrophic', why: `top-level folder of your home directory (${toPosix(abs)})` };
  return { cls: 'outside', why: `outside the project (${toPosix(abs)})` };
}

function relToProject(abs, ctx) {
  if (!abs) return null;
  if (!isInside(abs, ctx.projectRoot)) return null;
  return toPosix(path.relative(ctx.projectRoot, abs)) || '.';
}

function isSensitivePath(abs, ctx, rawValue = '') {
  const g = ctx.config?.guard || {};
  const candidates = [];
  if (abs) {
    const rel = relToProject(abs, ctx);
    if (rel) candidates.push(rel);
    candidates.push(toPosix(abs));
    if (isInside(abs, ctx.home)) candidates.push(toPosix(path.relative(ctx.home, abs)));
  }
  if (rawValue) candidates.push(toPosix(rawValue).replace(/^\.\//, ''));
  for (const c of candidates) {
    if (matchGlob(c, g.sensitiveExceptions || [])) return null;
  }
  for (const c of candidates) {
    const m = matchGlob(c, g.sensitiveFiles || []);
    if (m) return m;
  }
  if (/^\/proc\/(self|\d+|\*)\/environ$/.test(toPosix(abs || rawValue))) return '/proc/*/environ';
  return null;
}

function isGuardrailPath(abs, ctx) {
  if (!abs) return null;
  const g = ctx.config?.guard || {};
  const cands = [toPosix(abs)];
  const rel = relToProject(abs, ctx);
  if (rel) cands.push(rel);
  for (const c of cands) {
    const m = matchGlob(c, g.guardrailFiles || []);
    if (m) return m;
  }
  const hk = pathKey(path.join(ctx.home, '.claude'));
  const k = pathKey(abs);
  if (k === hk + '/settings.json' || k === hk + '/settings.local.json' || /\/\.claude\/veridone[^/]*\.json$/.test(k)) return '~/.claude/settings.json';
  return null;
}

function systemWriteClass(abs, ctx) {
  if (!abs) return null;
  const k = toPosix(abs);
  const home = toPosix(ctx.home);
  if (k.startsWith(home + '/.ssh/') || k === home + '/.ssh') return { rule: 'system-file-write', why: 'SSH keys/authorized_keys' };
  if (/^\/etc(\/|$)/.test(k) || /^\/(usr|bin|sbin|lib|boot)(\/|$)/.test(k)) return { rule: 'system-file-write', why: 'system configuration' };
  if (k.startsWith(home + '/.aws/') || k.startsWith(home + '/.kube/') || k.startsWith(home + '/.gnupg/') || k === home + '/.netrc' || k === home + '/.git-credentials') {
    return { rule: 'system-file-write', why: 'credential store' };
  }
  if (/\/(Library\/LaunchAgents|Library\/LaunchDaemons|\.config\/systemd|\.config\/autostart)\//.test(k)) return { rule: 'system-file-write', why: 'auto-start entries' };
  const base = path.basename(k);
  if (path.dirname(k) === home && /^\.(bashrc|bash_profile|bash_login|profile|zshrc|zprofile|zshenv|zlogin|cshrc|tcshrc|kshrc|inputrc)$/.test(base)) {
    return { rule: 'shell-profile-write', why: `shell startup file ~/${base}` };
  }
  if (k.startsWith(home + '/.config/fish/')) return { rule: 'shell-profile-write', why: 'fish shell config' };
  return null;
}

// ---------------------------------------------------------------------------
// Command unwrapping
// ---------------------------------------------------------------------------

function baseName(v) {
  const b = String(v || '').replace(/\\/g, '/').split('/').pop() || '';
  return b.replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

function skipOpts(words, i, withArg = new Set(), { stopAtNonOption = true } = {}) {
  while (i < words.length) {
    const v = words[i].value;
    if (v === '--') return i + 1;
    if (!v.startsWith('-') || v === '-') return i;
    if (withArg.has(v)) { i += 2; continue; }
    // --opt=value or clustered short flags
    i++;
    if (!stopAtNonOption) continue;
  }
  return i;
}

/**
 * A dynamic command word whose value is still knowable: `$(which rm)`, `$(command -v rm)`, `${RM:-rm}`.
 */
function staticCommandName(word) {
  if (!word || !word.dynamic) return null;
  const v = String(word.value || '');
  let m = /^\$\{\w+:?-([\w./+-]+)\}$/.exec(v);
  if (m) return m[1];
  m = /^(?:\$\(|`)\s*(?:which|command\s+-v|type\s+-p|whereis\s+-b)\s+([\w./+-]+)\s*(?:\)|`)$/.exec(v);
  if (m) return m[1];
  return null;
}

/**
 * Unwrap wrapper commands.
 * @returns {{words:any[], name:string, sudo:boolean, xargs:boolean, env:Record<string,string>, via:string[], nested:{src:string, kind:string, remote?:boolean}[]}}
 */
export function unwrap(cmd) {
  let words = cmd.argv.slice();
  const env = {};
  for (const a of cmd.assigns) env[a.name] = a.value;
  const via = [];
  const nested = [];
  let sudo = false;
  let xargs = false;
  for (let guard = 0; guard < 12 && words.length; guard++) {
    const resolved = staticCommandName(words[0]);
    if (resolved) words = [{ ...words[0], value: resolved, dynamic: false, subs: [] }, ...words.slice(1)];
    const name = baseName(words[0].value);
    if ((name === 'busybox' || name === 'toybox') && words[1] && !/^(sh|ash|bash|hush|-)/.test(words[1].value)) {
      via.push(name);
      words = words.slice(1);
      continue;
    }
    if (name === 'sudo' || name === 'doas' || name === 'run0' || name === 'pkexec') {
      sudo = true;
      via.push(name);
      const i = skipOpts(words, 1, new Set(['-u', '-g', '-p', '-h', '-C', '-D', '-r', '-t', '-T', '-U', '--user', '--group', '--prompt', '--host', '--close-from', '--chdir', '--role', '--type', '--command-timeout', '--other-user']));
      words = words.slice(i);
      continue;
    }
    if (name === 'env') {
      // `env` alone (or with only options) prints the environment: it is the command, not a wrapper.
      let probe = 1;
      while (probe < words.length && (words[probe].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[probe].value))) {
        probe += ['-u', '--unset', '-C', '--chdir'].includes(words[probe].value) ? 2 : 1;
      }
      if (probe >= words.length && !words.some((w) => w.value === '-S' || w.value === '--split-string')) break;
      via.push('env');
      let i = 1;
      while (i < words.length) {
        const v = words[i].value;
        if (v === '--') { i++; break; }
        if (v === '-u' || v === '--unset' || v === '-C' || v === '--chdir' || v === '-S' || v === '--split-string') {
          if (v === '-S' || v === '--split-string') {
            const s = words[i + 1]?.value;
            if (s) nested.push({ src: s, kind: 'env -S' });
          }
          i += 2;
          continue;
        }
        if (v.startsWith('-')) { i++; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { const eq = v.indexOf('='); env[v.slice(0, eq)] = v.slice(eq + 1); i++; continue; }
        break;
      }
      words = words.slice(i);
      continue;
    }
    if (['nohup', 'command', 'builtin', 'exec', 'unbuffer', 'caffeinate', 'setsid', 'chronic', 'time', 'noglob', 'stdbuf', 'ionice', 'chrt', 'taskset', 'nice', 'strace', 'ltrace', 'firejail', 'proxychains', 'proxychains4', 'tsp'].includes(name)) {
      via.push(name);
      const withArg = new Set(['-n', '--adjustment', '-c', '--class', '-o', '-e', '-i', '-a', '-p', '-s']);
      let i = 1;
      if (name === 'taskset') i = skipOpts(words, 1) + 1; // mask
      else if (name === 'chrt') { i = skipOpts(words, 1); i += 1; }
      else i = skipOpts(words, 1, withArg);
      words = words.slice(i);
      continue;
    }
    if (name === 'timeout' || name === 'gtimeout') {
      via.push('timeout');
      let i = skipOpts(words, 1, new Set(['-s', '--signal', '-k', '--kill-after']));
      i += 1; // duration
      words = words.slice(i);
      continue;
    }
    if (name === 'watch') {
      via.push('watch');
      const i = skipOpts(words, 1, new Set(['-n', '--interval', '-d', '--differences']));
      const rest = words.slice(i);
      if (rest.length === 1) { nested.push({ src: rest[0].value, kind: 'watch' }); words = []; } else words = rest;
      continue;
    }
    if (name === 'parallel') {
      // GNU parallel: `parallel [opts] cmd args ::: inputs` runs cmd with each input appended.
      via.push('parallel');
      const sep = words.findIndex((w) => w.value === ':::' || w.value === '::::');
      const start = skipOpts(words, 1, new Set(['-j', '--jobs', '-S', '--sshlogin', '--joblog', '-a', '--arg-file', '--delay', '--timeout', '-N', '-n', '--max-args', '-I', '--colsep']));
      const inputs = sep >= 0 ? words.slice(sep + 1).filter((w) => w.value !== ':::' && w.value !== '::::') : [];
      words = [...words.slice(start, sep >= 0 ? sep : words.length), ...inputs];
      if (!inputs.length) xargs = true; // inputs arrive on stdin, like xargs
      continue;
    }
    if (name === 'xargs') {
      xargs = true;
      via.push('xargs');
      const i = skipOpts(words, 1, new Set(['-n', '--max-args', '-I', '-i', '-L', '--max-lines', '-P', '--max-procs', '-d', '--delimiter', '-E', '-e', '-s', '--max-chars', '-a', '--arg-file']));
      words = words.slice(i);
      if (!words.length) words = [{ value: 'echo', quoted: false, dynamic: false, glob: false, subs: [] }];
      continue;
    }
    if (name === 'npx' || name === 'bunx' || name === 'pnpx') {
      via.push(name);
      let i = 1;
      while (i < words.length) {
        const v = words[i].value;
        if (v === '--') { i++; break; }
        if (v === '-c' || v === '--call') { if (words[i + 1]) nested.push({ src: words[i + 1].value, kind: 'npx -c' }); words = []; break; }
        if (v === '-p' || v === '--package') { i += 2; continue; }
        if (v.startsWith('-')) { i++; continue; }
        break;
      }
      if (!words.length) break;
      words = words.slice(i);
      if (words[0]) words[0] = { ...words[0], value: words[0].value.replace(/^(@[^/]+\/)?([^@]+)@.*$/, '$1$2') };
      continue;
    }
    const sub = words[1]?.value;
    if ((name === 'npm' && sub === 'exec') || ((name === 'pnpm' || name === 'yarn') && (sub === 'dlx' || sub === 'exec')) || (name === 'bun' && sub === 'x')) {
      via.push(`${name} ${sub}`);
      let i = skipOpts(words, 2, new Set(['-p', '--package', '-c', '--call']));
      words = words.slice(i);
      continue;
    }
    if (((name === 'poetry' || name === 'uv' || name === 'pipenv' || name === 'pdm' || name === 'hatch' || name === 'rye') && sub === 'run') || (name === 'bundle' && sub === 'exec') || ((name === 'mise' || name === 'asdf' || name === 'rtx') && sub === 'exec')) {
      via.push(`${name} ${sub}`);
      const i = skipOpts(words, 2, new Set(['--with', '-p', '--python', '--env', '-e']));
      words = words.slice(i);
      continue;
    }
    if (name === 'conda' && sub === 'run') {
      via.push('conda run');
      const i = skipOpts(words, 2, new Set(['-n', '--name', '-p', '--prefix', '--cwd']));
      words = words.slice(i);
      continue;
    }
    if (name === 'dotenv' || name === 'dotenvx' || name === 'env-cmd' || name === 'cross-env') {
      via.push(name);
      let i = 1;
      if (name === 'dotenvx' && sub === 'run') i = 2;
      while (i < words.length && words[i].value !== '--' && (words[i].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value))) {
        if (['-e', '-f', '--env-file', '-c'].includes(words[i].value)) i += 2; else i++;
      }
      if (words[i]?.value === '--') i++;
      words = words.slice(i);
      continue;
    }
    break;
  }
  const name = words.length ? baseName(words[0].value) : '';
  return { words, name, sudo, xargs, env, via, nested };
}

// ---------------------------------------------------------------------------
// Main entry: analyze a Bash command line
// ---------------------------------------------------------------------------

/**
 * @param {string} commandLine
 * @param {ReturnType<typeof makeContext>} ctx
 * @returns {{level:string|null, findings:any[]}}
 */
export function analyzeBash(commandLine, ctx) {
  const findings = [];
  const cfg = ctx.config;
  if (!cfg || cfg.mode === 'off' || cfg.guard?.enabled === false) return { level: null, findings };
  const line = String(commandLine || '');
  for (const pattern of cfg.guard?.allowCommands || []) {
    try { if (new RegExp(pattern).test(line)) return { level: null, findings }; } catch { /* bad regex: ignore */ }
  }
  analyzeSource(line, ctx, findings, ctx.cwd);
  customCommandRules(line, ctx, findings);
  // de-duplicate identical findings
  const seen = new Set();
  const uniq = findings.filter((f) => {
    const k = `${f.rule}|${f.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { level: combine(uniq), findings: uniq };
}

/**
 * Team-specific command rules from `guard.customRules` (Veridone Pro):
 * { id, pattern, flags?, level: 'deny'|'ask'|'warn', message, fix? } — matched against the whole command line.
 */
function customCommandRules(line, ctx, out) {
  for (const r of ctx.config?.guard?.customRules || []) {
    if (!r || !r.id || typeof r.pattern !== 'string') continue;
    let re;
    try { re = new RegExp(r.pattern, String(r.flags || '').replace(/[^imsu]/g, '')); } catch { continue; }
    if (!re.test(line)) continue;
    let level = ['deny', 'ask', 'warn'].includes(r.level) ? r.level : 'ask';
    if (ctx.config.mode === 'relaxed' && level === 'ask') level = 'warn';
    out.push({ rule: `custom:${String(r.id).replace(/^custom:/, '')}`, level, title: r.title || `Team rule ${r.id}`, detail: r.message || `Matches the team rule "${r.id}".`, fix: r.fix || '' });
  }
}

function analyzeSource(src, ctx, out, cwd) {
  if (ctx.depth > 5 || !src) return;
  rawChecks(src, ctx, out);
  const { commands } = parse(src);
  let effCwd = cwd;
  // group by pipeline
  const pipelines = new Map();
  for (const cmd of commands) {
    const u = unwrap(cmd);
    const inv = { cmd, ...u, cwd: effCwd, pipelineId: cmd.pipelineId, pipeIndex: cmd.pipeIndex };
    if (!pipelines.has(cmd.pipelineId)) pipelines.set(cmd.pipelineId, []);
    pipelines.get(cmd.pipelineId).push(inv);

    // nested sources: substitutions, env -S, npx -c ...
    for (const s of nestedSources(cmd)) recurse(s.src, ctx, out, effCwd, s.kind === 'proc' ? 'process substitution' : 'command substitution');
    for (const n of u.nested) recurse(n.src, ctx, out, effCwd, n.kind);

    // cd tracking (approximation: ignores subshell scoping)
    if (u.name === 'cd' || u.name === 'pushd') {
      const target = u.words[1];
      if (!target) effCwd = ctx.home;
      else if (target.value === '-') effCwd = null;
      else {
        const r = resolvePathWord(target, effCwd, ctx);
        effCwd = r.dynamic ? null : r.abs;
      }
      continue;
    }
    if (u.name === 'popd') { effCwd = null; continue; }

    checkInvocation(inv, ctx, out);
    checkRedirects(inv, ctx, out);
  }
  for (const invs of pipelines.values()) checkPipeline(invs, ctx, out);
}

function recurse(src, ctx, out, cwd, kind) {
  const child = { ...ctx, depth: ctx.depth + 1 };
  analyzeSource(src, child, out, cwd);
}

// ---------------------------------------------------------------------------
// Raw-string checks (patterns that survive any tokenization)
// ---------------------------------------------------------------------------

function rawChecks(src, ctx, out) {
  if (/(\b\w+|:)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;?\s*\1/.test(src) || /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(src)) {
    add(out, ctx, 'fork-bomb', 'This is a fork bomb: it spawns processes until the machine becomes unresponsive.', 'Do not run it.');
  }
  if (/\/dev\/(tcp|udp)\/[^\s/]+\/\d+/.test(src) && /(\b(ba|z|k)?sh\b[^|;&]*-i|>&|0>&1|exec\s+\d+<>)/.test(src)) {
    add(out, ctx, 'reverse-shell', 'Opens an interactive shell over a raw network socket (/dev/tcp), which hands control of this machine to a remote host.', 'Do not run it.');
  }
  if (/\b(nc|ncat|netcat)\b[^|;&]*\s-(e|c)\s*\/?(bin\/)?(ba|z)?sh\b/.test(src) || /\bsocat\b[^|;&]*\bexec:[^|;&]*(ba|z)?sh/i.test(src) || /mkfifo[^;&|]*;[^;]*\b(nc|ncat)\b[^;]*\b(ba|z)?sh\b/.test(src)) {
    add(out, ctx, 'reverse-shell', 'Binds a shell to a network connection (reverse/bind shell).', 'Do not run it.');
  }
}

// ---------------------------------------------------------------------------
// Per-invocation checks
// ---------------------------------------------------------------------------

function nonOptionArgs(words, startIdx = 1, withArg = new Set()) {
  const out = [];
  let endOfOpts = false;
  for (let i = startIdx; i < words.length; i++) {
    const v = words[i].value;
    if (!endOfOpts && v === '--') { endOfOpts = true; continue; }
    if (!endOfOpts && v.startsWith('-') && v !== '-') {
      if (withArg.has(v)) i++;
      continue;
    }
    out.push(words[i]);
  }
  return out;
}

function hasFlag(words, shorts = [], longs = []) {
  for (const w of words.slice(1)) {
    const v = w.value;
    if (v === '--') break;
    if (longs.some((l) => v === l || v.startsWith(l + '='))) return true;
    if (/^-[A-Za-z0-9]+$/.test(v) && shorts.some((s) => v.slice(1).includes(s))) return true;
  }
  return false;
}

function checkInvocation(inv, ctx, out) {
  const { name, words } = inv;
  if (!name) return;
  const lname = name.toLowerCase();

  // Nested shells and code runners ------------------------------------------------
  if (SHELLS.has(lname)) return checkShell(inv, ctx, out);
  if (lname === 'eval') {
    recurse(words.slice(1).map((w) => w.value).join(' '), ctx, out, inv.cwd, 'eval');
    return;
  }
  if (lname === 'source' || lname === '.') {
    const f = words[1];
    if (f) checkScriptFile(f, inv, ctx, out);
    return;
  }
  if (lname === 'ssh') return checkSsh(inv, ctx, out);
  if ((lname === 'docker' || lname === 'podman' || lname === 'kubectl' || lname === 'oc') && words.some((w) => w.value === 'exec')) {
    const dash = words.findIndex((w) => w.value === '--');
    let inner = null;
    if (dash >= 0) inner = words.slice(dash + 1);
    else {
      const ei = words.findIndex((w) => w.value === 'exec');
      const rest = nonOptionArgs(words, ei + 1, new Set(['-e', '--env', '-u', '--user', '-w', '--workdir', '-c', '--container', '-n', '--namespace']));
      inner = rest.slice(1);
    }
    if (inner && inner.length) {
      const child = { ...ctx, depth: ctx.depth + 1, remote: true };
      analyzeSource(inner.map((w) => quoteIfNeeded(w.value)).join(' '), child, out, null);
    }
  }
  if (INTERPRETERS.has(lname)) checkInlineCode(inv, ctx, out);
  // The Veridone CLI itself: loosening its own mode or removing the license is the user's call.
  if ((lname === 'node' || lname === 'bun' || lname === 'deno') || /veridone(\.mjs)?$/.test(lname)) {
    const vals = words.map((w) => w.value);
    const i = vals.findIndex((v) => /(^|\/)veridone(\.mjs)?$/.test(v));
    if (i >= 0) {
      const sub = vals[i + 1];
      const rest = vals.slice(i + 2).filter((v) => !v.startsWith('-'));
      if (sub === 'mode' && ['off', 'relaxed', 'reset'].includes(rest[0])) {
        add(out, ctx, 'guardrail-tamper', `\`veridone mode ${rest[0]}\` loosens the Veridone guardrails.`, 'Changing the mode is the user\'s decision: ask them to run /veridone:mode themselves.');
      } else if (sub === 'license' && rest[0] === 'deactivate') {
        add(out, ctx, 'guardrail-tamper', 'Removes the Veridone license from this machine.', 'Ask the user to do this themselves.');
      }
    }
  }
  if (/^\.\/|\.(sh|bash|zsh)$/.test(words[0]?.value || '') && !SHELLS.has(lname)) checkScriptFile(words[0], inv, ctx, out);

  if (/^(mkfs(\.\w+)?|mke2fs|mkdosfs|mkntfs|mkexfatfs|newfs(_\w+)?|zpool|zfs)$/.test(lname)) {
    if ((lname === 'zpool' || lname === 'zfs') && !/^(destroy|labelclear)$/.test(words[1]?.value || '')) return;
    return add(out, ctx, 'disk-destroy', `\`${name}\` creates a new filesystem (or destroys a pool), erasing everything on the target.`, 'Do not run disk-level tools from an agent session.');
  }
  switch (lname) {
    case 'rm': case 'rimraf': case 'del': case 'rmrf': case 'trash-put': case 'unlink': case 'shred': case 'srm':
      return checkRm(inv, ctx, out);
    case 'find':
      return checkFind(inv, ctx, out);
    case 'mv':
      return checkMv(inv, ctx, out);
    case 'git':
      return checkGit(inv, ctx, out);
    case 'dd':
      return checkDd(inv, ctx, out);
    case 'wipefs': case 'fdisk': case 'sfdisk': case 'gdisk': case 'sgdisk': case 'parted': case 'cfdisk': case 'diskpart': case 'mkswap': case 'blkdiscard': case 'cryptsetup':
      if (lname === 'cryptsetup' && !words.some((w) => /^(luksFormat|erase|luksErase)$/.test(w.value))) return;
      return add(out, ctx, 'disk-destroy', `\`${name}\` rewrites disk partitions or signatures and can make data unrecoverable.`, 'Do not run disk-level tools from an agent session.');
    case 'diskutil':
      if (/^(erase|zero|secureerase|partitiondisk|reformat|apfs\s*deletecontainer)/i.test(words[1]?.value || '')) {
        return add(out, ctx, 'disk-destroy', `\`diskutil ${words[1].value}\` erases a disk.`, 'Do not run disk-level tools from an agent session.');
      }
      return;
    case 'format':
      if (IS_WINDOWS || /^[a-z]:$/i.test(words[1]?.value || '')) return add(out, ctx, 'disk-destroy', '`format` erases a volume.', 'Do not run it.');
      return;
    case 'shutdown': case 'reboot': case 'halt': case 'poweroff':
      return add(out, ctx, 'system-power', `\`${name}\` would power off or restart the machine.`, 'Do not run it from an agent session.');
    case 'init': case 'telinit':
      if (['0', '6'].includes(words[1]?.value)) return add(out, ctx, 'system-power', `\`${name} ${words[1].value}\` halts or reboots the machine.`, 'Do not run it.');
      return;
    case 'systemctl':
      if (words.some((w) => /^(poweroff|reboot|halt|kexec|soft-reboot)$/.test(w.value))) return add(out, ctx, 'system-power', '`systemctl` power action.', 'Do not run it.');
      return;
    case 'chmod': case 'chown': case 'chgrp':
      return checkPerms(inv, ctx, out);
    case 'truncate':
      return checkTruncate(inv, ctx, out);
    case 'curl': case 'wget': case 'http': case 'xh':
      return checkUpload(inv, ctx, out);
    case 'scp': case 'rsync': case 'sftp':
      return checkCopyRemote(inv, ctx, out);
    case 'env': case 'printenv': case 'export': case 'declare': case 'set': case 'typeset': case 'compgen':
      return checkEnvDump(inv, ctx, out);
    case 'echo': case 'printf':
      return checkSecretEcho(inv, ctx, out);
    case 'kill': case 'killall': case 'pkill': case 'killall5': case 'taskkill': case 'stop-process':
      return checkKill(inv, ctx, out);
    case 'crontab':
      if (words.some((w) => w.value === '-r')) add(out, ctx, 'system-file-write', '`crontab -r` deletes every scheduled job for this user without confirmation.', 'Edit specific entries instead.');
      return;
    case 'claude':
      if (/^(plugin|plugins)$/.test(words[1]?.value || '') && /^(disable|uninstall|remove)$/.test(words[2]?.value || '') && /veridone/i.test(words.slice(3).map((w) => w.value).join(' '))) {
        add(out, ctx, 'guardrail-tamper', 'This disables the Veridone guardrails for the session.', 'Ask the user to change guardrails themselves if they want to.');
      }
      if (words[1]?.value === 'config' && /hooks|permissions/i.test(words.slice(2).map((w) => w.value).join(' '))) {
        add(out, ctx, 'guardrail-tamper', 'Changes Claude Code hook/permission configuration.', 'Ask the user to make this change.');
      }
      return;
    default:
      break;
  }
  if (PRINTERS.has(name) || PRINTERS.has(lname)) checkSecretRead(inv, ctx, out);
  checkPublishDeploy(inv, ctx, out);
  checkDb(inv, ctx, out);
  checkSnapshot(inv, ctx, out);
  checkContainers(inv, ctx, out);
  checkSedInPlace(inv, ctx, out);
  checkWriters(inv, ctx, out);
}

function quoteIfNeeded(v) {
  return /[\s'"$`\\|&;<>(){}*?]/.test(v) ? `'${v.replace(/'/g, `'\\''`)}'` : v;
}

// --- nested shells -----------------------------------------------------------

function checkShell(inv, ctx, out) {
  const { words } = inv;
  let i = 1;
  let script = null;
  let file = null;
  while (i < words.length) {
    const v = words[i].value;
    if (v === '--') { i++; break; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(v)) { script = words[i + 1]; break; }
    if (v === '-o' || v === '+o' || v === '--rcfile' || v === '--init-file') { i += 2; continue; }
    if (v.startsWith('-') || v.startsWith('+')) { i++; continue; }
    file = words[i];
    break;
  }
  if (script) {
    recurse(script.value, ctx, out, inv.cwd, `${inv.name} -c`);
    // sh -c "$(curl ...)" — downloaded code executed
    if (script.subs?.some((s) => /\b(curl|wget|iwr|irm|fetch)\b/.test(s.src))) {
      add(out, ctx, 'remote-script-exec', `Runs code downloaded at execution time (\`${oneLine(script.value, 80)}\`) without letting anyone review it first.`, 'Download the script to a file, inspect it, then run it.');
    }
    return;
  }
  if (file) {
    if (file.subs?.some((s) => s.kind === 'proc' && /\b(curl|wget|iwr|irm|fetch)\b/.test(s.src))) {
      add(out, ctx, 'remote-script-exec', 'Executes a script streamed from the network via process substitution.', 'Download the script to a file, inspect it, then run it.');
      return;
    }
    checkScriptFile(file, inv, ctx, out);
    return;
  }
  // heredoc / herestring fed to a shell
  for (const r of inv.cmd.redirects) {
    if (r.heredoc) recurse(r.heredoc, ctx, out, inv.cwd, 'heredoc');
    if (r.herestring) recurse(r.herestring, ctx, out, inv.cwd, 'herestring');
  }
}

function checkScriptFile(word, inv, ctx, out) {
  if (!ctx.config?.guard?.scanScripts || word.dynamic || inv.cwd === null) return;
  const abs = path.resolve(inv.cwd, word.value.replace(/^~(?=\/|$)/, ctx.home));
  const key = pathKey(abs);
  if (ctx.visitedScripts.has(key)) return;
  ctx.visitedScripts.add(key);
  const text = readTextSafe(abs, 256 * 1024);
  if (!text || text.includes('\u0000')) return;
  recurse(text, ctx, out, path.dirname(abs), `script ${toPosix(path.relative(ctx.projectRoot, abs))}`);
}

function checkSsh(inv, ctx, out) {
  const { words } = inv;
  const withArg = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-W', '-b', '-c', '-e', '-E', '-m', '-O', '-Q', '-S', '-w', '-B', '-I', '-P']);
  let i = 1;
  while (i < words.length) {
    const v = words[i].value;
    if (withArg.has(v)) { i += 2; continue; }
    if (v.startsWith('-')) { i++; continue; }
    break;
  }
  const rest = words.slice(i + 1);
  if (!rest.length) return;
  const remoteSrc = rest.map((w) => w.value).join(' ');
  const child = { ...ctx, depth: ctx.depth + 1, remote: true };
  analyzeSource(remoteSrc, child, out, null);
  // ssh host < .env style exfil handled by redirect/pipeline checks
}

/**
 * Shell commands embedded in inline code: os.system("..."), subprocess.run([...]), execSync('...'),
 * spawnSync('rm', ['-rf', '/']), system("..."), `...` (perl/ruby), shell_exec("...").
 */
export function shellCommandsInCode(code) {
  const outCmds = [];
  const src = String(code || '');
  const STR = String.raw`(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|\`((?:\\.|[^\`\\])*)\`)`;
  const strAt = (m, base) => m[base] ?? m[base + 1] ?? m[base + 2] ?? '';
  const listItems = (text) => [...text.matchAll(new RegExp(STR, 'g'))].map((x) => strAt(x, 1));
  const call = new RegExp(String.raw`\b(system|popen|getoutput|getstatusoutput|check_output|check_call|call|run|Popen|execSync|execFileSync|spawnSync|exec|execFile|spawn|shell_exec|passthru|proc_open|capture2e?|capture3|pipeline_r|IO\.popen|Command)\s*\(\s*(?:${STR}|\[([^\]]*)\])(\s*,\s*\[([^\]]*)\])?`, 'g');
  for (const m of src.matchAll(call)) {
    const first = m[5] !== undefined ? listItems(m[5]) : [strAt(m, 2)];
    const rest = m[7] !== undefined ? listItems(m[7]) : [];
    const parts = [...first, ...rest].filter((x) => x !== undefined);
    if (parts.length) outCmds.push(parts.length === 1 && rest.length === 0 && m[5] === undefined ? parts[0] : parts.map(quoteIfNeeded).join(' '));
  }
  // perl/ruby backticks and %x{}
  for (const m of src.matchAll(/`([^`]{2,400})`|%x\{([^}]{2,400})\}/g)) outCmds.push(m[1] ?? m[2]);
  return outCmds.slice(0, 20);
}

function checkInlineCode(inv, ctx, out) {
  const { words } = inv;
  const idx = words.findIndex((w, i) => i > 0 && /^(-c|-e|--eval|-r|--command|-Command|-EncodedCommand|eval|-p|--print)$/i.test(w.value));
  if (idx < 0 || !words[idx + 1]) return;
  const code = words[idx + 1].value;
  for (const cmd of shellCommandsInCode(code)) recurse(cmd, ctx, out, inv.cwd, `${inv.name} inline code`);
  if (/(rmtree|rm_rf|rmSync|rimraf|remove_dir_all|RemoveAll|Remove-Item)\s*\(?[^)]{0,80}(['"`](\/|~|C:\\)['"`]|expanduser\(\s*['"]~['"]\s*\)|Path\.home\(\)|homedir\(\)|os\.homedir\(\)|\$HOME|\$env:USERPROFILE)/i.test(code)) {
    add(out, ctx, 'rm-catastrophic', 'Inline code recursively deletes the root or home directory.', 'Do not run it.');
  }
  if (/(open|readFile|readFileSync|read_text|File\.read|Get-Content|fs\.read)[^;\n]{0,60}(\.env\b(?!\.example|\.sample|\.template)|id_rsa|id_ed25519|\.aws\/credentials|\.netrc|\.git-credentials|\.npmrc)/.test(code)) {
    add(out, ctx, 'secret-file-read', 'Inline code reads a secrets file and would bring credentials into the conversation.', 'Reference the variable names, not the values.');
  }
}

// --- rm / find / mv ------------------------------------------------------------

function checkRm(inv, ctx, out) {
  const { words, name } = inv;
  const lname = name.toLowerCase();
  const recursive = lname === 'rimraf' || lname === 'rmrf' || hasFlag(words, ['r', 'R'], ['--recursive', '--dir']);
  const noPreserve = words.some((w) => w.value === '--no-preserve-root');
  const targets = lname === 'shred' || lname === 'srm'
    ? nonOptionArgs(words, 1, new Set(['-n', '--iterations', '-s', '--size', '--random-source']))
    : nonOptionArgs(words, 1);
  if (lname === 'shred' && targets.some((t) => /^\/dev\//.test(t.value))) {
    add(out, ctx, 'disk-destroy', `\`shred ${targets.map((t) => t.value).join(' ')}\` overwrites a block device.`, 'Do not run disk-level tools from an agent session.');
    return;
  }
  if (inv.xargs && recursive) {
    add(out, ctx, 'rm-dynamic-path', 'Recursive delete of paths produced by another command (via xargs); the actual targets are unknown until it runs.', 'List the paths first, then delete explicit, reviewed paths.');
  }
  for (const t of targets) {
    const r = resolvePathWord(t, inv.cwd, ctx);
    if (ctx.remote) {
      if (recursive && (t.value === '/' || t.value === '/*' || t.value === '~' || /^\/(etc|usr|var|home|root|opt|srv|bin|lib)\/?$/.test(t.value) || noPreserve)) {
        add(out, ctx, 'rm-catastrophic', `Remote/container recursive delete of \`${t.value}\`.`, 'Do not run it.');
      } else if (recursive && t.value.startsWith('/')) {
        add(out, ctx, 'rm-outside-project', `Recursive delete on a remote host or container: \`${t.value}\`.`, 'Confirm the host and path first.');
      }
      continue;
    }
    const c = classifyDeleteTarget(r, ctx, recursive || lname === 'shred');
    if (c.cls !== 'catastrophic' && !r.dynamic && checkProtectedPath(r.abs, t.value, 'Deletes', ctx, out, { includeAsk: false })) continue;
    if (c.cls === 'catastrophic' && (recursive || c.why.startsWith('system') || noPreserve || lname === 'shred')) {
      add(out, ctx, 'rm-catastrophic', `\`${name} ${recursive ? '-r ' : ''}${t.value}\` ${c.why}.`, 'Delete only the specific files or build directories you need to, using paths inside the project.');
      continue;
    }
    if (c.cls === 'dynamic' && recursive) {
      add(out, ctx, 'rm-dynamic-path', c.why + '.', 'Validate the variable first (e.g. `${VAR:?}`) or use an explicit path.');
      continue;
    }
    if (c.cls === 'protected') {
      add(out, ctx, 'rm-uncommitted-work', `\`${t.value}\` deletes everything at the top level of the project.`, 'Delete specific paths instead.');
      continue;
    }
    if (c.cls === 'outside' && recursive) {
      add(out, ctx, 'rm-outside-project', `\`${t.value}\` is ${c.why}.`, 'Only delete files inside the project unless the user asked for this.');
      continue;
    }
    if (c.cls === 'inside' || c.cls === 'protected') {
      const rel = c.rel || '';
      if (isTestPath(rel) || isTestPath(t.value)) {
        add(out, ctx, 'rm-tests', `Deletes test code (\`${rel || t.value}\`). Removing tests reduces the verification the user relies on.`, 'Keep the tests; if they are obsolete, explain why and let the user confirm.');
        continue;
      }
      if (r.abs && isSensitivePath(r.abs, ctx, t.value) && !recursive) {
        add(out, ctx, 'env-file-clobber', `Deletes \`${rel}\`, a local secrets file that is usually not in git and cannot be recovered.`, 'Leave secrets files alone unless the user asked.');
        continue;
      }
      if (recursive || t.glob) {
        const lost = uncommittedUnder(ctx, r.abs, t.glob);
        if (lost && lost.count > 0) {
          add(out, ctx, 'rm-uncommitted-work', `\`${t.value}\` contains ${lost.summary} that git cannot restore.`, 'Commit or stash first, or delete narrower paths.');
        } else if (lost === null && !ctx.git.isRepo() && recursive && r.abs && dirExists(r.abs)) {
          add(out, ctx, 'rm-uncommitted-work', `Recursive delete of \`${t.value}\` in a project without git: nothing can be restored.`, 'Double-check the path.');
        }
      }
    }
  }
}

function uncommittedUnder(ctx, abs, glob) {
  if (!abs || !ctx.git.isRepo()) return null;
  const rel = toPosix(path.relative(ctx.cwd || ctx.projectRoot, abs)) || '.';
  const st = ctx.git.status([glob ? rel : rel]);
  if (!st) return null;
  let untracked = 0;
  let modified = 0;
  for (const e of st) {
    if (e.x === '?' && e.y === '?') untracked++;
    else if (e.x === '!' ) continue;
    else modified++;
  }
  const parts = [];
  if (modified) parts.push(`${modified} modified file${modified > 1 ? 's' : ''}`);
  if (untracked) parts.push(`${untracked} untracked file${untracked > 1 ? 's' : ''}`);
  return { count: modified + untracked, summary: parts.join(' and ') };
}

function checkFind(inv, ctx, out) {
  const { words } = inv;
  const roots = [];
  let i = 1;
  while (i < words.length && !/^[-(!]/.test(words[i].value)) { roots.push(words[i]); i++; }
  if (!roots.length) roots.push({ value: '.', quoted: false, dynamic: false, glob: false, subs: [] });
  const expr = words.slice(i).map((w) => w.value);
  const hasFilter = expr.some((v) => /^-(i?name|i?path|i?wholename|i?regex|type|mtime|mmin|atime|newer|size|user|empty|perm)$/.test(v));
  const deletes = expr.includes('-delete');
  // -exec / -execdir / -ok
  for (let k = 0; k < expr.length; k++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(expr[k])) {
      const end = expr.findIndex((v, j) => j > k && (v === ';' || v === '\\;' || v === '+'));
      const inner = expr.slice(k + 1, end < 0 ? undefined : end).map((v) => (v === '{}' ? roots[0].value : v));
      if (inner.length) {
        const child = { ...ctx, depth: ctx.depth + 1 };
        analyzeSource(inner.map(quoteIfNeeded).join(' '), child, out, inv.cwd);
      }
    }
  }
  if (!deletes) return;
  for (const root of roots) {
    const r = resolvePathWord(root, inv.cwd, ctx);
    const c = classifyDeleteTarget(r, ctx, true);
    const projectLevel = r.abs && (isInside(r.abs, ctx.projectRoot) || pathKey(r.abs) === pathKey(ctx.projectRoot));
    if (c.cls === 'catastrophic' && hasFilter && projectLevel && !/git repository/.test(c.why)) {
      continue; // e.g. `find . -name '*.pyc' -delete` at the project root: scoped by filters
    }
    if (c.cls === 'catastrophic') {
      add(out, ctx, hasFilter ? 'rm-outside-project' : 'rm-catastrophic', `\`find ${root.value} … -delete\` ${c.why}${hasFilter ? ' (filtered, but across a huge tree)' : ''}.`, 'Scope find to a directory inside the project.');
    } else if (c.cls === 'dynamic') {
      add(out, ctx, 'rm-dynamic-path', `find root \`${root.value}\` is unresolved; -delete could run anywhere.`, 'Use an explicit directory.');
    } else if (c.cls === 'outside') {
      add(out, ctx, 'rm-outside-project', `\`find ${root.value} … -delete\` deletes files ${c.why}.`, 'Only delete inside the project unless asked.');
    } else if ((c.cls === 'inside' || c.cls === 'protected') && !hasFilter) {
      const lost = uncommittedUnder(ctx, r.abs, false);
      if (lost && lost.count) add(out, ctx, 'rm-uncommitted-work', `\`find ${root.value} -delete\` (no filters) removes ${lost.summary}.`, 'Add -name/-type filters or delete narrower paths.');
    }
  }
}

function checkMv(inv, ctx, out) {
  const args = nonOptionArgs(inv.words, 1, new Set(['-t', '--target-directory', '-S', '--suffix']));
  if (args.length < 2) return;
  const dest = args[args.length - 1];
  const destAbs = resolvePathWord(dest, inv.cwd, ctx).abs;
  if (dest.value === '/dev/null') {
    for (const s of args.slice(0, -1)) {
      const r = resolvePathWord(s, inv.cwd, ctx);
      const c = classifyDeleteTarget(r, ctx, true);
      if (c.cls === 'catastrophic') add(out, ctx, 'rm-catastrophic', `Moving \`${s.value}\` to /dev/null destroys it (${c.why}).`, 'Do not run it.');
      else if (c.cls === 'inside' && isTestPath(c.rel || '')) add(out, ctx, 'rm-tests', `Moving tests to /dev/null deletes them (\`${s.value}\`).`, 'Keep the tests.');
    }
    return;
  }
  for (const s of args.slice(0, -1)) {
    const r = resolvePathWord(s, inv.cwd, ctx);
    if (r.dynamic || r.glob) continue;
    const c = classifyDeleteTarget(r, ctx, true);
    if (c.cls === 'catastrophic') add(out, ctx, 'rm-catastrophic', `Moving \`${s.value}\` away ${c.why.replace(/^targets/, 'relocates')} — everything that depends on that location breaks.`, 'Move specific files inside the project instead.');
  }
  const g = isGuardrailPath(destAbs, ctx);
  if (g) add(out, ctx, 'guardrail-tamper', `Overwrites \`${dest.value}\` (safety/hook configuration).`, 'Ask the user to change guardrail configuration.');
  const sys = systemWriteClass(destAbs, ctx);
  if (sys) add(out, ctx, sys.rule, `Writes into ${sys.why} (\`${dest.value}\`).`, 'Leave system and credential files alone.');
  if (!g && !sys) checkProtectedPath(destAbs, dest.value, 'Overwrites', ctx, out);
  for (const src of args.slice(0, -1)) {
    const r = resolvePathWord(src, inv.cwd, ctx);
    if (!r.dynamic) checkProtectedPath(r.abs, src.value, 'Moves', ctx, out, { includeAsk: false });
  }
  for (const s of args.slice(0, -1)) {
    const r = resolvePathWord(s, inv.cwd, ctx);
    const rel = relToProject(r.abs, ctx);
    if (rel && isTestPath(rel) && destAbs && !isInside(destAbs, ctx.projectRoot)) {
      add(out, ctx, 'rm-tests', `Moves tests out of the project (\`${s.value}\`).`, 'Keep the tests in place.');
    }
  }
}

// --- git -----------------------------------------------------------------------

function gitSplit(words) {
  let i = 1;
  let cwdOverride = null;
  while (i < words.length) {
    const v = words[i].value;
    if (v === '-C') { cwdOverride = words[i + 1]; i += 2; continue; }
    if (v === '-c' || v === '--git-dir' || v === '--work-tree' || v === '--namespace' || v === '--exec-path' || v === '--config-env') { i += 2; continue; }
    if (v.startsWith('-')) { i++; continue; }
    break;
  }
  return { sub: words[i]?.value || '', rest: words.slice(i + 1), cwdOverride };
}

function protectedBranch(branch, ctx) {
  if (!branch) return false;
  const list = ctx.config?.guard?.protectedBranches || [];
  return list.some((p) => {
    if (p.includes('*')) return new RegExp('^' + p.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(branch);
    return p === branch;
  });
}

function checkGit(inv, ctx, out) {
  const { sub, rest, cwdOverride } = gitSplit(inv.words);
  let gctx = ctx;
  let gcwd = inv.cwd;
  if (cwdOverride) {
    const r = resolvePathWord(cwdOverride, inv.cwd, ctx);
    gcwd = r.dynamic ? null : r.abs;
    if (gcwd) gctx = { ...ctx, cwd: gcwd, git: makeContext({ cwd: gcwd, projectRoot: G.gitTopLevel(gcwd) || gcwd, config: ctx.config }).git };
  }
  const vals = rest.map((w) => w.value);
  const flag = (...names) => vals.some((v) => names.some((n) => v === n || v.startsWith(n + '=') || (/^-[a-zA-Z]+$/.test(n) && n.length === 2 && /^-[a-zA-Z]+$/.test(v) && !v.startsWith('--') && v.includes(n[1]))));
  const hookBypassEnv = Object.keys(inv.env).find((k) => /^(HUSKY|HUSKY_SKIP_HOOKS|SKIP|PRE_COMMIT_ALLOW_NO_CONFIG|LEFTHOOK|SKIP_HOOKS|GIT_HOOKS_DISABLED)$/.test(k) && !(k === 'LEFTHOOK' && inv.env[k] !== '0'));

  switch (sub) {
    case 'push': {
      const force = vals.some((v) => v === '-f' || v === '--force' || v.startsWith('--force-with-lease') || v === '--force-if-includes' || (/^-[a-zA-Z]+$/.test(v) && v.includes('f')));
      const del = vals.some((v) => v === '-d' || v === '--delete' || v === '--prune');
      const mirror = vals.includes('--mirror');
      if (vals.includes('--no-verify') || hookBypassEnv) add(out, gctx, 'git-hooks-bypass', '`git push --no-verify` skips the repository\'s pre-push checks.', 'Run the push without --no-verify and fix what the hooks report.');
      const positional = nonOptionArgs([{ value: 'push' }, ...rest], 1, new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']));
      const refspecs = positional.slice(1).map((w) => w.value);
      const targets = [];
      let plusForce = false;
      for (const rs of refspecs) {
        if (rs.startsWith('+')) plusForce = true;
        const s = rs.replace(/^\+/, '');
        if (s.startsWith(':')) { targets.push({ branch: s.slice(1), deleting: true }); continue; }
        const dst = s.includes(':') ? s.split(':')[1] : s;
        targets.push({ branch: dst.replace(/^refs\/heads\//, ''), deleting: false });
      }
      if (!targets.length) {
        const b = gctx.git.branch();
        if (b) targets.push({ branch: b, deleting: false, implicit: true });
      }
      if (mirror) add(out, gctx, 'git-push-delete', '`git push --mirror` overwrites and can delete every ref on the remote.', 'Push specific branches instead.');
      for (const t of targets) {
        const branch = t.branch === 'HEAD' ? gctx.git.branch() : t.branch;
        if (t.deleting || del) {
          add(out, gctx, 'git-push-delete', `Deletes the remote branch/tag \`${branch}\`.`, 'Only delete remote refs when the user asked for it.');
        } else if ((force || plusForce) && protectedBranch(branch, gctx)) {
          add(out, gctx, 'git-force-push-protected', `Force-push to protected branch \`${branch}\` rewrites shared history for everyone.`, 'Push to a feature branch and open a pull request instead.');
        }
      }
      return;
    }
    case 'reset': {
      if (vals.includes('--hard') || vals.includes('--merge')) {
        const dirty = (gctx.git.status([]) || []).filter((e) => !(e.x === '?' && e.y === '?'));
        if (dirty.length) add(out, gctx, 'git-discard-changes', `\`git reset --hard\` permanently discards uncommitted changes in ${dirty.length} file${dirty.length > 1 ? 's' : ''} (${dirty.slice(0, 3).map((e) => e.path).join(', ')}${dirty.length > 3 ? ', …' : ''}).`, 'Commit or `git stash` first.');
      }
      return;
    }
    case 'checkout': case 'restore': case 'switch': {
      if (sub === 'restore' && vals.includes('--staged') && !vals.includes('--worktree') && !vals.includes('-W')) return;
      const forced = vals.includes('-f') || vals.includes('--force') || vals.includes('--discard-changes');
      const dd = vals.indexOf('--');
      let paths = [];
      if (dd >= 0) paths = vals.slice(dd + 1);
      else if (sub === 'restore') paths = nonOptionArgs([{ value: 'restore' }, ...rest], 1, new Set(['-s', '--source'])).map((w) => w.value);
      else if (sub === 'checkout') {
        const pos = nonOptionArgs([{ value: 'checkout' }, ...rest], 1, new Set(['-b', '-B', '--orphan', '--conflict'])).map((w) => w.value);
        if (vals.includes('-b') || vals.includes('-B') || vals.includes('--orphan')) paths = [];
        else paths = pos.filter((p) => p === '.' || (gcwd && fileExists(path.resolve(gcwd, p))) || (gcwd && dirExists(path.resolve(gcwd, p)) && p !== '..'));
      }
      if (paths.length || forced) {
        const st = gctx.git.status(paths.length ? paths : []) || [];
        const dirty = st.filter((e) => !(e.x === '?' && e.y === '?'));
        if (dirty.length) add(out, gctx, 'git-discard-changes', `\`git ${sub} ${paths.length ? paths.join(' ') : '--force'}\` overwrites uncommitted changes in ${dirty.length} file${dirty.length > 1 ? 's' : ''} (${dirty.slice(0, 3).map((e) => e.path).join(', ')}${dirty.length > 3 ? ', …' : ''}).`, 'Commit or `git stash` first if those edits matter.');
      }
      return;
    }
    case 'clean': {
      const dry = vals.some((v) => v === '-n' || v === '--dry-run' || (/^-[a-zA-Z]+$/.test(v) && v.includes('n')));
      const forceClean = vals.some((v) => v === '--force' || (/^-[a-zA-Z]+$/.test(v) && v.includes('f')));
      if (!forceClean || dry) return;
      const ignoredToo = vals.some((v) => (/^-[a-zA-Z]+$/.test(v) && (v.includes('x') || v.includes('X'))));
      if (ignoredToo) {
        add(out, gctx, 'git-discard-changes', '`git clean -x` also deletes ignored files such as .env, local configs and caches — they cannot be restored.', 'Run `git clean -n` first and delete specific paths.');
        return;
      }
      const untracked = (gctx.git.status([]) || []).filter((e) => e.x === '?');
      if (untracked.length) add(out, gctx, 'git-discard-changes', `\`git clean\` permanently deletes ${untracked.length} untracked file${untracked.length > 1 ? 's' : ''} (${untracked.slice(0, 3).map((e) => e.path).join(', ')}${untracked.length > 3 ? ', …' : ''}).`, 'Run `git clean -n` to review first.');
      return;
    }
    case 'stash': {
      if (/^(drop|clear)$/.test(vals[0] || '')) add(out, gctx, 'git-discard-changes', `\`git stash ${vals[0]}\` permanently removes stashed work.`, 'Leave stashes alone unless the user asked.');
      return;
    }
    case 'branch': {
      if (vals.some((v) => v === '-D' || (/^-[a-zA-Z]+$/.test(v) && v.includes('D'))) || (vals.includes('--delete') && vals.includes('--force'))) {
        add(out, gctx, 'git-branch-force-delete', '`git branch -D` deletes a branch even if its commits are not merged anywhere.', 'Use `git branch -d` (safe delete) or confirm with the user.');
      }
      return;
    }
    case 'filter-branch': case 'filter-repo': case 'replace':
      add(out, gctx, 'git-history-rewrite', `\`git ${sub}\` rewrites repository history.`, 'Only do this when the user explicitly asked.');
      return;
    case 'reflog':
      if (/^(expire|delete)$/.test(vals[0] || '')) add(out, gctx, 'git-history-rewrite', '`git reflog expire/delete` removes the safety net used to recover lost commits.', 'Leave the reflog alone.');
      return;
    case 'gc':
      if (vals.some((v) => /^--prune=(now|all)$/.test(v))) add(out, gctx, 'git-history-rewrite', '`git gc --prune=now` permanently removes unreachable commits.', 'Use plain `git gc`.');
      return;
    case 'update-ref':
      if (vals.includes('-d')) add(out, gctx, 'git-history-rewrite', '`git update-ref -d` deletes a ref directly.', 'Use normal branch commands.');
      return;
    case 'commit': case 'merge': case 'cherry-pick': case 'revert': case 'am': case 'rebase': {
      if (vals.includes('--no-verify') || (sub === 'commit' && vals.some((v) => v === '-n' || (/^-[a-zA-Z]+$/.test(v) && !v.startsWith('--') && v.includes('n') && !v.includes('m'))))) {
        add(out, gctx, 'git-hooks-bypass', `\`git ${sub} --no-verify\` skips the repository's pre-commit checks (lint, tests, secret scanning).`, 'Commit normally and fix whatever the hooks report.');
      } else if (hookBypassEnv) {
        add(out, gctx, 'git-hooks-bypass', `\`${hookBypassEnv}=…\` disables the repository's git hooks for this ${sub}.`, 'Commit normally and fix whatever the hooks report.');
      }
      return;
    }
    case 'config': {
      if (vals.some((v) => /^core\.hookspath$/i.test(v))) add(out, gctx, 'git-hooks-bypass', 'Changes `core.hooksPath`, which can disable the repository\'s hooks.', 'Leave hook configuration to the user.');
      return;
    }
    case 'rm': {
      for (const w of nonOptionArgs([{ value: 'rm' }, ...rest], 1)) {
        if (isTestPath(w.value)) { add(out, gctx, 'rm-tests', `\`git rm ${w.value}\` deletes test code.`, 'Keep the tests; if obsolete, explain and let the user confirm.'); break; }
      }
      return;
    }
    default:
      return;
  }
}

// --- disks / permissions ----------------------------------------------------

function checkDd(inv, ctx, out) {
  const of = inv.words.find((w) => w.value.startsWith('of='));
  if (of && /^of=\/dev\/(sd|hd|vd|xvd|nvme|disk|mmcblk|rdisk|mapper|md)/.test(of.value)) {
    add(out, ctx, 'disk-destroy', `\`dd ${of.value}\` overwrites a raw disk device.`, 'Do not run disk-level tools from an agent session.');
  } else if (of) {
    const abs = resolvePathWord({ ...of, value: of.value.slice(3) }, inv.cwd, ctx).abs;
    const sys = systemWriteClass(abs, ctx);
    if (sys) add(out, ctx, sys.rule, `\`dd\` writes into ${sys.why}.`, 'Leave system files alone.');
  }
}

function checkPerms(inv, ctx, out) {
  const { words, name } = inv;
  const recursive = hasFlag(words, ['R'], ['--recursive']);
  const args = nonOptionArgs(words, 1, new Set(['--reference']));
  if (!args.length) return;
  const mode = name === 'chmod' ? args[0].value : null;
  const targets = args.slice(1);
  const worldWritable = mode && (/^0?[0-7]?[0-7][0-7][2367]$/.test(mode) || /(^|,)(a|o)\+[rwxXst]*w/.test(mode) || mode === '777' || /^\+?w$/.test(mode) === false && /a=rwx/.test(mode));
  const setuid = mode && (/^[4-7][0-7]{3}$/.test(mode) || /[ug]\+[rwx]*s/.test(mode));
  for (const t of targets) {
    const r = resolvePathWord(t, inv.cwd, ctx);
    const c = classifyDeleteTarget(r, ctx, true);
    if (recursive && (c.cls === 'catastrophic' || c.cls === 'dynamic')) {
      add(out, ctx, 'dangerous-permissions', `Recursive \`${name}\` on \`${t.value}\` (${c.why || 'unresolved path'}) can break the OS or expose private files.`, 'Change permissions only on specific project files.');
      if (c.cls === 'catastrophic') out[out.length - 1].level = 'deny';
    } else if (!recursive && c.cls === 'catastrophic' && !/project/.test(c.why)) {
      add(out, ctx, 'dangerous-permissions', `\`${name}\` on \`${t.value}\` (${c.why}) can lock you out of the system or your files.`, 'Change permissions only on specific project files.');
    } else if (worldWritable && recursive) {
      add(out, ctx, 'dangerous-permissions', `\`chmod ${mode}\` recursively makes \`${t.value}\` world-writable.`, 'Use the narrowest permission that works (e.g. 755 for dirs, 644 for files).');
    } else if (setuid) {
      add(out, ctx, 'dangerous-permissions', `\`chmod ${mode}\` sets the setuid/setgid bit on \`${t.value}\`.`, 'Setuid binaries are a privilege-escalation risk; avoid unless required.');
    } else if (r.abs && (pathKey(r.abs).startsWith(pathKey(path.join(ctx.home, '.ssh'))))) {
      if (worldWritable || (mode && /^0?[0-7][0-7][1-7]{2}$/.test(mode) && !/^0?[0-7]00$/.test(mode))) add(out, ctx, 'dangerous-permissions', `Loosens permissions on SSH material (\`${t.value}\`).`, 'SSH keys must stay 600.');
    }
  }
}

// --- network / secrets ------------------------------------------------------

function checkUpload(inv, ctx, out) {
  const { words } = inv;
  for (let i = 1; i < words.length; i++) {
    const v = words[i].value;
    let fileRef = null;
    if (/^(-d|--data|--data-binary|--data-raw|--data-urlencode|--json|-F|--form|--form-string)$/.test(v)) {
      const next = words[i + 1]?.value || '';
      const m = /@([^;,\s]+)/.exec(next);
      if (m) fileRef = m[1];
    } else if (/^(-T|--upload-file)$/.test(v)) {
      fileRef = words[i + 1]?.value;
    } else if (/^--post-file=|^--body-file=/.test(v)) {
      fileRef = v.split('=')[1];
    } else if (/^(--data(-binary|-urlencode)?|--form)=@/.test(v)) {
      fileRef = v.split('@')[1];
    }
    if (fileRef && fileRef !== '-') {
      const r = resolvePathWord({ value: fileRef, tilde: fileRef.startsWith('~'), dynamic: false, glob: false, subs: [] }, inv.cwd, ctx);
      if (isSensitivePath(r.abs, ctx, fileRef)) {
        add(out, ctx, 'secret-exfiltration', `Uploads \`${fileRef}\` (a secrets file) to a remote server.`, 'Never send credential files over the network.');
      }
    }
  }
}

function checkCopyRemote(inv, ctx, out) {
  const args = nonOptionArgs(inv.words, 1, new Set(['-P', '-i', '-o', '-e', '-F', '-c', '-l', '-S', '--port', '--rsh', '--exclude', '--include', '--filter', '-f']));
  if (args.length < 2) return;
  const dest = args[args.length - 1].value;
  // rsync --delete makes the destination an exact mirror of the source: everything else there is deleted
  if (inv.name === 'rsync' && inv.words.some((w) => /^--(delete|del|delete-before|delete-during|delete-after|delete-delay|delete-excluded|remove-source-files)$/.test(w.value))) {
    const r = resolvePathWord(args[args.length - 1], inv.cwd, ctx);
    const c = classifyDeleteTarget(r, ctx, true);
    if (c.cls === 'catastrophic') add(out, ctx, 'rm-catastrophic', `\`rsync --delete\` into \`${dest}\` deletes whatever is there but not in the source (${c.why}).`, 'Sync into a dedicated, empty directory.');
    else if (c.cls === 'dynamic') add(out, ctx, 'rm-dynamic-path', `\`rsync --delete\` into \`${dest}\`: ${c.why}.`, 'Use an explicit destination path.');
  }
  const remoteDest = /^[^/\s]+@?[^/\s]*:/.test(dest) || /^[a-z]+:\/\//i.test(dest);
  if (!remoteDest) return;
  for (const s of args.slice(0, -1)) {
    const r = resolvePathWord(s, inv.cwd, ctx);
    if (isSensitivePath(r.abs, ctx, s.value) || (r.abs && pathKey(r.abs) === pathKey(path.join(ctx.home, '.ssh')))) {
      add(out, ctx, 'secret-exfiltration', `Copies \`${s.value}\` (credentials) to a remote host.`, 'Never send credential files over the network.');
    }
  }
}

/** A pattern that can only match an environment variable NAME followed by '=' (never the value). */
function nameOnlyPattern(p) {
  if (typeof p !== 'string') return false;
  const body = p.replace(/^\^/, '').replace(/\$$/, '');
  if (!body.endsWith('=')) return false;
  const head = body.slice(0, -1);
  return head.length > 0 && /^(?:[A-Za-z0-9_]|\\w|\[(?:[A-Za-z0-9_]|[A-Za-z0-9]-[A-Za-z0-9])+\]|[*+?])+$/.test(head);
}

/**
 * Reads of a secrets file that reveal only variable names, counts or existence:
 * grep -o with a name-only pattern, grep -c/-q/-l, cut -d= -f1, awk -F= '{print $1}', and sed that strips '=value'.
 */
function revealsNamesOnly(name, words) {
  const v = words.slice(1).map((w) => w.value);
  const flags = v.filter((x) => x.startsWith('-'));
  if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') {
    if (flags.some((f) => /^-[A-Za-z]*[qlLc][A-Za-z]*$/.test(f) || /^--(quiet|silent|files-with-matches|files-without-match|count)$/.test(f))) return true;
    const onlyMatching = flags.some((f) => /^-[A-Za-z]*o[A-Za-z]*$/.test(f) || f === '--only-matching');
    if (!onlyMatching) return false;
    const ei = v.findIndex((x) => x === '-e' || x === '--regexp');
    const pattern = ei >= 0 ? v[ei + 1] : (v.find((x) => x.startsWith('--regexp=')) || '').slice(9) || v.find((x) => !x.startsWith('-'));
    return nameOnlyPattern(pattern);
  }
  if (name === 'cut') {
    const joined = v.join(' ');
    const delimEq = /(^|\s)(-d\s*=|--delimiter=?\s*=)(\s|$)/.test(joined) || /(^|\s)-d=(\s|$)/.test(joined);
    const field1 = /(^|\s)(-f\s*1|--fields=?\s*1)(\s|$)/.test(joined);
    return delimEq && field1;
  }
  if (name === 'awk' || name === 'gawk' || name === 'mawk') {
    const fsEq = v.some((x, i) => x === '-F=' || (x === '-F' && v[i + 1] === '=') || x === "-F'='" || x === '-F"="');
    const prog = v.find((x) => x.includes('print'));
    return fsEq && !!prog && /^\s*\{\s*print\s+\$1\s*;?\s*\}\s*$/.test(prog);
  }
  if (name === 'sed') {
    const script = v.find((x) => x.startsWith('s'));
    return !!script && /^s(.)=\.\*\$?\1\1g?$/.test(script);
  }
  return false;
}

function checkSecretRead(inv, ctx, out) {
  const { words, name, cmd } = inv;
  if (name === 'sed' && words.some((w) => /^-i|^--in-place/.test(w.value))) return; // in-place edit, not a print
  if (name === 'tee') return;
  if (revealsNamesOnly(name, words)) return;
  // stdout redirected to a file → not exposed to the model
  const stdoutToFile = cmd.redirects.some((r) => (r.op === '>' || r.op === '>>' || r.op === '&>' || r.op === '>|') && (r.fd === null || r.fd === 1) && r.target && !/^\/dev\/(stdout|stderr|tty)$/.test(r.target.value));
  const args = nonOptionArgs(words, 1, new Set(['-e', '-f', '-n', '-m', '-A', '-B', '-C', '--max-count', '--regexp', '-o', '--output', '-d', '-t', '-k', '-s']));
  for (const a of args) {
    const r = resolvePathWord(a, inv.cwd, ctx);
    const hit = isSensitivePath(r.abs, ctx, a.value);
    if (hit) {
      if (stdoutToFile) continue;
      add(out, ctx, 'secret-file-read', `\`${name} ${a.value}\` prints the contents of a secrets file (${hit}) into the conversation, sending credentials to the model provider and the transcript.`, 'Refer to variable names instead (e.g. `grep -o "^[A-Z_]*=" .env`), or ask the user for the specific non-secret value you need.');
      break;
    }
  }
}

function checkEnvDump(inv, ctx, out) {
  const { name, words, cmd } = inv;
  const args = words.slice(1).map((w) => w.value);
  const dumps = (name === 'env' || name === 'printenv') ? args.filter((a) => !a.startsWith('-')).length === 0
    : (name === 'export' || name === 'declare' || name === 'typeset') ? args.length === 1 && /^-[px]+$/.test(args[0]) || (name === 'declare' && args.length === 0)
      : name === 'set' ? args.length === 0
        : name === 'compgen' ? args.includes('-v') || args.includes('-e') : false;
  if (name === 'printenv' && args.length === 1 && /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|ACCESS_KEY)/i.test(args[0])) {
    add(out, ctx, 'secret-env-dump', `\`printenv ${args[0]}\` prints a secret value into the conversation.`, 'Check that the variable is set (`[ -n "$VAR" ] && echo set`) instead of printing it.');
    return;
  }
  if (!dumps) return;
  const redirected = cmd.redirects.some((r) => (r.op === '>' || r.op === '>>') && r.target && r.target.value !== '/dev/stdout');
  if (redirected) return;
  add(out, ctx, 'secret-env-dump', `\`${[name, ...args].join(' ')}\` prints every environment variable, which usually includes API keys and tokens.`, 'Print only the variables you need, e.g. `printenv NODE_ENV PATH`.');
}

function checkSecretEcho(inv, ctx, out) {
  for (const w of inv.words.slice(1)) {
    const m = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/.exec(w.value);
    if (m && /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_SECRET|CREDENTIALS?|AUTH|DSN|DATABASE_URL|CONNECTION_STRING)$/i.test(m[1]) && !/:[?+]|#/.test(w.value)) {
      add(out, ctx, 'secret-env-dump', `\`${inv.name} ${w.value}\` prints a secret value into the conversation.`, 'Check presence instead: `[ -n "$' + m[1] + '" ] && echo "' + m[1] + ' is set"`.');
      return;
    }
  }
}

function checkKill(inv, ctx, out) {
  const { name, words } = inv;
  const vals = words.slice(1).map((w) => w.value);
  if (name === 'killall5' || vals.includes('-1') && name === 'kill' && vals.filter((v) => !v.startsWith('-')).length === 0 || (name === 'kill' && vals.some((v, i) => v === '-1' && i > 0 && vals[i - 1].startsWith('-')))) {
    add(out, ctx, 'kill-broad', '`kill -1` signals every process you own, including your editor, terminal and Claude Code itself.', 'Kill a specific PID instead.');
    return;
  }
  if (name === 'kill' && vals.some((v) => /^-(9|KILL|SIGKILL)$/.test(v)) && vals.includes('-1')) {
    add(out, ctx, 'kill-broad', '`kill -9 -1` kills every process you own.', 'Kill a specific PID instead.');
    return;
  }
  if (name === 'killall' || name === 'pkill' || name === 'taskkill') {
    const targets = vals.filter((v) => !v.startsWith('-') && !/^\d+$/.test(v));
    if (targets.some((t) => /^(node|nodejs|python3?|java|ruby|bash|zsh|sh|Terminal|iTerm2?|Code|code|claude|\.\*?|\.|-u)$/i.test(t)) || vals.includes('-u')) {
      add(out, ctx, 'kill-broad', `\`${name} ${targets.join(' ')}\` kills every matching process on the machine, including ones unrelated to this task (other projects, editors, Claude Code tooling).`, 'Stop the specific process (by PID or a precise `pkill -f <script-path>`).');
    }
  }
}

// --- releases / infrastructure / databases ------------------------------------

function checkPublishDeploy(inv, ctx, out) {
  const { name, words } = inv;
  const v = words.slice(1).map((w) => w.value);
  const has = (...xs) => xs.every((x) => v.includes(x));
  const first = v.find((a) => !a.startsWith('-')) || '';
  const lname = name.toLowerCase();
  const pub = (what) => add(out, ctx, 'publish-release', `${what} publishes to an external registry — irreversible and visible to others.`, 'Only publish when the user explicitly asked for a release.');
  const change = (what) => add(out, ctx, 'infra-change', `${what} changes live infrastructure or a deployed environment.`, 'Confirm the target environment with the user first.');
  const destroy = (what) => add(out, ctx, 'infra-destroy', `${what} destroys infrastructure/resources.`, 'Only run with explicit user approval.');

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(lname)) {
    if (first === 'publish' || (lname === 'yarn' && v[0] === 'npm' && v[1] === 'publish')) return pub(`\`${name} publish\``);
    if (first === 'unpublish' || first === 'deprecate') return pub(`\`${name} ${first}\``);
    return;
  }
  if (lname === 'cargo' && /^(publish|yank|owner)$/.test(first)) return pub(`\`cargo ${first}\``);
  if (lname === 'twine' && first === 'upload') return pub('`twine upload`');
  if (['poetry', 'flit', 'hatch', 'uv', 'pdm'].includes(lname) && first === 'publish') return pub(`\`${name} publish\``);
  if (lname === 'gem' && /^(push|yank)$/.test(first)) return pub(`\`gem ${first}\``);
  if (lname === 'mvn' && v.some((a) => /^(deploy|release:perform|release:prepare)$/.test(a))) return pub('`mvn deploy`');
  if ((lname === 'gradle' || lname === 'gradlew') && v.some((a) => /^publish|^:?.*:publish/.test(a))) return pub('`gradle publish`');
  if (lname === 'dotnet' && first === 'nuget' && v.includes('push')) return pub('`dotnet nuget push`');
  if (lname === 'gh') {
    if (first === 'release' && /^(create|delete|upload|edit)$/.test(v[1] || '')) return pub(`\`gh release ${v[1]}\``);
    if (first === 'repo' && /^(delete|archive|rename)$/.test(v[1] || '')) return destroy(`\`gh repo ${v[1]}\``);
    if (first === 'secret' && /^(set|delete)$/.test(v[1] || '')) return change(`\`gh secret ${v[1]}\``);
    return;
  }
  if ((lname === 'docker' || lname === 'podman') && first === 'push') return pub(`\`${name} push\``);
  if (lname === 'helm') {
    if (first === 'push') return pub('`helm push`');
    if (/^(uninstall|delete)$/.test(first)) return destroy(`\`helm ${first}\``);
    if (/^(install|upgrade|rollback)$/.test(first)) return change(`\`helm ${first}\``);
    return;
  }
  if (lname === 'kubectl' || lname === 'oc') {
    if (first === 'delete') {
      if (v.includes('--all') || v.includes('-A') || v.includes('--all-namespaces') || /^(namespace|ns|pv|pvc|persistentvolume|persistentvolumeclaim)s?$/.test(v[1] || '')) return destroy(`\`${name} delete ${v.slice(1, 3).join(' ')}\``);
      return change(`\`${name} delete\``);
    }
    if (/^(apply|create|replace|patch|scale|rollout|drain|cordon|uncordon|taint|set|edit|annotate|label|autoscale)$/.test(first)) return change(`\`${name} ${first}\``);
    return;
  }
  if (lname === 'terraform' || lname === 'tofu' || lname === 'terragrunt') {
    if (first === 'destroy' || (first === 'apply' && v.includes('-destroy'))) return destroy(`\`${name} destroy\``);
    if (first === 'apply' || first === 'import' || first === 'taint' || first === 'untaint' || (first === 'state' && /^(rm|mv|push|replace-provider)$/.test(v[1] || '')) || (first === 'workspace' && v[1] === 'delete') || first === 'run-all') {
      return change(`\`${name} ${first}${first === 'state' || first === 'workspace' ? ' ' + v[1] : ''}\``);
    }
    return;
  }
  if (lname === 'pulumi') {
    if (first === 'destroy' || (first === 'stack' && v[1] === 'rm')) return destroy(`\`pulumi ${first}\``);
    if (/^(up|update|refresh|import|cancel)$/.test(first)) return change(`\`pulumi ${first}\``);
    return;
  }
  if (lname === 'cdk' || lname === 'cdktf') {
    if (first === 'destroy') return destroy(`\`${name} destroy\``);
    if (first === 'deploy') return change(`\`${name} deploy\``);
    return;
  }
  if (lname === 'aws') {
    const op = v[1] || '';
    if (first === 's3' && (op === 'rb' || (op === 'rm' && v.includes('--recursive')))) return destroy(`\`aws s3 ${op}\``);
    if (first === 's3' && op === 'sync' && v.includes('--delete')) return change('`aws s3 sync --delete`');
    if (/^(delete|terminate|remove|purge|deregister|drop|disable|revoke|detach|release|cancel)-/.test(op) || /^(delete|terminate|purge)$/.test(op)) return destroy(`\`aws ${first} ${op}\``);
    if (first === 'cloudformation' && /^(deploy|update-stack|create-stack|execute-change-set)$/.test(op)) return change(`\`aws cloudformation ${op}\``);
    if (first === 'lambda' && /^update-function/.test(op)) return change(`\`aws lambda ${op}\``);
    if (first === 'ecs' && op === 'update-service') return change('`aws ecs update-service`');
    return;
  }
  if (lname === 'gcloud' || lname === 'az' || lname === 'doctl' || lname === 'linode-cli' || lname === 'hcloud') {
    if (v.some((a) => /^(delete|destroy|remove|purge)$/.test(a))) return destroy(`\`${name} … ${v.find((a) => /^(delete|destroy|remove|purge)$/.test(a))}\``);
    if (v.some((a) => /^(deploy|update|set-iam-policy|add-iam-policy-binding|create)$/.test(a)) && v.some((a) => /^(run|functions|app|compute|sql|container|webapp|functionapp|aks|deployments|apps)$/.test(a))) return change(`\`${name} ${v.slice(0, 3).join(' ')}\``);
    return;
  }
  if (lname === 'vercel' || lname === 'vc') {
    if (v.includes('--prod') || v.includes('--production') || first === 'promote') return change('`vercel --prod`');
    if (/^(remove|rm)$/.test(first)) return destroy('`vercel remove`');
    return;
  }
  if (lname === 'netlify' && first === 'deploy' && v.includes('--prod')) return change('`netlify deploy --prod`');
  if ((lname === 'fly' || lname === 'flyctl') && /^(deploy|destroy|scale)$/.test(first)) return first === 'destroy' ? destroy('`fly destroy`') : change(`\`fly ${first}\``);
  if ((lname === 'fly' || lname === 'flyctl') && first === 'apps' && v[1] === 'destroy') return destroy('`fly apps destroy`');
  if (lname === 'heroku') {
    if (/^(apps:destroy|pg:reset|destroy|addons:destroy)$/.test(first)) return destroy(`\`heroku ${first}\``);
    if (/^(releases:rollback|ps:scale|config:set|config:unset|maintenance:on)$/.test(first)) return change(`\`heroku ${first}\``);
    return;
  }
  if (lname === 'firebase' && first === 'deploy') return change('`firebase deploy`');
  if ((lname === 'firebase') && /^(projects:delete|database:remove|firestore:delete|hosting:disable|functions:delete)$/.test(first)) return destroy(`\`firebase ${first}\``);
  if ((lname === 'serverless' || lname === 'sls') && /^(deploy|remove)$/.test(first)) return first === 'remove' ? destroy('`serverless remove`') : change('`serverless deploy`');
  if (lname === 'wrangler' && /^(deploy|publish|delete|secret|rollback)$/.test(first)) return first === 'delete' ? destroy('`wrangler delete`') : change(`\`wrangler ${first}\``);
  if (lname === 'railway' && /^(up|down|redeploy)$/.test(first)) return change(`\`railway ${first}\``);
  if (lname === 'eb' && /^(deploy|terminate|swap)$/.test(first)) return first === 'terminate' ? destroy('`eb terminate`') : change(`\`eb ${first}\``);
  if (lname === 'ansible-playbook' && !v.includes('--check') && !v.includes('-C')) return change('`ansible-playbook`');
}

const SQL_DESTRUCTIVE = [
  [/\bdrop\s+(database|schema|table|view|materialized\s+view|index|collection|keyspace|user|role)\b/i, (m) => `DROP ${m[1].toUpperCase()}`],
  [/\btruncate\s+(table\s+)?[\w."`[\]]+/i, () => 'TRUNCATE'],
  [/\bdelete\s+from\s+[\w."`[\]]+\s*(;|$|\)|'|")/im, () => 'DELETE without WHERE'],
  [/\bupdate\s+[\w."`[\]]+\s+set\b(?![\s\S]*\bwhere\b)/i, () => 'UPDATE without WHERE'],
  [/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)?/i, () => 'ALTER TABLE … DROP'],
  [/\b(flushall|flushdb)\b/i, (m) => m[1].toUpperCase()],
  [/\bdropDatabase\s*\(|\.drop\s*\(\s*\)|\.(deleteMany|remove)\s*\(\s*\{\s*\}\s*\)/, () => 'MongoDB drop/delete-all'],
];

function sqlVerdict(text) {
  if (!text) return null;
  for (const [re, label] of SQL_DESTRUCTIVE) {
    const m = re.exec(text);
    if (m) return label(m);
  }
  return null;
}

function checkDb(inv, ctx, out) {
  const { name, words, cmd } = inv;
  const lname = name.toLowerCase();
  const v = words.slice(1).map((w) => w.value);
  const clients = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'sqlcmd', 'mongosh', 'mongo', 'redis-cli', 'cqlsh', 'clickhouse-client', 'clickhouse', 'duckdb', 'cockroach', 'snowsql', 'bq', 'mycli', 'pgcli', 'usql', 'turso', 'wrangler', 'd1']);
  if (lname === 'dropdb' || lname === 'dropuser') return add(out, ctx, 'db-destructive', `\`${name}\` deletes a database/role.`, 'Only with explicit user approval, and never against production.');
  if (clients.has(lname)) {
    const texts = [v.join(' ')];
    for (const r of cmd.redirects) {
      if (r.heredoc) texts.push(r.heredoc);
      if (r.herestring) texts.push(r.herestring);
      if (r.op === '<' && r.target && !r.target.dynamic && inv.cwd) {
        const t = readTextSafe(path.resolve(inv.cwd, r.target.value), 512 * 1024);
        if (t) texts.push(t);
      }
    }
    const fIdx = v.findIndex((a) => a === '-f' || a === '--file');
    if (fIdx >= 0 && v[fIdx + 1] && inv.cwd) {
      const t = readTextSafe(path.resolve(inv.cwd, v[fIdx + 1]), 512 * 1024);
      if (t) texts.push(t);
    }
    for (const t of texts) {
      const verdict = sqlVerdict(t);
      if (verdict) return add(out, ctx, 'db-destructive', `\`${name}\` runs ${verdict}, which permanently removes data.`, 'Confirm the target database (never production) and take a backup first.');
    }
    return;
  }
  const joined = v.join(' ');
  const fw = [
    [lname === 'prisma' && /\bmigrate\s+reset\b|\bdb\s+push\b.*--(force-reset|accept-data-loss)/.test(joined), 'Prisma reset/force push'],
    [(lname === 'rails' || lname === 'rake') && /\bdb:(drop|reset|purge|schema:load|truncate_all|seed:replant)\b/.test(joined), `\`${name} ${joined}\``],
    [(lname === 'python' || lname === 'python3') && /manage\.py\s+(flush|reset_db|sqlflush)\b/.test(joined), 'Django flush/reset'],
    [lname === 'php' && /artisan\s+(migrate:(fresh|reset|refresh)|db:wipe)\b/.test(joined), 'Laravel migrate:fresh/db:wipe'],
    [(lname === 'sequelize' || lname === 'sequelize-cli') && /\bdb:drop\b|db:migrate:undo:all/.test(joined), 'sequelize drop'],
    [lname === 'knex' && /migrate:rollback.*--all/.test(joined), 'knex rollback --all'],
    [lname === 'alembic' && /\bdowngrade\s+base\b/.test(joined), 'alembic downgrade base'],
    [lname === 'typeorm' && /\bschema:drop\b/.test(joined), 'typeorm schema:drop'],
    [lname === 'mix' && /\becto\.(drop|reset)\b/.test(joined), 'ecto drop/reset'],
    [lname === 'dotnet' && /\bef\s+database\s+drop\b/.test(joined), 'EF database drop'],
    [lname === 'supabase' && /\bdb\s+reset\b/.test(joined) && v.includes('--linked'), 'supabase db reset --linked'],
    [lname === 'drizzle-kit' && /\bdrop\b/.test(joined), 'drizzle-kit drop'],
  ];
  for (const [hit, label] of fw) {
    if (hit) return add(out, ctx, 'db-destructive', `${label} wipes database data.`, 'Confirm this targets a disposable local database.');
  }
}

function checkContainers(inv, ctx, out) {
  const { name, words } = inv;
  const lname = name.toLowerCase();
  const v = words.slice(1).map((w) => w.value);
  const isDocker = lname === 'docker' || lname === 'podman';
  const isCompose = lname === 'docker-compose' || lname === 'podman-compose' || (isDocker && v[0] === 'compose');
  if (isCompose && v.includes('down') && (v.includes('-v') || v.includes('--volumes'))) {
    return add(out, ctx, 'container-data-loss', '`compose down -v` deletes the named volumes — databases and uploaded files stored in them are gone.', 'Use `compose down` (without -v) unless the user wants a clean slate.');
  }
  if (isDocker && v[0] === 'system' && v[1] === 'prune' && (v.includes('--volumes') || v.includes('-a') || v.includes('--all'))) {
    return add(out, ctx, 'container-data-loss', '`docker system prune -a/--volumes` removes all unused images and volumes on this machine, including other projects\' data.', 'Prune specific resources instead.');
  }
  if (isDocker && v[0] === 'volume' && /^(rm|remove|prune)$/.test(v[1] || '')) {
    return add(out, ctx, 'container-data-loss', `\`${name} volume ${v[1]}\` permanently deletes volume data.`, 'Confirm which volumes are disposable.');
  }
  // A container with the host's root, home or Docker socket mounted can do anything the host can.
  if (isDocker && /^(run|create)$/.test(v[0] || '')) {
    for (let i = 0; i < v.length; i++) {
      let spec = null;
      if (v[i] === '-v' || v[i] === '--volume') spec = v[i + 1];
      else if (/^--(volume|mount)=/.test(v[i])) spec = v[i].split('=').slice(1).join('=');
      else if (v[i] === '--mount') spec = v[i + 1];
      if (!spec) continue;
      const hostPath = spec.includes('source=') || spec.includes('src=') ? (/(?:source|src)=([^,]+)/.exec(spec) || [])[1] : spec.split(':')[0];
      if (!hostPath) continue;
      const hp = hostPath.replace(/^~(?=\/|$)/, ctx.home).replace(/^\$\{?HOME\}?/, ctx.home);
      if (hp === '/' || pathKey(hp) === pathKey(ctx.home) || /^\/(etc|usr|root|var\/run\/docker\.sock|run\/docker\.sock)\/?$/.test(hp)) {
        return add(out, ctx, 'dangerous-permissions', `\`${name} ${v[0]}\` mounts the host path \`${hostPath}\` into a container, giving it full access to it.`, 'Mount only the project directory or a dedicated data directory.');
      }
    }
  }
}

function checkTruncate(inv, ctx, out) {
  const targets = nonOptionArgs(inv.words, 1, new Set(['-s', '--size', '-r', '--reference', '-o']));
  for (const t of targets) {
    const r = resolvePathWord(t, inv.cwd, ctx);
    const sys = systemWriteClass(r.abs, ctx);
    if (sys) { add(out, ctx, sys.rule, `\`truncate\` empties ${sys.why} (\`${t.value}\`).`, 'Leave system and credential files alone.'); continue; }
    const c = classifyDeleteTarget(r, ctx, false);
    if (c.cls === 'catastrophic') add(out, ctx, 'rm-catastrophic', `\`truncate ${t.value}\` ${c.why}.`, 'Do not run it.');
    else if (c.cls === 'outside') add(out, ctx, 'rm-outside-project', `\`truncate\` empties \`${t.value}\`, ${c.why}.`, 'Only modify files inside the project unless the user asked for this.');
  }
}

function checkSnapshot(inv, ctx, out) {
  const { name, words } = inv;
  const v = words.slice(1).map((w) => w.value);
  const lname = name.toLowerCase();
  const runner = /^(jest|vitest|playwright|pytest|py\.test|npm|pnpm|yarn|bun|cargo|go|ava|mocha|deno)$/.test(lname);
  if (!runner) return;
  const snapFlag = v.find((a) => /^(-u|--updateSnapshot|--update-snapshots|--update|--snapshot-update|--force-regen|-update|--update-goldens?|--inline-snapshot=(create|fix|update))$/.test(a));
  const insta = lname === 'cargo' && v[0] === 'insta' && /^(accept|review)$/.test(v[1] || '');
  const envSnap = Object.keys(inv.env).find((k) => /^(UPDATE_SNAPSHOTS?|UPDATE_GOLDEN|INSTA_UPDATE|SNAPSHOT_UPDATE)$/.test(k));
  if (snapFlag || insta || envSnap) {
    if (lname === 'go' && snapFlag !== '-update') return;
    if ((lname === 'npm' || lname === 'pnpm' || lname === 'yarn' || lname === 'bun') && !v.some((a) => /^(test|t|run)$/.test(a))) return;
    add(out, ctx, 'snapshot-update', 'Snapshot/golden files will be rewritten to match current output, which turns any regression into the new "expected" value.', 'After updating, review every snapshot diff and confirm each change is intended before reporting success.');
  }
}

/**
 * `guard.protectedFiles` for writes made through the shell (sed -i, tee, cp, mv, redirects, rm).
 * Returns true when a finding was added.
 */
function checkProtectedPath(abs, rawValue, verb, ctx, out, { includeAsk = true } = {}) {
  if (!abs) return false;
  const rel = relToProject(abs, ctx);
  const p = rel || toPosix(abs);
  if (rel && (rel === '.git' || rel.startsWith('.git/'))) return false; // handled by the git/rm rules
  const g = ctx.config?.guard?.protectedFiles || {};
  const deny = matchGlob(p, g.deny || []);
  if (deny) {
    add(out, ctx, 'protected-file', `${verb} \`${rawValue}\`, which is protected (${deny}).`, 'Leave this path alone, or ask the user to change it.');
    if (out.length && out[out.length - 1].rule === 'protected-file') out[out.length - 1].level = 'deny';
    return true;
  }
  const ask = includeAsk && matchGlob(p, g.ask || []);
  if (ask) {
    add(out, ctx, 'protected-file', `${verb} \`${rawValue}\`, which is protected (${ask}).`, /lock|\.sum$|\.resolved$/i.test(p) ? 'Change dependencies through the package manager instead.' : 'Change the source that produces it instead.');
    return true;
  }
  return false;
}

function checkSedInPlace(inv, ctx, out) {
  const { name, words } = inv;
  if (!(name === 'sed' || name === 'perl' || name === 'gsed') || !words.some((w) => /^(-i|--in-place)/.test(w.value) || /^-[a-z]*i/.test(w.value) && name === 'perl')) return;
  const files = nonOptionArgs(words, 1, new Set(['-e', '-f', '--expression', '--file'])).slice(name === 'sed' && !words.some((w) => w.value === '-e') ? 1 : 0);
  for (const f of files) {
    const abs = resolvePathWord(f, inv.cwd, ctx).abs;
    const g = isGuardrailPath(abs, ctx);
    if (g) { add(out, ctx, 'guardrail-tamper', `Edits \`${f.value}\` in place (safety/hook configuration).`, 'Ask the user to change guardrail configuration.'); return; }
    const sys = systemWriteClass(abs, ctx);
    if (sys) { add(out, ctx, sys.rule, `Edits ${sys.why} in place (\`${f.value}\`).`, 'Leave system and credential files alone.'); return; }
    if (checkProtectedPath(abs, f.value, 'Edits', ctx, out)) return;
  }
}

function checkWriters(inv, ctx, out) {
  // tee / cp / install / ln targets
  const { name, words } = inv;
  let targets = [];
  if (name === 'tee') targets = nonOptionArgs(words, 1);
  else if (name === 'cp' || name === 'install' || name === 'ln' || name === 'rsync') {
    const args = nonOptionArgs(words, 1, new Set(['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '-g']));
    if (args.length >= 2) targets = [args[args.length - 1]];
  }
  for (const t of targets) {
    const abs = resolvePathWord(t, inv.cwd, ctx).abs;
    const g = isGuardrailPath(abs, ctx);
    if (g) { add(out, ctx, 'guardrail-tamper', `Writes \`${t.value}\` (safety/hook configuration).`, 'Ask the user to change guardrail configuration.'); continue; }
    const sys = systemWriteClass(abs, ctx);
    if (sys) { add(out, ctx, sys.rule, `Writes into ${sys.why} (\`${t.value}\`).`, 'Leave system and credential files alone.'); continue; }
    if (checkProtectedPath(abs, t.value, 'Writes', ctx, out)) continue;
    if ((name === 'cp' || name === 'install') && abs && isSecretStoreFile(abs) && fileExists(abs)) {
      add(out, ctx, 'env-file-clobber', `Overwrites the existing secrets file \`${t.value}\`.`, 'Merge the values instead of replacing the file, or ask the user.');
    }
  }
}

function checkRedirects(inv, ctx, out) {
  for (const r of inv.cmd.redirects) {
    if (!r.target || r.op === '<<' || r.op === '<<-' || r.op === '<<<' || r.op === '>&' || r.op === '<&') continue;
    const abs = resolvePathWord(r.target, inv.cwd, ctx).abs;
    if (r.op === '<') {
      if (isSensitivePath(abs, ctx, r.target.value) && inv.name && !['source', '.', 'export'].includes(inv.name) && !inv.cmd.redirects.some((x) => x.op === '>' || x.op === '>>')) {
        if (NET_SEND.has(inv.name)) add(out, ctx, 'secret-exfiltration', `Feeds \`${r.target.value}\` (secrets) into \`${inv.name}\`, which sends it over the network.`, 'Never send credential files over the network.');
        else if (PRINTERS.has(inv.name)) add(out, ctx, 'secret-file-read', `\`${inv.name} < ${r.target.value}\` prints a secrets file into the conversation.`, 'Refer to variable names, not values.');
      }
      continue;
    }
    // output redirections
    if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d)$/.test(r.target.value)) continue;
    const g = isGuardrailPath(abs, ctx);
    if (g) { add(out, ctx, 'guardrail-tamper', `Redirects output into \`${r.target.value}\` (safety/hook configuration).`, 'Ask the user to change guardrail configuration.'); continue; }
    const sys = systemWriteClass(abs, ctx);
    if (sys) { add(out, ctx, sys.rule, `Writes into ${sys.why} via \`${r.op} ${r.target.value}\`.`, 'Leave system and credential files alone.'); continue; }
    if (checkProtectedPath(abs, r.target.value, `Redirects output (${r.op}) into`, ctx, out)) continue;
    if ((r.op === '>' || r.op === '>|' || r.op === '&>') && abs && isSecretStoreFile(abs) && fileExists(abs)) {
      add(out, ctx, 'env-file-clobber', `\`${r.op} ${r.target.value}\` truncates an existing secrets file that git cannot restore.`, 'Append (>>) or edit specific keys instead.');
    }
  }
}

// --- pipelines --------------------------------------------------------------

function checkPipeline(invs, ctx, out) {
  if (invs.length < 2) return;
  invs.sort((a, b) => a.pipeIndex - b.pipeIndex);
  for (let i = 0; i < invs.length; i++) {
    const a = invs[i];
    if (NET_FETCH.has(a.name) || NET_FETCH.has(a.name.toLowerCase())) {
      for (let j = i + 1; j < invs.length; j++) {
        const b = invs[j];
        const bn = b.name.toLowerCase();
        const readsStdin = SHELLS.has(bn) ? !b.words.slice(1).some((w) => !w.value.startsWith('-') || /^-[a-z]*c/.test(w.value)) || b.words.some((w) => w.value === '-s' || w.value === '-')
          : INTERPRETERS.has(bn) ? !b.words.slice(1).some((w) => !w.value.startsWith('-')) || b.words.some((w) => w.value === '-') : false;
        if (readsStdin || bn === 'iex' || bn === 'invoke-expression') {
          add(out, ctx, 'remote-script-exec', `\`${a.name} … | ${b.name}\` executes code straight from the network without anyone reviewing it.`, 'Download to a file, read it, then run it — or use the package manager.');
          break;
        }
      }
    }
    const secretRead = PRINTERS.has(a.name) && a.words.slice(1).some((w) => !w.value.startsWith('-') && isSensitivePath(resolvePathWord(w, a.cwd, ctx).abs, ctx, w.value));
    const secretRedirect = a.cmd.redirects.some((r) => r.op === '<' && r.target && isSensitivePath(resolvePathWord(r.target, a.cwd, ctx).abs, ctx, r.target.value));
    if (secretRead || secretRedirect) {
      for (let j = i + 1; j < invs.length; j++) {
        const b = invs[j];
        if (NET_SEND.has(b.name)) {
          add(out, ctx, 'secret-exfiltration', `Pipes a secrets file into \`${b.name}\`, sending credentials over the network.`, 'Never send credential files over the network.');
          break;
        }
      }
    }
    if (a.name === 'env' || a.name === 'printenv') {
      const next = invs[i + 1];
      if (next && NET_SEND.has(next.name)) add(out, ctx, 'secret-exfiltration', 'Sends the whole environment (API keys, tokens) over the network.', 'Do not transmit environment variables.');
    }
  }
  // env | grep: only flag secret-looking filters
  const first = invs[0];
  if ((first.name === 'env' || first.name === 'printenv') && first.words.length === 1) {
    const filt = invs[1];
    if (filt && /^(grep|egrep|rg)$/.test(filt.name)) {
      const pat = filt.words.slice(1).map((w) => w.value).join(' ');
      // remove a finding already added for the bare `env` since it is filtered
      const idx = out.findIndex((f) => f.rule === 'secret-env-dump' && f.detail.startsWith(`\`${first.name}\``));
      if (idx >= 0 && !/(key|token|secret|pass|auth|cred|private)/i.test(pat)) out.splice(idx, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// File tools (Write / Edit / NotebookEdit / Read)
// ---------------------------------------------------------------------------

/**
 * @param {{tool:string, filePath:string, newText:string, isNewFile?:boolean}} op
 */
export function analyzeFileWrite(op, ctx) {
  const findings = [];
  const cfg = ctx.config;
  if (!cfg || cfg.mode === 'off' || cfg.guard?.enabled === false) return { level: null, findings };
  const abs = path.resolve(ctx.cwd || ctx.projectRoot, op.filePath);
  const rel = relToProject(abs, ctx);
  const disp = rel || toPosix(abs);
  const g = cfg.guard;

  if (rel && (rel === '.git' || rel.startsWith('.git/'))) {
    add(findings, ctx, 'git-internals', `\`${disp}\` is inside .git; editing repository internals directly can corrupt the repo.`, 'Use git commands instead.');
  }
  const sys = systemWriteClass(abs, ctx);
  if (sys) add(findings, ctx, sys.rule, `\`${toPosix(abs)}\` is ${sys.why}.`, 'Leave system and credential files alone.');
  const gr = isGuardrailPath(abs, ctx);
  if (gr) add(findings, ctx, 'guardrail-tamper', `\`${disp}\` controls hooks/permissions/guardrails for this agent.`, 'Ask the user to make guardrail changes themselves.');

  const matchPath = rel || toPosix(abs);
  if (!findings.some((f) => f.rule === 'git-internals')) {
    const deny = matchGlob(matchPath, g.protectedFiles?.deny || []);
    const ask = !deny && matchGlob(matchPath, g.protectedFiles?.ask || []);
    if (deny) {
      add(findings, ctx, 'protected-file', `\`${disp}\` is protected (${deny}).`, 'Edit the source that produces it instead.');
      findings[findings.length - 1].level = 'deny';
    } else if (ask) {
      const why = /lock|\.sum$|\.resolved$/i.test(matchPath)
        ? 'is a lockfile — it should change only through the package manager (e.g. `npm install <pkg>`), never by hand'
        : /node_modules|vendor/.test(matchPath) ? 'is a third-party dependency — edits are lost on the next install' : 'is a build artifact';
      add(findings, ctx, 'protected-file', `\`${disp}\` ${why}.`, 'Change the source/manifest and regenerate.');
    }
  }
  // generated header
  if (!op.isNewFile && fileExists(abs)) {
    const head = (readTextSafe(abs, 4 * 1024 * 1024) || '').slice(0, 1200);
    if (/@generated\b|\bDO NOT EDIT\b|\bAUTO-GENERATED\b|\bauto-generated\b|\bautogenerated\b|This file (is|was) (automatically )?generated|Code generated .* DO NOT EDIT/i.test(head) && !/veridone-allow/.test(head)) {
      add(findings, ctx, 'generated-file', `\`${disp}\` is generated (its header says so); hand edits will be overwritten by the next generation run.`, 'Change the generator input/source and regenerate.');
    }
    if (rel && matchGlob(rel, g.migrationDirs || []) && ctx.git.isRepo() && ctx.git.isTracked(rel)) {
      add(findings, ctx, 'migration-edit', `\`${disp}\` is an existing, committed migration. Databases that already applied it will not re-run it, so editing it causes schema drift.`, 'Create a new migration for the change instead.');
    }
  }
  // secrets in new content
  if (cfg.secrets?.enabled !== false && op.newText) {
    const hits = scanSecrets(op.newText);
    if (hits.length) {
      const store = isSecretStoreFile(abs);
      const allowed = matchGlob(matchPath, cfg.secrets?.allowFiles || []);
      if (store) {
        if (rel && ctx.git.isRepo() && !ctx.git.isIgnored(rel)) {
          add(findings, ctx, 'secret-not-ignored', `\`${disp}\` holds credentials but is not git-ignored, so it can be committed.`, `Add \`${path.basename(abs)}\` to .gitignore.`);
        }
      } else {
        const high = hits.filter((h) => h.severity === 'high');
        const list = hits.slice(0, 3).map((h) => `${h.name} on line ${h.line} (${h.preview})`).join('; ');
        if (high.length && !allowed && cfg.secrets?.block !== 'off') {
          add(findings, ctx, 'hardcoded-secret', `The new content of \`${disp}\` contains ${list}.`, 'Read credentials from environment variables or a secrets manager (e.g. `process.env.X`, `os.environ["X"]`) and keep real values in a git-ignored .env file. If this is a test fixture, use an obviously fake value.');
        } else {
          add(findings, ctx, 'possible-secret', `\`${disp}\` may contain a credential: ${list}.`, 'Make sure this is not a real secret; load real values from the environment.');
        }
      }
    }
  }
  return { level: combine(findings), findings };
}

export function analyzeFileRead(filePath, ctx) {
  const findings = [];
  const cfg = ctx.config;
  if (!cfg || cfg.mode === 'off' || cfg.guard?.enabled === false) return { level: null, findings };
  const abs = path.resolve(ctx.cwd || ctx.projectRoot, filePath);
  const hit = isSensitivePath(abs, ctx, filePath);
  if (hit) {
    const disp = relToProject(abs, ctx) || toPosix(abs);
    add(findings, ctx, 'secret-file-read', `Reading \`${disp}\` (${hit}) would put credentials into the conversation and transcript.`, 'Ask the user for the specific non-secret value you need, or read the matching .example file.');
  }
  return { level: combine(findings), findings };
}

/** Format findings into the reason text for a hook decision. */
export function formatReason(findings, level) {
  const relevant = findings.filter((f) => f.level === level);
  const lines = relevant.slice(0, 3).map((f) => `• ${f.title}: ${f.detail}${f.fix ? ` → ${f.fix}` : ''} [${f.rule}]`);
  if (relevant.length > 3) lines.push(`• …and ${relevant.length - 3} more`);
  return lines.join('\n');
}
