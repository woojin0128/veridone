import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, fromStructuredPatch, parseUnifiedDiff } from '../scripts/lib/diff.mjs';

/** Apply a diff to `a` and check it reproduces `b` (the diff must be a valid edit script). */
function applies(a, b, d) {
  const A = a.split('\n');
  const removedAt = new Set(d.removed.map((r) => r.line));
  const kept = A.filter((_, i) => !removedAt.has(i + 1));
  const B = b.split('\n');
  const addedAt = new Map(d.added.map((x) => [x.line, x.text]));
  const rebuilt = [];
  let k = 0;
  for (let i = 1; i <= B.length; i++) rebuilt.push(addedAt.has(i) ? addedAt.get(i) : kept[k++]);
  return rebuilt.join('\n') === b;
}

test('reports added and removed lines with their line numbers', () => {
  const d = diffLines('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.deepEqual(d.removed, [{ line: 2, text: 'b' }]);
  assert.deepEqual(d.added, [{ line: 2, text: 'B' }, { line: 5, text: 'e' }]);
});

test('handles empty inputs', () => {
  assert.deepEqual(diffLines('', 'x\ny'), { added: [{ line: 1, text: 'x' }, { line: 2, text: 'y' }], removed: [] });
  assert.deepEqual(diffLines('x', ''), { added: [], removed: [{ line: 1, text: 'x' }] });
  assert.deepEqual(diffLines(null, null), { added: [], removed: [] });
});

test('produces minimal, valid edit scripts on random inputs', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const alphabet = ['a', 'b', 'c', 'd', 'e'];
    const a = Array.from({ length: rnd(12) }, () => alphabet[rnd(5)]).join('\n');
    const b = Array.from({ length: rnd(12) }, () => alphabet[rnd(5)]).join('\n');
    const d = diffLines(a, b);
    assert.ok(applies(a, b, d), `round ${round}: ${JSON.stringify({ a, b, d })}`);
    // minimality: edits = |A| + |B| - 2·LCS
    const A = a ? a.split('\n') : [];
    const B = b ? b.split('\n') : [];
    const L = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
    for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++) L[i][j] = A[i - 1] === B[j - 1] ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
    assert.equal(d.added.length + d.removed.length, A.length + B.length - 2 * L[A.length][B.length], `round ${round}`);
  }
});

test('falls back to a multiset diff when the edit distance is huge', () => {
  const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join('\n');
  const d = diffLines(a, b, { maxD: 10 });
  assert.equal(d.added.length, 300);
  assert.equal(d.removed.length, 300);
});

test('converts Claude Code structuredPatch hunks', () => {
  const d = fromStructuredPatch([{ oldStart: 3, newStart: 3, lines: [' ctx', '-old', '+new', '+more', ' ctx2', '\\ No newline at end of file'] }]);
  assert.deepEqual(d.removed, [{ line: 4, text: 'old' }]);
  assert.deepEqual(d.added, [{ line: 4, text: 'new' }, { line: 5, text: 'more' }]);
});

test('parses git unified diffs, including content lines that look like headers', () => {
  const text = [
    'diff --git a/sql/a.sql b/sql/a.sql',
    'index 111..222 100644',
    '--- a/sql/a.sql',
    '+++ b/sql/a.sql',
    '@@ -2 +2 @@',
    '--- old comment',
    '+++ new counter',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1,2 @@',
    '+hello',
    '+world',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
  ].join('\n');
  const files = parseUnifiedDiff(text);
  assert.deepEqual([...files.keys()], ['sql/a.sql', 'new.txt', 'gone.txt']);
  assert.deepEqual(files.get('sql/a.sql').removed, [{ line: 2, text: '-- old comment' }]);
  assert.deepEqual(files.get('sql/a.sql').added, [{ line: 2, text: '++ new counter' }]);
  assert.equal(files.get('new.txt').status, 'added');
  assert.equal(files.get('new.txt').added.length, 2);
  assert.equal(files.get('gone.txt').status, 'deleted');
});
