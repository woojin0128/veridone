import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, findProjectRoot, deepMerge, DEFAULT_CONFIG, configPaths, writeProjectConfig } from '../scripts/lib/config.mjs';
import { tmpDir, gitRepo, writeTree } from './helpers.mjs';

let home;
beforeEach(() => {
  home = tmpDir('veridone-cfg-home-');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const k of ['VERIDONE_MODE', 'VERIDONE_DISABLE', 'VERIDONE_POLICY_FILE', 'CLAUDE_PROJECT_DIR']) delete process.env[k];
});

test('defaults to standard mode', () => {
  const repo = gitRepo();
  const { config, sources, warnings } = loadConfig({ projectRoot: repo });
  assert.equal(config.mode, 'standard');
  assert.deepEqual(sources, []);
  assert.deepEqual(warnings, []);
});

test('layers user < project < local < session < env', () => {
  const repo = gitRepo();
  writeTree(home, { '.claude/veridone.json': JSON.stringify({ mode: 'strict', condense: { minChars: 1000 } }) });
  writeTree(repo, { '.claude/veridone.json': JSON.stringify({ mode: 'relaxed', verify: { commands: { test: 'make check' } } }) });
  let c = loadConfig({ projectRoot: repo }).config;
  assert.equal(c.mode, 'relaxed');
  assert.equal(c.condense.minChars, 1000);
  assert.equal(c.verify.commands.test, 'make check');
  writeTree(repo, { '.claude/veridone.local.json': '// personal\n{ "mode": "strict" }' });
  assert.equal(loadConfig({ projectRoot: repo }).config.mode, 'strict', 'JSONC comments are allowed');
  assert.equal(loadConfig({ projectRoot: repo, sessionMode: 'off' }).config.mode, 'off');
  process.env.VERIDONE_MODE = 'relaxed';
  assert.equal(loadConfig({ projectRoot: repo, sessionMode: 'off' }).config.mode, 'relaxed');
  process.env.VERIDONE_DISABLE = '1';
  assert.equal(loadConfig({ projectRoot: repo }).config.mode, 'off');
});

test('list settings extend the defaults instead of replacing them', () => {
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), { guard: { protectedBranches: ['prod-eu'] }, integrity: { ignore: ['legacy/**'] } });
  assert.ok(merged.guard.protectedBranches.includes('main'));
  assert.ok(merged.guard.protectedBranches.includes('prod-eu'));
  assert.ok(merged.integrity.ignore.includes('legacy/**'));
  assert.ok(merged.integrity.ignore.includes('**/node_modules/**'));
});

test('invalid files produce warnings, not crashes', () => {
  const repo = gitRepo();
  writeTree(repo, { '.claude/veridone.json': '{ not json' });
  const r = loadConfig({ projectRoot: repo });
  assert.equal(r.config.mode, 'standard');
  assert.match(r.warnings[0], /invalid JSON/);
  writeTree(repo, { '.claude/veridone.json': '{"mode":"yolo"}' });
  assert.match(loadConfig({ projectRoot: repo }).warnings.join(' '), /Unknown mode "yolo"/);
});

test('an organization policy applies only when licensed, and locked policies win', () => {
  const repo = gitRepo();
  const policy = path.join(home, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({ mode: 'strict', locked: true, guard: { protectedBranches: ['release-*'] } }));
  process.env.VERIDONE_POLICY_FILE = policy;
  const unlicensed = loadConfig({ projectRoot: repo, sessionMode: 'off', policyAllowed: false });
  assert.equal(unlicensed.config.mode, 'off');
  assert.match(unlicensed.warnings.join(' '), /requires a Veridone Team license/);
  process.env.VERIDONE_DISABLE = '1';
  const licensed = loadConfig({ projectRoot: repo, sessionMode: 'off', policyAllowed: true });
  assert.equal(licensed.config.mode, 'strict');
  assert.ok(licensed.config.guard.protectedBranches.includes('release-*'));
});

test('findProjectRoot walks up to the git root', () => {
  const repo = gitRepo({ 'a/b/c/file.txt': 'x' });
  assert.equal(findProjectRoot(path.join(repo, 'a/b/c')), repo);
  const plain = tmpDir();
  assert.equal(findProjectRoot(plain), plain);
});

test('writeProjectConfig writes where configPaths points', () => {
  const repo = gitRepo();
  const p = writeProjectConfig(repo, { mode: 'strict' });
  assert.equal(p, configPaths(repo).project);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).mode, 'strict');
  assert.equal(writeProjectConfig(repo, { mode: 'relaxed' }, { local: true }), configPaths(repo).local);
});

test('the JSON schema documents every configuration key', async () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/veridone.schema.json', import.meta.url), 'utf8'));
  const missing = [];
  const walk = (obj, node, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const child = node?.properties?.[k];
      if (!child) { missing.push(prefix + k); continue; }
      if (v && typeof v === 'object' && !Array.isArray(v) && child.properties) walk(v, child, `${prefix}${k}.`);
    }
  };
  walk(DEFAULT_CONFIG, schema, '');
  assert.deepEqual(missing, []);
});
