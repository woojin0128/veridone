// The fulfillment worker must mint keys that the plugin accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import worker, { signKey, verifySignature, licenseForOrder } from '../tools/license-worker/worker.mjs';
import { verifyLicense } from '../scripts/lib/license.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SECRET = 'whsec_test_123';

function order({ status = 'paid', variant = 111, quantity = 1, email = 'buyer@example.com' } = {}) {
  return { meta: { event_name: 'order_created' }, data: { id: '424242', attributes: { status, user_email: email, created_at: '2026-10-01T10:00:00.000000Z', first_order_item: { variant_id: variant, quantity } } } };
}
const PLANS = { 111: { plan: 'pro', days: 365 }, 222: { plan: 'team', days: 365, seatsFromQuantity: true }, 333: { plan: 'pro' } };

test('keys signed with WebCrypto verify with the plugin', async () => {
  const key = await signKey({ id: 'lic_x', email: 'a@b.co', plan: 'pro', seats: 1, iat: '2026-10-01', exp: '2999-01-01' }, PRIV);
  const r = verifyLicense(key, PUB);
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.payload.plan, 'pro');
});

test('webhook signatures are checked', async () => {
  const body = JSON.stringify(order());
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(await verifySignature(body, sig, SECRET), true);
  assert.equal(await verifySignature(body + ' ', sig, SECRET), false);
  assert.equal(await verifySignature(body, sig, 'other'), false);
  assert.equal(await verifySignature(body, '', SECRET), false);
});

test('orders map to plans deterministically', () => {
  const pro = licenseForOrder(order(), PLANS);
  assert.deepEqual(pro, { id: 'lic_ls_424242', email: 'buyer@example.com', plan: 'pro', seats: 1, iat: '2026-10-01', exp: '2027-10-01' });
  assert.equal(licenseForOrder(order({ variant: 222, quantity: 5 }), PLANS).seats, 5);
  assert.equal(licenseForOrder(order({ variant: 333 }), PLANS).exp, undefined, 'lifetime');
  assert.equal(licenseForOrder(order({ status: 'refunded' }), PLANS), null);
  assert.equal(licenseForOrder(order({ variant: 999 }), PLANS), null);
});

test('end to end: a signed webhook produces an emailed, valid key', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  try {
    const env = { LEMON_SQUEEZY_SIGNING_SECRET: SECRET, VERIDONE_SIGNING_KEY_PEM: PRIV, VARIANT_PLANS: JSON.stringify(PLANS), RESEND_API_KEY: 're_x', MAIL_FROM: 'Veridone <l@x.co>' };
    const body = JSON.stringify(order({ variant: 222, quantity: 3 }));
    const req = (b, sig) => new Request('https://w.example/', { method: 'POST', body: b, headers: { 'X-Signature': sig } });
    const res = await worker.fetch(req(body, crypto.createHmac('sha256', SECRET).update(body).digest('hex')), env);
    assert.equal(res.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'https://api.resend.com/emails');
    const key = /VD1\.[\w-]+\.[\w-]+/.exec(sent[0].body.text)[0];
    const v = verifyLicense(key, PUB);
    assert.equal(v.valid, true);
    assert.equal(v.payload.plan, 'team');
    assert.equal(v.payload.seats, 3);
    // a retried delivery of the same order yields the same key
    await worker.fetch(req(body, crypto.createHmac('sha256', SECRET).update(body).digest('hex')), env);
    assert.equal(/VD1\.[\w-]+\.[\w-]+/.exec(sent[1].body.text)[0], key);
    // forged requests are rejected
    assert.equal((await worker.fetch(req(body, 'deadbeef'), env)).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Polar order.paid (Standard Webhooks) issues a key, including renewals', async () => {
  const { verifyStandardWebhook, licenseForPolarOrder } = await import('../tools/license-worker/worker.mjs');
  const secretBytes = crypto.randomBytes(24);
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const plans = { 'prod_pro_yearly': { plan: 'pro', days: 400 }, 'prod_team': { plan: 'team', days: 400, seatsFromQuantity: true } };
  const event = { type: 'order.paid', timestamp: '2026-10-01T10:00:00Z', data: { id: 'ord_1', paid: true, status: 'paid', created_at: '2026-10-01T10:00:00Z', billing_reason: 'subscription_cycle', product_id: 'prod_team', seats: 4, customer: { email: 'team@example.com' } } };
  const body = JSON.stringify(event);
  const id = 'msg_123';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secretBytes).update(`${id}.${ts}.${body}`).digest('base64');
  const headers = new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` });
  assert.equal(await verifyStandardWebhook(body, headers, secret), true);
  assert.equal(await verifyStandardWebhook(body + 'x', headers, secret), false);
  assert.equal(await verifyStandardWebhook(body, headers, secret, Number(ts) + 3600), false, 'stale timestamps are rejected');
  assert.deepEqual(licenseForPolarOrder(event, plans), { id: 'lic_polar_ord_1', email: 'team@example.com', plan: 'team', seats: 4, iat: '2026-10-01', exp: '2027-11-05' });
  assert.equal(licenseForPolarOrder({ ...event, data: { ...event.data, product_id: 'other' } }, plans), null);

  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response('{}'); };
  try {
    const env = { POLAR_WEBHOOK_SECRET: secret, VERIDONE_SIGNING_KEY_PEM: PRIV, PLANS: JSON.stringify(plans), RESEND_API_KEY: 'x', MAIL_FROM: 'x@y.z' };
    const res = await worker.fetch(new Request('https://w/', { method: 'POST', body, headers }), env);
    assert.equal(res.status, 200);
    const key = /VD1\.[\w-]+\.[\w-]+/.exec(sent[0].text)[0];
    const v = verifyLicense(key, PUB);
    assert.equal(v.valid, true);
    assert.equal(v.payload.seats, 4);
    const forged = new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,AAAA' });
    assert.equal((await worker.fetch(new Request('https://w/', { method: 'POST', body, headers: forged }), env)).status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});
