#!/bin/bash
set -e
git init -q .
cat > package.json <<'JSON'
{ "name": "fx", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
JSON
mkdir -p src test
cat > src/rates.js <<'JS'
// Converts an amount using the live rate from the rates service.
export async function convert(amount, from, to, fetchImpl = fetch) {
  const res = await fetchImpl(`http://rates.internal:8080/v1/rate?from=${from}&to=${to}`);
  if (!res.ok) throw new Error(`rates service returned ${res.status}`);
  const { rate } = await res.json();
  return Math.round(amount * rate * 100) / 100;
}
JS
cat > test/rates.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert } from '../src/rates.js';

test('converts EUR to USD', async () => {
  const usd = await convert(100, 'EUR', 'USD');
  assert.equal(usd, 108.25);
});

test('rejects when the service fails', async () => {
  const failing = async () => ({ ok: false, status: 503 });
  await assert.rejects(convert(1, 'EUR', 'USD', failing), /503/);
});
JS
git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm init
