import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanEdit, actionFor, formatFindings } from '../scripts/lib/integrity.mjs';
import { config, editOf } from './helpers.mjs';

async function scan(relPath, before, after, mode = 'standard', patch = {}) {
  return scanEdit(await editOf(relPath, before, after), await config(mode, patch));
}
const ruleIds = (fs) => fs.map((f) => f.rule);

const JS_TEST = `import { test } from 'vitest';
import { add } from '../src/math.js';

test('adds numbers', () => {
  expect(add(1, 2)).toEqual(3);
});

test('handles negatives', () => {
  expect(add(-1, -2)).toEqual(-3);
});
`;

describe('test tampering', () => {
  test('skipping a test is blocked', async () => {
    const f = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace("test('handles negatives'", "test.skip('handles negatives'"));
    assert.deepEqual(ruleIds(f), ['test-skip']);
    assert.equal(f[0].action, 'block');
    assert.equal(f[0].line, 8);
  });

  test('skip patterns across languages', async () => {
    const cases = [
      ['tests/test_x.py', '@pytest.mark.skip(reason="flaky")'],
      ['tests/test_x.py', '    pytest.skip("later")'],
      ['pkg/x_test.go', '\tt.Skip("broken")'],
      ['src/lib.rs', '#[ignore]'],
      ['src/test/java/FooTest.java', '  @Disabled'],
      ['spec/user_spec.rb', "  xit 'works' do"],
      ['tests/Unit/FooTest.php', '        $this->markTestSkipped("todo");'],
      ['Tests/FooTests.swift', '        throw XCTSkip("later")'],
      ['test/foo_test.exs', '  @tag :skip'],
      ['tests/foo.cc', 'TEST(Suite, DISABLED_Works) {'],
      ['UnitTests/FooTests.cs', '    [Fact(Skip = "flaky")]'],
    ];
    for (const [file, line] of cases) {
      const f = await scan(file, 'x\n', `x\n${line}\n`);
      assert.ok(ruleIds(f).includes('test-skip'), `${file}: ${line} → ${ruleIds(f)}`);
    }
  });

  test('patterns inside string literals are text, not code', async () => {
    const docs = "const EXAMPLES = [\n  [\"it.skip('charges the card', async () => {\", 'block'],\n  [\"if (process.env.NODE_ENV === 'test') return 849\", 'block'],\n  ['// @ts-ignore', 'flag'],\n];\n";
    assert.deepEqual(ruleIds(await scan('site/build.mjs', 'x\n', docs)), []);
    assert.ok(ruleIds(await scan('src/a.test.js', 'x\n', "x\nit.skip('charges the card', () => {});\n")).includes('test-skip'), 'real code is still caught');
    assert.ok(ruleIds(await scan('src/a.js', 'x\n', "x\nconst s = 'a'; if (process.env.NODE_ENV === 'test') return 849;\n")).includes('test-env-special-case'));
  });
  test('focused tests are blocked', async () => {
    const f = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace("test('adds numbers'", "test.only('adds numbers'"));
    assert.ok(ruleIds(f).includes('test-focus'));
  });

  test('tautological assertions are blocked', async () => {
    for (const line of ['  expect(true).toBe(true);', '  assert.equal(1, 1);', '    assert True', '    self.assertTrue(True)', '    assert!(true);', '  expect(1).toEqual(1);']) {
      const f = await scan('tests/a.test.js', 'x\n', `x\n${line}\n`);
      assert.ok(ruleIds(f).includes('trivial-assertion'), line);
    }
  });

  test('removed and weakened assertions are reported', async () => {
    const removed = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace("  expect(add(-1, -2)).toEqual(-3);\n", ''));
    assert.ok(ruleIds(removed).includes('assertions-removed'));
    const weakened = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace('expect(add(1, 2)).toEqual(3);', 'expect(add(1, 2)).toBeDefined();'));
    assert.ok(ruleIds(weakened).includes('assertion-weakened'));
    assert.equal(weakened.find((x) => x.rule === 'assertion-weakened').action, 'warn');
  });

  test('changed expectations are recorded quietly in standard mode', async () => {
    const f = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace('toEqual(3)', 'toEqual(4)'));
    const e = f.find((x) => x.rule === 'expectation-changed');
    assert.ok(e);
    assert.equal(e.action, 'info');
  });

  test('gutting a test file is blocked', async () => {
    const f = await scan('tests/math.test.js', JS_TEST, "import { test } from 'vitest';\n", 'standard');
    assert.ok(ruleIds(f).includes('test-file-gutted'));
  });

  test('adding new tests and assertions is clean', async () => {
    const more = JS_TEST + "\ntest('handles zero', () => {\n  expect(add(0, 0)).toEqual(0);\n});\n";
    assert.deepEqual(await scan('tests/math.test.js', JS_TEST, more), []);
  });
});

describe('production code shortcuts', () => {
  test('special-casing the test environment is blocked', async () => {
    for (const [file, line] of [
      ['src/pay.js', "  if (process.env.NODE_ENV === 'test') return { ok: true };"],
      ['src/pay.ts', '  if (process.env.VITEST) return mockResult;'],
      ['app/pay.py', "    if 'pytest' in sys.modules:"],
      ['pay/pay.go', '\tif testing.Testing() {'],
      ['app/models/pay.rb', '    return true if Rails.env.test?'],
    ]) {
      const f = await scan(file, 'a\n', `a\n${line}\n`);
      assert.ok(ruleIds(f).includes('test-env-special-case'), `${file} → ${ruleIds(f)}`);
    }
  });

  test('the same check in test setup files is fine', async () => {
    const f = await scan('jest.setup.js', 'a\n', "a\nif (process.env.NODE_ENV === 'test') setup();\n");
    assert.ok(!ruleIds(f).includes('test-env-special-case'));
  });

  test('elided "existing code" placeholders are blocked', async () => {
    for (const line of ['  // ... existing code ...', '# rest of the implementation unchanged', '  /* ... */', '  // … rest of file remains the same …', '    {/* ...existing JSX... */}']) {
      const f = await scan('src/app.js', 'a\nb\nc\n', `a\n${line}\n`);
      assert.ok(ruleIds(f).includes('elided-code'), `${line} → ${ruleIds(f)}`);
    }
  });

  test('placeholders and stubs', async () => {
    const p = await scan('src/app.js', 'a\n', 'a\nfunction pay() {\n  // TODO: implement\n}\n');
    assert.ok(ruleIds(p).includes('placeholder-code'));
    const n = await scan('app/x.py', 'a\n', 'a\ndef pay():\n    raise NotImplementedError\n');
    assert.ok(ruleIds(n).includes('not-implemented'));
    const abstract = await scan('app/x.py', 'a\n', 'a\nclass Base(ABC):\n    @abstractmethod\n    def pay(self):\n        raise NotImplementedError\n');
    assert.ok(!ruleIds(abstract).includes('not-implemented'));
  });

  test('suppressions', async () => {
    const cases = [
      ['src/a.ts', '  // @ts-ignore', 'type-suppression'],
      ['src/a.ts', '  // @ts-expect-error', 'type-suppression'],
      ['app/a.py', 'x = f()  # type: ignore', 'type-suppression'],
      ['src/a.js', '  // eslint-disable-next-line no-unused-vars', 'lint-suppression'],
      ['app/a.py', 'import os  # noqa', 'lint-suppression'],
      ['src/lib.rs', '#[allow(dead_code)]', 'lint-suppression'],
      ['src/a.js', '  /* istanbul ignore next */', 'coverage-exclusion'],
      ['app/a.py', '    pass  # pragma: no cover', 'coverage-exclusion'],
    ];
    for (const [file, line, rule] of cases) {
      const f = await scan(file, 'a\n', `a\n${line}\n`);
      assert.ok(ruleIds(f).includes(rule), `${line} → ${ruleIds(f)}`);
    }
  });

  test('swallowed errors, single and multi-line', async () => {
    assert.ok(ruleIds(await scan('src/a.js', 'a\n', 'a\ntry { run(); } catch (e) {}\n')).includes('swallowed-error'));
    assert.ok(ruleIds(await scan('src/a.js', 'a\n', 'a\npromise.catch(() => {});\n')).includes('swallowed-error'));
    assert.ok(ruleIds(await scan('src/a.js', 'a\n', 'a\ntry {\n  run();\n} catch (err) {\n  // ignore\n}\n')).includes('swallowed-error'));
    assert.ok(ruleIds(await scan('app/a.py', 'a\n', 'a\ntry:\n    run()\nexcept Exception:\n    pass\n')).includes('swallowed-error'));
    // a comment that gives a reason marks the swallow as intentional; a bare "ignore" does not
    assert.ok(!ruleIds(await scan('src/a.js', 'a\n', 'a\ntry { fs.unlinkSync(tmp); } catch { /* best effort: the file may already be gone */ }\n')).includes('swallowed-error'));
    assert.ok(!ruleIds(await scan('src/a.js', 'a\n', 'a\ntry {\n  run();\n} catch (err) {\n  // optional plugin, not installed everywhere\n}\n')).includes('swallowed-error'));
    assert.ok(ruleIds(await scan('src/a.js', 'a\n', 'a\ntry { run(); } catch { /* ignore errors */ }\n')).includes('swallowed-error'));
    assert.ok(!ruleIds(await scan('app/a.py', 'a\n', 'a\ntry:\n    import yaml\nexcept ImportError:\n    pass  # optional dependency, YAML support is disabled\n')).includes('swallowed-error'));
    const handled = await scan('src/a.js', 'a\n', 'a\ntry {\n  run();\n} catch (err) {\n  logger.error(err);\n  throw err;\n}\n');
    assert.ok(!ruleIds(handled).includes('swallowed-error'));
  });

  test('replacing an except body with pass is caught', async () => {
    const before = 'try:\n    run()\nexcept ValueError as e:\n    log(e)\n    raise\n';
    const after = 'try:\n    run()\nexcept ValueError as e:\n    pass\n';
    assert.ok(ruleIds(await scan('app/a.py', before, after)).includes('swallowed-error'));
  });

  test('debugger leftovers', async () => {
    assert.ok(ruleIds(await scan('src/a.js', 'a\n', 'a\n  debugger;\n')).includes('debug-leftover'));
    assert.ok(ruleIds(await scan('app/a.py', 'a\n', 'a\n    breakpoint()\n')).includes('debug-leftover'));
  });
});

describe('build and CI configuration', () => {
  test('neutering the test script in package.json is blocked', async () => {
    const before = JSON.stringify({ scripts: { test: 'jest' } }, null, 2);
    for (const script of ['jest || true', 'echo ok', 'exit 0', 'jest --passWithNoTests']) {
      const f = await scan('package.json', before, JSON.stringify({ scripts: { test: script } }, null, 2));
      assert.ok(ruleIds(f).includes('test-script-neutered'), script);
    }
    const removed = await scan('package.json', before, JSON.stringify({ scripts: {} }, null, 2));
    assert.ok(ruleIds(removed).includes('test-script-neutered'));
    const fine = await scan('package.json', before, JSON.stringify({ scripts: { test: 'vitest run' } }, null, 2));
    assert.deepEqual(ruleIds(fine), []);
  });

  test('weakening CI is blocked', async () => {
    const wf = 'jobs:\n  test:\n    steps:\n      - run: npm test\n';
    assert.ok(ruleIds(await scan('.github/workflows/ci.yml', wf, wf.replace('npm test', 'npm test || true'))).includes('ci-weakened'));
    assert.ok(ruleIds(await scan('.github/workflows/ci.yml', wf, wf + '        continue-on-error: true\n')).includes('ci-weakened'));
    assert.ok(ruleIds(await scan('.github/workflows/ci.yml', wf, 'jobs:\n  test:\n    steps:\n      - run: echo skip\n')).includes('ci-weakened'));
  });

  test('relaxing compiler and coverage configuration', async () => {
    const ts = '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n';
    assert.ok(ruleIds(await scan('tsconfig.json', ts, ts.replace('"strict": true', '"strict": false'))).includes('checks-config-weakened'));
    const cov = 'coverageThreshold: { global: { lines: 90 } },\n';
    assert.ok(ruleIds(await scan('jest.config.js', cov, cov.replace('90', '60'))).includes('checks-config-weakened'));
  });

  test('retries added to tests are reported', async () => {
    assert.ok(ruleIds(await scan('tests/a.test.js', 'a\n', 'a\njest.retryTimes(3);\n')).includes('flaky-retry'));
  });
});

describe('suppression and modes', () => {
  test('veridone-allow comments suppress a specific rule', async () => {
    const f = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace("test('handles negatives'", "// veridone-allow: test-skip upstream bug #123\ntest.skip('handles negatives'"));
    assert.deepEqual(ruleIds(f), []);
    const other = await scan('tests/math.test.js', JS_TEST, JS_TEST.replace("test('handles negatives'", "// veridone-allow: lint-suppression\ntest.skip('handles negatives'"));
    assert.deepEqual(ruleIds(other), ['test-skip']);
  });

  test('actions follow the mode', async () => {
    assert.equal(actionFor('test-skip', await config('strict')), 'block');
    assert.equal(actionFor('test-skip', await config('relaxed')), 'warn');
    assert.equal(actionFor('lint-suppression', await config('strict')), 'block');
    assert.equal(actionFor('lint-suppression', await config('standard')), 'warn');
    assert.equal(actionFor('test-skip', await config('off')), 'off');
    assert.equal(actionFor('test-skip', await config('standard', { integrity: { rules: { 'test-skip': 'warn' } } })), 'warn');
  });

  test('ignored paths and docs are not scanned', async () => {
    assert.deepEqual(await scan('README.md', 'a\n', 'a\n// ... existing code ...\ntest.skip("x")\n'), []);
    assert.deepEqual(await scan('node_modules/x/index.js', 'a\n', 'a\n// @ts-ignore\n'), []);
  });

  test('formatFindings is readable and bounded', async () => {
    const f = await scan('src/a.ts', 'a\n', 'a\n// @ts-ignore\n// @ts-nocheck\n// eslint-disable\n');
    const text = formatFindings(f, 'src/a.ts', { max: 2 });
    assert.match(text, /\[type-suppression\] src\/a\.ts:2/);
    assert.match(text, /…and 1 more/);
  });
});

describe('team rules (Pro)', () => {
  const rules = {
    integrity: {
      customRules: [
        { id: 'no-raw-sql', pattern: 'db\\.raw\\(', paths: ['src/**'], severity: 'high', message: 'Raw SQL bypasses the query builder.', fix: 'Use the repository layer.' },
        { id: 'no-moment', pattern: "from ['\"]moment['\"]", severity: 'low', message: 'moment is deprecated here.' },
        { id: 'broken', pattern: '([unclosed', message: 'invalid regex is ignored' },
      ],
    },
  };
  test('custom patterns produce findings with their own severity', async () => {
    const f = await scan('src/repo.js', 'a\n', "a\nconst rows = db.raw('select 1');\nimport m from 'moment';\n", 'standard', rules);
    const byRule = Object.fromEntries(f.map((x) => [x.rule, x]));
    assert.equal(byRule['custom:no-raw-sql'].action, 'block');
    assert.equal(byRule['custom:no-raw-sql'].line, 2);
    assert.equal(byRule['custom:no-moment'].action, 'info');
  });
  test('path scoping and veridone-allow apply', async () => {
    assert.deepEqual(ruleIds(await scan('scripts/seed.js', 'a\n', "a\ndb.raw('x')\n", 'standard', rules)), []);
    assert.deepEqual(ruleIds(await scan('src/repo.js', 'a\n', "a\n// veridone-allow: no-raw-sql migration helper\ndb.raw('x')\n", 'standard', rules)), []);
  });
});
