// Store (Polar) license keys end to end: the CLI and hooks against a local stand-in for Polar's
// public customer-portal license-key API.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitRepo, isolatedEnv, runCliAsync, runHookAsync, startMockPolar } from './helpers.mjs';
import { parseKey, maskKey, planFor, normalizeStore } from '../scripts/lib/store.mjs';
import { evaluateStoreState, refreshDue, GRACE_DAYS } from '../scripts/lib/license.mjs';

const DAY = 86400e3;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

const ORG = '00000000-0000-4000-8000-000000000001';
const STORE = {
  provider: 'polar', environment: 'production', organizationId: ORG, organizationSlug: 'veridone',
  portalUrl: 'https://polar.sh/veridone/portal', keyPrefixes: { 'VERIDONE-PRO': 'pro', 'VERIDONE-TEAM': 'team' },
  benefits: { 'benefit-pro': { plan: 'pro' }, 'benefit-team': { plan: 'team' } }, products: {},
};

let polar;
before(async () => { polar = await startMockPolar({ organizationId: ORG, store: STORE }); });
after(() => polar.close());

/** A project plus an isolated machine (HOME) whose plugin build has no store yet and fetches the published one. */
async function machine(extra = {}) {
  const repo = gitRepo({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}\n', 'src/a.js': 'export const a = 1;\n' });
  const iso = isolatedEnv({ VERIDONE_POLAR_API: polar.base, VERIDONE_STORE_URL: `${polar.base}/store.json`, ...extra });
  const cli = (...args) => runCliAsync(args, { cwd: repo, env: iso.env });
  const stateFile = path.join(iso.home, '.claude', 'veridone-license.json');
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const patchState = (patch) => fs.writeFileSync(stateFile, JSON.stringify({ ...readState(), ...patch }));
  return { repo, ...iso, cli, stateFile, readState, patchState };
}

describe('key parsing and plan mapping', () => {
  test('store keys, offline keys and junk are told apart', () => {
    const uuid = '1C285B2D-6CE6-4BC7-B8BE-ADB6A7E304DA';
    assert.deepEqual(parseKey(`VERIDONE-PRO-${uuid}`), { kind: 'polar', key: `VERIDONE-PRO-${uuid}`, prefix: 'VERIDONE-PRO' });
    assert.equal(parseKey(` veridone-team-${uuid.toLowerCase()} `).prefix, 'VERIDONE-TEAM');
    assert.equal(parseKey(uuid).kind, 'polar');
    assert.equal(parseKey(uuid).prefix, null);
    assert.equal(parseKey('VD1.abc.def').kind, 'offline');
    assert.equal(parseKey('hello').kind, null);
    assert.equal(parseKey(`VERIDONE-PRO-${uuid.slice(0, -1)}`).kind, null);
    assert.equal(maskKey(`VERIDONE-PRO-${uuid}`), 'VERIDONE-PRO-****-E304DA');
  });

  test('plan comes from the benefit, then the key prefix, then defaults to Pro', () => {
    const store = normalizeStore({ benefits: { b1: { plan: 'team' } } });
    const uuid = '1C285B2D-6CE6-4BC7-B8BE-ADB6A7E304DA';
    assert.equal(planFor(store, { benefitId: 'b1', key: `VERIDONE-PRO-${uuid}` }), 'team');
    assert.equal(planFor(store, { benefitId: 'other', key: `VERIDONE-TEAM-${uuid}` }), 'team');
    assert.equal(planFor(store, { benefitId: 'other', key: uuid }), 'pro');
  });

  test('grace period and refresh schedule', () => {
    const base = { kind: 'polar', key: 'k', plan: 'pro', status: 'granted' };
    assert.equal(evaluateStoreState({ ...base, validatedAt: ago(1) }).valid, true);
    assert.equal(evaluateStoreState({ ...base, validatedAt: ago(GRACE_DAYS - 1) }).valid, true);
    const stale = evaluateStoreState({ ...base, validatedAt: ago(GRACE_DAYS + 1) });
    assert.equal(stale.valid, false);
    assert.match(stale.reason, /not verified for 15 days/);
    assert.equal(evaluateStoreState({ ...base, validatedAt: ago(0), status: 'inactive', statusReason: 'refunded' }).reason, 'refunded');
    assert.equal(evaluateStoreState({ ...base, validatedAt: ago(0), expiresAt: ago(1) }).valid, false);
    assert.equal(refreshDue({ ...base, validatedAt: ago(1), checkedAt: ago(1) }), false);
    assert.equal(refreshDue({ ...base, validatedAt: ago(4), checkedAt: ago(1) }), true);
    assert.equal(refreshDue({ ...base, validatedAt: ago(4), checkedAt: new Date().toISOString() }), false, 'retries are spaced out');
    assert.equal(refreshDue({ kind: 'offline', key: 'VD1.a.b' }), false);
  });
});

describe('activation', () => {
  test('activate, check status, use a paid feature, re-activate, deactivate', async () => {
    const m = await machine();
    const key = polar.issue();
    const r = await m.cli('license', 'activate', key);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Activated Veridone Pro \(VERIDONE-PRO-\*{4}-[0-9A-F]{6}\) for buyer@example\.com/);
    assert.match(r.stdout, /up to 3 machines/);
    const [activation] = polar.activations(key);
    assert.match(activation.label, /^(Linux|macOS|Windows) · [0-9a-f]{8}$/);
    assert.equal(activation.meta.app, 'veridone');
    const st = m.readState();
    assert.equal(st.activationId, activation.id);
    assert.equal(st.plan, 'pro');
    if (process.platform !== 'win32') assert.equal(fs.statSync(m.stateFile).mode & 0o077, 0, 'the key file is private');

    const status = await m.cli('license', 'status');
    assert.match(status.stdout, /Plan: Pro · key VERIDONE-PRO-\*{4}-/);
    assert.match(status.stdout, /customer portal|polar\.sh\/veridone\/portal/);
    assert.ok(!status.stdout.includes(key), 'status never prints the whole key');
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'r.html'))).status, 0);

    const again = await m.cli('license', 'activate', key);
    assert.equal(again.status, 0);
    assert.equal(polar.activations(key).length, 1, 're-activating on the same machine reuses its slot');

    const off = await m.cli('license', 'deactivate');
    assert.match(off.stdout, /License removed from this machine/);
    assert.equal(polar.activations(key).length, 0, 'the slot is released on the server');
    assert.ok(!fs.existsSync(m.stateFile));
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'r2.html'))).status, 3);
  });

  test('a Team key unlocks Team features', async () => {
    const m = await machine();
    const key = polar.issue({ prefix: 'VERIDONE-TEAM', benefitId: 'benefit-team', member: { id: 'm1', email: 'dev@acme.io', external_id: null } });
    const r = await m.cli('license', 'activate', key);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Activated Veridone Team .* for dev@acme\.io/);
    assert.equal(m.readState().plan, 'team');
  });

  test('activation problems are explained', async () => {
    const m = await machine();
    const missing = await m.cli('license', 'activate', 'VERIDONE-PRO-00000000-0000-4000-8000-000000000000');
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /License key not found/);

    const junk = await m.cli('license', 'activate', 'not-a-key');
    assert.match(junk.stderr, /does not look like a Veridone license key/);

    const single = polar.issue({ limit: 1 });
    assert.equal((await m.cli('license', 'activate', single)).status, 0);
    const other = await machine();
    const full = await other.cli('license', 'activate', single);
    assert.equal(full.status, 1);
    assert.match(full.stderr, /maximum number of machines/);
    assert.match(full.stderr, /polar\.sh\/veridone\/portal/);

    const revoked = polar.issue();
    polar.setStatus(revoked, 'revoked');
    assert.match((await other.cli('license', 'activate', revoked)).stderr, /refused this key: License key is no longer active/);

    const down = await machine({ VERIDONE_POLAR_API: 'http://127.0.0.1:9' });
    const offline = await down.cli('license', 'activate', polar.issue());
    assert.equal(offline.status, 1);
    assert.match(offline.stderr, /Couldn't reach the license server/);
  });

  test('keys without activations are validated instead', async () => {
    const m = await machine();
    const key = polar.issue({ limit: null });
    const r = await m.cli('license', 'activate', key);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(m.readState().activationId, null);
    assert.doesNotMatch(r.stdout, /registered as/);
  });

  test('without a connected store, activation says so', async () => {
    const lonely = await startMockPolar();
    try {
      const repo = gitRepo();
      const { env } = isolatedEnv({ VERIDONE_POLAR_API: lonely.base, VERIDONE_STORE_URL: `${lonely.base}/store.json` });
      const r = await runCliAsync(['license', 'activate', 'VERIDONE-PRO-1C285B2D-6CE6-4BC7-B8BE-ADB6A7E304DA'], { cwd: repo, env });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /not connected to a store yet/);
    } finally { await lonely.close(); }
  });
});

describe('re-checks', () => {
  test('a revoked or refunded license turns paid features off', async () => {
    const m = await machine();
    const key = polar.issue();
    await m.cli('license', 'activate', key);
    polar.setStatus(key, 'revoked');
    const r = await m.cli('license', 'refresh');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no longer active/);
    assert.match((await m.cli('license', 'status')).stdout, /Plan: free — the license on this machine is not active/);
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'r.html'))).status, 3);
    polar.setStatus(key, 'granted');
    assert.equal((await m.cli('license', 'refresh')).status, 0, 'a renewed subscription works again');
    assert.equal(m.readState().status, 'granted');
  });

  test('a machine removed in the customer portal stops being licensed', async () => {
    const m = await machine();
    const key = polar.issue();
    await m.cli('license', 'activate', key);
    polar.removeActivations(key);
    assert.equal((await m.cli('license', 'refresh')).status, 1);
    assert.equal(m.readState().status, 'inactive');
  });

  test('network trouble keeps the license during the grace period only', async () => {
    const m = await machine();
    const key = polar.issue();
    await m.cli('license', 'activate', key);
    polar.failNext(503);
    m.patchState({ validatedAt: ago(5), checkedAt: ago(1) });
    const r = await m.cli('license', 'refresh');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /having problems \(HTTP 503\)/);
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'a.html'))).status, 0, 'still licensed within the grace period');

    const cut = await machine({ VERIDONE_POLAR_API: 'http://127.0.0.1:9' });
    fs.mkdirSync(path.dirname(cut.stateFile), { recursive: true });
    fs.writeFileSync(cut.stateFile, JSON.stringify({ ...m.readState(), validatedAt: ago(GRACE_DAYS + 1), checkedAt: ago(1) }));
    const s = await cut.cli('license', 'status');
    assert.match(s.stdout, /not verified for 15 days/);
  });

  test('status re-checks a stale activation before answering', async () => {
    const m = await machine();
    const key = polar.issue();
    await m.cli('license', 'activate', key);
    m.patchState({ validatedAt: ago(20), checkedAt: ago(1) });
    const s = await m.cli('license', 'status');
    assert.match(s.stdout, /Plan: Pro/);
    assert.ok(Date.now() - Date.parse(m.readState().validatedAt) < 60e3);
  });
});

describe('CI keys', () => {
  test('VERIDONE_LICENSE_KEY is validated without using an activation slot', async () => {
    const key = polar.issue({ limit: 1 });
    const m = await machine({ VERIDONE_LICENSE_KEY: key });
    fs.writeFileSync(path.join(m.repo, 'src/a.js'), 'export const a = 2;\n');
    const r = await m.cli('scan', '--format', 'sarif');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).version, '2.1.0');
    assert.equal(polar.activations(key).length, 0);
    const v = polar.requests.filter((q) => q.url.endsWith('/validate') && q.body.key === key);
    assert.equal(v.length, 1);
    assert.equal(v[0].body.activation_id, undefined);
    // cached for the next commands in the same job
    assert.equal((await m.cli('scan', '--format', 'sarif')).status, 0);
    assert.equal(polar.requests.filter((q) => q.url.endsWith('/validate') && q.body.key === key).length, 1);
  });

  test('an inactive CI key explains itself', async () => {
    const key = polar.issue();
    polar.setStatus(key, 'revoked');
    const m = await machine({ VERIDONE_LICENSE_KEY: key });
    const r = await m.cli('scan', '--format', 'sarif');
    assert.equal(r.status, 3);
    assert.match(r.stderr, /needs Veridone Pro/);
    assert.match(r.stderr, /no longer active/);
  });
});

describe('trial', () => {
  test('one free trial per machine, then paid features pause', async () => {
    const m = await machine();
    const t = await m.cli('license', 'trial');
    assert.match(t.stdout, /Trial started: every paid feature is unlocked on this machine until \d{4}-\d{2}-\d{2} \(14 days, no card needed\)/);
    assert.match((await m.cli('license', 'status')).stdout, /Plan: Team \(free trial\) · ends .* \(14 days left\)/);
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'r.html'))).status, 0);
    assert.match((await m.cli('license', 'trial')).stdout, /already running/);
    const tf = path.join(m.home, '.claude', 'veridone-trial.json');
    fs.writeFileSync(tf, JSON.stringify({ ...JSON.parse(fs.readFileSync(tf, 'utf8')), endsAt: ago(1) }));
    const s = await m.cli('license', 'status');
    assert.match(s.stdout, /Plan: free\./);
    assert.match(s.stdout, /free trial ended on/);
    assert.equal((await m.cli('report', '--html', path.join(m.home, 'r2.html'))).status, 3);
    assert.match((await m.cli('license', 'trial')).stdout, /ended on/);
  });

  test('a paid license makes the trial unnecessary', async () => {
    const m = await machine();
    await m.cli('license', 'activate', polar.issue());
    assert.match((await m.cli('license', 'trial')).stdout, /already have Veridone Pro/);
  });
});

describe('session start upkeep', () => {
  async function waitFor(fn, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  }

  test('a due re-check runs in the background without delaying the session', async () => {
    const m = await machine();
    await m.cli('license', 'activate', polar.issue());
    m.patchState({ validatedAt: ago(4), checkedAt: ago(1) });
    const t0 = Date.now();
    const h = await runHookAsync('SessionStart', { hook_event_name: 'SessionStart', session_id: 's-bg', cwd: m.repo, source: 'startup' }, m.env);
    assert.equal(h.status, 0);
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(await waitFor(() => Date.now() - Date.parse(m.readState().validatedAt) < 60e3), 'background refresh updated the activation');
  });

  test('an ended license is announced to the user once', async () => {
    const m = await machine();
    const key = polar.issue();
    await m.cli('license', 'activate', key);
    polar.setStatus(key, 'revoked');
    await m.cli('license', 'refresh');
    const start = (id) => runHookAsync('SessionStart', { hook_event_name: 'SessionStart', session_id: id, cwd: m.repo, source: 'startup' }, m.env);
    const first = await start('s1');
    assert.match(first.json.systemMessage, /Veridone: your Pro license is inactive — no longer active/);
    assert.match(first.json.systemMessage, /free guardrails keep working/);
    assert.ok(first.json.hookSpecificOutput.additionalContext, 'the normal session context is still provided');
    const second = await start('s2');
    assert.equal(second.json.systemMessage, undefined);
  });

  test('the trial end is announced ahead of time and when it happens', async () => {
    const m = await machine();
    await m.cli('license', 'trial');
    const tf = path.join(m.home, '.claude', 'veridone-trial.json');
    const set = (endsAt) => fs.writeFileSync(tf, JSON.stringify({ ...JSON.parse(fs.readFileSync(tf, 'utf8')), endsAt }));
    const start = (id) => runHookAsync('SessionStart', { hook_event_name: 'SessionStart', session_id: id, cwd: m.repo, source: 'startup' }, m.env);
    set(new Date(Date.now() + 1.5 * DAY).toISOString());
    assert.match((await start('t1')).json.systemMessage, /trial ends in 2 day/);
    assert.equal((await start('t2')).json.systemMessage, undefined);
    set(ago(0.1));
    assert.match((await start('t3')).json.systemMessage, /14-day trial has ended/);
    assert.equal((await start('t4')).json.systemMessage, undefined);
  });
});
