import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSecrets, redact, isSecretStoreFile } from '../scripts/lib/secrets.mjs';

// Test credentials are generated at runtime (seeded, so runs are reproducible) so this file never contains a literal secret.
const j = (...parts) => parts.join('');
const ids = (text) => scanSecrets(text).map((f) => f.id);
let seed = 20260928;
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function r(n, alphabet = ALNUM) {
  let out = '';
  for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; out += alphabet[(seed >>> 16) % alphabet.length]; }
  return out;
}
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ234567';
const HEX = '0123456789abcdef';

test('detects vendor credentials', () => {
  const cases = [
    ['aws-access-key-id', j('AKIA', r(16, UPPER))],
    ['github-token', j('ghp_', r(36))],
    ['github-fine-grained', j('github_pat_', r(82))],
    ['gitlab-token', j('glpat-', r(20))],
    ['slack-token', j('xoxb-', r(10, '23456789'), '-', r(10, '23456789'), '-', r(24))],
    ['stripe-live-key', j('sk_live_', r(24))],
    ['google-api-key', j('AIza', r(35))],
    ['anthropic-key', j('sk-ant-api03-', r(48))],
    ['openai-key', j('sk-proj-', r(56))],
    ['npm-token', j('npm_', r(36))],
    ['sendgrid-key', j('SG.', r(22), '.', r(43))],
    ['digitalocean-token', j('dop_v1_', r(64, HEX))],
    ['private-key', j('-----BEGIN RSA ', 'PRIVATE KEY-----')],
    ['db-url-credentials', j('postgres://app:', r(12), '@db.internal:5432/app')],
  ];
  for (const [id, value] of cases) {
    const found = ids(`const x = "${value}";`);
    assert.ok(found.includes(id), `${id}: ${found}`);
  }
});

test('ignores documentation examples and placeholders', () => {
  for (const text of [
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'STRIPE_KEY=sk_live_your_key_here_replace_me',
    'DATABASE_URL=postgres://user:password@localhost/db',
    'DATABASE_URL=postgres://user:${DB_PASSWORD}@localhost/db',
    'const key = process.env.OPENAI_API_KEY;',
    'api_key = "<your-api-key>"',
  ]) {
    assert.deepEqual(ids(text), [], text);
  }
});

test('an inline veridone-allow comment suppresses a line', () => {
  assert.deepEqual(ids(`const k = "${j('sk_live_', r(24))}"; // veridone-allow-secret fixture`), []);
});

test('reports line numbers and redacts values', () => {
  const token = j('ghp_', r(36));
  const found = scanSecrets(`a\nb\nconst t = "${token}";\n`);
  assert.equal(found[0].line, 3);
  assert.ok(!found[0].preview.includes(token.slice(4, 20)));
  assert.equal(redact('short'), '****');
  assert.match(redact('abcdefghijklmnop'), /^abcd…op \(16 chars\)$/);
});

test('secret store files', () => {
  for (const f of ['.env', '.env.local', 'config/.env.production', 'secrets.json', 'certs/server.key', '.dev.vars']) assert.ok(isSecretStoreFile(f), f);
  for (const f of ['.env.example', '.env.sample', 'src/env.ts', 'secrets.md']) assert.ok(!isSecretStoreFile(f), f);
});
