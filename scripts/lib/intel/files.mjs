// Veridone intel — enumerate source files (git-aware, with a safe fallback walker).
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from '../git.mjs';
import { toPosix } from '../util.mjs';

export const SOURCE_EXT = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'cs', 'fs', 'rb', 'php', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'm', 'mm', 'dart', 'ex', 'exs', 'lua', 'sh', 'bash', 'zsh', 'sql', 'proto', 'graphql', 'gql',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.turbo', '.cache', 'coverage', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData', '.dart_tool', '.terraform', 'bower_components', '.svelte-kit', '.parcel-cache', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.tox', 'site-packages', '.yarn', '.pnpm-store']);

export function extOf(p) {
  const b = p.split('/').pop() || '';
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1).toLowerCase() : '';
}

export function isSourceFile(p) {
  if (!SOURCE_EXT.has(extOf(p))) return false;
  if (/\.min\.(js|css)$|\.bundle\.js$|\.d\.ts\.map$|(^|\/)(node_modules|vendor|dist|build|target|\.git)\//.test(p)) return false;
  return true;
}

/**
 * List source files relative to root.
 * @returns {string[]}
 */
export function listSourceFiles(root, { max = 20000, subdir = null } = {}) {
  let files = listFiles(root, { others: true, maxFiles: max * 3 });
  if (!files) files = walk(root, max * 3);
  files = files.map(toPosix).filter(isSourceFile);
  if (subdir) {
    const pre = toPosix(subdir).replace(/^\.\/?/, '').replace(/\/$/, '');
    if (pre) files = files.filter((f) => f === pre || f.startsWith(pre + '/'));
  }
  return files.slice(0, max);
}

function walk(root, max) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < max) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); }
      else if (e.isFile()) out.push(r);
      if (out.length >= max) break;
    }
  }
  return out;
}
