// Veridone — the only module that talks to the network: activating, re-checking and releasing
// store license keys through Polar's public customer-portal license-key API. It is loaded by the
// CLI (`veridone license …` and paid CLI features), never by hooks.
//
// Requests carry the license key, the store's organization id and, on activation, a label for this
// machine plus the Veridone version and OS name. Nothing about your code or sessions is sent.

import crypto from 'node:crypto';
import { loadStore, normalizeStore, isConfigured, apiBase, remoteStoreUrl, parseKey, planFor, maskKey } from './store.mjs';
import {
  readState, writeState, clearState, verifyLicense, entitlement, _resetCache, writeCiCache, GRACE_DAYS,
} from './license.mjs';
import { STORE_URL } from './brand.mjs';
import { version } from './version.mjs';

const TIMEOUT_MS = 10000;

const PLATFORM = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

function iso(now) { return new Date(now).toISOString(); }
function title(plan) { return `${plan[0].toUpperCase()}${plan.slice(1)}`; }

async function postJson(url, body, { fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') return { status: 0, error: 'this Node.js has no fetch (Node 18+ required)' };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': `veridone/${version()}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { detail: text.slice(0, 200) }; }
    return { status: res.status, json };
  } catch (e) {
    const reason = e?.name === 'TimeoutError' ? 'timed out' : (e?.cause?.code || e?.message || String(e));
    return { status: 0, error: reason };
  }
}

function detailOf(json) {
  if (!json) return '';
  if (typeof json.detail === 'string') return json.detail;
  if (Array.isArray(json.detail)) return json.detail.map((d) => d?.msg).filter(Boolean).join('; ');
  return '';
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
  if (r.status === 404) {
    return phase === 'activate'
      ? 'License key not found. Check that you copied the whole key from your receipt or the customer portal.'
      : `The license is no longer active${detail ? ` (${detail.replace(/\.$/, '')})` : ''}: the subscription may have ended, been refunded, or this machine's activation was removed.`;
  }
  if (r.status === 403) {
    if (/limit/i.test(detail)) return `This key is already active on its maximum number of machines. Free one by running \`/veridone:license deactivate\` on a machine you no longer use${portalUrl ? `, or in the customer portal: ${portalUrl}` : ''}.`;
    return `The license server refused this key${detail ? `: ${detail}` : ''}.`;
  }
  if (r.status === 422) return `The license server rejected the request${detail ? ` (${detail})` : ''}. Check the key for typos.`;
  if (r.status === 429) return 'Too many requests to the license server. Try again in a minute.';
  if (r.status >= 500) return `The license server is having problems (HTTP ${r.status}). Try again later; an existing activation keeps working for ${GRACE_DAYS} days without a check.`;
  return `Unexpected answer from the license server (HTTP ${r.status}${detail ? `: ${detail}` : ''}).`;
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

function machineLabel(installId) {
  return `${PLATFORM[process.platform] || process.platform} · ${installId.slice(0, 8)}`;
}

/**
 * Activate a key on this machine. Store keys are activated online; offline (VD1) keys are verified
 * locally. Returns { ok, message, state? }.
 */
export async function activateKey(rawKey, { label = null, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const p = parseKey(rawKey);
  if (p.kind === 'offline') {
    const r = verifyLicense(p.key, undefined, now);
    if (!r.valid) return { ok: false, message: `License not activated: ${r.reason}.` };
    writeState({ kind: 'offline', key: p.key, activatedAt: iso(now) });
    return { ok: true, message: `Activated Veridone ${title(r.payload.plan)} for ${r.payload.email || r.payload.org || 'this machine'}${r.payload.exp ? ` (valid until ${r.payload.exp})` : ''}.` };
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

  // Re-activating the same key on the same machine reuses its activation instead of taking a new slot.
  if (previous?.kind === 'polar' && previous.key === p.key && previous.activationId && previous.organizationId === store.organizationId) {
    const v = await postJson(`${base}/v1/customer-portal/license-keys/validate`, { ...body, activation_id: previous.activationId }, { fetchImpl });
    if (v.status === 200) return finish(v.json, previous.activationId, store, p.key, installId, previous.label || lbl, now);
  }

  const r = await postJson(`${base}/v1/customer-portal/license-keys/activate`, {
    ...body, label: lbl, meta: { app: 'veridone', version: version(), os: PLATFORM[process.platform] || process.platform },
  }, { fetchImpl });
  if (r.status === 200 && r.json?.id) return finish(r.json.license_key || {}, r.json.id, store, p.key, installId, lbl, now);
  if (r.status === 403 && /does not support activations/i.test(detailOf(r.json))) {
    const v = await postJson(`${base}/v1/customer-portal/license-keys/validate`, body, { fetchImpl });
    if (v.status === 200) return finish(v.json, null, store, p.key, installId, lbl, now);
    return { ok: false, message: explainFailure(v, { phase: 'activate', portalUrl: store.portalUrl }) };
  }
  return { ok: false, message: explainFailure(r, { phase: 'activate', portalUrl: store.portalUrl }) };
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
  const where = activationId ? ` This machine is registered as "${label}"${state.limitActivations ? ` (a key works on up to ${state.limitActivations} machines)` : ''}.` : '';
  return { ok: true, state, message: `Activated Veridone ${title(plan)} (${maskKey(key)})${state.email ? ` for ${state.email}` : ''}.${where}` };
}

/**
 * Re-check this machine's store activation. Network problems keep the current state (grace period);
 * a definite "no longer active" answer marks it inactive.
 */
export async function refreshState({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const st = readState();
  if (!st || st.kind !== 'polar') return { ok: true, skipped: true, message: st ? 'Offline keys need no refresh.' : 'No store license is activated on this machine.' };
  const base = apiBase({ environment: st.environment });
  const r = await postJson(`${base}/v1/customer-portal/license-keys/validate`, {
    key: st.key, organization_id: st.organizationId, ...(st.activationId ? { activation_id: st.activationId } : {}),
  }, { fetchImpl });
  const next = { ...readState(), checkedAt: iso(now) };
  if (r.status === 200 && r.json) {
    const local = loadStore();
    const store = isConfigured(local) && local.organizationId === st.organizationId ? local : { keyPrefixes: local.keyPrefixes, benefits: {} };
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
    delete next.noticeFor;
    writeState(next);
    _resetCache();
    return { ok: true, state: next, message: `Veridone ${title(next.plan)} license is active (${maskKey(st.key)}).` };
  }
  if (r.status === 404 || r.status === 403) {
    next.status = 'inactive';
    next.statusReason = explainFailure(r, { phase: 'validate', portalUrl: st.portalUrl }).replace(/^The license is no longer active/, 'no longer active');
    writeState(next);
    _resetCache();
    return { ok: false, state: next, message: explainFailure(r, { phase: 'validate', portalUrl: st.portalUrl }) };
  }
  writeState(next);
  _resetCache();
  return { ok: false, transient: true, state: next, message: explainFailure(r, { phase: 'validate' }) };
}

/** Release this machine's activation (frees a slot) and forget the key locally. */
export async function deactivateKey({ fetchImpl = globalThis.fetch } = {}) {
  const st = readState();
  if (!st) return { ok: true, message: clearState() ? 'License removed from this machine.' : 'No license is activated on this machine.' };
  let note = '';
  if (st.kind === 'polar' && st.activationId) {
    const r = await postJson(`${apiBase({ environment: st.environment })}/v1/customer-portal/license-keys/deactivate`, {
      key: st.key, organization_id: st.organizationId, activation_id: st.activationId,
    }, { fetchImpl });
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) {
      note = ` The license server could not be told (${explainFailure(r, { phase: 'deactivate' })}), so this machine may still count toward the key's limit${st.portalUrl ? `; remove it in the customer portal: ${st.portalUrl}` : ''}.`;
    }
  }
  clearState();
  _resetCache();
  return { ok: true, message: `License removed from this machine (${maskKey(st.key)}).${note}` };
}

/**
 * For paid CLI features: make sure the entitlement reflects the store. Validates a store key given in
 * VERIDONE_LICENSE_KEY (CI; no machine activation), and re-checks a due activation.
 */
export async function ensureEntitlement({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  let e = entitlement(now);
  if (e.kind === 'polar' && e.pendingOnline && e.key) {
    const store = await resolveStore({ fetchImpl });
    if (!isConfigured(store)) return e;
    const r = await postJson(`${apiBase(store)}/v1/customer-portal/license-keys/validate`, { key: e.key, organization_id: store.organizationId }, { fetchImpl });
    if (r.status === 200 && r.json) {
      writeCiCache(e.key, { ok: true, validatedAt: iso(now), plan: planFor(store, { benefitId: r.json.benefit_id, key: e.key }), email: r.json.member?.email || r.json.customer?.email || null, expiresAt: r.json.expires_at || null });
    } else if (r.status === 404 || r.status === 403) {
      writeCiCache(e.key, { ok: false, validatedAt: iso(now), reason: explainFailure(r, { phase: 'validate' }) });
    } else {
      _resetCache();
      return { ...entitlement(now), reason: explainFailure(r, { phase: 'validate' }) };
    }
    _resetCache();
    e = entitlement(now);
  } else if (e.kind === 'polar' && e.state && (now - (Date.parse(e.state.validatedAt) || 0)) > 3 * 86400e3) {
    await refreshState({ fetchImpl, now });
    e = entitlement(now);
  }
  return e;
}
