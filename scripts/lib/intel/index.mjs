// Veridone intel — incremental code index: symbols, import graph, PageRank ranking,
// repo map rendering, outlines, symbol search and change-impact analysis.

import fs from 'node:fs';
import path from 'node:path';
import { listSourceFiles, extOf } from './files.mjs';
import { parseFile, languageOf } from './symbols.mjs';
import { dataDir, ensureDir, readJsonFile, shortHash, toPosix, readTextSafe, writeFileAtomic } from '../util.mjs';
import { isTestPath } from '../guard.mjs';

const CACHE_VERSION = 3;
const MAX_FILE_BYTES = 768 * 1024;
const memo = new Map(); // root -> index (long-lived MCP process)

function cachePath(root) {
  return path.join(ensureDir(path.join(dataDir(), 'intel')), `${shortHash(path.resolve(root), 16)}.json`);
}

/**
 * Build or refresh the index for a project root.
 * @returns {{root:string, files:Map<string, any>, stats:{parsed:number, reused:number, total:number, ms:number}}}
 */
export function buildIndex(root, { maxFiles = 20000 } = {}) {
  const t0 = Date.now();
  root = path.resolve(root);
  let idx = memo.get(root);
  if (!idx) {
    idx = { root, files: new Map(), dirty: false };
    const cached = readJsonFile(cachePath(root), null);
    if (cached && cached.version === CACHE_VERSION && cached.files) {
      for (const [rel, info] of Object.entries(cached.files)) idx.files.set(rel, { ...info, idents: new Map(info.idents || []) });
    }
    memo.set(root, idx);
  }
  const list = listSourceFiles(root, { max: maxFiles });
  const present = new Set(list);
  let parsed = 0;
  let reused = 0;
  for (const rel of list) {
    let st;
    try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    const prev = idx.files.get(rel);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) { reused++; continue; }
    const text = readTextSafe(path.join(root, rel), MAX_FILE_BYTES);
    if (text == null || text.includes('\u0000')) continue;
    if (text.length > 20000 && text.split('\n').length < 5) continue; // minified
    const info = parseFile(rel, text);
    // keep only the most frequent identifiers to bound memory
    const idents = new Map([...info.idents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200));
    idx.files.set(rel, { mtimeMs: st.mtimeMs, size: st.size, lines: info.lines, symbols: info.symbols, imports: info.imports, idents });
    parsed++;
    idx.dirty = true;
  }
  for (const rel of [...idx.files.keys()]) if (!present.has(rel)) { idx.files.delete(rel); idx.dirty = true; }
  if (idx.dirty) {
    const obj = { version: CACHE_VERSION, root, files: {} };
    for (const [rel, info] of idx.files) obj.files[rel] = { ...info, idents: [...info.idents.entries()] };
    try { writeFileAtomic(cachePath(root), JSON.stringify(obj)); } catch { /* cache is best effort */ }
    idx.dirty = false;
  }
  idx.graph = null; // invalidate derived data
  idx.stats = { parsed, reused, total: idx.files.size, ms: Date.now() - t0 };
  return idx;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.d.ts'];

function tsAliases(root) {
  const out = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const cfg = readJsonFile(path.join(root, name), null);
    const co = cfg?.compilerOptions;
    if (!co) continue;
    const base = co.baseUrl ? toPosix(path.normalize(co.baseUrl)).replace(/^\.\/?/, '') : '';
    for (const [k, targets] of Object.entries(co.paths || {})) {
      const t = Array.isArray(targets) ? targets[0] : null;
      if (!t) continue;
      out.push({ from: k.replace(/\*$/, ''), to: toPosix(path.posix.join(base || '.', t.replace(/\*$/, ''))).replace(/^\.\//, ''), wildcard: k.endsWith('*') });
    }
    if (co.baseUrl) out.push({ from: '', to: base ? base + '/' : '', wildcard: true, baseUrl: true });
  }
  return out;
}

function goModule(root) {
  const t = readTextSafe(path.join(root, 'go.mod'));
  const m = t && /^module\s+(\S+)/m.exec(t);
  return m ? m[1] : null;
}

function composerPsr4(root) {
  const c = readJsonFile(path.join(root, 'composer.json'), null);
  const map = { ...(c?.autoload?.['psr-4'] || {}), ...(c?.['autoload-dev']?.['psr-4'] || {}) };
  return Object.entries(map).map(([ns, dir]) => ({ ns, dir: toPosix(Array.isArray(dir) ? dir[0] : dir).replace(/\/?$/, '/') }));
}

function buildResolver(idx) {
  const files = idx.files;
  const has = (p) => files.has(p);
  const aliases = tsAliases(idx.root);
  const goMod = goModule(idx.root);
  const psr4 = composerPsr4(idx.root);
  const byBase = new Map();
  for (const f of files.keys()) {
    const b = f.split('/').pop();
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  const dirFiles = new Map();
  for (const f of files.keys()) {
    const d = path.posix.dirname(f);
    if (!dirFiles.has(d)) dirFiles.set(d, []);
    dirFiles.get(d).push(f);
  }
  const tryJs = (base) => {
    const b = toPosix(path.posix.normalize(base)).replace(/^\.\//, '');
    if (has(b)) return b;
    const noJs = b.replace(/\.(js|jsx|mjs|cjs)$/, '');
    for (const e of JS_EXT) if (has(noJs + e)) return noJs + e;
    for (const e of JS_EXT) if (has(`${b}/index${e}`)) return `${b}/index${e}`;
    return null;
  };
  return (from, imp) => {
    const lang = languageOf(from);
    const spec = imp.spec;
    const dir = path.posix.dirname(from);
    if (lang === 'js') {
      if (spec.startsWith('.')) return [tryJs(path.posix.join(dir, spec))].filter(Boolean);
      for (const a of aliases) {
        if (a.baseUrl) { const r = tryJs(a.to + spec); if (r) return [r]; continue; }
        if (a.wildcard ? spec.startsWith(a.from) : spec === a.from) {
          const r = tryJs(a.to + spec.slice(a.from.length));
          if (r) return [r];
        }
      }
      return [];
    }
    if (lang === 'py') {
      const out = [];
      const dots = (/^\.+/.exec(spec) || [''])[0].length;
      const mod = spec.slice(dots).replace(/\./g, '/');
      const bases = [];
      if (dots) {
        let d = dir;
        for (let k = 1; k < dots; k++) d = path.posix.dirname(d);
        bases.push(d === '.' ? '' : d);
      } else bases.push('', 'src', 'lib', 'app');
      for (const b of bases) {
        const p = [b, mod].filter(Boolean).join('/');
        if (p && has(`${p}.py`)) out.push(`${p}.py`);
        else if (p && has(`${p}/__init__.py`)) out.push(`${p}/__init__.py`);
        for (const n of imp.names || []) {
          const q = [p, n].filter(Boolean).join('/');
          if (has(`${q}.py`)) out.push(`${q}.py`);
        }
        if (out.length) break;
      }
      return out;
    }
    if (lang === 'go') {
      if (!goMod || !spec.startsWith(goMod)) return [];
      const rel = spec.slice(goMod.length).replace(/^\//, '') || '.';
      return (dirFiles.get(rel) || []).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
    }
    if (lang === 'rs') {
      if (spec.startsWith('mod:')) {
        const name = spec.slice(4);
        const baseDir = /(^|\/)(main|lib|mod)\.rs$/.test(from) ? dir : from.replace(/\.rs$/, '');
        return [`${baseDir}/${name}.rs`, `${baseDir}/${name}/mod.rs`].map((p) => p.replace(/^\.\//, '')).filter(has);
      }
      const m = /^(crate|super|self)::([\w:]+)/.exec(spec);
      if (!m) return [];
      const parts = m[2].split('::');
      const srcRoot = from.includes('src/') ? from.slice(0, from.indexOf('src/') + 4) : '';
      for (let k = parts.length; k > 0; k--) {
        const p = srcRoot + parts.slice(0, k).join('/');
        for (const c of [`${p}.rs`, `${p}/mod.rs`]) if (has(c)) return [c];
      }
      return [];
    }
    if (lang === 'java' || lang === 'kt') {
      const cls = spec.split('.').filter((s) => s !== '*').pop();
      const suffix = spec.replace(/\.\*$/, '').replace(/\./g, '/');
      const cands = [...(byBase.get(`${cls}.java`) || []), ...(byBase.get(`${cls}.kt`) || [])];
      return cands.filter((f) => f.replace(/\.(java|kt)$/, '').endsWith(suffix)).slice(0, 1);
    }
    if (lang === 'php') {
      const s = spec.replace(/^\\/, '');
      for (const { ns, dir: d } of psr4) {
        if (s.startsWith(ns)) {
          const p = d + s.slice(ns.length).replace(/\\/g, '/') + '.php';
          if (has(p)) return [p];
        }
      }
      if (/\.php$/.test(spec)) { const p = toPosix(path.posix.normalize(path.posix.join(dir, spec))); return has(p) ? [p] : []; }
      return [];
    }
    if (lang === 'rb') {
      const p = imp.relative ? path.posix.normalize(path.posix.join(dir, spec)) : `lib/${spec}`;
      return [`${p}.rb`, p].filter(has).slice(0, 1);
    }
    if (lang === 'c') {
      if (!imp.local) return [];
      const rel = toPosix(path.posix.normalize(path.posix.join(dir, spec)));
      if (has(rel)) return [rel];
      const b = spec.split('/').pop();
      return (byBase.get(b) || []).filter((f) => f.endsWith(spec)).slice(0, 1);
    }
    if (lang === 'dart') {
      if (spec.startsWith('package:')) { const p = 'lib/' + spec.replace(/^package:[^/]+\//, ''); return has(p) ? [p] : []; }
      if (!spec.startsWith('dart:')) { const p = toPosix(path.posix.normalize(path.posix.join(dir, spec))); return has(p) ? [p] : []; }
      return [];
    }
    if (lang === 'sh') {
      const p = toPosix(path.posix.normalize(path.posix.join(dir, spec)));
      return has(p) ? [p] : [];
    }
    return [];
  };
}

// ---------------------------------------------------------------------------
// Graph + PageRank
// ---------------------------------------------------------------------------

export function graphOf(idx) {
  if (idx.graph) return idx.graph;
  const resolve = buildResolver(idx);
  const names = [...idx.files.keys()];
  const id = new Map(names.map((n, i) => [n, i]));
  const imports = names.map(() => new Set());
  const importedBy = names.map(() => new Set());
  // definitions: symbol name -> files defining it (top-level-ish symbols only)
  const defs = new Map();
  for (const [f, info] of idx.files) {
    if (isTestPath(f)) continue; // tests define fixtures that shadow real names
    for (const s of info.symbols) {
      if (s.depth > 1 || s.name.length < 3) continue;
      if (!defs.has(s.name)) defs.set(s.name, new Set());
      defs.get(s.name).add(f);
    }
  }
  const weights = names.map(() => new Map());
  const symbolRefs = new Map(); // name -> number of referencing files
  for (const [f, info] of idx.files) {
    const i = id.get(f);
    for (const imp of info.imports) {
      for (const target of resolve(f, imp)) {
        const j = id.get(target);
        if (j === undefined || j === i) continue;
        imports[i].add(j);
        importedBy[j].add(i);
        weights[i].set(j, (weights[i].get(j) || 0) + 3);
      }
    }
    for (const [name, count] of info.idents) {
      const owners = defs.get(name);
      if (!owners) continue;
      // Aider-style weighting: distinctive identifiers carry signal, generic ones are noise.
      let mul = 1;
      const snake = name.includes('_') && /[a-z]/i.test(name);
      const camel = /[A-Z]/.test(name) && /[a-z]/.test(name);
      if ((snake || camel) && name.length >= 8) mul *= 10;
      if (name.startsWith('_')) mul *= 0.1;
      if (owners.size > 5) mul *= 0.1;
      if (name.length < 5 && !camel) mul *= 0.3;
      for (const owner of owners) {
        if (owner === f) continue;
        const j = id.get(owner);
        weights[i].set(j, (weights[i].get(j) || 0) + Math.sqrt(count) * mul / Math.sqrt(owners.size));
        symbolRefs.set(name, (symbolRefs.get(name) || 0) + 1);
      }
    }
  }
  idx.graph = { names, id, imports, importedBy, weights, defs, symbolRefs };
  return idx.graph;
}

export function pageRank(idx, { focus = [], damping = 0.85, iterations = 40 } = {}) {
  const g = graphOf(idx);
  const n = g.names.length;
  if (!n) return new Map();
  const pers = new Float64Array(n).fill(1 / n);
  const focusIds = focus.map((f) => g.id.get(toPosix(f).replace(/^\.\//, ''))).filter((x) => x !== undefined);
  if (focusIds.length) {
    pers.fill(0.2 / n);
    for (const i of focusIds) pers[i] += 0.8 / focusIds.length;
  }
  let rank = Float64Array.from(pers);
  const outSum = g.weights.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  for (let it = 0; it < iterations; it++) {
    const next = new Float64Array(n);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (!outSum[i]) { dangling += rank[i]; continue; }
      for (const [j, w] of g.weights[i]) next[j] += damping * rank[i] * (w / outSum[i]);
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] += (1 - damping) * pers[i] + damping * dangling * pers[i];
      delta += Math.abs(next[i] - rank[i]);
    }
    rank = next;
    if (delta < 1e-7) break;
  }
  const out = new Map();
  for (let i = 0; i < n; i++) out.set(g.names[i], rank[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const KIND_WEIGHT = { class: 3, interface: 3, type: 2.5, enum: 2, function: 2.5, module: 1.5, method: 1, const: 0.8, export: 1.2, extension: 1.5 };

function symbolScore(s, g) {
  const refs = g.symbolRefs.get(s.name) || 0;
  return (KIND_WEIGHT[s.kind] || 1) * (s.exported ? 1.5 : 1) * (1 + Math.log1p(refs)) * (s.depth > 0 ? 0.6 : 1);
}

function fmtSymbol(s) {
  const range = s.endLine > s.line ? `L${s.line}-${s.endLine}` : `L${s.line}`;
  return `${s.kind} ${s.parent && s.kind === 'method' ? s.parent + '.' : ''}${s.name} (${range})`;
}

/**
 * Ranked repository overview within a token budget.
 */
export function repoMap(root, { focus = [], maxTokens = 1500, subdir = null } = {}) {
  const idx = buildIndex(root);
  const g = graphOf(idx);
  const ranks = pageRank(idx, { focus });
  let files = [...idx.files.keys()];
  if (subdir) {
    const pre = toPosix(subdir).replace(/^\.\/?/, '').replace(/\/$/, '');
    if (pre) files = files.filter((f) => f.startsWith(pre + '/') || f === pre);
  }
  const focusSet = new Set(focus.map((f) => toPosix(f).replace(/^\.\//, '')));
  const peripheral = /(^|\/)(benchmarks?|bench|examples?|samples?|demos?|docs?|fixtures?|__fixtures__|perf[-\w]*|scripts|tools?|e2e|playground|sandbox|storybook|stories|\.github)\//;
  const score = (f) => {
    if (focusSet.has(f)) return (ranks.get(f) || 0) * 10;
    let s = ranks.get(f) || 0;
    if (isTestPath(f)) s *= 0.25;
    if (peripheral.test(f)) s *= 0.3;
    return s;
  };
  files = files.filter((f) => idx.files.get(f).symbols.length || focusSet.has(f));
  files.sort((a, b) => score(b) - score(a));
  const budget = Math.max(200, maxTokens) * 4;
  const header = `Repository map — ${idx.files.size} source files indexed${subdir ? ` (showing ${subdir})` : ''}, ranked by how much the rest of the code depends on them.${focus.length ? ` Focus: ${focus.slice(0, 5).join(', ')}.` : ''}\nFormat: file, then key symbols with line ranges (read only those ranges with offset/limit).\n`;
  let out = header;
  let shown = 0;
  for (const f of files) {
    const info = idx.files.get(f);
    const seenNames = new Set();
    const syms = [...info.symbols]
      .sort((a, b) => symbolScore(b, g) - symbolScore(a, g) || (b.endLine - b.line) - (a.endLine - a.line))
      .filter((s) => { const k = `${s.kind}:${s.parent || ''}:${s.name}`; if (seenNames.has(k)) return false; seenNames.add(k); return true; })
      .slice(0, 8)
      .sort((a, b) => a.line - b.line);
    const tests = isTestPath(f) ? ' [test]' : '';
    let block = `\n${f}${tests} (${info.lines} lines)\n`;
    for (const s of syms) block += `  ${fmtSymbol(s)}: ${s.signature}\n`;
    if (out.length + block.length > budget) {
      if (shown === 0) out += block.slice(0, budget - out.length);
      break;
    }
    out += block;
    shown++;
  }
  const rest = files.length - shown;
  if (rest > 0) {
    const dirs = new Map();
    for (const f of files.slice(shown)) { const d = f.includes('/') ? f.split('/')[0] + '/' : './'; dirs.set(d, (dirs.get(d) || 0) + 1); }
    const summary = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, c]) => `${d} ${c}`).join(', ');
    out += `\n… ${rest} more files not shown (${summary}). Increase max_tokens or pass path to zoom in.\n`;
  }
  return { text: out, shown, total: idx.files.size, stats: idx.stats };
}

export function outline(root, files) {
  const idx = buildIndex(root);
  const out = [];
  for (const raw of files.slice(0, 25)) {
    const rel = toPosix(path.isAbsolute(raw) ? path.relative(idx.root, raw) : raw).replace(/^\.\//, '');
    let info = idx.files.get(rel);
    if (!info) {
      const text = readTextSafe(path.join(idx.root, rel), MAX_FILE_BYTES);
      if (text == null) { out.push(`${rel}: not found`); continue; }
      const p = parseFile(rel, text);
      info = { symbols: p.symbols, imports: p.imports, lines: p.lines };
    }
    out.push(`${rel} (${info.lines} lines, ${info.symbols.length} symbols)`);
    if (info.imports.length) out.push(`  imports: ${[...new Set(info.imports.map((i) => i.spec))].slice(0, 12).join(', ')}${info.imports.length > 12 ? ', …' : ''}`);
    for (const s of info.symbols) out.push(`${'  '.repeat(1 + Math.min(s.depth, 3))}${fmtSymbol(s)}: ${s.signature}`);
    if (!info.symbols.length) out.push('  (no symbols recognized)');
  }
  return out.join('\n');
}

export function findSymbol(root, query, { kind = null, limit = 20 } = {}) {
  const idx = buildIndex(root);
  const q = String(query || '').trim();
  if (!q) return 'Empty query.';
  const ql = q.toLowerCase();
  // camelCase / PascalCase initials (connectDatabase → cd, UserService → us) and snake/kebab initials (open_account → oa)
  const initials = (n) => (n[0] + n.slice(1).replace(/[^A-Z]/g, '')).toLowerCase() + '|' + n.split(/[_-]/).map((p) => p[0] || '').join('').toLowerCase();
  const hits = [];
  for (const [f, info] of idx.files) {
    for (const s of info.symbols) {
      if (kind && s.kind !== kind) continue;
      const n = s.name;
      const nl = n.toLowerCase();
      let score = 0;
      if (n === q) score = 100;
      else if (nl === ql) score = 90;
      else if (nl.startsWith(ql)) score = 70 - Math.min(20, n.length - q.length);
      else if (nl.includes(ql)) score = 50 - Math.min(20, n.length - q.length);
      else if (q.length >= 2 && initials(n).split('|').some((x) => x === ql)) score = 40;
      if (!score) continue;
      if (s.exported) score += 3;
      if (isTestPath(f)) score -= 5;
      hits.push({ score, f, s });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  if (!hits.length) return `No symbol matching "${q}" in ${idx.files.size} indexed files. Try a shorter query or grep for usages.`;
  const lines = hits.slice(0, limit).map((h) => `${h.f}:${h.s.line}  ${fmtSymbol(h.s)}  ${h.s.signature}`);
  if (hits.length > limit) lines.push(`… ${hits.length - limit} more`);
  return lines.join('\n');
}

/**
 * Change impact: dependents (reverse imports, BFS) and related tests.
 */
export function impact(root, files, { depth = 2 } = {}) {
  const idx = buildIndex(root);
  const g = graphOf(idx);
  const start = files.map((f) => toPosix(path.isAbsolute(f) ? path.relative(idx.root, f) : f).replace(/^\.\//, ''));
  const known = start.filter((f) => g.id.has(f));
  const dist = new Map(known.map((f) => [f, 0]));
  let frontier = known.map((f) => g.id.get(f));
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next = [];
    for (const i of frontier) for (const j of g.importedBy[i]) {
      const name = g.names[j];
      if (!dist.has(name)) { dist.set(name, d); next.push(j); }
    }
    frontier = next;
  }
  const dependents = [...dist.entries()].filter(([, d]) => d > 0).sort((a, b) => a[1] - b[1]);
  const tests = new Set([...dist.keys()].filter((f) => isTestPath(f)));
  // naming conventions
  const all = [...idx.files.keys()];
  for (const f of start) {
    const base = f.split('/').pop().replace(/\.[^.]+$/, '');
    const ext = extOf(f);
    const conv = new RegExp(`(^|/)(${escapeRe(base)}\\.(test|spec)\\.[a-z]+|test_${escapeRe(base)}\\.py|${escapeRe(base)}_test\\.(go|py|rb|exs)|${escapeRe(base)}_spec\\.rb|${escapeRe(base[0]?.toUpperCase() + base.slice(1))}Tests?\\.(java|kt|cs|swift))$`);
    for (const c of all) if (conv.test(c)) tests.add(c);
    if (ext === 'go') for (const c of all) if (c.endsWith('_test.go') && path.posix.dirname(c) === path.posix.dirname(f)) tests.add(c);
  }
  const unknown = start.filter((f) => !g.id.has(f));
  return { changed: start, dependents, tests: [...tests].sort(), unknown };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Suggest a scoped test command for a set of test files. */
export function scopedTestCommand(project, testFiles) {
  if (!testFiles.length) return null;
  const fw = project?.frameworks || [];
  const pm = project?.packageManager || 'npm';
  const exec = (bin) => (pm === 'pnpm' ? `pnpm exec ${bin}` : pm === 'yarn' ? `yarn ${bin}` : pm === 'bun' ? `bunx ${bin}` : `npx ${bin}`);
  const js = testFiles.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  const py = testFiles.filter((f) => f.endsWith('.py'));
  const go = testFiles.filter((f) => f.endsWith('_test.go'));
  const rb = testFiles.filter((f) => f.endsWith('_spec.rb'));
  const cmds = [];
  if (js.length) {
    if (fw.includes('vitest')) cmds.push(exec(`vitest run ${js.join(' ')}`));
    else if (fw.includes('jest')) cmds.push(exec(`jest ${js.join(' ')}`));
    else if (fw.includes('mocha')) cmds.push(exec(`mocha ${js.join(' ')}`));
    else cmds.push(`node --test ${js.join(' ')}`);
  }
  if (py.length) cmds.push(`${(project?.commands?.test || 'pytest').startsWith('uv run') ? 'uv run ' : ''}pytest ${py.join(' ')}`);
  if (go.length) cmds.push(`go test ${[...new Set(go.map((f) => './' + path.posix.dirname(f)))].join(' ')}`);
  if (rb.length) cmds.push(`bundle exec rspec ${rb.join(' ')}`);
  return cmds.join(' && ') || null;
}
