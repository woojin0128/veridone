// tools/store-setup.mjs against an in-memory stand-in for the Polar admin API.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setupStore, CATALOG } from '../tools/store-setup.mjs';
import { loadStore, isConfigured, planFor } from '../scripts/lib/store.mjs';

/** A fake fetch that behaves like the parts of the Polar API the setup uses. */
function fakePolar({ orgs = [{ id: crypto.randomUUID(), slug: 'veridone', name: 'Veridone' }], refuseSeats = false } = {}) {
  const db = { benefits: [], products: [], links: [] };
  const calls = [];
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  const page = (items) => json(200, { items, pagination: { total_count: items.length, max_page: 1 } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, host: u.host, auth: init.headers?.authorization });
    if (init.headers?.authorization !== 'Bearer polar_oat_test') return json(401, { error: 'Unauthorized', detail: 'Invalid token' });
    const q = u.searchParams;
    if (method === 'GET' && u.pathname === '/v1/organizations/') return page(orgs);
    if (u.pathname === '/v1/benefits/') {
      if (method === 'GET') return page(db.benefits.filter((b) => b.organization_id === q.get('organization_id') && (!q.get('type_filter') || b.type === q.get('type_filter'))));
      const b = { id: crypto.randomUUID(), ...body, created_at: new Date().toISOString() };
      db.benefits.push(b);
      return json(201, b);
    }
    if (u.pathname === '/v1/products/') {
      if (method === 'GET') return page(db.products.filter((p) => p.organization_id === q.get('organization_id') && !p.is_archived));
      if (refuseSeats && body.prices.some((p) => p.amount_type === 'seat_based')) return json(422, { detail: [{ loc: ['body', 'prices', 0], msg: 'Seat-based pricing is not enabled for this organization', type: 'value_error' }] });
      if (!body.name || !Array.isArray(body.prices)) return json(422, { detail: [{ loc: ['body'], msg: 'invalid', type: 'value_error' }] });
      const p = { id: crypto.randomUUID(), ...body, is_archived: false, benefits: [] };
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
      if (method === 'GET') return page(db.links.filter((l) => !q.get('product_id') || l.product_id === q.get('product_id')));
      const l = { id: crypto.randomUUID(), ...body, url: `https://buy.polar.sh/polar_cl_${crypto.randomBytes(6).toString('hex')}` };
      db.links.push(l);
      return json(201, l);
    }
    return json(404, { detail: 'Not Found' });
  };
  return { fetchImpl, db, calls };
}

const quiet = () => {};

describe('store setup', () => {
  test('creates benefits, products, attachments and checkout links, then writes a usable store.json', async () => {
    const polar = fakePolar();
    const { store, created } = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet });
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

    assert.equal(store.organizationSlug, 'veridone');
    assert.equal(store.portalUrl, 'https://polar.sh/veridone/portal');
    assert.ok(isConfigured(store));
    const proBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'pro').id;
    const teamBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'team').id;
    assert.equal(planFor(store, { benefitId: proBenefit }), 'pro');
    assert.equal(planFor(store, { benefitId: teamBenefit }), 'team');
    assert.match(store.products['pro-yearly'].checkoutUrl, /^https:\/\/buy\.polar\.sh\/polar_cl_/);
    assert.equal(store.products['pro-yearly'].amount, 7900);
    assert.equal(store.products['team-yearly'].perSeat, true);
    assert.equal(store.products['team-yearly'].minSeats, 2);
    assert.equal(store.products['pro-lifetime'].interval, 'once');
  });

  test('running it again creates nothing and keeps the same ids', async () => {
    const polar = fakePolar();
    const first = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet });
    const posts = polar.calls.filter((c) => c.method === 'POST').length;
    const second = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet });
    assert.equal(second.created.length, 0);
    assert.equal(polar.calls.filter((c) => c.method === 'POST').length, posts);
    assert.deepEqual(second.store.products, first.store.products);
    assert.deepEqual(second.store.benefits, first.store.benefits);
  });

  test('without seat-based pricing, Team becomes a 5-seat bundle with its own key', async () => {
    const polar = fakePolar({ refuseSeats: true });
    const logs = [];
    const { store } = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: (l) => logs.push(l) });
    assert.ok(logs.some((l) => /Seat-based pricing was refused/.test(l)));
    const team = polar.db.products.find((p) => p.metadata.veridone_sku === 'team-yearly');
    assert.equal(team.metadata.veridone_variant, 'bundle');
    assert.equal(team.prices[0].price_amount, 89000);
    const bundleBenefit = polar.db.benefits.find((b) => b.metadata.veridone_sku === 'team-bundle');
    assert.equal(bundleBenefit.properties.activations.limit, 15);
    assert.equal(team.benefits[0].id, bundleBenefit.id);
    assert.equal(store.benefits[bundleBenefit.id].plan, 'team');
    assert.equal(store.products['team-yearly'].label, '$890 / year for 5 seats');
    // and a second run recognizes the bundle instead of retrying seats
    const again = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet });
    assert.equal(again.created.length, 0);
  });

  test('options: no lifetime offer, sandbox, dry run', async () => {
    const polar = fakePolar();
    const { store } = await setupStore({ token: 'polar_oat_test', fetchImpl: polar.fetchImpl, log: quiet, lifetime: false, sandbox: true });
    assert.equal(store.products['pro-lifetime'], undefined);
    assert.equal(store.environment, 'sandbox');
    assert.equal(store.portalUrl, 'https://sandbox.polar.sh/veridone/portal');
    assert.ok(polar.calls.every((c) => c.host === 'sandbox-api.polar.sh'));

    const dry = fakePolar();
    const r = await setupStore({ token: 'polar_oat_test', fetchImpl: dry.fetchImpl, log: quiet, dryRun: true });
    assert.equal(dry.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.ok(r.created.length > 0);
  });

  test('clear errors for a bad token, several organizations, or no token', async () => {
    await assert.rejects(setupStore({ token: '', fetchImpl: fakePolar().fetchImpl, log: quiet }), /POLAR_ACCESS_TOKEN is not set/);
    await assert.rejects(setupStore({ token: 'wrong', fetchImpl: fakePolar().fetchImpl, log: quiet }), /HTTP 401: Invalid token/);
    const two = fakePolar({ orgs: [{ id: 'a', slug: 'one' }, { id: 'b', slug: 'two' }] });
    await assert.rejects(setupStore({ token: 'polar_oat_test', fetchImpl: two.fetchImpl, log: quiet }), /several organizations \(one, two\); pass --org/);
    const picked = await setupStore({ token: 'polar_oat_test', fetchImpl: two.fetchImpl, log: quiet, orgSlug: 'two' });
    assert.equal(picked.store.organizationId, 'b');
  });

  test('the catalog matches what the plugin and website expect', () => {
    assert.deepEqual(Object.keys(CATALOG.benefits), ['pro', 'team']);
    const bundled = loadStore();
    for (const b of Object.values(CATALOG.benefits)) assert.ok(bundled.keyPrefixes[b.properties.prefix], `${b.properties.prefix} maps to a plan`);
  });
});
