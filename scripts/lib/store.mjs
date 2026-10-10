// Veridone — store configuration (which Polar organization sells Veridone, and which of its
// license-key benefits map to which plan). Read from store.json at the plugin root; written by
// tools/store-setup.mjs. Everything in it is public information.

import path from 'node:path';
import { pluginRoot, readJsonFile } from './util.mjs';
import { REPO_URL } from './brand.mjs';

export const POLAR_API = { production: 'https://api.polar.sh', sandbox: 'https://sandbox-api.polar.sh' };

const DEFAULTS = {
  provider: 'polar',
  environment: 'production',
  organizationId: null,
  organizationSlug: null,
  portalUrl: null,
  keyPrefixes: { 'VERIDONE-PRO': 'pro', 'VERIDONE-TEAM': 'team' },
  benefits: {},
  products: {},
  updatedAt: null,
};

export function storeFile() {
  return path.join(pluginRoot(), 'store.json');
}

/** The bundled store configuration, with defaults filled in. */
export function loadStore(file = storeFile()) {
  return normalizeStore(readJsonFile(file, {}));
}

export function normalizeStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    ...DEFAULTS,
    ...s,
    keyPrefixes: { ...DEFAULTS.keyPrefixes, ...(s.keyPrefixes || {}) },
    benefits: { ...(s.benefits || {}) },
    products: { ...(s.products || {}) },
  };
}

export function isConfigured(store) {
  return !!(store && typeof store.organizationId === 'string' && store.organizationId);
}

/** Base URL of the Polar API for this store (VERIDONE_POLAR_API overrides it, e.g. for tests). */
export function apiBase(store) {
  const override = process.env.VERIDONE_POLAR_API;
  if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  return store?.environment === 'sandbox' ? POLAR_API.sandbox : POLAR_API.production;
}

/** Where the latest store.json is published (used when this install predates the store connection). */
export function remoteStoreUrl() {
  const override = process.env.VERIDONE_STORE_URL;
  if (override) return override;
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(REPO_URL);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/store.json` : null;
}

const UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}';
const POLAR_KEY = new RegExp(`^(?:([A-Z0-9][A-Z0-9_-]*?)-)?(${UUID})$`, 'i');

/**
 * Classify a license key string.
 *   VD1.<payload>.<sig>                    → offline key (signed by the vendor)
 *   [PREFIX-]XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX → Polar license key
 */
export function parseKey(key) {
  const k = String(key || '').trim();
  if (!k) return { kind: null };
  if (/^VD1\.[^.]+\.[^.]+$/.test(k)) return { kind: 'offline', key: k };
  const m = POLAR_KEY.exec(k);
  if (m) return { kind: 'polar', key: k, prefix: m[1] ? m[1].toUpperCase() : null };
  return { kind: null };
}

/** Plan granted by a Polar key: by benefit id when known, else by key prefix, else Pro. */
export function planFor(store, { benefitId, key } = {}) {
  const byBenefit = benefitId && store?.benefits?.[benefitId];
  if (byBenefit) return typeof byBenefit === 'string' ? byBenefit : byBenefit.plan || 'pro';
  const { prefix } = parseKey(key);
  if (prefix && store?.keyPrefixes?.[prefix]) return store.keyPrefixes[prefix];
  return 'pro';
}

/** "VERIDONE-PRO-1C28…-ADB6A7E304DA" → "VERIDONE-PRO-****-E304DA" (safe to print). */
export function maskKey(key) {
  const k = String(key || '').trim();
  const p = parseKey(k);
  if (p.kind === 'polar') return `${p.prefix ? p.prefix + '-' : ''}****-${k.slice(-6)}`;
  if (p.kind === 'offline') return `VD1.…${k.slice(-6)}`;
  return k.length > 8 ? `…${k.slice(-4)}` : '****';
}

export function checkoutUrl(store, sku) {
  return store?.products?.[sku]?.checkoutUrl || null;
}
