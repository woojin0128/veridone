#!/usr/bin/env node
// Point the plugin at YOUR GitHub repository, name and store before publishing.
//
//   node tools/configure-publisher.mjs --github your-name/veridone \
//        --author "Your Name or Company" [--email you@example.com] \
//        [--site https://your-name.github.io/veridone/] [--store https://…/#pricing]
//
// Rewrites every repository and website URL (plugin.json, marketplace.json, README, docs, site,
// the GitHub Action usage, the config schema URL), the author/owner, the LICENSE copyright holder,
// and the purchase/support links shown to users. Safe to run again with new values.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXT = /\.(md|mjs|js|json|ya?ml|txt|sh|html|css|toml|svg|xml)$|^LICENSE$|^CNAME$/;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'results', '_site']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    args[k] = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
  }
  return args;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

const args = parseArgs(process.argv.slice(2));
if (!Object.keys(args).length || args.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const pluginPath = path.join(ROOT, '.claude-plugin', 'plugin.json');
const marketPath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const currentRepo = (/github\.com\/([^/#\s]+\/[^/#\s]+)/.exec(readJson(pluginPath).repository || '') || [])[1];
const changes = [];

if (typeof args.github === 'string') {
  const next = args.github.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(next)) { console.error(`--github must look like owner/repo, got "${args.github}"`); process.exit(2); }
  if (currentRepo && currentRepo !== next) {
    const [curOwner, curName] = currentRepo.split('/');
    const [nextOwner, nextName] = next.split('/');
    let n = 0;
    for (const f of walk(ROOT)) {
      if (f.endsWith(path.join('tools', 'configure-publisher.mjs'))) continue;
      const s = fs.readFileSync(f, 'utf8');
      const t = s
        .split(`github.com/${currentRepo}`).join(`github.com/${next}`)
        .split(`raw.githubusercontent.com/${currentRepo}/`).join(`raw.githubusercontent.com/${next}/`)
        .split(`uses: ${currentRepo}@`).join(`uses: ${next}@`)
        .split(`marketplace add ${currentRepo}`).join(`marketplace add ${next}`)
        .split(`--marketplace ${currentRepo}`).join(`--marketplace ${next}`)
        .split(`github.com/${curOwner})`).join(`github.com/${nextOwner})`)
        .split(`${curOwner.toLowerCase()}.github.io/${curName}`).join(`${nextOwner.toLowerCase()}.github.io/${nextName}`);
      if (t !== s) { fs.writeFileSync(f, t); n++; }
    }
    changes.push(`repository ${currentRepo} → ${next} (${n} files)`);
  }
}

// read the manifests only now: the rewrite above may have changed them on disk
const plugin = readJson(pluginPath);
const market = readJson(marketPath);
const author = typeof args.author === 'string' ? args.author.trim() : null;
const email = typeof args.email === 'string' ? args.email.trim() : null;
if (author || email) {
  plugin.author = { ...(plugin.author || {}), ...(author ? { name: author } : {}), ...(email ? { email } : {}) };
  market.owner = { ...(market.owner || {}), ...(author ? { name: author } : {}), ...(email ? { email } : {}) };
  changes.push(`author/owner → ${[author, email].filter(Boolean).join(' <')}${email && author ? '>' : ''}`);
}
if (author) {
  const lic = path.join(ROOT, 'LICENSE');
  const s = fs.readFileSync(lic, 'utf8');
  fs.writeFileSync(lic, s.replace(/^Copyright \(c\) (\d{4}) .*?\. All rights/m, `Copyright (c) $1 ${author.replace(/\$/g, '$$$$')}. All rights`));
  changes.push('LICENSE copyright holder');
}
writeJson(pluginPath, plugin);
writeJson(marketPath, market);

// brand constants shown in the CLI and skills
const brandPath = path.join(ROOT, 'scripts', 'lib', 'brand.mjs');
let brand = fs.readFileSync(brandPath, 'utf8');
const setConst = (name, value) => { brand = brand.replace(new RegExp(`export const ${name} = [^;]*;`), `export const ${name} = ${JSON.stringify(value)};`); };
const repoUrl = (/github\.com\/[^#\s"]+/.exec(readJson(pluginPath).repository || '') || [])[0];
if (repoUrl) setConst('REPO_URL', `https://${repoUrl}`);
const [owner, name] = repoUrl ? repoUrl.replace('github.com/', '').split('/') : [];
const site = typeof args.site === 'string' ? args.site.replace(/\/?$/, '/') : owner ? `https://${owner.toLowerCase()}.github.io/${name}/` : null;
if (site) {
  setConst('SITE_URL', site);
  if (typeof args.site === 'string') changes.push(`site → ${site}`);
  const pj = readJson(pluginPath);
  if (pj.homepage !== site) { pj.homepage = site; writeJson(pluginPath, pj); }
}
if (typeof args.store === 'string') { setConst('STORE_URL', args.store); changes.push(`store → ${args.store}`); }
else if (site && /STORE_URL = "[^"]*(#pricing|github\.io)[^"]*"/.test(brand)) setConst('STORE_URL', `${site}#pricing`);
if (email) setConst('SUPPORT_EMAIL', email);
fs.writeFileSync(brandPath, brand);

if (typeof args.store === 'string') {
  for (const f of ['README.md', 'README.ko.md'].map((x) => path.join(ROOT, x))) {
    if (!fs.existsSync(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    // purchase links are written as [text](url "store")
    const t = s.replace(/\]\([^\s)]+ "store"\)/g, `](${args.store} "store")`);
    if (t !== s) fs.writeFileSync(f, t);
  }
}

console.log(changes.length ? `Updated:\n- ${changes.join('\n- ')}` : 'Nothing to change.');
console.log('\nNext: run `claude plugin validate --strict .` and `node --test test/*.test.mjs`, then commit and push.');
