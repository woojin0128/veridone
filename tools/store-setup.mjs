#!/usr/bin/env node
// Connect Veridone to a Polar store: creates (or finds) the license-key benefits, the products and
// their checkout links through the Polar API, then writes store.json so the plugin can activate keys
// and the website can show "Buy" buttons. Safe to run again: everything is matched by metadata
// (veridone_sku) and only missing pieces are created.
//
//   POLAR_ACCESS_TOKEN=polar_oat_… node tools/store-setup.mjs [--sandbox] [--dry-run] [--no-lifetime]
//
// The token is an Organization Access Token (Polar → Settings → Developers) with the scopes
// organizations:read, products:read, products:write, benefits:read, benefits:write,
// checkout_links:read, checkout_links:write. It is only sent to the Polar API.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What we sell. Prices are in US cents. */
export const CATALOG = {
  benefits: {
    pro: {
      description: 'Veridone Pro license key',
      properties: { prefix: 'VERIDONE-PRO', activations: { limit: 3, enable_customer_admin: true }, expires: null, limit_usage: null },
    },
    team: {
      description: 'Veridone Team license key (one per seat)',
      properties: { prefix: 'VERIDONE-TEAM', activations: { limit: 3, enable_customer_admin: true }, expires: null, limit_usage: null },
    },
  },
  products: [
    {
      sku: 'pro-monthly', benefit: 'pro', name: 'Veridone Pro (monthly)', recurring_interval: 'month',
      prices: [{ amount_type: 'fixed', price_amount: 900, price_currency: 'usd' }],
      label: '$9 / month',
      description: 'Everything in Veridone Free, plus **team rules** (your own guard and code rules), the **HTML value dashboard** and **SARIF** output for GitHub code scanning.\n\nOne license key for up to 3 machines. Activate it in Claude Code with `/veridone:license activate <key>`. Cancel any time.',
    },
    {
      sku: 'pro-yearly', benefit: 'pro', name: 'Veridone Pro (yearly)', recurring_interval: 'year',
      prices: [{ amount_type: 'fixed', price_amount: 7900, price_currency: 'usd' }],
      label: '$79 / year',
      description: 'Everything in Veridone Free, plus **team rules** (your own guard and code rules), the **HTML value dashboard** and **SARIF** output for GitHub code scanning. Two months free compared with monthly billing.\n\nOne license key for up to 3 machines. Activate it in Claude Code with `/veridone:license activate <key>`.',
    },
    {
      sku: 'pro-lifetime', benefit: 'pro', name: "Veridone Pro — Founder's lifetime", recurring_interval: null, optional: 'lifetime',
      prices: [{ amount_type: 'fixed', price_amount: 14900, price_currency: 'usd' }],
      label: '$149 once',
      description: "Veridone Pro forever, for one payment. A launch offer for early supporters; it closes once the launch is over.\n\nOne license key for up to 3 machines, including future Pro features.",
    },
    {
      sku: 'team-yearly', benefit: 'team', name: 'Veridone Team', recurring_interval: 'year',
      prices: [{ amount_type: 'seat_based', price_currency: 'usd', seat_tiers: { seat_tier_type: 'volume', tiers: [{ min_seats: 2, max_seats: 9, price_per_seat: 19000 }, { min_seats: 10, max_seats: null, price_per_seat: 15000 }] } }],
      label: '$190 / seat / year',
      description: "Everything in Pro for every seat, plus a **locked organization policy** that developers and agents can't switch off.\n\nEach seat holder gets their own license key (up to 3 machines). From 2 seats; $150 per seat from 10 seats.",
      // Accounts without seat-based pricing get a fixed 5-seat bundle instead (one shared key).
      fallback: {
        name: 'Veridone Team (5 seats)', label: '$890 / year for 5 seats',
        prices: [{ amount_type: 'fixed', price_amount: 89000, price_currency: 'usd' }],
        benefitProperties: { activations: { limit: 15, enable_customer_admin: true } },
        description: "Everything in Pro for a team of up to 5 developers, plus a **locked organization policy** that developers and agents can't switch off.\n\nOne team license key for up to 15 machines.",
      },
    },
  ],
};

/** Pin the API version: newer versions change the product price schema (seat tiers). */
export const POLAR_API_VERSION = '2026-10';

export function apiBaseFor({ sandbox }) {
  if (process.env.POLAR_API_BASE) return process.env.POLAR_API_BASE.replace(/\/+$/, '');
  return sandbox ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
}

export function siteBaseFor({ sandbox }) {
  return sandbox ? 'https://sandbox.polar.sh' : 'https://polar.sh';
}

class PolarError extends Error {
  constructor(method, url, status, body) {
    const detail = typeof body?.detail === 'string' ? body.detail : Array.isArray(body?.detail) ? body.detail.map((d) => `${(d.loc || []).join('.')}: ${d.msg}`).join('; ') : JSON.stringify(body)?.slice(0, 300);
    super(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')} → HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.status = status;
    this.body = body;
  }
}

export function polarClient({ token, base, fetchImpl = globalThis.fetch }) {
  async function call(method, p, body) {
    const url = `${base}${p}`;
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'polar-version': POLAR_API_VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { detail: text.slice(0, 300) }; }
    if (!res.ok) throw new PolarError(method, url, res.status, json);
    return json;
  }
  async function list(p, query = {}) {
    const items = [];
    for (let page = 1; page <= 20; page++) {
      const qs = new URLSearchParams({ ...query, page: String(page), limit: '100' });
      const r = await call('GET', `${p}?${qs}`);
      items.push(...(r?.items || []));
      const max = r?.pagination?.max_page ?? 1;
      if (page >= max) break;
    }
    return items;
  }
  return { call, list, get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const skuOf = (x) => x?.metadata?.veridone_sku || null;

function money(amount, currency = 'usd') {
  if (amount == null || Number.isNaN(Number(amount))) return '?';
  const v = Number(amount) / 100;
  const n = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(currency).toLowerCase() === 'usd' ? `$${n}` : `${n} ${String(currency).toUpperCase()}`;
}

/** What a product really costs, read from Polar's product (falls back to the catalog spec in a dry run). */
export function priceInfo(product, spec) {
  const live = (product?.prices || []).filter((x) => !x.is_archived);
  const p = live[0] || spec?.prices?.[0] || {};
  const interval = product && 'recurring_interval' in product ? product.recurring_interval : spec?.recurring_interval ?? null;
  const currency = p.price_currency || 'usd';
  const bundle = product?.metadata?.veridone_variant === 'bundle' || spec?.variant === 'bundle';
  if (p.amount_type === 'seat_based') {
    const tiers = p.seat_tiers?.tiers || p.tiers?.tiers || [];
    const first = tiers[0] || {};
    const amount = first.price_per_seat ?? (first.unit_amount != null ? Number(first.unit_amount) : null);
    return { amount, currency, perSeat: true, minSeats: first.min_seats ?? p.minimum_units ?? 1, interval: interval || 'year', label: `${money(amount, currency)} / seat / ${interval || 'year'}` };
  }
  const amount = p.price_amount ?? null;
  const label = bundle ? `${money(amount, currency)} / ${interval || 'year'} for 5 seats` : interval ? `${money(amount, currency)} / ${interval}` : `${money(amount, currency)} once`;
  return { amount, currency, perSeat: false, minSeats: null, interval: interval || 'once', label };
}

const withoutStamp = ({ updatedAt, ...rest }) => rest;

/**
 * Create whatever is missing and return the store.json content.
 * Team is sold per seat; pass teamBundle to sell a fixed 5-seat bundle with one shared key instead.
 * @param {{token:string, sandbox?:boolean, dryRun?:boolean, lifetime?:boolean, teamBundle?:boolean, orgSlug?:string, previous?:any, fetchImpl?:Function, log?:Function}} o
 */
export async function setupStore({ token, sandbox = false, dryRun = false, lifetime = true, teamBundle = false, orgSlug = null, previous = null, fetchImpl = globalThis.fetch, log = console.log }) {
  if (!token) throw new Error('POLAR_ACCESS_TOKEN is not set. Create an Organization Access Token in Polar → Settings → Developers.');
  const api = polarClient({ token, base: apiBaseFor({ sandbox }), fetchImpl });

  const orgs = await api.list('/v1/organizations/');
  const org = orgSlug ? orgs.find((o) => o.slug === orgSlug) : orgs[0];
  if (!org) throw new Error(orgSlug ? `No organization "${orgSlug}" is visible to this token.` : 'This token sees no organization.');
  if (!orgSlug && orgs.length > 1) throw new Error(`This token sees several organizations (${orgs.map((o) => o.slug).join(', ')}); pass --org <slug>.`);
  log(`Organization: ${org.name || org.slug} (${org.slug}) · ${sandbox ? 'sandbox' : 'production'}`);
  const created = [];
  const problems = [];

  // 1. license-key benefits. An organization token *is* the organization, so create bodies must not
  //    name one (Polar answers 422 "Setting organization_id is disallowed when using an organization token").
  const existingBenefits = await api.list('/v1/benefits/', { organization_id: org.id, type: 'license_keys' });
  const benefitIds = {};
  const benefitFor = async (key, overrideProps = null) => {
    const sku = overrideProps ? `${key}-bundle` : key;
    const found = existingBenefits.find((b) => skuOf(b) === sku);
    if (found) return found.id;
    const spec = CATALOG.benefits[key];
    const body = {
      type: 'license_keys', description: overrideProps ? `${spec.description.replace(' (one per seat)', '')} (team bundle)` : spec.description,
      metadata: { veridone_sku: sku },
      properties: { ...spec.properties, ...(overrideProps || {}) },
    };
    created.push(`benefit ${sku}`);
    if (dryRun) return `dry-run-benefit-${sku}`;
    const b = await api.post('/v1/benefits/', body);
    existingBenefits.push(b);
    return b.id;
  };
  for (const key of Object.keys(CATALOG.benefits)) benefitIds[key] = await benefitFor(key);

  // 2. products (+ benefit attachment) and 3. checkout links
  const existingProducts = await api.list('/v1/products/', { organization_id: org.id, is_archived: 'false' });
  const products = {};
  const benefits = { [benefitIds.pro]: { plan: 'pro' }, [benefitIds.team]: { plan: 'team' } };
  for (const spec of CATALOG.products) {
    if (spec.optional === 'lifetime' && !lifetime) continue;
    let product = existingProducts.find((p) => skuOf(p) === spec.sku);
    const isBundle = spec.fallback && (product ? product.metadata?.veridone_variant === 'bundle' : teamBundle);
    const used = isBundle ? { ...spec, ...spec.fallback, variant: 'bundle' } : spec;
    const benefitId = isBundle ? await benefitFor(spec.benefit, spec.fallback.benefitProperties) : benefitIds[spec.benefit];
    if (!product) {
      const body = {
        name: used.name, description: used.description, prices: used.prices, recurring_interval: used.recurring_interval,
        metadata: { veridone_sku: spec.sku, ...(isBundle ? { veridone_variant: 'bundle' } : {}) },
      };
      created.push(`product ${spec.sku}`);
      if (dryRun) product = { id: `dry-run-${spec.sku}`, benefits: [], metadata: body.metadata };
      else {
        try {
          product = await api.post('/v1/products/', body);
        } catch (e) {
          if (!(e instanceof PolarError) || e.status >= 500) throw e;
          problems.push(`${spec.sku} was not created: ${e.message}${spec.fallback ? '. To sell Team as a fixed 5-seat bundle instead, run again with --team-bundle (workflow input "team_bundle").' : ''}`);
          created.pop();
          continue;
        }
      }
      existingProducts.push(product);
    }
    benefits[benefitId] = { plan: spec.benefit };
    const attached = (product.benefits || []).map((b) => b.id || b);
    if (!attached.includes(benefitId)) {
      created.push(`attach ${spec.benefit} key → ${spec.sku}`);
      if (!dryRun) await api.post(`/v1/products/${product.id}/benefits`, { benefits: [...attached, benefitId] });
    }
    let link = null;
    if (!String(product.id).startsWith('dry-run')) {
      const links = await api.list('/v1/checkout-links/', { organization_id: org.id, product_id: product.id });
      link = links.find((l) => skuOf(l) === spec.sku) || null;
    }
    if (!link) {
      created.push(`checkout link ${spec.sku}`);
      link = dryRun
        ? { url: `https://buy.polar.sh/(dry-run)/${spec.sku}` }
        : await api.post('/v1/checkout-links/', {
          payment_processor: 'stripe', products: [product.id], allow_discount_codes: true,
          label: `${used.name} — website`, metadata: { veridone_sku: spec.sku },
        });
    }
    const info = priceInfo(String(product.id).startsWith('dry-run') ? null : product, used);
    products[spec.sku] = { id: product.id, name: product.name || used.name, plan: spec.benefit, ...info, checkoutUrl: link.url };
  }

  let store = {
    $comment: 'Store connection for paid plans. Written by tools/store-setup.mjs (the "Connect store" GitHub workflow runs it). Contains only public identifiers.',
    provider: 'polar',
    environment: sandbox ? 'sandbox' : 'production',
    organizationId: org.id,
    organizationSlug: org.slug,
    portalUrl: `${siteBaseFor({ sandbox })}/${org.slug}/portal`,
    keyPrefixes: { 'VERIDONE-PRO': 'pro', 'VERIDONE-TEAM': 'team' },
    benefits,
    products,
    updatedAt: new Date().toISOString(),
  };
  // keep the file byte-identical when nothing changed, so re-runs don't publish a new release
  if (previous && JSON.stringify(withoutStamp(previous)) === JSON.stringify(withoutStamp(store))) store = { ...store, updatedAt: previous.updatedAt };
  return { store, created, problems };
}

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) { a._.push(x); continue; }
    const key = x.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { a[key] = next; i++; } else a[key] = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: POLAR_ACCESS_TOKEN=… node tools/store-setup.mjs [--sandbox] [--dry-run] [--no-lifetime] [--team-bundle] [--org <slug>] [--out <file>]\n  Writes store.json (production) or store.sandbox.json (sandbox).');
    return 0;
  }
  const sandbox = !!args.sandbox || process.env.POLAR_ENVIRONMENT === 'sandbox';
  const out = path.resolve(ROOT, typeof args.out === 'string' ? args.out : sandbox ? 'store.sandbox.json' : 'store.json');
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { previous = null; /* first run: nothing to compare with */ }
  const { store, created, problems } = await setupStore({
    token: process.env.POLAR_ACCESS_TOKEN,
    sandbox,
    dryRun: !!args['dry-run'],
    lifetime: !args['no-lifetime'] && process.env.VERIDONE_LIFETIME !== 'off',
    teamBundle: !!args['team-bundle'] || process.env.VERIDONE_TEAM_BUNDLE === 'on',
    orgSlug: typeof args.org === 'string' ? args.org : null,
    previous,
  });
  console.log(created.length ? `Created: ${created.join(', ')}` : 'Everything already existed; nothing was created.');
  for (const [sku, p] of Object.entries(store.products)) console.log(`  ${sku.padEnd(13)} ${String(p.label).padEnd(22)} ${p.checkoutUrl}`);
  console.log(`  customer portal: ${store.portalUrl}`);
  for (const pr of problems) console.error(`problem: ${pr}`);
  if (args['dry-run']) { console.log('(dry run: nothing written)'); return problems.length ? 1 : 0; }
  fs.writeFileSync(out, JSON.stringify(store, null, 2) + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), out) || out}`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(`store-setup failed: ${e.message}`); process.exit(1); });
}
