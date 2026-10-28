import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { signLicense, verifyLicense, hasFeature, FEATURES, b64urlEncode } from '../scripts/lib/license.mjs';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });

const base = { id: 'lic_1', email: 'dev@example.com', plan: 'pro', seats: 1, iat: '2026-01-01' };

test('a signed key verifies offline', () => {
  const key = signLicense(base, priv);
  assert.match(key, /^VD1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const r = verifyLicense(key, pub);
  assert.equal(r.valid, true);
  assert.equal(r.payload.plan, 'pro');
  assert.equal(r.payload.v, 1);
});

test('tampering with the payload or signature is rejected', () => {
  const key = signLicense(base, priv);
  const [prefix, , sig] = key.split('.');
  const forged = `${prefix}.${b64urlEncode(Buffer.from(JSON.stringify({ ...base, v: 1, plan: 'enterprise' })))}.${sig}`;
  assert.equal(verifyLicense(forged, pub).valid, false);
  assert.equal(verifyLicense(key.slice(0, -4) + 'AAAA', pub).valid, false);
});

test('keys signed by someone else are rejected', () => {
  const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.equal(verifyLicense(signLicense(base, other), pub).reason, 'invalid signature');
});

test('expiry, malformed keys and unknown plans', () => {
  const expired = signLicense({ ...base, exp: '2020-01-01' }, priv);
  assert.match(verifyLicense(expired, pub).reason, /expired/);
  const future = signLicense({ ...base, exp: '2999-01-01' }, priv);
  assert.equal(verifyLicense(future, pub).valid, true);
  assert.equal(verifyLicense('not-a-key', pub).reason, 'malformed license key');
  assert.equal(verifyLicense('', pub).valid, false);
  assert.equal(verifyLicense(signLicense({ ...base, plan: 'gold' }, priv), pub).reason, 'unknown plan');
});

test('the placeholder public key never validates anything', () => {
  const key = signLicense(base, priv);
  assert.match(verifyLicense(key, '-----BEGIN PUBLIC KEY-----\nPLACEHOLDER\n-----END PUBLIC KEY-----').reason, /does not accept offline \(VD1\) keys/);
});

test('features map to plans', () => {
  const free = { plan: 'free' };
  const pro = { plan: 'pro' };
  const team = { plan: 'team' };
  assert.equal(hasFeature('report-html', free), false);
  assert.equal(hasFeature('report-html', pro), true);
  assert.equal(hasFeature('scan-sarif', pro), true);
  assert.equal(hasFeature('org-policy', pro), false);
  assert.equal(hasFeature('org-policy', team), true);
  assert.equal(hasFeature('something-free', free), true);
  assert.ok(Object.keys(FEATURES).length >= 3);
});
