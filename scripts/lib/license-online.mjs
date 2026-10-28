// Veridone — the only module that talks to the network: activating, re-checking and releasing
// store license keys through Polar's public customer-portal license-key API. It is loaded by the
// CLI (`veridone license …` and paid CLI features), never by hooks.
//
// Requests carry the license key, the store's organization id and the activation id; activation
// also sends a label for the computer plus the Veridone version and OS name. A build that predates
// the store connection also downloads the published store.json. Nothing about your code is sent.

import crypto from 'node:crypto';
import { loadStore, normalizeStore, isConfigured, apiBase, remoteStoreUrl, parseKey, planFor, maskKey } from './store.mjs';
import {
  readState, writeState, clearState, verifyLicense, entitlement, _resetCache, readCiCache, writeCiCache, GRACE_DAYS,
} from './license.mjs';
import { STORE_URL } from './brand.mjs';
import { version } from './version.mjs';

const TIMEOUT_MS = 10000;
/** Pin Polar's API version so a future default can't change these endpoints under us. */
const POLAR_API_VERSION = '2026-10';
/** Back-off between attempts when the server can't be reached or is overloaded. */
const RETRY_DELAYS_MS = [400, 1200];

const PLATFORM = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function iso(now) { return new Date(now).toISOString(); }
function title(plan) { return `${plan[0].toUpperCase()}${plan.slice(1)}`; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url, body, { fetchImpl, timeoutMs }) {
  if (typeof fetchImpl !== 'function') return { status: 0, error: 'this Node.js has no fetch (Node 18+ required)' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'veridone', 'polar-version': POLAR_API_VERSION },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; /* not JSON: a proxy or firewall page, never Polar */ }
    return { status: res.status, json };
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code || e?.message || String(e));
    return { status: 0, error: reason };
  }
}

/** POST with retries for unreachable, rate-limited or failing servers. */
async function postJson(url, body, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await postOnce(url, body, { fetchImpl, timeoutMs });
    const retry = r.status === 0 || r.status === 429 || r.status >= 500;
    if (!retry || attempt >= RETRY_DELAYS_MS.length) return r;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

function detailOf(json) {
  if (!json || typeof json !== 'object') return '';
  if (typeof json.detail === 'string') return json.detail;
  if (Array.isArray(json.detail)) return json.detail.map((d) => d?.msg).filter(Boolean).join('; ');
  return '';
}

/** Polar's own error answers name the error ({error: "ResourceNotFound", detail}); proxies don't. */
const polarSays = (r, name) => !!(r.json && typeof r.json === 'object' && r.json.error === name);

/**
 * Is this a definite answer from Polar (as opposed to a network, proxy or server problem)?
 * Only definite answers may deactivate a license; everything else keeps the grace period.
 */
export function isDefinitive(r, phase = 'validate') {
  if (r.status === 404 && polarSays(r, 'ResourceNotFound')) return true;
  if (phase === 'activate' && r.status === 403 && polarSays(r, 'NotPermitted')) return true;
  return false;
}

function proxyHint() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    ? ' Node.js ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set (Node 22.21+ / 24+).'
    : '';
}

/** Human explanation of a failed license-server response. */
export function explainFailure(r, { phase = 'activate', portalUrl = null } = {}) {
  const detail = detailOf(r.json);
  if (r.status === 0) return `Couldn't reach the license server (${r.error}). Check your internet connection and try again.${proxyHint()}`;
  if (isDefinitive(r, phase) && r.status === 404) {
    if (phase === 'activate') {
      return !detail || /^not found\.?$/i.test(detail)
        ? 'License key not found. Check that you copied the whole key from your receipt or the customer portal.'
        : `This license key can't be used: ${detail.replace(/\.$/, '')}.`;
    }
    return `The license is no longer active${detail && !/^not found\.?$/i.test(detail) ? ` (${detail.replace(/\.$/, '')})` : ''}: the subscription may have ended or been revoked, or this computer was removed from the key in the customer portal.`;
  }
  if (isDefinitive(r, phase) && r.status === 403) {
    if (/limit/i.test(detail)) return `This key is already active on its maximum number of computers. Free one by running \`/veridone:license deactivate\` on a computer you no longer use${portalUrl ? `, or in the customer portal: ${portalUrl}` : ''}.`;
    return `The license server refused this key${detail ? `: ${detail.replace(/\.$/, '')}` : ''}.`;
  }
  if (r.status === 422 && detail) return `The license server rejected the request (${detail}). Check the key for typos.`;
  if (r.status === 429) return 'Too many requests to the license server. Try again in a minute.';
  if (r.status >= 500) return `The license server is having problems (HTTP ${r.status}). Try again later; an existing activation keeps working for ${GRACE_DAYS} days without a check.`;
  return `Unexpected answer from the license server (HTTP ${r.status}). A proxy or firewall may be blocking api.polar.sh.${proxyHint()}`;
}

/** The store to activate against: the bundled store.json, or the published one if this build predates it. */
export async function resolveStore({ fetchImpl = globalThis.fetch } = {}) {
  const local = loadStore();
  if (isConfigured(local)) return local;
  const url = remoteStoreUrl();
  if (!url || typeof fetchImpl !== 'function') return local;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
    if (res.ok) {
      const remote = normalizeStore(await res.json());
      if (isConfigured(remote)) return remote;
    }
  } catch { /* offline or not published yet: report "store not connected" below */ }
  return local;
}

/** A key from another product of the same Polar organization must not unlock Veridone. */
function wrongProduct(store, lk) {
  const known = Object.keys(store?.benefits || {});
  if (!known.length || !lk?.benefit_id || known.includes(lk.benefit_id)) return null;
  return { ok: false, message: 'This key belongs to a different product, not Veridone. Copy the Veridone key from your receipt or the customer portal.' };
}

function machineLabel(installId) {
  return `${PLATFORM[process.platform] || process.platform} · ${installId.slice(0, 8)}`;
}

/**
 * Activate a key on this computer. Store keys are activated online; offline (VD1) keys are verified
 * locally. Returns { ok, message, state? }.
 */
export async function activateKey(rawKey, { label = null, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const p = parseKey(rawKey);
  if (p.kind === 'offline') {
    const r = verifyLicense(p.key, undefined, now);
    if (!r.valid) return { ok: false, message: `License not activated: ${r.reason}.` };
    writeState({ kind: 'offline', key: p.key, activatedAt: iso(now) });
    return { ok: true, message: `Activated Veridone ${title(r.payload.plan)} for ${r.payload.email || r.payload.org || 'this computer'}${r.payload.exp ? ` (valid until ${r.payload.exp})` : ''}.` };
  }
  if (p.kind !== 'polar') {
    return { ok: false, message: 'That does not look like a Veridone license key. Store keys look like VERIDONE-PRO-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX; copy the whole key from your receipt or the customer portal.' };
  }
  const store = await resolveStore({ fetchImpl });
  if (!isConfigured(store)) {
    return { ok: false, message: `This copy of Veridone is not connected to a store yet. Update the plugin (\`claude plugin update veridone@veridone\`) and try again, or see ${STORE_URL}.` };
  }
  const previous = readState();
  const installId = previous?.installId || crypto.randomUUID();
  const lbl = String(label || machineLabel(installId)).slice(0, 100);
  const base = apiBase(store);
  const body = { key: p.key, organization_id: store.organizationId };
  const portalUrl = store.portalUrl;

  // 1. Reuse this computer's activation when the server still knows it, including after the key
  //    was rotated in the customer portal (Polar keeps activations across rotations).
  if (previous?.kind === 'polar' && previous.activationId && previous.organizationId === store.organizationId) {
    const v = await postJson(`${base}/v1/customer-portal/license-keys/validate`, { ...body, activation_id: previous.activationId }, { fetchImpl });
    if (v.status === 200 && v.json) return wrongProduct(store, v.json) || finish(v.json, previous.activationId, store, p.key, installId, previous.label || lbl, now);
  }

  // 2. Look the key up before taking an activation slot with it.
  const pre = await postJson(`${base}/v1/customer-portal/license-keys/validate`, body, { fetchImpl });
  if (pre.status !== 200 || !pre.json) return { ok: false, message: explainFailure(pre, { phase: 'activate', portalUrl }) };
  const bad = wrongProduct(store, pre.json);
  if (bad) return bad;

  // 3. Activate.
  const r = await postJson(`${base}/v1/customer-portal/license-keys/activate`, {
    ...body, label: lbl, meta: { app: 'veridone', version: version(), os: PLATFORM[process.platform] || process.platform },
  }, { fetchImpl });
  if (r.status === 200 && r.json?.id) return finish({ ...pre.json, ...(r.json.license_key || {}) }, r.json.id, store, p.key, installId, lbl, now);
  if (r.status === 403 && polarSays(r, 'NotPermitted') && /does not support activations/i.test(detailOf(r.json))) {
    return finish(pre.json, null, store, p.key, installId, lbl, now);
  }
  return { ok: false, message: explainFailure(r, { phase: 'activate', portalUrl }) };
}

function finish(lk, activationId, store, key, installId, label, now) {
  const plan = planFor(store, { benefitId: lk?.benefit_id, key });
  const state = {
    kind: 'polar',
    key,
    plan,
    email: lk?.member?.email || lk?.customer?.email || null,
    environment: store.environment,
    organizationId: store.organizationId,
    portalUrl: store.portalUrl || null,
    benefits: Object.keys(store.benefits || {}),
    licenseKeyId: lk?.id || null,
    benefitId: lk?.benefit_id || null,
    activationId,
    installId,
    label,
    limitActivations: lk?.limit_activations ?? null,
    expiresAt: lk?.expires_at || null,
    status: 'granted',
    activatedAt: iso(now),
    validatedAt: iso(now),
    checkedAt: iso(now),
  };
  writeState(state);
  _resetCache();
  const where = activationId ? ` This computer is registered as "${label}"${state.limitActivations ? ` (a key works on up to ${state.limitActivations} computers)` : ''}.` : '';
  return { ok: true, state, message: `Activated Veridone ${title(plan)} (${maskKey(key)})${state.email ? ` for ${state.email}` : ''}.${where}` };
}

/**
 * Re-check this computer's store activation. Network and proxy problems keep the current state
 * (grace period); only a definite answer from Polar marks it inactive.
 */
export async function refreshActivation({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const st = readState();
  if (!st || st.kind !== 'polar') return { ok: true, skipped: true, message: st ? 'Offline keys need no refresh.' : 'No store license is activated on this computer.' };
  const base = apiBase({ environment: st.environment });
  const r = await postJson(`${base}/v1/customer-portal/license-keys/validate`, {
    key: st.key, organization_id: st.organizationId, ...(st.activationId ? { activation_id: st.activationId } : {}),
  }, { fetchImpl });
  const next = { ...readState(), checkedAt: iso(now) };
  if (r.status === 200 && r.json) {
    const local = loadStore();
    const store = isConfigured(local) && local.organizationId === st.organizationId ? local : { keyPrefixes: local.keyPrefixes, benefits: {} };
    const known = Object.keys(store.benefits).length ? Object.keys(store.benefits) : (st.benefits || []);
    if (known.length && r.json.benefit_id && !known.includes(r.json.benefit_id)) {
      Object.assign(next, { status: 'inactive', statusCode: 'wrong-product', statusReason: 'the key belongs to a different product, not Veridone' });
      writeState(next);
      _resetCache();
      return { ok: false, state: next, message: 'This key belongs to a different product, not Veridone.' };
    }
    Object.assign(next, {
      status: 'granted',
      validatedAt: iso(now),
      expiresAt: r.json.expires_at || null,
      benefitId: r.json.benefit_id || next.benefitId,
      plan: (store.benefits[r.json.benefit_id] || !next.plan) ? planFor(store, { benefitId: r.json.benefit_id, key: st.key }) : next.plan,
      email: r.json.member?.email || r.json.customer?.email || next.email,
      limitActivations: r.json.limit_activations ?? next.limitActivations,
    });
    delete next.statusReason;
    delete next.statusCode;
    delete next.noticeFor;
    writeState(next);
    _resetCache();
    return { ok: true, state: next, message: `Veridone ${title(next.plan)} license is active (${maskKey(st.key)}).` };
  }
  if (isDefinitive(r, 'validate')) {
    const msg = explainFailure(r, { phase: 'validate', portalUrl: st.portalUrl });
    Object.assign(next, { status: 'inactive', statusCode: 'inactive', statusReason: msg.replace(/^The license is no longer active/, 'no longer active').replace(/\.$/, '') });
    writeState(next);
    _resetCache();
    return { ok: false, state: next, message: msg };
  }
  writeState(next);
  _resetCache();
  return { ok: false, transient: true, state: next, message: explainFailure(r, { phase: 'validate' }) };
}

/**
 * Validate a store key given through VERIDONE_LICENSE_KEY (CI, devcontainers). It never takes an
 * activation slot. The result is cached (and kept in memory) so later checks don't hit the network.
 */
export async function validateEnvKey(key, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const store = await resolveStore({ fetchImpl });
  const prev = readCiCache(key);
  if (!isConfigured(store)) {
    writeCiCache(key, { ...(prev || {}), checkedAt: iso(now) });
    return { ok: false, transient: true, message: 'This copy of Veridone is not connected to a store yet; update the plugin.' };
  }
  const r = await postJson(`${apiBase(store)}/v1/customer-portal/license-keys/validate`, { key, organization_id: store.organizationId }, { fetchImpl });
  if (r.status === 200 && r.json) {
    if (wrongProduct(store, r.json)) {
      writeCiCache(key, { ok: false, validatedAt: iso(now), checkedAt: iso(now), reason: 'the key belongs to a different product, not Veridone' });
      return { ok: false, message: 'This key belongs to a different product, not Veridone.' };
    }
    writeCiCache(key, { ok: true, validatedAt: iso(now), checkedAt: iso(now), plan: planFor(store, { benefitId: r.json.benefit_id, key }), email: r.json.member?.email || r.json.customer?.email || null, expiresAt: r.json.expires_at || null });
    return { ok: true, message: `VERIDONE_LICENSE_KEY is valid (${maskKey(key)}).` };
  }
  if (isDefinitive(r, 'validate')) {
    const reason = explainFailure(r, { phase: 'validate' });
    writeCiCache(key, { ok: false, validatedAt: iso(now), checkedAt: iso(now), reason: reason.replace(/^The license is no longer active/, 'no longer active').replace(/\.$/, '') });
    return { ok: false, message: reason };
  }
  writeCiCache(key, { ...(prev || {}), checkedAt: iso(now) });
  return { ok: false, transient: true, message: explainFailure(r, { phase: 'validate' }) };
}

/** `veridone license refresh`: re-check the activation and/or the key in VERIDONE_LICENSE_KEY. */
export async function refreshState({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const env = parseKey(process.env.VERIDONE_LICENSE_KEY);
  const parts = [];
  const st = readState();
  if (st?.kind === 'polar' || env.kind !== 'polar') parts.push(await refreshActivation({ fetchImpl, now }));
  if (env.kind === 'polar') parts.push(await validateEnvKey(env.key, { fetchImpl, now }));
  _resetCache();
  return {
    ok: parts.every((x) => x.ok || x.skipped),
    skipped: parts.every((x) => x.skipped),
    transient: parts.some((x) => x.transient),
    message: parts.map((x) => x.message).join('\n'),
  };
}

/** Release this computer's activation (frees a slot) and forget the key locally. */
export async function deactivateKey({ fetchImpl = globalThis.fetch } = {}) {
  const st = readState();
  if (!st) return { ok: true, message: clearState() ? 'License removed from this computer.' : 'No license is activated on this computer.' };
  let note = '';
  if (st.kind === 'polar' && st.activationId) {
    const r = await postJson(`${apiBase({ environment: st.environment })}/v1/customer-portal/license-keys/deactivate`, {
      key: st.key, organization_id: st.organizationId, activation_id: st.activationId,
    }, { fetchImpl });
    const portal = st.portalUrl ? ` in the customer portal: ${st.portalUrl}` : ' in the customer portal';
    if (r.status === 204 || r.status === 200) note = ' Its slot on the key is free again.';
    else if (isDefinitive(r, 'validate')) note = ` The license server no longer knows this computer's activation (the key may have been rotated, or the computer was already removed). If it still shows up, remove it${portal}.`;
    else note = ` The license server could not be told (${explainFailure(r, { phase: 'deactivate' })}), so this computer may still count toward the key's limit; remove it${portal}.`;
  }
  clearState();
  _resetCache();
  return { ok: true, message: `License removed from this computer (${maskKey(st.key)}).${note}` };
}

/**
 * For paid CLI features: make sure the entitlement reflects the store. Validates a store key given in
 * VERIDONE_LICENSE_KEY when it hasn't been checked recently, and re-checks a due activation.
 */
export async function ensureEntitlement({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  let e = entitlement(now);
  if (e.kind === 'polar' && e.source?.startsWith('env:') && e.pendingOnline && e.key) {
    const r = await validateEnvKey(e.key, { fetchImpl, now });
    _resetCache();
    e = entitlement(now);
    if (!e.valid && r.transient) e = { ...e, reason: r.message.replace(/\.$/, '') };
  } else if (e.kind === 'polar' && e.state && (now - (Date.parse(e.state.validatedAt) || 0)) > 3 * 86400e3) {
    await refreshActivation({ fetchImpl, now });
    e = entitlement(now);
  }
  return e;
}
