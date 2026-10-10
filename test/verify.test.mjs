import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCommand, exitStatusMasked, assessOutput, judgeSuccessfulRun, judgeFailedRun,
  findClaims, disclosesGap, evaluateStop, requiredCategories, failureSignature, exitCodeOf,
} from '../scripts/lib/verify.mjs';
import { deriveState } from '../scripts/lib/ledger.mjs';
import { config } from './helpers.mjs';

const project = { commands: { test: 'npm test', typecheck: 'npm run typecheck', lint: 'npm run lint', build: null } };
const cats = (cmd, p = project) => classifyCommand(cmd, p).map((c) => `${c.category}:${c.scope}`).sort();

describe('classifyCommand', () => {
  const cases = [
    ['npm test', ['test:full']],
    ['npm run test -- src/a.test.ts', ['test:partial']],
    ['npx vitest run', ['test:full']],
    ['npx jest -t "adds"', ['test:partial']],
    ['pnpm test && pnpm lint', ['lint:full', 'test:full']],
    ['yarn typecheck', ['typecheck:full']],
    ['pytest', ['test:full']],
    ['pytest tests/test_x.py -k fast', ['test:partial']],
    ['python -m pytest -q', ['test:full']],
    ['go test ./...', ['test:full']],
    ['go test -run TestX ./pkg', ['test:partial']],
    ['cargo test', ['test:full']],
    ['cargo clippy', ['lint:full']],
    ['tsc --noEmit', ['typecheck:full']],
    ['mypy src', ['typecheck:full']],
    ['ruff check .', ['lint:full']],
    ['make test', ['test:full']],
    ['node --test', ['test:full']],
    ['bundle exec rspec spec/models/user_spec.rb', ['test:partial']],
    ['dotnet test', ['test:full']],
    ['./gradlew test', ['test:full']],
    ['mvn -q verify', ['test:full']],
    ['mvn package -DskipTests', ['build:full']],
    ['npm install', []],
    ['git status', []],
    ['echo "npm test"', []],
    ['cat package.json | grep test', []],
  ];
  for (const [cmd, expected] of cases) test(cmd, () => assert.deepEqual(cats(cmd), expected));

  test('configured custom commands are recognized', () => {
    assert.deepEqual(cats('./scripts/ci-test.sh --fast', { commands: { test: './scripts/ci-test.sh' } }), ['test:full']);
  });
});

describe('exit status masking', () => {
  const cases = [
    ['npm test', 0, null],
    ['npm test 2>&1 | tail -30', 0, 'pipe'],
    ['npm test | tee out.log', 0, 'pipe'],
    ['set -o pipefail; npm test | tee out.log', 1, null],
    ['set -euo pipefail\nnpm test | tee x', 1, null],
    ['npm test || true', 0, 'or'],
    ['npm test; echo done', 0, 'sequence'],
    ['npm test && echo ok', 0, null],
    ['cd app && npm test', 1, null],
    ['(npm test) > out.txt', 0, null],
  ];
  for (const [cmd, idx, expected] of cases) test(JSON.stringify(cmd), () => assert.equal(exitStatusMasked(cmd, idx), expected));
});

describe('assessOutput', () => {
  const fails = [
    ['test', 'not ok 4 - totals\n# tests 4\n# pass 3\n# fail 1\n'],
    ['test', 'Tests:       1 failed, 3 passed, 4 total'],
    ['test', ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)'],
    ['test', '  3 passing (10ms)\n  1 failing\n'],
    ['test', '==================== 1 failed, 5 passed in 0.12s ===================='],
    ['test', 'Ran 3 tests in 0.001s\n\nFAILED (failures=1)'],
    ['test', '--- FAIL: TestX (0.00s)\nFAIL\texample.com/m\t0.002s'],
    ['test', 'test result: FAILED. 3 passed; 1 failed; 0 ignored'],
    ['test', '5 examples, 1 failure'],
    ['test', 'FAILURES!\nTests: 5, Assertions: 9, Failures: 1.'],
    ['test', 'Failed!  - Failed:     1, Passed:    12, Skipped:     0, Total:    13'],
    ['typecheck', "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."],
    ['typecheck', 'Found 2 errors in 1 file (checked 3 source files)'],
    ['lint', '✖ 3 problems (3 errors, 0 warnings)'],
    ['build', 'error[E0308]: mismatched types'],
    ['build', 'BUILD FAILURE'],
  ];
  for (const [cat, out] of fails) test(`fail: ${out.split('\n').pop().slice(0, 50)}`, () => assert.ok(assessOutput(out, cat).fail, out));

  const passes = [
    ['test', '# tests 4\n# pass 4\n# fail 0\n'],
    ['test', 'Test Suites: 2 passed, 2 total\nTests:       14 passed, 14 total'],
    ['test', ' Test Files  4 passed (4)\n      Tests  42 passed (42)'],
    ['test', '  4 passing (10ms)'],
    ['test', '============================== 6 passed in 0.10s ==============================='],
    ['test', 'Ran 3 tests in 0.001s\n\nOK'],
    ['test', 'ok  \texample.com/m\t0.002s'],
    ['test', 'test result: ok. 4 passed; 0 failed; 0 ignored'],
    ['test', '5 examples, 0 failures'],
    ['test', 'OK (5 tests, 9 assertions)'],
    ['typecheck', 'Success: no issues found in 12 source files'],
    ['lint', 'All checks passed!'],
  ];
  for (const [cat, out] of passes) {
    test(`pass: ${out.split('\n').pop().slice(0, 50)}`, () => {
      const r = assessOutput(out, cat);
      assert.equal(r.fail, null, JSON.stringify(r));
      assert.ok(r.pass, out);
    });
  }

  test('test names that contain "failed" are not failures', () => {
    const r = assessOutput('ok 1 - handles failed login\nok 2 - reports 3 failed attempts\n# pass 2\n# fail 0\n', 'test');
    assert.equal(r.fail, null);
    assert.ok(r.pass);
  });
  test('TAP todo entries are not failures', () => {
    assert.equal(assessOutput('not ok 3 - later # TODO\n# pass 2\n# fail 0', 'test').fail, null);
  });
  test('ANSI colors are ignored', () => {
    assert.ok(assessOutput('\u001b[31mTests:       \u001b[1m1 failed\u001b[22m, 3 passed, 4 total\u001b[39m', 'test').fail);
  });
});

describe('judging runs', () => {
  test('exit 0 is trusted unless the output reports failures', () => {
    assert.equal(judgeSuccessfulRun({ commandLine: 'npm test', index: 0, output: 'all good', category: 'test' }).ok, true);
    const lying = judgeSuccessfulRun({ commandLine: 'npm test', index: 0, output: 'Tests: 2 failed, 5 passed, 7 total', category: 'test' });
    assert.equal(lying.ok, false);
  });
  test('masked exit status falls back to the output', () => {
    assert.equal(judgeSuccessfulRun({ commandLine: 'npm test | tail -5', index: 0, output: '# pass 4\n# fail 1', category: 'test' }).ok, false);
    assert.equal(judgeSuccessfulRun({ commandLine: 'npm test | tail -5', index: 0, output: '# pass 4\n# fail 0', category: 'test' }).ok, true);
    const unknown = judgeSuccessfulRun({ commandLine: 'npm test | tail -2', index: 0, output: '# todo 0\n# duration_ms 98', category: 'test' });
    assert.equal(unknown.ok, null);
    assert.equal(unknown.masked, 'pipe');
    assert.equal(judgeSuccessfulRun({ commandLine: 'tsc --noEmit | head -20', index: 0, output: '', category: 'typecheck' }).ok, true);
  });
  test('an exit status echoed right after the check is read back', () => {
    const j = (commandLine, output) => judgeSuccessfulRun({ commandLine, index: 0, output, category: 'test' });
    assert.deepEqual(j('npm test > out.log 2>&1; echo "exit=$?"', 'exit=1\n'), { ok: false, basis: 'echoed', masked: null, note: 'exit=1' });
    assert.equal(j('npm test > out.log 2>&1; echo "exit=$?"', 'exit=0\n').ok, true);
    assert.equal(j('npm test; echo $?', 'output\n0\n').ok, true);
    assert.equal(j('npm test; echo $?', '0\nmore output\n').ok, null, 'a bare number is trusted only as the last line');
    assert.equal(j('npm test | tail -3; echo "rc=${PIPESTATUS[0]}"', 'x\nrc=2\n').ok, false);
    assert.equal(j('npm test | tail -3; echo "EXIT: $?"', 'x\nEXIT: 0\n').ok, null, "after a pipe, $? is the filter's status");
    assert.equal(j('npm test || echo "failed with $?"', 'failed with 1\n').ok, false);
    assert.equal(j('npm test; echo done', 'done\n').ok, null);
  });
  test('a failed multi-check command keeps the checks that passed', () => {
    const out = 'Exit code 1\nTests: 5 passed, 5 total\n✖ 2 problems (2 errors, 0 warnings)';
    assert.equal(judgeFailedRun({ output: out, category: 'test', categories: 2 }).ok, true);
    assert.equal(judgeFailedRun({ output: out, category: 'lint', categories: 2 }).ok, false);
    assert.equal(judgeFailedRun({ output: out, category: 'test', categories: 1 }).ok, false);
  });
});

describe('claims in the final message', () => {
  const claims = (m) => findClaims(m).map((c) => c.category);
  test('detects success claims in English and Korean', () => {
    assert.deepEqual(claims('All tests pass.'), ['test']);
    assert.deepEqual(claims('✅ All 42 tests passing'), ['test']);
    assert.deepEqual(claims('Tests: 14 passed'), ['test']);
    assert.deepEqual(claims('The build succeeds and typecheck passes.'), ['typecheck', 'build']);
    assert.deepEqual(claims('모든 테스트가 통과했습니다.'), ['test']);
    assert.deepEqual(claims('빌드 성공'), ['build']);
    assert.deepEqual(claims("I didn't touch the API, and all tests pass."), ['test']);
  });
  test('ignores negated, conditional and instructional mentions', () => {
    for (const m of ["I can't confirm that all tests pass.", 'If all tests pass, we can merge.', 'Run `npm test` to make sure all tests pass.', 'Do the tests pass?', '테스트가 통과하지 않았습니다.', 'Tests are not passing yet.']) {
      assert.deepEqual(claims(m), [], m);
    }
  });
  test('honest partial reports are not claims', () => {
    assert.deepEqual(claims('3 tests pass, and 1 pre-existing test is failing.'), []);
    assert.deepEqual(claims('All 12 tests pass; 0 failures.'), ['test']);
  });
  test('ignores fenced code', () => {
    assert.deepEqual(claims('```\nAll tests pass\n```'), []);
  });
});

describe('disclosure', () => {
  test('recognizes explicit "not run" and "still failing" statements', () => {
    assert.ok(disclosesGap("I haven't run the tests.", 'test', 'missing'));
    assert.ok(disclosesGap('The tests were not run because the database is unavailable.', 'test', 'missing'));
    assert.ok(disclosesGap('테스트는 아직 실행하지 않았습니다.', 'test', 'missing'));
    assert.ok(disclosesGap('npm test reports 3 passing and 1 failing.', 'test', 'failed'));
    assert.ok(disclosesGap('The suite is still red because of the flaky network test.', 'test', 'failed'));
    assert.ok(disclosesGap('테스트 1개가 실패합니다.', 'test', 'failed'));
  });
  test('does not accept unrelated or positive statements', () => {
    assert.ok(!disclosesGap('Done! The function now rounds correctly.', 'test', 'missing'));
    assert.ok(!disclosesGap('All tests pass.', 'test', 'failed'));
    assert.ok(!disclosesGap("I haven't run the linter.", 'test', 'missing'));
  });
});

// --- completion gate ------------------------------------------------------------

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
function state(events) {
  return deriveState([{ t: 'start', at: at(0), projectRoot: '/p' }, { t: 'prompt', at: at(1), promptId: 'p1', text: 'fix it' }, ...events]);
}
const edit = (s, p = 'src/a.js') => ({ t: 'edit', at: at(s), path: p, kind: 'code', tool: 'Edit' });
const run = (s, ok, extra = {}) => ({ t: 'verify', at: at(s), category: 'test', scope: 'full', ok, cmd: 'npm test', ...extra });

async function gate(events, message = 'Done.', mode = 'standard', extra = {}) {
  return evaluateStop({ state: state(events), project, cfg: await config(mode), input: { prompt_id: 'p1', last_assistant_message: message, ...extra }, turnStartAt: at(1) });
}

describe('completion gate', () => {
  test('allows turns without code changes', async () => {
    assert.equal((await gate([])).decision, 'allow');
    assert.equal((await gate([edit(5, 'README.md')])).decision, 'allow');
  });
  test('blocks when tests have not run since the last change', async () => {
    const r = await gate([run(3, true), edit(5)]);
    assert.equal(r.decision, 'block');
    assert.equal(r.kind, 'unverified');
    assert.match(r.reason, /test step has not run since the last change/);
    assert.match(r.reason, /npm test/);
  });
  test('allows after a passing run', async () => {
    assert.equal((await gate([edit(5), run(6, true)])).decision, 'allow');
  });
  test('blocks on a failing run', async () => {
    const r = await gate([edit(5), run(6, false, { exit: 1 })]);
    assert.equal(r.decision, 'block');
    assert.equal(r.kind, 'failed');
  });
  test('an inconclusive (filtered) run does not count, but a later conclusive one does', async () => {
    const r = await gate([edit(5), run(6, null, { masked: 'pipe', cmd: 'npm test | tail -2' })]);
    assert.equal(r.decision, 'block');
    assert.match(r.reason, /hidden by a pipe/);
    assert.equal((await gate([edit(5), run(6, true), run(7, null, { masked: 'pipe' })])).decision, 'allow');
  });
  test('baseline runs against a stashed tree are ignored', async () => {
    assert.equal((await gate([edit(5), run(6, true, { baseline: true })])).decision, 'block');
  });
  test('honest disclosure releases the gate', async () => {
    assert.equal((await gate([edit(5)], "I made the change but haven't run the tests yet.")).decision, 'allow');
    assert.equal((await gate([edit(5), run(6, false)], 'The fix is in, but 1 test is still failing (see above).')).decision, 'allow');
  });
  test('false claims are blocked even without edits this turn', async () => {
    const r = await gate([edit(0.5), run(0.6, false)], 'All tests pass now.');
    assert.equal(r.decision, 'block');
    assert.equal(r.kind, 'claim');
  });
  test('releases on stop_hook_active and after the per-turn cap', async () => {
    assert.equal((await gate([edit(5)], 'Done.', 'standard', { stop_hook_active: true })).decision, 'allow');
    const blocked = { t: 'stop', at: at(6), decision: 'block', promptId: 'p1' };
    assert.equal((await gate([edit(5), blocked])).kind, 'cap');
  });
  test('background verification is allowed to finish', async () => {
    const r = await gate([edit(5)], 'Running tests in the background.', 'standard', { background_tasks: [{ type: 'shell', command: 'npm test', status: 'running' }] });
    assert.equal(r.kind, 'background');
  });
  test('relaxed mode only checks claims; off mode does nothing', async () => {
    assert.equal((await gate([edit(5)], 'Done.', 'relaxed')).decision, 'allow');
    assert.equal((await gate([edit(5)], 'All tests pass.', 'relaxed')).decision, 'block');
    assert.equal((await gate([edit(5)], 'All tests pass.', 'off')).decision, 'allow');
  });
  test('strict mode requires the full suite and the typecheck', async () => {
    const partial = await gate([edit(5), run(6, true, { scope: 'partial' }), { t: 'verify', at: at(7), category: 'typecheck', scope: 'full', ok: true, cmd: 'tsc' }], 'Done.', 'strict');
    assert.equal(partial.decision, 'block');
    assert.match(partial.reason, /partial/);
    assert.deepEqual(requiredCategories(project, await config('strict')), ['test', 'typecheck']);
    assert.deepEqual(requiredCategories(project, await config('standard')), ['test']);
  });
});

test('failure signatures ignore timings and line numbers', () => {
  const a = failureSignature('Error: expected 3 got 4\n  at x (src/a.js:10:5) 12ms');
  const b = failureSignature('Error: expected 3 got 4\n  at x (src/a.js:11:7) 15ms');
  assert.equal(a, b);
  assert.notEqual(a, failureSignature('TypeError: cannot read properties of undefined'));
  assert.equal(exitCodeOf('Exit code 2\nboom'), 2);
  assert.equal(exitCodeOf('no code'), null);
});
