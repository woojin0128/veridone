// Shared helpers for Veridone's test suite (node --test, zero dependencies).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPTS = path.join(ROOT, 'scripts');

/** A fresh temporary directory, removed when the process exits. */
export function tmpDir(prefix = 'veridone-test-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

/** Write a tree of files: { 'src/a.js': 'content', ... }. */
export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A git repository with an initial commit of `files`. */
export function gitRepo(files = { 'README.md': '# test\n' }, { commit = true } = {}) {
  const dir = tmpDir('veridone-repo-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeTree(dir, files);
  if (commit) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'initial');
  }
  return dir;
}

/** Environment isolating Veridone's data directory, user config and license from the real machine. */
export function isolatedEnv(extra = {}) {
  const home = tmpDir('veridone-home-');
  const data = path.join(home, 'data');
  fs.mkdirSync(data, { recursive: true });
  // Tests never reach the real license server: point the store and API at a closed local port
  // unless a test passes its own mock server.
  const env = { ...process.env, HOME: home, USERPROFILE: home, VERIDONE_DATA_DIR: data, VERIDONE_POLAR_API: 'http://127.0.0.1:9', VERIDONE_STORE_URL: 'http://127.0.0.1:9/store.json', ...extra };
  // the suite itself runs in CI: don't let the runner's CI variables change what the CLI does
  for (const k of ['CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR', 'VERIDONE_MODE', 'VERIDONE_DISABLE', 'VERIDONE_LICENSE_KEY', 'VERIDONE_POLICY_FILE', 'CLAUDE_PLUGIN_ROOT', 'VERIDONE_STORE_FILE', 'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI']) {
    if (!(k in extra)) delete env[k];
  }
  return { env, home, data };
}

/** Run the CLI without blocking the event loop (needed when the test process also serves HTTP). */
export function runCliAsync(args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'veridone.mjs'), ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

/** Run a hook without blocking the event loop. */
export function runHookAsync(event, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS, 'hook.mjs'), event], { env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => {
      const out = stdout.trim();
      let json = null;
      if (out) { try { json = JSON.parse(out); } catch { json = { unparsed: out }; } }
      resolve({ status, stdout: out, json });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/**
 * A stand-in for Polar's public customer-portal license-key API (activate / validate / deactivate),
 * following the behavior of polar/license_key/service.py. Also serves /store.json.
 */
export async function startMockPolar({ organizationId = '00000000-0000-4000-8000-000000000001', store = null } = {}) {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const keys = new Map();
  const requests = [];
  let failures = [];
  const now = () => new Date().toISOString();
  const keyView = (k, activation) => ({
    id: k.id, created_at: k.created_at, modified_at: null, organization_id: organizationId, customer_id: k.customer.id,
    customer: k.customer, member_id: k.member ? k.member.id : null, member: k.member, benefit_id: k.benefit_id,
    key: k.key, display_key: `****-${k.key.slice(-6)}`, status: k.status, limit_activations: k.limit_activations,
    usage: 0, limit_usage: null, validations: k.validations, last_validated_at: k.last_validated_at, expires_at: k.expires_at,
    ...(activation !== undefined ? { activation } : {}),
  });
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      requests.push({ method: req.method, url: req.url, body });
      if (req.url === '/store.json') return store ? send(res, 200, store) : send(res, 404, { detail: 'Not Found' });
      if (failures.length) {
        const f = failures.shift();
        if (typeof f === 'number') return send(res, f, { detail: 'upstream error' });
        res.writeHead(f.status, { 'content-type': f.type || 'text/html' });
        return res.end(f.raw ?? JSON.stringify(f.body));
      }
      const m = /^\/v1\/customer-portal\/license-keys\/(activate|validate|deactivate)$/.exec(req.url || '');
      if (!m || req.method !== 'POST') return send(res, 404, { detail: 'Not Found' });
      if (typeof body.key !== 'string' || typeof body.organization_id !== 'string') return send(res, 422, { detail: [{ loc: ['body', 'key'], msg: 'Field required', type: 'missing' }] });
      const k = keys.get(body.key);
      const notFound = (detail) => send(res, 404, { error: 'ResourceNotFound', detail: detail || 'Not found' });
      if (!k || body.organization_id !== organizationId) return notFound();
      const active = k.status === 'granted';
      const expired = k.expires_at && Date.now() >= Date.parse(k.expires_at);
      if (m[1] === 'activate') {
        if (!active) return send(res, 403, { error: 'NotPermitted', detail: 'License key is no longer active. This license key can not be activated.' });
        if (expired) return send(res, 403, { error: 'NotPermitted', detail: 'License key has expired.' });
        if (!k.limit_activations) return send(res, 403, { error: 'NotPermitted', detail: 'This license key does not support activations. Use the /validate endpoint instead to check license validity.' });
        if (k.activations.size >= k.limit_activations) return send(res, 403, { error: 'NotPermitted', detail: 'License key activation limit already reached' });
        const a = { id: crypto.randomUUID(), license_key_id: k.id, label: body.label, meta: body.meta || {}, created_at: now(), modified_at: null };
        k.activations.set(a.id, a);
        return send(res, 200, { ...a, license_key: keyView(k) });
      }
      if (m[1] === 'validate') {
        if (!active) return notFound('License key is no longer active.');
        if (expired) return notFound('License key has expired.');
        let activation = null;
        if (body.activation_id) {
          activation = k.activations.get(body.activation_id);
          if (!activation) return notFound();
        }
        k.validations++;
        k.last_validated_at = now();
        return send(res, 200, keyView(k, activation));
      }
      if (!k.activations.has(body.activation_id)) return notFound();
      k.activations.delete(body.activation_id);
      return send(res, 204);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    organizationId,
    requests,
    /** Issue a key as Polar would for a license-key benefit. */
    issue({ prefix = 'VERIDONE-PRO', benefitId = 'benefit-pro', limit = 3, email = 'buyer@example.com', expiresAt = null, member = null } = {}) {
      const key = `${prefix}-${crypto.randomUUID().toUpperCase()}`;
      keys.set(key, { id: crypto.randomUUID(), key, benefit_id: benefitId, status: 'granted', limit_activations: limit, activations: new Map(), expires_at: expiresAt, created_at: now(), validations: 0, last_validated_at: null, customer: { id: crypto.randomUUID(), email, name: null }, member });
      return key;
    },
    setStatus(key, status) { keys.get(key).status = status; },
    activations(key) { return [...keys.get(key).activations.values()]; },
    removeActivations(key) { keys.get(key).activations.clear(); },
    /** Fail the next requests: a status code, or {status, raw|body, type} for proxy pages. */
    failNext(...statuses) { failures = failures.concat(statuses); },
    /** Rotate a key the way the customer portal does: new key string, same activations. */
    rotate(key) {
      const k = keys.get(key);
      const next = `${key.slice(0, key.length - 36)}${crypto.randomUUID().toUpperCase()}`;
      keys.delete(key);
      k.key = next;
      keys.set(next, k);
      return next;
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}

/** Run a hook event the way Claude Code does: JSON on stdin, JSON (or nothing) on stdout. */
export function runHook(event, input, env) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook.mjs'), event], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
    timeout: 30000,
  });
  const out = (r.stdout || '').trim();
  let json = null;
  if (out) { try { json = JSON.parse(out); } catch { json = { unparsed: out }; } }
  return { status: r.status, stdout: out, stderr: r.stderr || '', json };
}

/** Run the CLI. */
export function runCli(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, 'veridone.mjs'), ...args], { cwd, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Minimal effective config for unit tests. */
export async function config(mode = 'standard', patch = {}) {
  const { DEFAULT_CONFIG, deepMerge } = await import('../scripts/lib/config.mjs');
  return deepMerge({ ...structuredClone(DEFAULT_CONFIG), mode }, patch);
}

/** Build an edit object (as the PostToolUse hook does) from before/after file contents. */
export async function editOf(relPath, before, after, tool = 'Edit') {
  const { diffLines } = await import('../scripts/lib/diff.mjs');
  const d = before == null
    ? { added: after.split('\n').map((text, i) => ({ line: i + 1, text })), removed: [] }
    : diffLines(before, after);
  return { path: relPath, added: d.added, removed: d.removed, oldContent: before, newContent: after, tool: before == null ? 'Write-new' : tool };
}
