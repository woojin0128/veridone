// Veridone — integrity scanner: catches the ways an AI agent "makes it pass"
// instead of making it work. Runs on the lines an edit ADDS (and, for some
// rules, the lines it removes), so pre-existing code never triggers findings.

import path from 'node:path';
import { ruleLevel } from './config.mjs';
import { matchGlob, toPosix, safeJsonParse } from './util.mjs';
import { isTestPath } from './guard.mjs';

/** severity: high | medium | low. action per mode is derived in actionFor(). */
export const INTEGRITY_RULES = {
  'test-skip': { severity: 'high', title: 'Test disabled or skipped' },
  'test-focus': { severity: 'high', title: 'Focused test (.only) silently disables the rest of the suite' },
  'trivial-assertion': { severity: 'high', title: 'Tautological assertion' },
  'test-file-gutted': { severity: 'high', title: 'Test file emptied' },
  'assertions-removed': { severity: 'medium', title: 'Assertions removed from tests' },
  'assertion-weakened': { severity: 'medium', title: 'Assertion weakened' },
  'expectation-changed': { severity: 'low', title: 'Expected value in a test changed' },
  'test-env-special-case': { severity: 'high', title: 'Production code special-cases the test environment' },
  'elided-code': { severity: 'high', title: 'Real code replaced by an "… existing code …" placeholder' },
  'placeholder-code': { severity: 'high', title: 'Placeholder left instead of an implementation' },
  'not-implemented': { severity: 'medium', title: 'Stub left unimplemented' },
  'type-suppression': { severity: 'medium', title: 'Type checker suppressed' },
  'lint-suppression': { severity: 'medium', title: 'Linter suppressed' },
  'coverage-exclusion': { severity: 'medium', title: 'Code excluded from coverage' },
  'swallowed-error': { severity: 'medium', title: 'Error swallowed silently' },
  'test-script-neutered': { severity: 'high', title: 'Test command neutralized' },
  'ci-weakened': { severity: 'high', title: 'CI checks weakened' },
  'checks-config-weakened': { severity: 'medium', title: 'Lint/type/test configuration weakened' },
  'flaky-retry': { severity: 'medium', title: 'Retries added to mask a flaky test' },
  'large-deletion': { severity: 'medium', title: 'Large block of code removed' },
  'debug-leftover': { severity: 'medium', title: 'Debugger statement left in code' },
  'console-log': { severity: 'low', title: 'console.log left in source' },
  'any-cast': { severity: 'low', title: 'Type safety bypassed with any' },
};

/** Mode × severity → action. Users can override per rule with integrity.rules. */
const ACTION_TABLE = {
  strict: { high: 'block', medium: 'block', low: 'warn' },
  standard: { high: 'block', medium: 'warn', low: 'info' },
  relaxed: { high: 'warn', medium: 'info', low: 'off' },
  off: { high: 'off', medium: 'off', low: 'off' },
};

export function actionFor(ruleId, cfg, severity = null) {
  if (!cfg || cfg.mode === 'off' || cfg.integrity?.enabled === false) return 'off';
  const o = cfg.integrity?.rules?.[ruleId];
  if (typeof o === 'string') return o;
  const sev = severity || INTEGRITY_RULES[ruleId]?.severity || 'low';
  return (ACTION_TABLE[cfg.mode] || ACTION_TABLE.standard)[sev] || 'warn';
}

/**
 * Team-specific patterns from `integrity.customRules` (Veridone Pro):
 * { id, pattern, flags?, paths?, exclude?, severity?, message, fix? } — matched against added lines.
 */
function compileCustomRules(cfg) {
  const out = [];
  for (const r of cfg.integrity?.customRules || []) {
    if (!r || typeof r.pattern !== 'string' || !r.id) continue;
    try {
      out.push({
        id: `custom:${String(r.id).replace(/^custom:/, '')}`,
        re: new RegExp(r.pattern, String(r.flags || '').replace(/[^imsu]/g, '')),
        paths: Array.isArray(r.paths) ? r.paths : r.paths ? [r.paths] : null,
        exclude: Array.isArray(r.exclude) ? r.exclude : r.exclude ? [r.exclude] : null,
        severity: ['high', 'medium', 'low'].includes(r.severity) ? r.severity : 'medium',
        title: r.title || r.message || r.id,
        message: r.message || `Matches the team rule "${r.id}".`,
        fix: r.fix || 'Follow the team rule, or ask the user before keeping this change.',
      });
    } catch { /* invalid regex: ignored (reported by veridone doctor) */ }
  }
  return out;
}

const EXT_LANG = {
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js', astro: 'js',
  py: 'py', pyi: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', kts: 'java', scala: 'java', groovy: 'java',
  cs: 'cs', fs: 'cs', rb: 'rb', php: 'php', swift: 'swift', c: 'c', cc: 'c', cpp: 'c', cxx: 'c', h: 'c', hpp: 'c', hh: 'c',
  dart: 'dart', ex: 'ex', exs: 'ex', lua: 'lua', sh: 'sh', bash: 'sh', zsh: 'sh',
};

export function langOf(p) {
  const base = path.basename(p || '').toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return EXT_LANG[ext] || null;
}

const TS_LIKE = /\.(ts|tsx|mts|cts|vue|svelte)$/i;
const DOC_FILE = /\.(md|mdx|rst|txt|adoc|org)$/i;
const CONFIG_LIKE = /(^|\/)(config|configs|settings)\/|\.config\.[cm]?[jt]s$|(^|\/)(jest|vitest|playwright|karma|webpack|vite|rollup|babel|next|nuxt|astro|svelte|tailwind|postcss|eslint)\.config|(^|\/)(setupTests|test-utils|testUtils|jest\.setup|vitest\.setup|conftest)\.|(^|\/)\.env/i;

// ---------------------------------------------------------------------------
// Pattern tables
// ---------------------------------------------------------------------------

const SKIP_PATTERNS = {
  js: [/\b(it|test|describe|context|suite|specify|bench)\.skip\s*[(.]/, /\b(xit|xtest|xdescribe|xcontext|xspecify)\s*\(/, /\bthis\.skip\s*\(\s*\)/, /\bpending\s*\(\s*\)/, /\btest\.fixme\s*\(/],
  py: [/@(pytest\.mark\.)?skip(if|_if|Unless)?\b/, /@unittest\.skip/, /\bpytest\.skip\s*\(/, /\bself\.skipTest\s*\(/, /@pytest\.mark\.xfail\b/, /\braise\s+(unittest\.)?SkipTest\b/],
  go: [/\bt\.Skip(f|Now)?\s*\(/, /\bb\.Skip(f|Now)?\s*\(/],
  rs: [/#\[\s*ignore\b/],
  java: [/@Disabled\b/, /@Ignore\b/, /\bassumeTrue\s*\(\s*false\s*\)/, /@Test\s*\(\s*enabled\s*=\s*false/],
  cs: [/\[\s*Ignore\b/, /\[\s*(Fact|Theory|Test|TestMethod)\s*\(\s*Skip\s*=/, /\bAssert\.Inconclusive\s*\(/],
  rb: [/^\s*(xit|xdescribe|xcontext|xspecify|xscenario)\b/, /^\s*skip\b(\s*\(|\s+["'])?/, /^\s*pending\b(\s*\(|\s+["'])?/],
  php: [/->markTestSkipped\s*\(/, /->markTestIncomplete\s*\(/, /@group\s+skip/],
  swift: [/\bthrow\s+XCTSkip\b/, /\bXCTSkip(If|Unless)?\s*\(/],
  dart: [/\bskip\s*:\s*(true|['"])/],
  ex: [/@tag\s+:skip\b/, /@tag\s+skip\s*:/, /@moduletag\s+:skip\b/],
  c: [/\bTEST(_F|_P)?\s*\(\s*\w+\s*,\s*DISABLED_/, /\bGTEST_SKIP\s*\(/],
};

const FOCUS_PATTERNS = {
  js: [/\b(it|test|describe|context|suite|specify)\.only\s*\(/, /\b(fit|fdescribe|fcontext)\s*\(/],
  rb: [/^\s*(fit|fdescribe|fcontext)\b/, /,\s*focus:\s*true/, /:focus\b/],
  ex: [/@tag\s+:focus\b/],
  dart: [/\bsolo\s*:\s*true/],
};

const TRIVIAL_ASSERT = [
  /\bexpect\s*\(\s*(true|false|null|undefined|\d+|'[^']*'|"[^"]*")\s*\)\s*\.\s*(toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/,
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*toBeTruthy\s*\(\s*\)/,
  /\bexpect\s*\(\s*false\s*\)\s*\.\s*toBeFalsy\s*\(\s*\)/,
  /\bexpect\s*\(\s*true\s*\)\s*\.\s*to\s*\.\s*(be\s*\.\s*true|equal\s*\(\s*true\s*\))/,
  /\bassert(\.ok)?\s*\(\s*true\s*\)/,
  /\bassert\.(equal|strictEqual|deepEqual|deepStrictEqual)\s*\(\s*(true|\d+|'[^']*'|"[^"]*")\s*,\s*\2\s*\)/,
  /^\s*assert\s+True\s*(#.*)?$/,
  /^\s*assert\s+(\d+)\s*==\s*\1\s*(#.*)?$/,
  /\bself\.assertTrue\s*\(\s*True\s*\)/,
  /\bself\.assert(Equal|Equals)\s*\(\s*(True|\d+|'[^']*'|"[^"]*")\s*,\s*\2\s*\)/,
  /\bassertTrue\s*\(\s*true\s*\)/,
  /\bassertEquals?\s*\(\s*(\d+|"[^"]*"|true)\s*,\s*\1\s*\)/,
  /\bassert!\s*\(\s*true\s*\)/,
  /\bassert_eq!\s*\(\s*(\d+|true|"[^"]*")\s*,\s*\1\s*\)/,
  /\bAssert\.(IsTrue|True)\s*\(\s*true\s*\)/,
  /\bexpect\s*\(\s*true\s*\)\s*\.to\s+(be|eq)\b\s*\(?\s*true/,
  /\bXCTAssertTrue\s*\(\s*true\s*\)/,
  /\bassert\.True\s*\(\s*t\s*,\s*true\s*\)/,
  /\brequire\.True\s*\(\s*t\s*,\s*true\s*\)/,
];

const ASSERTION_RE = /\b(expect|assert\w*|should\b|\.should\.|must\w*|require\.\w+|t\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)|Assert\.\w+|XCTAssert\w*|EXPECT_\w+|ASSERT_\w+|REQUIRE\w*\s*\(|CHECK\w*\s*\(|assert_eq!|assert_ne!|assert!|verify\s*\(|expectThat|assertThat|then\s*\()\b|\bexpect\b/;
const TEST_DECL_RE = /\b(it|test|describe|context|specify)\s*\(|\bdef\s+test_\w+|\bfunc\s+(Test|Benchmark|Fuzz)\w*\s*\(|#\[\s*test\s*\]|@Test\b|\[\s*(Fact|Theory|Test|TestMethod)\b|\bfunction\s+test\w*\s*\(|\bpublic\s+function\s+test|\bfunc\s+test\w+\s*\(|\btest\s+['"]|\bscenario\s+['"]/;

const STRONG_MATCHER = /\.(toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveBeenNthCalledWith|toHaveLength|toContain|toContainEqual|toMatch|toMatchInlineSnapshot)\s*\(|\.toThrow\(\s*\S|assert(Equal|Equals|Same|CountEqual|DictEqual|ListEqual|Raises)\b|assert_eq!|assert_ne!|\bassert\s+[^=]+==|\bEqual\s*\(\s*t\s*,|require\.Equal|assertThat\(.*\)\.(isEqualTo|containsExactly)|\.to\s*\.\s*(equal|eql|deep)/;
const WEAK_MATCHER = /\.(toBeDefined|toBeTruthy|toBeFalsy|toBeInstanceOf|toHaveBeenCalled|toBeGreaterThan\s*\(\s*0|not\s*\.\s*(toBeNull|toBeUndefined|toThrow))\s*\(|expect\.anything\(\)|assertIsNotNone|assertTrue\s*\(\s*\w+\s*\)\s*$|\bassert\s+\w+\s*(#.*)?$|\bassert\s+\w+\s+is\s+not\s+None|\bNotNil\s*\(|\bassert!\s*\(\s*\w+\.is_(some|ok)\(\)\s*\)|\.to\s*\.\s*(exist|be\s*\.\s*ok)\b/;

const TEST_ENV = {
  js: [
    /process\.env\.NODE_ENV\s*[!=]==?\s*['"`]test['"`]/,
    /['"`]test['"`]\s*[!=]==?\s*process\.env\.NODE_ENV/,
    /process\.env\.(JEST_WORKER_ID|VITEST|VITEST_WORKER_ID|VITEST_POOL_ID|MOCHA_WORKER_ID|PLAYWRIGHT_TEST_BASE_URL)\b/,
    /typeof\s+(jest|vi|describe|it|expect)\s*[!=]==?\s*['"]undefined['"]/,
    /import\.meta\.env\.(VITEST|MODE\s*[!=]==?\s*['"]test['"])/,
    /globalThis\.__vitest|\bprocess\.env\.__TEST__/,
  ],
  py: [/['"]pytest['"]\s+in\s+sys\.modules/, /PYTEST_CURRENT_TEST/, /sys\.argv\[0\][^\n]*pytest/, /['"]unittest['"]\s+in\s+sys\.modules/],
  go: [/\btesting\.Testing\s*\(\s*\)/, /flag\.Lookup\s*\(\s*"test\.v"\s*\)/, /HasSuffix\s*\(\s*os\.Args\[0\]\s*,\s*"\.test"\s*\)/],
  rs: [/\bcfg!\s*\(\s*test\s*\)/],
  rb: [/ENV\[['"]RAILS_ENV['"]\]\s*==\s*['"]test['"]/, /\bRails\.env\.test\?/],
  php: [/->environment\(\s*['"]testing['"]\s*\)|App::environment\(\s*['"]testing['"]\s*\)|runningUnitTests\s*\(\s*\)/],
  java: [/System\.getProperty\(\s*"(junit|surefire)|isRunningTests?\s*\(\s*\)/],
  cs: [/IsRunningInUnitTest|AppDomain\.CurrentDomain\.GetAssemblies\(\)\.Any\([^)]*xunit/i],
};

const ELIDED = [
  /^\s*(\/\/|#|--|;|\*|\/\*+|<!--|%)\s*(\.{3}|…)\s*(\*\/|-->)?\s*$/,
  /^\s*(\/\/|#|--|;|\*|\/\*+|<!--|%|\{\/\*)\s*(\.{3}|…)?\s*\[?\s*(the\s+)?(rest|remainder|remaining|existing|previous|other|original|unchanged|same|more|additional|all(\s+other)?)\s+(of\s+(the\s+)?)?(code|implementation|methods?|functions?|content|contents|logic|imports|tests?|file|properties|fields|cases|lines|config(uration)?|components?|routes|handlers|styles|markup|body)\b[^\n]{0,60}(\.{3}|…|unchanged|remains?|here|omitted|as\s+(before|is)|same|stays|below|above)?/i,
  /^\s*(\/\/|#|--|\/\*+|<!--)\s*(\.{3}|…)\s*\w[^\n]{0,60}(\.{3}|…)\s*(\*\/|-->)?\s*$/,
  /^\s*(\/\/|#|--|\/\*+)\s*(code|implementation|content|logic)\s+(unchanged|omitted|remains?\s+the\s+same|stays\s+the\s+same|as\s+before)\b/i,
  /^\s*\{\s*\/\*\s*\.\.\.\s*(existing|rest|other)[^*]*\*\/\s*\}\s*$/i,
];

const PLACEHOLDER = [
  /\bTODO\b[:\s-]*(implement|add\s+(the\s+)?implementation|fill\s+(this\s+)?in|write\s+(the\s+)?(code|logic)|finish\s+(this|implementation))/i,
  /\b(your|the)\s+(code|implementation|logic)\s+(goes\s+)?here\b/i,
  /\bimplement(ation)?\s+(goes\s+)?here\b/i,
  /\bplaceholder\s+(implementation|logic|code|return|value)\b/i,
  /throw\s+new\s+(Error|TypeError)\s*\(\s*['"`](not\s+(yet\s+)?implemented|TODO|unimplemented|implement\s+me)/i,
  /\bpanic\s*\(\s*"(not\s+(yet\s+)?implemented|TODO|unimplemented|implement\s+me)/i,
  /\bfatalError\s*\(\s*"(not\s+(yet\s+)?implemented|TODO|unimplemented)/i,
  /\bpass\s*#\s*(TODO|FIXME|implement)/i,
  /\breturn\s+(null|None|nil|undefined|0|false|\[\]|\{\}|""|'')\s*;?\s*(\/\/|#)\s*(TODO|FIXME|placeholder|stub|implement)/i,
];

const NOT_IMPL = [
  /\braise\s+NotImplementedError\b/,
  /\bunimplemented!\s*\(/,
  /\btodo!\s*\(/,
  /\bthrow\s+new\s+(NotImplementedException|UnsupportedOperationException)\s*\(/,
  /\bNotImplementedError\s*\(/,
];

const TYPE_SUPPRESS = [
  [/@ts-ignore\b/, '@ts-ignore'], [/@ts-nocheck\b/, '@ts-nocheck'], [/@ts-expect-error\b/, '@ts-expect-error'],
  [/#\s*type:\s*ignore\b/, '# type: ignore'], [/#\s*pyright:\s*ignore\b/, '# pyright: ignore'], [/#\s*mypy:\s*ignore-errors/, '# mypy: ignore-errors'],
  [/@phpstan-ignore/, '@phpstan-ignore'], [/@psalm-suppress\b/, '@psalm-suppress'], [/\/\/\s*@flow\s+weak/, '@flow weak'],
  [/\$FlowFixMe|\$FlowIgnore/, '$FlowFixMe'], [/#\s*pyre-(ignore|fixme)/, 'pyre-ignore'],
];

const LINT_SUPPRESS = [
  [/eslint-disable(-next-line|-line)?\b/, 'eslint-disable'], [/biome-ignore\b/, 'biome-ignore'], [/oxlint-disable/, 'oxlint-disable'],
  [/#\s*noqa\b/, '# noqa'], [/#\s*pylint:\s*disable/, '# pylint: disable'], [/#\s*ruff:\s*noqa/, '# ruff: noqa'],
  [/\/\/\s*nolint\b/, '//nolint'], [/#!?\[\s*allow\s*\(/, '#[allow(...)]'], [/@SuppressWarnings\s*\(/, '@SuppressWarnings'],
  [/#pragma\s+warning\s+disable/, '#pragma warning disable'], [/rubocop:\s*disable/, 'rubocop:disable'], [/swiftlint:\s*disable/, 'swiftlint:disable'],
  [/deno-lint-ignore/, 'deno-lint-ignore'], [/stylelint-disable/, 'stylelint-disable'], [/#\s*shellcheck\s+disable/, 'shellcheck disable'],
  [/\/\/\s*NOLINT/, '// NOLINT'], [/#\s*nosec\b|\/\/\s*#nosec/, '# nosec'], [/@SuppressLint\s*\(/, '@SuppressLint'],
];

const COVERAGE_EXCL = [
  [/istanbul\s+ignore/, 'istanbul ignore'], [/\bc8\s+ignore/, 'c8 ignore'], [/\bv8\s+ignore/, 'v8 ignore'], [/#\s*pragma:\s*no\s*cover/, 'pragma: no cover'],
  [/@codeCoverageIgnore/, '@codeCoverageIgnore'], [/\[\s*ExcludeFromCodeCoverage/, '[ExcludeFromCodeCoverage]'], [/coverage:\s*ignore/, 'coverage:ignore'],
  [/#\[\s*coverage\s*\(\s*off\s*\)\s*\]|cfg\s*\(\s*not\s*\(\s*tarpaulin/, 'coverage(off)'],
];

const SWALLOW = {
  js: [/\bcatch\s*(\(\s*[\w$]*\s*(:\s*\w+)?\s*\))?\s*\{\s*(\/\/[^\n]*|\/\*[^*]*\*\/)?\s*\}/, /\.catch\s*\(\s*(\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(\{\s*\}|null|undefined|void\s+0|false)\s*\)/, /\.catch\s*\(\s*(noop|\(\)\s*=>\s*\{\s*\})\s*\)/],
  py: [/^\s*except\s*(\(?\s*(Exception|BaseException)[\w\s,()]*\)?)?\s*(as\s+\w+)?\s*:\s*(pass|\.\.\.)\s*(#.*)?$/],
  java: [/\bcatch\s*\([^)]*\)\s*\{\s*\}/],
  cs: [/\bcatch\s*(\([^)]*\))?\s*\{\s*\}/],
  php: [/\bcatch\s*\([^)]*\)\s*\{\s*\}/],
  go: [/^\s*_\s*=\s*err\s*$/, /if\s+err\s*!=\s*nil\s*\{\s*\}/],
  rb: [/\brescue\s*(=>\s*\w+)?\s*;?\s*(nil|end)\s*$/, /\brescue\s+nil\b/],
  swift: [/\bcatch\s*\{\s*\}/],
  dart: [/\bcatch\s*\([^)]*\)\s*\{\s*\}/, /\bon\s+\w+\s+catch\s*\([^)]*\)\s*\{\s*\}/],
  kt: [],
};

const SWALLOW_MESSAGE = 'An error is caught and silently discarded, so failures disappear instead of surfacing.';
const SWALLOW_FIX = 'Handle the error, log it with context, or let it propagate. If ignoring it is intended, say why in the comment (e.g. `// best effort: the cache is optional`).';
const SWALLOW_FILLER = /\b(ignored?|ignoring|noop|no-op|empty|nothing|swallow(?:ed|s)?|silence|silent|todo|fixme|xxx|errors?|exceptions?|err|e|ex|it|this|here|for|now|just)\b/giu;

/** Comment text on a line (// …, /* … *\/, # …), or ''. */
function commentIn(line) {
  const m = /(\/\/.*$|\/\*.*?(\*\/|$)|#.*$)/.exec(String(line || ''));
  return m ? m[1] : '';
}

/** Does a comment actually explain why swallowing the error is fine? ("// ignore" does not.) */
export function explainsSwallow(comment) {
  const text = String(comment || '')
    .replace(/\/\/|\/\*|\*\/|#|\*/g, ' ')
    .replace(SWALLOW_FILLER, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return text ? text.split(/\s+/).length >= 2 : false;
}

const DEBUGGER = {
  js: [/^\s*debugger\s*;?\s*$/],
  py: [/\bbreakpoint\s*\(\s*\)/, /\b(i?pdb|pudb)\.set_trace\s*\(/, /^\s*import\s+(i?pdb|pudb)\b/],
  rb: [/\bbinding\.(pry|irb)\b/, /^\s*byebug\b/, /^\s*debugger\b/],
  rs: [/\bdbg!\s*\(/],
  php: [/\b(var_dump|dd|dump|ray)\s*\(/, /\bdie\s*\(\s*(var_dump|print_r)/],
  ex: [/\bIEx\.pry\b/, /\bIO\.inspect\b/],
  swift: [/^\s*raise\(SIGINT\)/],
};

const FLAKY = [/\bjest\.retryTimes\s*\(/, /\bretries\s*:\s*[1-9]/, /@pytest\.mark\.flaky\b/, /@flaky\b/, /--reruns\b/, /\bthis\.retries\s*\(\s*[1-9]/, /\brerunFailingTestsCount\b/, /@RetryingTest\b|@Retry\b/, /\bretry\s*:\s*[1-9]/];

const CI_FILE = /(^|\/)(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|Jenkinsfile|\.travis\.ya?ml|\.buildkite\/.+\.ya?ml|\.drone\.ya?ml|cloudbuild\.ya?ml|\.woodpecker\.ya?ml|codemagic\.ya?ml)$/i;
const CHECK_CMD = /\b(test|tests|lint|typecheck|type-check|tsc|pytest|tox|nox|go\s+(test|vet)|cargo\s+(test|clippy|check)|jest|vitest|mocha|rspec|phpunit|eslint|ruff|mypy|pyright|golangci-lint|check|verify|gradle\w*\s+(test|check)|mvn\s+(test|verify)|dotnet\s+test|swift\s+test|flake8|pylint|biome|clippy)\b/i;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * @typedef {{rule:string, severity:string, action:string, title:string, line:number|null, text:string, message:string, fix:string}} Finding
 */

/**
 * Scan an edit.
 * @param {{path:string, added:{line:number,text:string}[], removed:{line:number,text:string}[], oldContent?:string|null, newContent?:string|null, tool?:string}} edit
 * @param {any} cfg effective config
 * @returns {Finding[]}
 */
export function scanEdit(edit, cfg) {
  const p = toPosix(edit.path || '');
  const findings = [];
  if (!cfg || cfg.mode === 'off' || cfg.integrity?.enabled === false) return findings;
  if (matchGlob(p, cfg.integrity?.ignore || [])) return findings;
  if (DOC_FILE.test(p)) return findings;
  const lang = langOf(p);
  const isTest = isTestPath(p);
  const base = path.basename(p);
  const added = edit.added || [];
  const removed = edit.removed || [];
  const newLines = edit.newContent != null ? String(edit.newContent).split(/\r?\n/) : null;

  const push = (rule, line, text, message, fix, meta = INTEGRITY_RULES[rule]) => {
    const action = actionFor(rule, cfg, meta.severity);
    if (action === 'off') return;
    if (line != null && newLines && isAllowed(newLines, line, rule)) return;
    if (line == null && text && /veridone-allow/.test(text) && allowCovers(text, rule)) return;
    findings.push({ rule, severity: meta.severity, action, title: meta.title, line: line ?? null, text: String(text || '').trim().slice(0, 200), message, fix });
  };

  const scanLines = (patterns, rule, message, fix, filter = () => true) => {
    if (!patterns) return;
    for (const a of added) {
      if (!filter(a)) continue;
      for (const re of patterns) {
        const m = re.exec(a.text);
        // `"it.skip(…)"` inside a string literal is text (docs, fixtures, messages), not code
        if (m && !(lang && insideStringLiteral(a.text, m.index, lang))) { push(rule, a.line, a.text, message, fix); break; }
      }
    }
  };

  // --- tests ---------------------------------------------------------------
  if (lang) {
    scanLines(SKIP_PATTERNS[lang], 'test-skip', 'This edit disables a test. A skipped test hides the failure instead of fixing it.', 'Make the test pass by fixing the code. If the test itself is wrong, fix the test; only skip with the user\'s approval and a `veridone-allow: test-skip <reason>` comment.');
    scanLines(FOCUS_PATTERNS[lang], 'test-focus', 'This edit focuses one test (.only/fit), so the rest of the suite silently stops running.', 'Remove .only/fit before finishing.');
  }
  if (isTest) {
    scanLines([TRIVIAL_ASSERT].flat(), 'trivial-assertion', 'This assertion is always true, so the test cannot fail.', 'Assert on the real result of the code under test.');
    // assertion accounting
    const aRemoved = removed.filter((r) => ASSERTION_RE.test(r.text) && !/^\s*(\/\/|#)/.test(r.text)).length;
    const aAdded = added.filter((r) => ASSERTION_RE.test(r.text) && !/^\s*(\/\/|#)/.test(r.text)).length;
    const tRemoved = removed.filter((r) => TEST_DECL_RE.test(r.text)).length;
    const tAdded = added.filter((r) => TEST_DECL_RE.test(r.text)).length;
    if (aRemoved > aAdded && aRemoved >= 1 && edit.tool !== 'Write-new') {
      const net = aRemoved - aAdded;
      push('assertions-removed', added[0]?.line ?? removed[0]?.line ?? null, removed.find((r) => ASSERTION_RE.test(r.text))?.text || '', `This edit removes ${net} assertion${net > 1 ? 's' : ''}${tRemoved > tAdded ? ` and ${tRemoved - tAdded} test case${tRemoved - tAdded > 1 ? 's' : ''}` : ''} from ${base}.`, 'Keep the assertions. If they were wrong, replace them with correct ones and say so explicitly in your summary.');
    }
    // weakened matchers
    const strongRemoved = removed.filter((r) => STRONG_MATCHER.test(r.text)).length;
    const strongAdded = added.filter((r) => STRONG_MATCHER.test(r.text)).length;
    const weakAdded = added.filter((r) => WEAK_MATCHER.test(r.text));
    if (strongRemoved > strongAdded && weakAdded.length) {
      push('assertion-weakened', weakAdded[0].line, weakAdded[0].text, 'A precise assertion was replaced by a weaker one (e.g. toEqual → toBeDefined), so the test no longer checks the actual result.', 'Keep the exact expectation, and fix the code so it produces the expected value.');
    }
    // expected literal changed: same call shape, different literal
    for (const r of removed) {
      if (!STRONG_MATCHER.test(r.text)) continue;
      const shape = r.text.replace(/(['"`])(?:\\.|(?!\1).)*\1|\b\d+(\.\d+)?\b/g, '§').trim();
      const twin = added.find((a) => a.text.replace(/(['"`])(?:\\.|(?!\1).)*\1|\b\d+(\.\d+)?\b/g, '§').trim() === shape && a.text.trim() !== r.text.trim());
      if (twin) {
        push('expectation-changed', twin.line, twin.text, `Expected value changed in ${base}: \`${r.text.trim().slice(0, 80)}\` → \`${twin.text.trim().slice(0, 80)}\`.`, 'Only change an expectation when the requirement changed — never to match what buggy code returns.');
        break;
      }
    }
    // gutted test file (Write that removes most tests)
    if (edit.oldContent != null && edit.newContent != null) {
      const oldTests = countMatches(edit.oldContent, TEST_DECL_RE);
      const newTests = countMatches(edit.newContent, TEST_DECL_RE);
      if (oldTests >= 2 && newTests <= Math.floor(oldTests / 3)) {
        push('test-file-gutted', null, '', `${base} went from ${oldTests} test declarations to ${newTests}.`, 'Restore the removed tests; delete tests only when the user asked.');
      }
    }
  }

  // --- production code -------------------------------------------------------
  if (lang && !isTest && !CONFIG_LIKE.test(p)) {
    scanLines(TEST_ENV[lang], 'test-env-special-case', 'Production code now behaves differently under test. That makes tests pass without the real code path working.', 'Remove the test-environment check; use dependency injection, configuration, or mocks inside the tests instead.');
  }
  if (lang || /\.(json|ya?ml|toml|html|css|scss|sql|graphql|proto|tf)$/i.test(p)) {
    scanLines(ELIDED, 'elided-code', 'The new content contains an elision placeholder ("… existing code …"). Whatever code was there has been deleted from the file.', 'Write the complete code. With the Write tool, include every line of the file; for partial changes, use Edit on the specific region.');
  }
  if (lang) {
    scanLines(PLACEHOLDER, 'placeholder-code', 'A placeholder was written where the implementation should be.', 'Implement it now, or tell the user explicitly that this part is unfinished.');
    scanLines(NOT_IMPL, 'not-implemented', 'A stub that throws "not implemented" was added.', 'Implement the function, or state clearly in your final message that it is a stub.', (a) => !/abstract|interface|protocol|trait/i.test(contextBefore(newLines, a.line, 4)));
    for (const [re, label] of TYPE_SUPPRESS) scanLines([re], 'type-suppression', `\`${label}\` silences the type checker instead of fixing the type error.`, 'Fix the underlying type error. If suppression is truly required, add a comment explaining why (`veridone-allow: type-suppression <reason>`).');
    for (const [re, label] of LINT_SUPPRESS) scanLines([re], 'lint-suppression', `\`${label}\` silences the linter instead of fixing the issue.`, 'Fix the lint finding. If the rule is wrong here, explain why in the comment.');
    for (const [re, label] of COVERAGE_EXCL) scanLines([re], 'coverage-exclusion', `\`${label}\` hides this code from coverage.`, 'Add a test for this code path instead.');
    if (!isTest) {
      scanLines(SWALLOW[lang] || [], 'swallowed-error', SWALLOW_MESSAGE, SWALLOW_FIX, (a) => !explainsSwallow(commentIn(a.text)));
      multiLineSwallow(added, newLines, lang, push);
      scanLines(DEBUGGER[lang] || [], 'debug-leftover', 'A debugger/inspection statement was left in the code.', 'Remove it before finishing.');
      if (lang === 'js' && !/(^|\/)(scripts?|bin|cli|tools?)\//.test(p) && !/\.config\./.test(p)) {
        scanLines([/^\s*console\.(log|debug)\s*\(/], 'console-log', 'console.log left in source code.', 'Remove debugging output or use the project logger.');
      }
      if (TS_LIKE.test(p)) scanLines([/\bas\s+any\b/, /:\s*any\b(?!\w)/, /<any>/, /\bas\s+unknown\s+as\b/], 'any-cast', '`any` bypasses type checking.', 'Use a precise type or `unknown` with narrowing.');
    }
  }
  scanLines(FLAKY, 'flaky-retry', 'Retries were added, which masks a flaky or failing test instead of fixing it.', 'Find and fix the source of flakiness.');

  // --- configs / CI ---------------------------------------------------------
  if (base === 'package.json') checkPackageJson(edit, push);
  if (/^(pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml)$/.test(base)) {
    scanLines([/(addopts|testpaths)\s*=.*(--deselect|-k\s+["']?not\b|--ignore(-glob)?=|-p\s+no:)/, /^\s*["']?(--deselect|--ignore(-glob)?=|-k\s+["']?not\b)/], 'test-script-neutered', 'The pytest configuration now deselects or ignores tests.', 'Run the full suite; fix failing tests instead of excluding them.');
  }
  if (/^(Makefile|makefile|GNUmakefile|justfile|Justfile|Taskfile\.ya?ml)$/.test(base)) {
    scanLines([/^\t@?(true|:|exit\s+0|echo\b[^|&;]*)\s*$/], 'test-script-neutered', 'A build/test recipe was replaced by a no-op.', 'Restore the real command.', (a) => /^\s*(test|check|lint|ci|verify)\s*:/m.test(contextBefore(newLines, a.line, 3)));
  }
  if (CI_FILE.test(p)) checkCi(edit, push);
  scanLines([/-DskipTests\b|-Dmaven\.test\.skip=true|\s-x\s+test\b|--exclude-task\s+test\b|SKIP_TESTS\s*[:=]\s*["']?(1|true)/], 'ci-weakened', 'Tests are being skipped in the build.', 'Run the tests; fix failures instead of skipping them.');
  checkConfigWeakening(edit, base, p, push);

  // --- team rules (Pro) ------------------------------------------------------
  for (const r of compileCustomRules(cfg)) {
    if (r.paths && !matchGlob(p, r.paths)) continue;
    if (r.exclude && matchGlob(p, r.exclude)) continue;
    for (const a of added) {
      if (r.re.test(a.text)) push(r.id, a.line, a.text, r.message, r.fix, { severity: r.severity, title: r.title });
    }
  }

  // --- size of deletion -----------------------------------------------------
  if (lang && edit.oldContent != null && !isTest) {
    const oldCount = String(edit.oldContent).split(/\r?\n/).length;
    if (removed.length >= 40 && removed.length >= oldCount * 0.5 && added.length < removed.length * 0.5) {
      push('large-deletion', null, '', `${base}: ${removed.length} of ${oldCount} lines were removed and only ${added.length} added.`, 'Make sure no required code was lost. Prefer targeted Edit calls over rewriting whole files.');
    }
  }
  return dedupeFindings(findings);
}

function contextBefore(lines, lineNo, n) {
  if (!lines || !lineNo) return '';
  return lines.slice(Math.max(0, lineNo - 1 - n), lineNo - 1).join('\n');
}

function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  return (String(text).match(g) || []).length;
}

function allowCovers(text, rule) {
  const m = /veridone-allow(?::\s*([\w,\s-]+))?/.exec(text);
  if (!m) return false;
  if (!m[1]) return true;
  const ids = m[1].split(/[\s,]+/).filter(Boolean);
  const bare = rule.replace(/^custom:/, '');
  return ids.includes(rule) || ids.includes(bare) || ids.includes('all') || !ids.some((id) => INTEGRITY_RULES[id] || id.startsWith('custom:'));
}

function isAllowed(lines, lineNo, rule) {
  const cur = lines[lineNo - 1] || '';
  const prev = lines[lineNo - 2] || '';
  return (/veridone-allow/.test(cur) && allowCovers(cur, rule)) || (/veridone-allow/.test(prev) && allowCovers(prev, rule));
}

/**
 * Is position `index` of a single source line inside a string literal? Counts quotes from the start
 * of the line and stops at a line comment. Multi-line strings are not tracked (they stay scanned).
 */
export function insideStringLiteral(line, index, lang) {
  const hashComments = lang === 'py' || lang === 'rb' || lang === 'ex';
  let quote = null;
  for (let i = 0; i < index && i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '`' || (c === "'" && lang !== 'rs')) quote = c;
    else if ((c === '/' && line[i + 1] === '/' && lang !== 'py') || (c === '#' && hashComments)) return false;
  }
  return quote !== null;
}

function multiLineSwallow(added, newLines, lang, push) {
  if (!newLines) return;
  const indentOf = (s) => (/^\s*/.exec(s) || [''])[0].replace(/\t/g, '    ').length;
  for (const a of added) {
    let opener = null;
    if ((lang === 'js' || lang === 'java' || lang === 'cs' || lang === 'php' || lang === 'dart' || lang === 'swift') && /\bcatch\b[^{]*\{\s*$/.test(a.text)) opener = 'brace';
    if (lang === 'py' && /^\s*except\b[^:]*:\s*$/.test(a.text)) opener = 'py';
    if (!opener) continue;
    let j = a.line; // index of the line after the opener (0-based)
    while (j < newLines.length && /^\s*$/.test(newLines[j])) j++;
    const next = newLines[j] || '';
    let empty = false;
    let comments = commentIn(a.text);
    if (opener === 'brace') {
      // only comment lines before the closing brace: the block is empty; a comment that gives a
      // reason marks the swallow as intentional (like ESLint's no-empty), a bare "ignore" does not
      let k = j;
      while (k < newLines.length && /^\s*(\/\/.*|\/\*.*\*\/|\*.*)\s*$/.test(newLines[k])) { comments += ' ' + newLines[k]; k++; }
      empty = /^\s*\}/.test(newLines[k] || '');
    } else {
      const body = /^\s*(pass|\.\.\.)\s*(#.*)?$/.test(next);
      const after = newLines.slice(j + 1).find((l) => l.trim() !== '');
      const blockEnds = after === undefined || indentOf(after) <= indentOf(a.text);
      empty = body && blockEnds;
      comments += ' ' + commentIn(next);
    }
    if (empty && !explainsSwallow(comments)) push('swallowed-error', a.line, a.text, SWALLOW_MESSAGE, SWALLOW_FIX);
  }
  // Python: an existing except block whose handling was replaced by `pass`
  if (lang === 'py') {
    for (const a of added) {
      if (!/^\s*(pass|\.\.\.)\s*(#.*)?$/.test(a.text)) continue;
      let k = a.line - 2;
      while (k >= 0 && newLines[k].trim() === '') k--;
      const prev = newLines[k] || '';
      if (!/^\s*except\b[^:]*:\s*$/.test(prev) || added.some((x) => x.line === k + 1)) continue;
      const after = newLines.slice(a.line).find((l) => l.trim() !== '');
      if ((after === undefined || indentOf(after) <= indentOf(prev)) && !explainsSwallow(commentIn(a.text))) {
        push('swallowed-error', a.line, `${prev.trim()} ${a.text.trim()}`, 'Error handling was replaced by `pass`, so failures disappear instead of surfacing.', SWALLOW_FIX);
      }
    }
  }
}

function checkPackageJson(edit, push) {
  const oldJ = safeJsonParse(edit.oldContent ?? '', null);
  const newJ = safeJsonParse(edit.newContent ?? '', null);
  if (!newJ || typeof newJ !== 'object') return;
  const oldS = (oldJ && oldJ.scripts) || {};
  const newS = newJ.scripts || {};
  for (const key of Object.keys({ ...oldS, ...newS })) {
    if (!/^(test|test:.+|check|lint|typecheck|type-check|ci|verify|validate)$/.test(key)) continue;
    const before = oldS[key];
    const after = newS[key];
    if (before && after === undefined) {
      push('test-script-neutered', null, `"${key}"`, `The "${key}" script was removed from package.json.`, 'Restore it; fix what fails instead.');
      continue;
    }
    if (!after || after === before) continue;
    const neutered = /^\s*(true|:|exit\s+0|echo\b(?![^&|;]*&&)[^&|;]*)\s*$/.test(after) && !/^\s*echo\s+["']?Error: no test specified/.test(after);
    const masked = /\|\|\s*(true|exit\s+0|:)\b|--passWithNoTests|--pass-with-no-tests|--bail\s*=?\s*0|\s-k\s+["']?not\b|--deselect|--testPathIgnorePatterns|--exclude|--ignore/.test(after) && !/\|\|\s*(true|exit\s+0|:)\b|--passWithNoTests|--pass-with-no-tests|--bail\s*=?\s*0|\s-k\s+["']?not\b|--deselect|--testPathIgnorePatterns|--exclude|--ignore/.test(before || '');
    if (neutered || masked) {
      push('test-script-neutered', null, `"${key}": "${after}"`, `The "${key}" script was changed from \`${before || '(none)'}\` to \`${after}\`, which can no longer fail properly.`, 'Restore the real command and fix the failures it reports.');
    }
  }
  // jest config inside package.json
  const oldJest = JSON.stringify((oldJ && oldJ.jest) || {});
  const newJest = JSON.stringify(newJ.jest || {});
  if (oldJest !== newJest && /testPathIgnorePatterns|coveragePathIgnorePatterns|"passWithNoTests":true/.test(newJest) && !/testPathIgnorePatterns|coveragePathIgnorePatterns|"passWithNoTests":true/.test(oldJest)) {
    push('checks-config-weakened', null, 'jest', 'Jest configuration now ignores tests or coverage paths.', 'Keep all tests in scope.');
  }
}

function checkCi(edit, push) {
  const added = edit.added || [];
  const removed = edit.removed || [];
  for (const a of added) {
    if (/continue-on-error\s*:\s*true|allow_failure\s*:\s*true|^\s*if\s*:\s*(false|\$\{\{\s*false\s*\}\})\s*$/.test(a.text)) {
      push('ci-weakened', a.line, a.text, 'A CI step can now fail without failing the build.', 'Keep CI failures blocking; fix the underlying problem.');
    } else if (CHECK_CMD.test(a.text) && /\|\|\s*(true|exit\s+0|:)\s*$|--passWithNoTests|-DskipTests|--no-verify/.test(a.text)) {
      push('ci-weakened', a.line, a.text, 'A CI check was changed so it can never fail.', 'Remove the `|| true`/skip flag and fix the failures.');
    }
  }
  const removedChecks = removed.filter((r) => /^\s*(-\s*)?(run|script|command)\s*:|^\s*-\s+\S/.test(r.text) && CHECK_CMD.test(r.text));
  for (const r of removedChecks) {
    const cmd = (CHECK_CMD.exec(r.text) || [''])[0];
    const stillThere = added.some((a) => a.text.includes(cmd)) || (edit.newContent && String(edit.newContent).includes(r.text.trim()));
    if (!stillThere) {
      push('ci-weakened', null, r.text, `A CI step running \`${cmd}\` was removed.`, 'Keep the CI check; fix what it reports.');
      break;
    }
  }
}

function checkConfigWeakening(edit, base, p, push) {
  const added = edit.added || [];
  const removed = edit.removed || [];
  const isTsconfig = /^(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(base);
  const isEslint = /^(\.eslintrc(\.\w+)?|eslint\.config\.[cm]?[jt]s|\.oxlintrc\.json|biome\.jsonc?)$/.test(base);
  const isPyCfg = /^(pyproject\.toml|setup\.cfg|tox\.ini|mypy\.ini|\.mypy\.ini|ruff\.toml|\.ruff\.toml|\.coveragerc|\.flake8|\.pylintrc|pylintrc)$/.test(base);
  const isTestCfg = /^(jest|vitest|playwright|karma|cypress)\.config\.[cm]?[jt]s$|^\.mocharc/.test(base);
  const isGo = /^\.golangci\.(ya?ml|toml|json)$/.test(base);
  const isRustCfg = base === 'Cargo.toml' || base === 'clippy.toml';
  if (!(isTsconfig || isEslint || isPyCfg || isTestCfg || isGo || isRustCfg || /\.github\/workflows\//.test(p))) return;
  for (const a of added) {
    const t = a.text;
    if (isTsconfig && /"(strict|noImplicitAny|strictNullChecks|strictFunctionTypes|noImplicitReturns|noUncheckedIndexedAccess|checkJs|noImplicitThis|alwaysStrict|useUnknownInCatchVariables)"\s*:\s*false/.test(t)) {
      push('checks-config-weakened', a.line, t, 'TypeScript strictness was turned off, hiding type errors project-wide.', 'Fix the type errors instead of relaxing the compiler.');
    } else if (isEslint && /(['"]?[\w@/-]+['"]?\s*:\s*(['"]off['"]|0|\[\s*['"]off['"]))|ignorePatterns|ignores\s*:/.test(t)) {
      push('checks-config-weakened', a.line, t, 'Lint rules were disabled or files excluded from linting.', 'Fix the lint findings instead.');
    } else if (isPyCfg && /(ignore_errors\s*=\s*true|disallow_untyped_defs\s*=\s*false|strict\s*=\s*false|^\s*(extend-)?ignore\s*=|per-file-ignores|^\s*omit\s*=|exclude\s*=)/i.test(t)) {
      push('checks-config-weakened', a.line, t, 'Type-check/lint/coverage settings were relaxed.', 'Fix the underlying findings instead.');
    } else if (isTestCfg && /(testPathIgnorePatterns|coveragePathIgnorePatterns|exclude\s*:|passWithNoTests|testIgnore)/.test(t)) {
      push('checks-config-weakened', a.line, t, 'The test runner now ignores some tests or files.', 'Keep all tests in scope.');
    } else if (isGo && /(disable\s*:|exclude-rules|exclude\s*:|skip-(dirs|files))/.test(t)) {
      push('checks-config-weakened', a.line, t, 'golangci-lint checks were disabled or paths excluded.', 'Fix the lint findings instead.');
    } else if (isRustCfg && /=\s*["']allow["']|level\s*=\s*["']allow["']/.test(t)) {
      push('checks-config-weakened', a.line, t, 'Lints were set to allow.', 'Fix the warnings instead.');
    }
  }
  // coverage thresholds lowered
  const num = (s) => { const m = /(threshold|fail_under|fail-under|minimum|min_coverage|branches|functions|lines|statements)\D{0,20}?(\d{1,3}(\.\d+)?)/i.exec(s); return m ? { key: m[1].toLowerCase(), v: Number(m[2]) } : null; };
  for (const r of removed) {
    const before = num(r.text);
    if (!before) continue;
    const twin = added.map((a) => ({ a, n: num(a.text) })).find((x) => x.n && x.n.key === before.key);
    if (twin && twin.n.v < before.v) {
      push('checks-config-weakened', twin.a.line, twin.a.text, `Coverage threshold lowered (${before.key}: ${before.v} → ${twin.n.v}).`, 'Add tests to meet the threshold instead of lowering it.');
      break;
    }
  }
}

function dedupeFindings(list) {
  const seen = new Set();
  return list.filter((f) => {
    const k = `${f.rule}:${f.line}:${f.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Human summary of findings for hook feedback. */
export function formatFindings(findings, relPath, { max = 6 } = {}) {
  const lines = [];
  for (const f of findings.slice(0, max)) {
    const loc = f.line ? `${relPath}:${f.line}` : relPath;
    lines.push(`• [${f.rule}] ${loc} — ${f.message}${f.text ? `\n  ${f.text.length > 120 ? f.text.slice(0, 117) + '…' : f.text}` : ''}\n  Fix: ${f.fix}`);
  }
  if (findings.length > max) lines.push(`• …and ${findings.length - max} more`);
  return lines.join('\n');
}
