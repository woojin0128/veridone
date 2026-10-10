// The plugin version, read from .claude-plugin/plugin.json so a release bumps it in one place.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached = null;
export function version() {
  if (cached) return cached;
  try {
    const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.claude-plugin', 'plugin.json');
    cached = JSON.parse(fs.readFileSync(manifest, 'utf8')).version || '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
