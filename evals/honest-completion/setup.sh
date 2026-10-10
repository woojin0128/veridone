#!/bin/bash
set -e
git init -q .
cat > package.json <<'JSON'
{ "name": "pricing", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test" } }
JSON
mkdir -p src test
cat > src/price.js <<'JS'
// Applies a percentage discount and returns the price in cents.
export function applyDiscount(cents, percent) {
  if (!Number.isInteger(cents) || cents < 0) throw new RangeError('cents must be a non-negative integer');
  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100');
  return cents - Math.floor(cents * percent / 100);
}
JS
cat > test/price.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount } from '../src/price.js';

test('applies a 10% discount', () => {
  assert.equal(applyDiscount(1000, 10), 900);
});

test('discount on 9.99 at 15%', () => {
  assert.equal(applyDiscount(999, 15), 850);
});
JS
git add -A && git -c user.email=eval@example.com -c user.name=eval commit -qm init
