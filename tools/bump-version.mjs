#!/usr/bin/env node
// Bump the plugin version everywhere it lives and open a CHANGELOG section for it.
//   node tools/bump-version.mjs <patch|minor|major|X.Y.Z> [--note "What changed"]
// Claude Code only delivers plugin updates when the version changes, and the Release workflow
// publishes whenever it does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [ma, mi, pa] = current.split('.').map(Number);
  if (kind === 'major') return `${ma + 1}.0.0`;
  if (kind === 'minor') return `${ma}.${mi + 1}.0`;
  if (kind === 'patch') return `${ma}.${mi}.${pa + 1}`;
  throw new Error(`Unknown bump "${kind}" (use patch, minor, major or X.Y.Z)`);
}

export function bump(root, kind, note = null, date = new Date().toISOString().slice(0, 10)) {
  const pluginPath = path.join(root, '.claude-plugin', 'plugin.json');
  const plugin = JSON.parse(fs.readFileSync(pluginPath, 'utf8'));
  const next = nextVersion(plugin.version, kind);
  plugin.version = next;
  fs.writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');
  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.version = next;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  }
  const logPath = path.join(root, 'CHANGELOG.md');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '# Changelog\n';
  if (!new RegExp(`^## \\[?${next.replace(/\./g, '\\.')}\\b`, 'm').test(log)) {
    const entry = `## ${next} (${date})\n\n- ${note || 'Maintenance release.'}\n\n`;
    const at = log.search(/^## /m);
    fs.writeFileSync(logPath, at >= 0 ? log.slice(0, at) + entry + log.slice(at) : `${log.trimEnd()}\n\n${entry}`);
  }
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const kind = args[0];
  const note = args.includes('--note') ? args[args.indexOf('--note') + 1] : null;
  if (!kind || kind.startsWith('--')) { console.error('Usage: node tools/bump-version.mjs <patch|minor|major|X.Y.Z> [--note "…"]'); process.exit(2); }
  try { console.log(`Version ${bump(ROOT, kind, note)}`); } catch (e) { console.error(e.message); process.exit(2); }
}
