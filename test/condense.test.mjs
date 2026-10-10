import { test } from 'node:test';
import assert from 'node:assert/strict';
import { condense, stripAnsi } from '../scripts/lib/condense.mjs';

function jestLikeOutput({ passing = 400, failing = 1 } = {}) {
  const lines = ['> app@1.0.0 test', '> jest', ''];
  for (let i = 0; i < passing; i++) lines.push(`  \u001b[32m✓\u001b[39m renders component variant ${i} (${i % 7 + 1} ms)`);
  for (let i = 0; i < failing; i++) {
    lines.push(`  ✕ computes the total for cart ${i} (4 ms)`, '', `  ● Cart › computes the total for cart ${i}`, '',
      '    expect(received).toBe(expected) // Object.is equality', '', '    Expected: 800', '    Received: 350', '',
      '      at Object.<anonymous> (src/cart.test.js:18:23)', '      at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)');
  }
  lines.push('', `Tests:       ${failing} failed, ${passing} passed, ${passing + failing} total`, 'Time:        3.2 s', 'Ran all test suites.');
  return lines.join('\n');
}

test('keeps failures and the summary, drops passing noise', () => {
  const raw = jestLikeOutput();
  const c = condense(raw, { logPath: '/tmp/full.log' });
  assert.ok(c, 'expected condensing');
  assert.ok(c.after < c.before / 3, `${c.before} → ${c.after}`);
  assert.match(c.text, /Expected: 800/);
  assert.match(c.text, /Received: 350/);
  assert.match(c.text, /Tests: {7}1 failed, 400 passed, 401 total/);
  assert.match(c.text, /src\/cart\.test\.js:18:23/);
  assert.match(c.text, /Full output: \/tmp\/full\.log/);
  assert.match(c.text, /lines omitted/);
  assert.doesNotMatch(c.text, /\u001b\[/);
});

test('leaves short output alone', () => {
  assert.equal(condense('ok\n'.repeat(10)), null);
  assert.equal(condense(jestLikeOutput({ passing: 5 })), null);
});

test('respects the character budget on huge failure-heavy logs', () => {
  const raw = jestLikeOutput({ passing: 200, failing: 300 });
  const c = condense(raw, { targetChars: 3000 });
  assert.ok(c);
  assert.ok(c.text.length < 9000, String(c.text.length));
  assert.match(c.text, /300 failed, 200 passed/); // the tail summary survives truncation
});

test('collapses carriage-return progress bars', () => {
  const progress = Array.from({ length: 50 }, (_, i) => `\rDownloading ${i * 2}%`).join('') + '\rDownloading 100%\n';
  const raw = progress + Array.from({ length: 300 }, (_, i) => `Compiling crate-${i} v1.0.${i}`).join('\n') + '\nerror[E0308]: mismatched types\n --> src/main.rs:4:5\n' + 'x\n'.repeat(40);
  const c = condense(raw);
  assert.ok(c);
  assert.match(c.text, /error\[E0308\]: mismatched types/);
  assert.doesNotMatch(c.text, /Downloading 42%/);
});

test('stripAnsi removes color and cursor sequences', () => {
  assert.equal(stripAnsi('\u001b[1;31mred\u001b[0m \u001b[2Kline'), 'red line');
});
