// Seller tools: configure-publisher rewrites every identity reference consistently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, tmpDir } from './helpers.mjs';

function copyProject() {
  const dir = path.join(tmpDir('veridone-publisher-'), 'veridone');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[/\\](\.git|node_modules|_site)([/\\]|$)/.test(src) });
  return dir;
}

test('configure-publisher moves every URL, the author and the store link to a new owner', () => {
  const dir = copyProject();
  const before = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8'));
  const [owner, name] = before.repository.replace('https://github.com/', '').split('/');
  const r = spawnSync(process.execPath, ['tools/configure-publisher.mjs', '--github', 'acme-tools/guardrails', '--author', 'ACME Ltd'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plugin = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/marketplace.json'), 'utf8'));
  assert.equal(plugin.repository, 'https://github.com/acme-tools/guardrails');
  assert.equal(plugin.homepage, 'https://acme-tools.github.io/guardrails/');
  assert.equal(plugin.author.name, 'ACME Ltd');
  assert.equal(market.owner.name, 'ACME Ltd');
  const brand = fs.readFileSync(path.join(dir, 'scripts/lib/brand.mjs'), 'utf8');
  assert.match(brand, /REPO_URL = "https:\/\/github\.com\/acme-tools\/guardrails"/);
  assert.match(brand, /SITE_URL = "https:\/\/acme-tools\.github\.io\/guardrails\/"/);
  assert.match(brand, /STORE_URL = "https:\/\/acme-tools\.github\.io\/guardrails\/#pricing"/);
  assert.match(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), /^Copyright \(c\) \d{4} ACME Ltd\./);
  // nothing still points at the previous owner
  const leftovers = spawnSync('grep', ['-rIl', `github.com/${owner}/${name}\\|${owner}.github.io/${name}`, '.', '--exclude-dir=.git'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  assert.equal(leftovers, '', `files still mention ${owner}/${name}:\n${leftovers}`);
  const again = spawnSync(process.execPath, ['tools/configure-publisher.mjs', '--github', 'acme-tools/guardrails'], { cwd: dir, encoding: 'utf8' });
  assert.match(again.stdout, /Nothing to change|Updated/);
});

test('bump-version updates plugin.json, package.json and the changelog together', async () => {
  const { bump, nextVersion } = await import('../tools/bump-version.mjs');
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.3', '4.0.1'), '4.0.1');
  assert.throws(() => nextVersion('1.2.3', 'huge'), /Unknown bump/);
  const dir = copyProject();
  const before = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')).version;
  const next = bump(dir, 'patch', 'Connected the production store.', '2026-10-10');
  assert.equal(next, nextVersion(before, 'patch'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin/plugin.json'), 'utf8')).version, next);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, next);
  const log = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  assert.ok(log.indexOf(`## ${next} (2026-10-10)`) < log.indexOf(`## ${before}`), 'newest section first');
  assert.match(log, /- Connected the production store\./);
  bump(dir, next, 'again');
  assert.equal(log.split(`## ${next}`).length, fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8').split(`## ${next}`).length, 'no duplicate section');
});
