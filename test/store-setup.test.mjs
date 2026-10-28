// tools/store-setup.mjs against an in-memory stand-in for the Polar admin API that enforces the
// rules of polar/organization/resolver.py (organization tokens) and the pinned API version.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupStore, priceInfo, CATALOG, POLAR_API_VERSION } from '../tools/store-setup.mjs';
import { loadStore, isConfigured, planFor } from '../scripts/lib/store.mjs';

/** A fake fetch that behaves like the parts of the Polar API the setup uses. */
function fakePolar({ orgs = [{ id: crypto.randomUUID(), slug: 'veridone', name: 'Veridone' }], refuseSeats = false } = {}) {
  const db = { benefits: [], products: [], links: [] };
  const calls = [];
  const tokenOrg = orgs[0];
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const page = (items) => json(200, { items, pagination: { total_count: items.length, max_page: 1 } });
  const orgTokenRule = (body) => json(422, { error: 'PolarRequestValidationError', detail: [{ type: 'organization_token', loc: ['body', 'organization_id'], msg: 'Setting organization_id is disallowed when using an organization token.', input: body.organization_id }] });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, host: u.host, headers: init.headers || {} });
    if (init.headers?.authorization !== 'Bearer polar_oat_test') return json(401, { error: 'Unauthorized', detail: 'Invalid token' });
    if (init.headers?.['polar-version'] !== '2026-10') return json(400, { detail: 'test fake: expected Polar-Version 2026-10' });
    if (method === 'POST' && body && 'organization_id' in body) return orgTokenRule(body);
    const q = u.searchParams;
    if (method === 'GET' && u.pathname === '/v1/organizations/') return page(orgs);
    if (u.pathname === '/v1/benefits/') {
      if (method === 'GET') return page(db.benefits.filter((b) => b.organization_id === q.get('organization_id') && (!q.get('type') || b.type === q.get('type'))));
      if (!(body.description?.length >= 3 && body.description.length <= 42)) return json(422, { detail: [{ loc: ['body', 'description'], msg: 'length', type: 'string_too_long' }] });
      const b = { id: crypto.randomUUID(), ...body, organization_id: tokenOrg.id, created_at: new Date().toISOString() };
      db.benefits.push(b);
      return json(201, b);
    }
    if (u.pathname === '/v1/products/') {
      if (method === 'GET') return page(db.products.filter((p) => p.organization_id === q.get('organization_id') && !p.is_archived));
      if (refuseSeats && body.prices.some((p) => p.amount_type === 'seat_based')) return json(422, { detail: [{ loc: ['body', 'prices', 0], msg: 'Seat-based pricing is not enabled for this organization', type: 'value_error' }] });
      if (!body.name || !Array.isArray(body.prices)) return json(422, { detail: [{ loc: ['body'], msg: 'invalid', type: 'value_error' }] });
      const p = { id: crypto.randomUUID(), ...body, organization_id: tokenOrg.id, is_archived: false, benefits: [] };
      db.products.push(p);
      return json(201, p);
    }
    const m = /^\/v1\/products\/([^/]+)\/benefits$/.exec(u.pathname);
    if (m && method === 'POST') {
      const p = db.products.find((x) => x.id === m[1]);
      p.benefits = body.benefits.map((id) => db.benefits.find((b) => b.id === id));
      return json(200, p);
    }
    if (u.pathname === '/v1/checkout-links/') {
      if (method === 'GET') return page(db.links.filter((l) => !q.get('product_id') || (l.products || []).includes(q.get('product_id'))));
      if (!Array.isArray(body.products) || !body.products.length) return json(422, { detail: [{ loc: ['body', 'products'], msg: 'Field required', type: 'missing' }] });
      const l = { id: crypto.randomUUID(), ...body, url: `https://buy.polar.sh/polar_cl_${crypto.randomBytes(6).toString('hex')}` };
      db.links.push(l);
      return json(201, l);
    }
    return json(404, { detail: 'Not Found' });
  };
  return { fetchImpl, db, calls };
}

const quiet = () => {};
const run = (polar, opts = {}) => setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet, ...opts });

describe('store setup', () => {
  test('creates benefits, products, attachments and checkout links, then writes a usable store.json', async () => {
    const polar = fakePolar();
    const { store, created, problems } = await run(polar);
    assert.deepEqual(problems, []);
    assert.equal(polar.db.benefits.length, 2);
    assert.deepEqual(polar.db.benefits.map((b) => b.properties.prefix).sort(), ['VERIDONE-PRO', 'VERIDONE-TEAM']);
    assert.ok(polar.db.benefits.every((b) => b.type === 'license_keys' && b.properties.activations.limit === 3 && b.properties.activations.enable_customer_admin));
    assert.deepEqual(polar.db.products.map((p) => p.metadata.veridone_sku), ['pro-monthly', 'pro-yearly', 'pro-lifetime', 'team-yearly']);
    const team = polar.db.products.find((p) => p.metadata.veridone_sku === 'team-yearly');
    assert.equal(team.prices[0].amount_type, 'seat_based');
    assert.equal(team.prices[0].seat_tiers.tiers[0].min_seats, 2);
    for (const p of polar.db.products) assert.equal(p.benefits.length, 1, `${p.name} grants a license key`);
    assert.equal(polar.db.products.find((p) => p.metadata.veridone_sku === 'pro-lifetime').recurring_interval, null);
    assert.equal(polar.db.links.length, 4);
    assert.ok(polar.db.links.every((l) => l.payment_processor === 'stripe' && l.allow_discount_codes === true && !l.success_url), 'buyers land on Polar\'s confirmation page, which shows the key');
    assert.equal(created.length, 2 + 4 + 4 + 4);
    assert.ok(polar.calls.every((c) => c.headers['polar-version'] === POLAR_API_VERSION), 'the API version is pinned');
    assert.ok(polar.calls.filter((c) => c.method === 'POST').every((c) => !('organization_id' in c.body)), 'an organization token implies the organization');

    assert.equal(store.organizationSlug, 'veridone');
    assert.equal(store.portalUrl, 'https://polar.sh/veridone/portal');
    assert.ok(isConfigured(store));
    const proBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'pro').id;
    const teamBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'team').id;
    assert.equal(planFor(store, { benefitId: proBenefit }), 'pro');
    assert.equal(planFor(store, { benefitId: teamBenefit }), 'team');
    assert.match(store.products['pro-yearly'].checkoutUrl, /^https:\/\/buy\.polar\.sh\/polar_cl_/);
    assert.equal(store.products['pro-yearly'].amount, 7900);
    assert.equal(store.products['pro-yearly'].label, '$79 / year');
    assert.equal(store.products['pro-monthly'].label, '$9 / month');
    assert.equal(store.products['pro-lifetime'].label, '$149 once');
    assert.equal(store.products['team-yearly'].label, '$190 / seat / year');
    assert.equal(store.products['team-yearly'].perSeat, true);
    assert.equal(store.products['team-yearly'].minSeats, 2);
    assert.equal(store.products['pro-lifetime'].interval, 'once');
  });

  test('running it again creates nothing, keeps the ids and leaves store.json byte-identical', async () => {
    const polar = fakePolar();
    const first = await run(polar);
    const posts = polar.calls.filter((c) => c.method === 'POST').length;
    await new Promise((r) => setTimeout(r, 5));
    const second = await run(polar, { previous: JSON.parse(JSON.stringify(first.store)) });
    assert.equal(second.created.length, 0);
    assert.equal(polar.calls.filter((c) => c.method === 'POST').length, posts);
    assert.deepEqual(second.store, first.store, 'same content keeps the same timestamp, so no release is cut');
  });

  test('prices on the website follow what is set in Polar', async () => {
    const polar = fakePolar();
    await run(polar);
    polar.db.products.find((p) => p.metadata.veridone_sku === 'pro-yearly').prices = [
      { amount_type: 'fixed', price_amount: 7900, price_currency: 'usd', is_archived: true },
      { amount_type: 'fixed', price_amount: 9900, price_currency: 'usd', is_archived: false },
    ];
    const { store } = await run(polar);
    assert.equal(store.products['pro-yearly'].amount, 9900);
    assert.equal(store.products['pro-yearly'].label, '$99 / year');
    assert.deepEqual(priceInfo({ recurring_interval: 'year', prices: [{ amount_type: 'seat_based', price_currency: 'usd', seat_tiers: { tiers: [{ min_seats: 3, max_seats: null, price_per_seat: 15000 }] } }] }),
      { amount: 15000, currency: 'usd', perSeat: true, minSeats: 3, interval: 'year', label: '$150 / seat / year' });
  });

  test('if seat-based pricing is refused, Team is skipped with a clear problem instead of silently changing', async () => {
    const polar = fakePolar({ refuseSeats: true });
    const { store, problems } = await run(polar);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /team-yearly was not created: .*HTTP 422.*--team-bundle/);
    assert.equal(store.products['team-yearly'], undefined);
    assert.ok(store.products['pro-yearly'].checkoutUrl, 'Pro still goes on sale');
    assert.equal(polar.db.products.some((p) => p.metadata.veridone_variant === 'bundle'), false);
  });

  test('--team-bundle sells Team as a 5-seat bundle with its own key, and re-runs keep it', async () => {
    const polar = fakePolar({ refuseSeats: true });
    const { store, problems } = await run(polar, { teamBundle: true });
    assert.deepEqual(problems, []);
    const team = polar.db.products.find((p) => p.metadata.veridone_sku === 'team-yearly');
    assert.equal(team.metadata.veridone_variant, 'bundle');
    assert.equal(team.prices[0].price_amount, 89000);
    const bundleBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'team-bundle');
    assert.equal(bundleBenefit.properties.activations.limit, 15);
    assert.equal(team.benefits[0].id, bundleBenefit.id);
    assert.equal(store.benefits[bundleBenefit.id].plan, 'team');
    assert.equal(store.products['team-yearly'].label, '$890 / year for 5 seats');
    assert.equal(store.products['team-yearly'].perSeat, false);
    const again = await run(polar);
    assert.equal(again.created.length, 0, 'an existing bundle is recognized without the flag');
    assert.equal(again.store.products['team-yearly'].label, '$890 / year for 5 seats');
  });

  test('options: no lifetime offer, sandbox, dry run', async () => {
    const polar = fakePolar();
    const { store } = await run(polar, { lifetime: false, sandbox: true });
    assert.equal(store.products['pro-lifetime'], undefined);
    assert.equal(store.environment, 'sandbox');
    assert.equal(store.portalUrl, 'https://sandbox.polar.sh/veridone/portal');
    assert.ok(polar.calls.every((c) => c.host === 'sandbox-api.polar.sh'));

    const dry = fakePolar();
    const r = await run(dry, { dryRun: true });
    assert.equal(dry.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.ok(r.created.length > 0);
    assert.equal(r.store.products['pro-yearly'].label, '$79 / year');
  });

  test('clear errors for a bad token, several organizations, or no token', async () => {
    await assert.rejects(setupStore({ token: '', fetchImpl: fakePolar().fetchImpl, log: quiet }), /POLAR_ACCESS_TOKEN is not set/);
    await assert.rejects(setupStore({ token: 'wrong', fetchImpl: fakePolar().fetchImpl, log: quiet }), /HTTP 401: Invalid token/);
    const two = fakePolar({ orgs: [{ id: 'a', slug: 'one' }, { id: 'b', slug: 'two' }] });
    await assert.rejects(run(two), /several organizations \(one, two\); pass --org/);
    const picked = await run(two, { orgSlug: 'two' });
    assert.equal(picked.store.organizationId, 'b');
  });

  test('the catalog matches what the plugin, the website and Polar accept', () => {
    assert.deepEqual(Object.keys(CATALOG.benefits), ['pro', 'team']);
    // Polar: benefit descriptions are 3–42 characters (polar/benefit/strategies/base/schemas.py)
    for (const b of Object.values(CATALOG.benefits)) assert.ok(b.description.length >= 3 && b.description.length <= 42, b.description);
    assert.ok('Veridone Team license key (team bundle)'.length <= 42);
    // product names are 3–64 characters (polar/product/schemas.py)
    for (const p of CATALOG.products) assert.ok(p.name.length >= 3 && p.name.length <= 64, p.name);
    const bundled = loadStore();
    for (const b of Object.values(CATALOG.benefits)) assert.ok(bundled.keyPrefixes[b.properties.prefix], `${b.properties.prefix} maps to a plan`);
  });
});
