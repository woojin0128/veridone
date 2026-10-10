// Veridone — license entitlement (zero dependencies, no network in this module).
//
// Three ways to unlock the paid features:
//   - Store keys (VERIDONE-PRO-<uuid>, VERIDONE-TEAM-<uuid>) bought through Polar. They are activated
//     online once with `veridone license activate`, then re-checked in the background every few days;
//     when the store can't be reached the license keeps working for a GRACE_DAYS grace period.
//     Network code lives in license-online.mjs so hooks never load it.
//   - Offline keys (VD1.<base64url payload>.<base64url signature>) signed with the vendor's Ed25519
//     key, for invoiced or air-gapped customers. Verified locally, no network at all.
//   - A one-time TRIAL_DAYS trial of every paid feature, recorded on this machine.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { homeDir, dataDir, pluginRoot, readJsonFile, writeFileAtomic, shortHash } from './util.mjs';
import { LICENSE_PUBLIC_KEY_PEM } from './license-key.mjs';
import { STORE_URL } from './brand.mjs';
import { parseKey } from './store.mjs';

export const PLANS = { free: 0, pro: 1, team: 2, enterprise: 3 };

export const FEATURES = {
  'custom-rules': 'pro',
  'report-html': 'pro',
  'scan-sarif': 'pro',
  'org-policy': 'team',
  'policy-lock': 'team',
};

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 14;
export const REFRESH_DAYS = 3;
const RETRY_HOURS = 6;
const CI_CACHE_HOURS = 24;
const DAY = 86400e3;

const PREFIX = 'VD1';

// --- files ------------------------------------------------------------------------

export function licenseStateFile() { return path.join(homeDir(), '.claude', 'veridone-license.json'); }
/** Older releases stored a bare offline key here; still honored. */
export function licenseFile() { return path.join(homeDir(), '.claude', 'veridone-license.key'); }
export function trialFile() { return path.join(homeDir(), '.claude', 'veridone-trial.json'); }
function ciCacheFile() { return path.join(dataDir(), 'license-ci.json'); }

export function readState() {
  const s = readJsonFile(licenseStateFile(), null);
  return s && typeof s === 'object' && s.key ? s : null;
}

export function writeState(state) {
  writeFileAtomic(licenseStateFile(), JSON.stringify(state, null, 2) + '\n');
  try { fs.chmodSync(licenseStateFile(), 0o600); } catch { /* best effort (Windows) */ }
  cached = null;
}

export function clearState() {
  let removed = false;
  for (const f of [licenseStateFile(), licenseFile()]) {
    try { fs.unlinkSync(f); removed = true; } catch { /* nothing to remove: the file is already absent */ }
  }
  cached = null;
  return removed;
}

export function readTrial() {
  const t = readJsonFile(trialFile(), null);
  return t && t.startedAt && t.endsAt ? t : null;
}

/** Start the one-time trial. Returns { started, trial } (started=false when a trial already exists). */
export function startTrial(now = Date.now()) {
  const existing = readTrial();
  if (existing) return { started: false, trial: existing };
  const trial = { startedAt: new Date(now).toISOString(), endsAt: new Date(now + TRIAL_DAYS * DAY).toISOString(), plan: 'team' };
  writeFileAtomic(trialFile(), JSON.stringify(trial, null, 2) + '\n');
  cached = null;
  return { started: true, trial };
}

function patchTrial(patch) {
  const t = readTrial();
  if (!t) return;
  try { writeFileAtomic(trialFile(), JSON.stringify({ ...t, ...patch }, null, 2) + '\n'); } catch { /* a notice may repeat once; harmless */ }
}

// --- CI cache for store keys given through VERIDONE_LICENSE_KEY --------------------

export function readCiCache(key) {
  const all = readJsonFile(ciCacheFile(), {}) || {};
  return all[shortHash(key, 16)] || null;
}

export function writeCiCache(key, entry) {
  const all = readJsonFile(ciCacheFile(), {}) || {};
  all[shortHash(key, 16)] = entry;
  try { writeFileAtomic(ciCacheFile(), JSON.stringify(all) + '\n'); } catch { /* cache is optional: the next run validates again */ }
  cached = null;
}

// --- offline keys -------------------------------------------------------------------

function b64urlDecode(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Locate a key given through the environment or the legacy key file (store activations use readState). */
export function findLicenseKey() {
  const env = process.env.VERIDONE_LICENSE_KEY;
  if (env && env.trim()) return { key: env.trim(), source: 'env:VERIDONE_LICENSE_KEY' };
  try {
    const k = fs.readFileSync(licenseFile(), 'utf8').trim();
    if (k) return { key: k, source: licenseFile() };
  } catch { /* none */ }
  return null;
}

/**
 * Verify an offline (VD1) key.
 * @returns {{valid:boolean, reason?:string, payload?:any}}
 */
export function verifyLicense(key, publicKeyPem = LICENSE_PUBLIC_KEY_PEM, now = Date.now()) {
  if (!key) return { valid: false, reason: 'no license key' };
  const parts = String(key).trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { valid: false, reason: 'malformed license key' };
  if (!publicKeyPem || /PLACEHOLDER/.test(publicKeyPem)) return { valid: false, reason: 'this build cannot verify offline keys (no vendor public key; run tools/license-admin.mjs init)' };
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
  } catch {
    return { valid: false, reason: 'unreadable license payload' };
  }
  let ok = false;
  try {
    const pub = crypto.createPublicKey(publicKeyPem);
    ok = crypto.verify(null, Buffer.from(`${PREFIX}.${parts[1]}`), pub, b64urlDecode(parts[2]));
  } catch (e) {
    return { valid: false, reason: `signature check failed: ${e.message}` };
  }
  if (!ok) return { valid: false, reason: 'invalid signature' };
  if (payload.v !== 1) return { valid: false, reason: 'unsupported license version' };
  if (!PLANS[payload.plan]) return { valid: false, reason: 'unknown plan' };
  if (payload.exp && now > Date.parse(payload.exp)) return { valid: false, reason: `expired on ${payload.exp}`, payload };
  return { valid: true, payload };
}

/** Sign a payload with a private key (vendor side; used by tools/license-admin.mjs and tests). */
export function signLicense(payload, privateKeyPem) {
  const body = b64urlEncode(Buffer.from(JSON.stringify({ v: 1, ...payload })));
  const sig = crypto.sign(null, Buffer.from(`${PREFIX}.${body}`), crypto.createPrivateKey(privateKeyPem));
  return `${PREFIX}.${body}.${b64urlEncode(sig)}`;
}

function offlineEntitlement(key, source, now) {
  const r = verifyLicense(key, LICENSE_PUBLIC_KEY_PEM, now);
  if (!r.valid) return { plan: 'free', valid: false, kind: 'offline', source, reason: r.reason };
  const p = r.payload;
  return { plan: p.plan, valid: true, kind: 'offline', source, email: p.email || null, org: p.org || null, seats: p.seats || 1, expiresAt: p.exp || null, payload: p };
}

// --- store keys -----------------------------------------------------------------------

/** Judge a stored store-key activation without touching the network. */
export function evaluateStoreState(st, now = Date.now()) {
  const base = { kind: 'polar', source: licenseStateFile(), email: st.email || null, key: st.key, expiresAt: st.expiresAt || null, seats: 1, state: st };
  if (st.status && st.status !== 'granted') return { ...base, plan: 'free', valid: false, reason: st.statusReason || 'the license is no longer active' };
  if (st.expiresAt && now > Date.parse(st.expiresAt)) return { ...base, plan: 'free', valid: false, reason: `expired on ${String(st.expiresAt).slice(0, 10)}` };
  const age = now - (Date.parse(st.validatedAt) || 0);
  if (age > GRACE_DAYS * DAY) return { ...base, plan: 'free', valid: false, reason: `not verified for ${Math.floor(age / DAY)} days (the license server couldn't be reached); run \`/veridone:license refresh\`` };
  return { ...base, plan: st.plan || 'pro', valid: true };
}

/** A background re-check is due (store keys only; never more than every RETRY_HOURS). */
export function refreshDue(st, now = Date.now()) {
  if (!st || st.kind !== 'polar') return false;
  if (now - (Date.parse(st.checkedAt) || 0) < RETRY_HOURS * 3600e3) return false;
  return now - (Date.parse(st.validatedAt) || 0) > REFRESH_DAYS * DAY || (st.status && st.status !== 'granted');
}

/**
 * Re-check the activation in a detached process so hooks never wait on the network.
 * Returns true when a refresh was started.
 */
export function maybeRefreshInBackground(now = Date.now(), { spawnImpl = spawn } = {}) {
  const st = readState();
  if (!refreshDue(st, now)) return false;
  try {
    writeState({ ...st, checkedAt: new Date(now).toISOString() });
    const child = spawnImpl(process.execPath, [path.join(pluginRoot(), 'scripts', 'veridone.mjs'), 'license', 'refresh', '--quiet'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

// --- entitlement ------------------------------------------------------------------------

let cached = null;

/** Current entitlement (cached per process). Never touches the network. */
export function entitlement(now = Date.now()) {
  if (cached) return cached;
  let found = null;
  const env = process.env.VERIDONE_LICENSE_KEY && process.env.VERIDONE_LICENSE_KEY.trim();
  if (env) {
    const p = parseKey(env);
    if (p.kind === 'offline') found = offlineEntitlement(env, 'env:VERIDONE_LICENSE_KEY', now);
    else if (p.kind === 'polar') {
      const c = readCiCache(env);
      const fresh = c && now - (Date.parse(c.validatedAt) || 0) < CI_CACHE_HOURS * 3600e3;
      found = fresh && c.ok
        ? { plan: c.plan || 'pro', valid: true, kind: 'polar', source: 'env:VERIDONE_LICENSE_KEY', email: c.email || null, expiresAt: c.expiresAt || null, seats: 1, key: env }
        : { plan: 'free', valid: false, kind: 'polar', source: 'env:VERIDONE_LICENSE_KEY', key: env, pendingOnline: !fresh, reason: fresh ? (c.reason || 'the license is not active') : 'not validated with the store yet' };
    } else found = { plan: 'free', valid: false, kind: null, source: 'env:VERIDONE_LICENSE_KEY', reason: 'malformed license key' };
  }
  if (!found || !found.valid) {
    const st = readState();
    if (st) {
      const e = st.kind === 'offline' ? offlineEntitlement(st.key, licenseStateFile(), now) : evaluateStoreState(st, now);
      if (e.valid || !found) found = e;
    }
  }
  if (!found || !found.valid) {
    try {
      const k = fs.readFileSync(licenseFile(), 'utf8').trim();
      if (k) { const e = offlineEntitlement(k, licenseFile(), now); if (e.valid || !found) found = e; }
    } catch { /* no legacy key file on this machine */ }
  }
  if (!found || !found.valid) {
    const t = readTrial();
    if (t && now < Date.parse(t.endsAt)) {
      found = { plan: t.plan || 'team', valid: true, kind: 'trial', trial: true, source: trialFile(), expiresAt: t.endsAt, seats: 1, ...(found ? { ignoredKey: found } : {}) };
    } else if (!found) {
      found = { plan: 'free', valid: false, kind: null, source: null, reason: 'no license key', trialUsed: !!t, trialEndedAt: t ? t.endsAt : null };
    } else found = { ...found, trialUsed: !!t };
  }
  return (cached = found);
}

export function hasFeature(feature, ent = entitlement()) {
  const need = FEATURES[feature];
  if (!need) return true;
  return (PLANS[ent.plan] || 0) >= PLANS[need];
}

export function featureMessage(feature, ent = entitlement()) {
  const need = FEATURES[feature] || 'pro';
  const plan = `${need[0].toUpperCase()}${need.slice(1)}`;
  const trial = !ent?.trialUsed && ent?.kind !== 'trial' && !readTrial() ? ' Try every paid feature free for 14 days with `/veridone:license trial`.' : '';
  return `This feature needs Veridone ${plan}.${trial} Plans: ${STORE_URL} · Activate a key with \`/veridone:license activate <key>\`, or set VERIDONE_LICENSE_KEY in CI.`;
}

/**
 * One-time notices for the user (shown by the SessionStart hook): trial ending or ended,
 * license revoked/expired, or license unverifiable for the whole grace period.
 */
export function pendingNotice(now = Date.now()) {
  const st = readState();
  if (st && st.kind === 'polar') {
    const e = evaluateStoreState(st, now);
    if (!e.valid && st.noticeFor !== e.reason) {
      try { writeState({ ...st, noticeFor: e.reason }); } catch { /* the notice may repeat next session; harmless */ }
      return `Veridone: your ${st.plan === 'team' ? 'Team' : 'Pro'} license is inactive — ${e.reason}. The free guardrails keep working; paid features are paused.${st.portalUrl ? ` Manage it: ${st.portalUrl}` : ` Plans: ${STORE_URL}`}`;
    }
    if (e.valid) return null;
  }
  if (st && st.kind === 'offline') return null;
  const t = readTrial();
  if (!t) return null;
  const left = Date.parse(t.endsAt) - now;
  const hasPaid = entitlement(now).kind !== 'trial' && entitlement(now).valid;
  if (hasPaid) return null;
  if (left <= 0 && !t.endNoticeShown) {
    patchTrial({ endNoticeShown: true });
    return `Veridone: your ${TRIAL_DAYS}-day trial has ended. Team rules, the HTML report, SARIF and organization policy are paused; the free guardrails keep working. Keep them: ${STORE_URL}`;
  }
  if (left > 0 && left <= 2 * DAY && !t.soonNoticeShown) {
    patchTrial({ soonNoticeShown: true });
    return `Veridone: your trial ends in ${Math.max(1, Math.ceil(left / DAY))} day(s). Keep the paid features: ${STORE_URL}`;
  }
  return null;
}

export function _resetCache() { cached = null; }
