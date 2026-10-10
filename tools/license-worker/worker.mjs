// Veridone license fulfillment worker (Cloudflare Workers, or any runtime with WebCrypto + fetch).
//
// Your store calls this webhook when an order is paid. The worker verifies the webhook signature,
// maps the purchased product to a plan, signs a Veridone license key with your Ed25519 signing key
// and emails it to the buyer through Resend. Supported stores:
//   - Polar         event `order.paid` (Standard Webhooks signature). Yearly subscriptions get a
//                   fresh key on every renewal, so keys follow the subscription.
//   - Lemon Squeezy event `order_created` (X-Signature HMAC).
// Retries of the same order produce the same key, so duplicate deliveries are harmless.
//
// Environment (Cloudflare: `wrangler secret put NAME` for secrets, [vars] for the rest):
//   POLAR_WEBHOOK_SECRET          Polar webhook secret (whsec_…)            — if you sell on Polar
//   LEMON_SQUEEZY_SIGNING_SECRET  Lemon Squeezy webhook signing secret       — if you sell on Lemon Squeezy
//   VERIDONE_SIGNING_KEY_PEM      contents of ~/.veridone-vendor/license-signing-key.pem
//   PLANS                         JSON: {"<product or variant id>": {"plan": "pro", "days": 400},
//                                        "<id>": {"plan": "team", "days": 400, "seatsFromQuantity": true}}
//                                 Omit "days" for a lifetime key. (VARIANT_PLANS is accepted as an alias.)
//   RESEND_API_KEY                API key from resend.com (or replace sendEmail with your provider)
//   MAIL_FROM                     e.g. "Veridone <license@your-domain.com>"
//   SUPPORT_EMAIL                 shown in the email (optional)

const PREFIX = 'VD1';
const enc = new TextEncoder();
const TOLERANCE_SECONDS = 5 * 60;

export function b64url(bytes) {
  return b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

function fromB64(str) {
  const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pemToDer(pem) {
  return fromB64(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacSha256(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Sign a payload into a `VD1.<payload>.<signature>` key (same format as scripts/lib/license.mjs). */
export async function signKey(payload, privateKeyPem) {
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(privateKeyPem), { name: 'Ed25519' }, false, ['sign']);
  const body = b64url(enc.encode(JSON.stringify({ v: 1, ...payload })));
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(`${PREFIX}.${body}`));
  return `${PREFIX}.${body}.${b64url(sig)}`;
}

/** Lemon Squeezy: `X-Signature` is the hex HMAC-SHA256 of the raw body. */
export async function verifySignature(rawBody, signatureHex, secret) {
  if (!secret || !signatureHex) return false;
  const mac = await hmacSha256(enc.encode(secret), rawBody);
  return timingSafeEqual([...mac].map((b) => b.toString(16).padStart(2, '0')).join(''), String(signatureHex).toLowerCase());
}

/**
 * Polar / Standard Webhooks: HMAC-SHA256 over `${id}.${timestamp}.${body}`, base64, sent as
 * `webhook-signature: v1,<sig> [v1,<sig> …]`. `whsec_` secrets carry a base64 key.
 */
export async function verifyStandardWebhook(rawBody, headers, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!secret || !id || !ts || !sigHeader) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSeconds - Number(ts)) > TOLERANCE_SECONDS) return false;
  const keyBytes = secret.startsWith('whsec_') ? fromB64(secret.slice(6)) : enc.encode(secret);
  const expected = b64(await hmacSha256(keyBytes, `${id}.${ts}.${rawBody}`));
  return sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && typeof sig === 'string' && timingSafeEqual(sig, expected);
  });
}

function planPayload({ orderId, email, rule, quantity, createdAt }) {
  if (!rule || !rule.plan || !email) return null;
  const created = new Date(createdAt || Date.now());
  const payload = {
    id: `lic_${orderId}`,
    email: String(email).trim(),
    plan: rule.plan,
    seats: rule.seatsFromQuantity ? Math.max(1, Number(quantity) || 1) : Math.max(1, Number(rule.seats) || 1),
    iat: created.toISOString().slice(0, 10),
  };
  if (rule.days) payload.exp = new Date(created.getTime() + rule.days * 86400e3).toISOString().slice(0, 10);
  return payload;
}

/** Lemon Squeezy `order_created` → license payload (or null when nothing should be issued). */
export function licenseForOrder(event, plans) {
  const attrs = event?.data?.attributes || {};
  if (attrs.status !== 'paid') return null;
  const item = attrs.first_order_item || {};
  return planPayload({ orderId: `ls_${event.data.id}`, email: attrs.user_email, rule: plans[String(item.variant_id)], quantity: item.quantity, createdAt: attrs.created_at });
}

/** Polar `order.paid` → license payload (or null). Renewals produce a new key for the new period. */
export function licenseForPolarOrder(event, plans) {
  const o = event?.data || {};
  if (event?.type !== 'order.paid' || o.paid === false) return null;
  return planPayload({ orderId: `polar_${o.id}`, email: o.customer?.email, rule: plans[String(o.product_id)], quantity: o.seats, createdAt: o.created_at });
}

export function emailText(payload, key, support) {
  return [
    `Thanks for buying Veridone ${payload.plan[0].toUpperCase()}${payload.plan.slice(1)}!`,
    '',
    'Your license key:',
    '',
    key,
    '',
    'Activate it in Claude Code:',
    `  /veridone:license activate ${key}`,
    '',
    'In CI, set the VERIDONE_LICENSE_KEY secret to the same key.',
    `Seats: ${payload.seats} · Valid until: ${payload.exp || 'no expiry'}`,
    support ? `\nQuestions? Reply to this email or write to ${support}.` : '',
  ].join('\n');
}

async function sendEmail(env, to, subject, text) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, reply_to: env.SUPPORT_EMAIL || undefined }),
  });
  if (!r.ok) throw new Error(`email provider returned ${r.status}: ${await r.text()}`);
}

const reply = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' } });

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return reply(200, 'Veridone license worker');
    const raw = await request.text();
    let plans;
    try { plans = JSON.parse(env.PLANS || env.VARIANT_PLANS || '{}'); } catch { return reply(500, 'PLANS is not valid JSON'); }

    let payload = null;
    if (request.headers.get('webhook-signature')) {
      if (!(await verifyStandardWebhook(raw, request.headers, env.POLAR_WEBHOOK_SECRET))) return reply(401, 'invalid signature');
      let event;
      try { event = JSON.parse(raw); } catch { return reply(400, 'invalid JSON'); }
      if (event?.type !== 'order.paid') return reply(200, 'ignored');
      payload = licenseForPolarOrder(event, plans);
    } else {
      if (!(await verifySignature(raw, request.headers.get('X-Signature') || '', env.LEMON_SQUEEZY_SIGNING_SECRET))) return reply(401, 'invalid signature');
      let event;
      try { event = JSON.parse(raw); } catch { return reply(400, 'invalid JSON'); }
      if (event?.meta?.event_name !== 'order_created') return reply(200, 'ignored');
      payload = licenseForOrder(event, plans);
    }
    if (!payload) return reply(200, 'no license for this order');
    const key = await signKey(payload, env.VERIDONE_SIGNING_KEY_PEM);
    await sendEmail(env, payload.email, 'Your Veridone license key', emailText(payload, key, env.SUPPORT_EMAIL));
    return reply(200, { issued: payload.id });
  },
};
