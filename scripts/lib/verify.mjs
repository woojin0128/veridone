// Veridone — verification tracking, completion gate, and claim checking.

import { parse } from './shell.mjs';
import { unwrap } from './guard.mjs';
import { matchGlob, shortHash, oneLine } from './util.mjs';
import { fileKind } from './project.mjs';

export const CATEGORIES = ['test', 'typecheck', 'lint', 'build'];

const SCRIPT_CATS = [
  ['test', /^(test|tests|t|test:[\w:-]+|unit|e2e|integration|spec|ci)$/],
  ['typecheck', /^(typecheck|type-check|check-types|types|tsc|check:types|lint:types|typecheck:[\w:-]+)$/],
  ['lint', /^(lint|lint:[\w:-]+|eslint|stylelint|format:check|prettier:check)$/],
  ['build', /^(build|build:[\w:-]+|compile)$/],
];

/**
 * Classify a Bash command as verification.
 * @returns {{category:string, scope:'full'|'partial', cmd:string}[]}
 */
export function classifyCommand(commandLine, project) {
  const results = [];
  const line = String(commandLine || '');
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let parsed;
  try { parsed = parse(line); } catch {
    for (const cat of CATEGORIES) {
      const c = project?.commands?.[cat];
      if (c && norm(line) === norm(c)) results.push({ category: cat, scope: 'full', cmd: c });
    }
    return dedupe(results);
  }
  // Detected / configured commands: their simple commands must appear, in order, as commands of this line
  // (so `echo "npm test"` or `grep test package.json` never count as running the tests).
  const texts = parsed.commands.map((c) => norm(unwrap(c).words.map((x) => x.value).join(' ')));
  for (const cat of CATEGORIES) {
    const c = project?.commands?.[cat];
    if (!c) continue;
    let parts;
    try { parts = parse(c).commands.map((x) => norm(unwrap(x).words.map((w) => w.value).join(' '))).filter(Boolean); } catch { parts = [norm(c)]; }
    if (!parts.length) continue;
    for (let i = 0; i + parts.length <= texts.length; i++) {
      if (parts.every((p, j) => texts[i + j] === p || texts[i + j].startsWith(p + ' '))) {
        results.push({ category: cat, scope: 'full', cmd: c, index: i + parts.length - 1 });
        break;
      }
    }
  }
  parsed.commands.forEach((cmd, index) => {
    const u = unwrap(cmd);
    const w = u.words.map((x) => x.value);
    if (!w.length) return;
    const name = u.name;
    const args = w.slice(1);
    const first = args.find((a) => !a.startsWith('-')) || '';
    const add = (category, scope = 'full') => results.push({ category, scope, cmd: w.join(' '), index });
    const hasFileArgs = (list) => list.some((a) => /\.(test|spec)\.|_test\.|test_|\/|::|\.py$|\.[jt]sx?$/.test(a) && !a.startsWith('-'));
    const hasFilter = (list) => list.some((a) => /^(-t|--testNamePattern|--grep|-g|-k|--filter|-run|--run|-m|--testPathPattern|--only|--tests?)(=|$)/.test(a));
    switch (name) {
      case 'npm': case 'pnpm': case 'yarn': case 'bun': {
        let script = null;
        if (first === 'test' || first === 't' || first === 'tst') script = 'test';
        else if (first === 'run' || first === 'run-script') script = args[args.indexOf(first) + 1];
        else if (name !== 'npm' && name !== 'bun' && first && !/^(install|i|add|remove|rm|exec|dlx|x|create|init|publish|link|unlink|outdated|update|upgrade|why|audit|info|view|pack|config|cache|store|workspace|workspaces|global)$/.test(first)) script = first;
        if (name === 'bun' && first === 'test') { add('test', hasFileArgs(args.slice(1)) || hasFilter(args) ? 'partial' : 'full'); break; }
        if (!script) break;
        for (const [cat, re] of SCRIPT_CATS) if (re.test(script)) { add(cat, script === 'test' || cat !== 'test' ? (hasFilter(args) || args.includes('--') && hasFileArgs(args.slice(args.indexOf('--') + 1)) ? 'partial' : 'full') : 'full'); break; }
        if (/^(check|verify|validate|ci)$/.test(script)) add('lint');
        break;
      }
      case 'jest': case 'vitest': case 'mocha': case 'ava': case 'tap': case 'uvu': case 'karma': case 'jasmine': case 'cypress': case 'playwright': case 'wdio': case 'nyc': case 'c8': {
        if (name === 'playwright' && first !== 'test') break;
        if (name === 'cypress' && first !== 'run') break;
        if ((name === 'nyc' || name === 'c8') && !args.some((a) => /jest|mocha|vitest|ava|tap|node/.test(a))) break;
        const rest = args.filter((a) => a !== 'run' && a !== 'test');
        add('test', hasFileArgs(rest) || hasFilter(rest) ? 'partial' : 'full');
        break;
      }
      case 'node':
        if (args.includes('--test')) add('test', hasFileArgs(args.filter((a) => a !== '--test')) ? 'partial' : 'full');
        break;
      case 'deno':
        if (first === 'test') add('test', hasFileArgs(args.slice(1)) ? 'partial' : 'full');
        else if (first === 'check') add('typecheck');
        else if (first === 'lint') add('lint');
        break;
      case 'pytest': case 'py.test':
        add('test', hasFileArgs(args) || hasFilter(args) ? 'partial' : 'full');
        break;
      case 'python': case 'python3': case 'python2': {
        const mi = args.indexOf('-m');
        const mod = mi >= 0 ? args[mi + 1] : null;
        // python's own `-m` selects the module; only flags after it can filter tests
        if (mod === 'pytest' || mod === 'unittest' || mod === 'nose2') add('test', hasFileArgs(args.slice(mi + 2)) || hasFilter(args.slice(mi + 2)) ? 'partial' : 'full');
        else if (mod === 'mypy' || mod === 'pyright') add('typecheck');
        else if (mod === 'ruff' || mod === 'flake8' || mod === 'pylint') add('lint');
        else if (args.some((a) => /manage\.py$/.test(a)) && args.includes('test')) add('test');
        break;
      }
      case 'tox': case 'nox': add('test'); break;
      case 'mypy': case 'pyright': case 'basedpyright': case 'pytype': case 'pyre': add('typecheck'); break;
      case 'ruff': if (first === 'check' || !first) add('lint'); break;
      case 'flake8': case 'pylint': case 'eslint': case 'oxlint': case 'stylelint': case 'rubocop': case 'standardrb': case 'phpcs': case 'swiftlint': case 'ktlint': case 'detekt': case 'golangci-lint': case 'staticcheck': case 'shellcheck': case 'hadolint': case 'markdownlint': case 'xo':
        add('lint');
        break;
      case 'biome': if (/^(check|lint|ci)$/.test(first)) add('lint'); break;
      case 'prettier': if (args.includes('--check') || args.includes('-c')) add('lint'); break;
      case 'black': if (args.includes('--check')) add('lint'); break;
      case 'tsc': case 'vue-tsc': case 'svelte-check': case 'astro': case 'flow': case 'phpstan': case 'psalm': case 'sorbet': case 'srb':
        if (name === 'astro' && first !== 'check') break;
        if (name === 'tsc' && (args.includes('--init') || args.includes('--version') || args.includes('-v'))) break;
        add(name === 'tsc' && !args.includes('--noEmit') && !args.includes('-b') && !args.includes('--build') ? 'typecheck' : 'typecheck');
        break;
      case 'go':
        if (first === 'test') add('test', args.some((a) => /^\.\/\.\.\.$|^\.\.\.$/.test(a)) && !hasFilter(args) ? 'full' : (args.filter((a) => !a.startsWith('-')).length > 1 || hasFilter(args) ? 'partial' : 'full'));
        else if (first === 'vet') add('lint');
        else if (first === 'build') add('typecheck');
        break;
      case 'cargo':
        if (first === 'test' || first === 'nextest') add('test', args.slice(1).some((a) => !a.startsWith('-') && a !== 'run') ? 'partial' : 'full');
        else if (first === 'check') add('typecheck');
        else if (first === 'clippy') add('lint');
        else if (first === 'build') add('build');
        break;
      case 'mvn': case 'mvnw':
        if (args.some((a) => /^(test|verify|integration-test)$/.test(a)) && !args.some((a) => /skipTests|maven\.test\.skip/.test(a))) add('test');
        else if (args.some((a) => /^(compile|package|install)$/.test(a))) add('build');
        break;
      case 'gradle': case 'gradlew':
        if (args.some((a) => /(^|:)(test|check|connectedCheck)$/.test(a)) && !args.includes('-x')) add('test');
        else if (args.some((a) => /(^|:)(build|assemble|compileJava|compileKotlin)$/.test(a))) add('build');
        break;
      case 'dotnet':
        if (first === 'test') add('test');
        else if (first === 'build') add('build');
        break;
      case 'rspec': add('test', hasFileArgs(args) ? 'partial' : 'full'); break;
      case 'rake': case 'rails': if (/^(test|spec)(:|$)/.test(first)) add('test'); break;
      case 'phpunit': case 'pest': case 'paratest': add('test', hasFileArgs(args) || hasFilter(args) ? 'partial' : 'full'); break;
      case 'composer': if (first === 'test') add('test'); break;
      case 'mix': if (first === 'test') add('test'); else if (first === 'compile') add('build'); else if (first === 'dialyzer') add('typecheck'); else if (first === 'credo') add('lint'); break;
      case 'swift': if (first === 'test') add('test'); else if (first === 'build') add('build'); break;
      case 'flutter': case 'dart': if (first === 'test') add('test'); else if (first === 'analyze') add('typecheck'); break;
      case 'ctest': add('test'); break;
      case 'make': case 'just': case 'task': case 'mise': {
        const target = first;
        if (/^(test|tests|check|ci|verify|spec|unit)$/.test(target)) add('test');
        else if (/^(lint|fmt-check|format-check)$/.test(target)) add('lint');
        else if (/^(typecheck|type-check|types|mypy|tsc)$/.test(target)) add('typecheck');
        else if (/^(build|all|compile)$/.test(target) || (!target && name === 'make')) add('build');
        break;
      }
      case 'bazel': case 'bazelisk': if (first === 'test') add('test'); else if (first === 'build') add('build'); break;
      case 'zig': if (first === 'build' && args.includes('test')) add('test'); else if (first === 'build') add('build'); break;
      case 'sbt': if (args.some((a) => /^(test|testOnly)$/.test(a))) add('test'); break;
      case 'vite': case 'next': case 'nuxt': case 'webpack': case 'rollup': case 'esbuild': case 'tsup': case 'turbo': case 'nx':
        if ((name === 'turbo' || name === 'nx') && (first === 'run' || /^(test|lint|typecheck|build)$/.test(first))) {
          const t = first === 'run' ? args[args.indexOf('run') + 1] : first;
          for (const [cat, re] of SCRIPT_CATS) if (re.test(t || '')) { add(cat); break; }
        } else if (first === 'build' || name === 'webpack' || name === 'rollup' || name === 'esbuild' || name === 'tsup') add('build');
        break;
      default:
        break;
    }
  });
  // Configured commands matched as text: locate the simple command that starts them.
  for (const r of results) {
    if (r.index != null) continue;
    const head = String(r.cmd).trim().split(/\s+/).slice(0, 2).join(' ');
    const i = parsed.commands.findIndex((c) => c.argv.map((x) => x.value).join(' ').startsWith(head));
    if (i >= 0) r.index = i;
  }
  return dedupe(results);
}

function dedupe(list) {
  const seen = new Map();
  for (const r of list) {
    const prev = seen.get(r.category);
    if (!prev || (prev.scope === 'partial' && r.scope === 'full')) seen.set(r.category, { ...r, index: r.index ?? prev?.index });
    else if (prev.index == null && r.index != null) prev.index = r.index;
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Outcome of a verification run
// ---------------------------------------------------------------------------

/**
 * Does the shell hide the exit status of simple command `index`?
 * `npm test | tail`, `npm test || true` and `npm test; echo done` all exit 0 when the tests fail.
 * @returns {null|'pipe'|'or'|'sequence'}
 */
export function exitStatusMasked(commandLine, index) {
  let parsed;
  try { parsed = parse(String(commandLine || '')); } catch { return null; }
  const cmds = parsed.commands;
  const v = cmds[index];
  if (!v) return null;
  const pipefail = cmds.slice(0, index).some((c) => {
    const w = c.argv.map((x) => x.value);
    return w[0] === 'set' && w.includes('pipefail');
  });
  if (!pipefail && cmds.some((c) => c.pipelineId === v.pipelineId && c.pipeIndex > v.pipeIndex && c.argv.length)) return 'pipe';
  const seen = new Set();
  for (const c of cmds) {
    if (c.pipelineId <= v.pipelineId || seen.has(c.pipelineId)) continue;
    seen.add(c.pipelineId);
    if (c.connectorBefore === '&&') continue;
    return c.connectorBefore === '||' ? 'or' : 'sequence';
  }
  return null;
}

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `npm test > log; echo "exit=$?"` or `npm test | tail; echo "rc=${PIPESTATUS[0]}"`: the command right
 * after the check prints the check's own exit status. Read it back from the output.
 * @returns {{code:number, line:string}|null}
 */
export function echoedExitStatus(commandLine, index, output) {
  let parsed;
  try { parsed = parse(String(commandLine || '')); } catch { return null; }
  const cmds = parsed.commands;
  const v = cmds[index];
  if (!v) return null;
  const pipeline = cmds.filter((c) => c.pipelineId === v.pipelineId);
  const next = cmds.find((c) => c.pipelineId > v.pipelineId);
  if (!next || (next.connectorBefore !== ';' && next.connectorBefore !== '||' && next.connectorBefore !== '\n' && next.connectorBefore != null)) return null;
  const words = next.argv.map((x) => x.value);
  if (words[0] !== 'echo') return null;
  const text = words.slice(1).filter((w, i) => !(i === 0 && /^-[neE]+$/.test(w))).join(' ');
  const tokens = pipeline[pipeline.length - 1] === v ? ['$?', '${?}'] : [`\${PIPESTATUS[${v.pipeIndex}]}`];
  const tok = tokens.find((t) => text.includes(t));
  if (!tok || text.split(tok).length !== 2) return null;
  const [before, after] = text.split(tok);
  const re = new RegExp(`^\\s*${escapeRe(before.trim())}\\s*(\\d{1,3})\\s*${escapeRe(after.trim())}\\s*$`);
  const lines = String(output || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  // a bare `echo $?` is only trusted as the very last line; a labeled one may be followed by more output
  const candidates = before.trim() || after.trim() ? lines.slice(-20).reverse() : lines.slice(-1);
  for (const line of candidates) {
    const m = re.exec(line);
    if (m) return { code: Number(m[1]), line: line.trim() };
  }
  return null;
}

// Anchored summary lines printed by common runners. `cat` limits a signature to one category.
const FAIL_SIGNATURES = [
  { cat: 'test', re: /^# fail [1-9]\d*\s*$/m },                                        // node:test / TAP
  { cat: 'test', re: /^not ok \d+(?![^\n]*#\s*(TODO|SKIP))/m },                         // TAP
  { cat: 'test', re: /^Tests?:\s+.*\b[1-9]\d* failed/m },                                // jest / phpunit(new)
  { cat: 'test', re: /^Test Suites:\s+.*\b[1-9]\d* failed/m },                           // jest
  { cat: 'test', re: /^\s*Test(s| Files)\s+.*\b[1-9]\d* failed/m },                      // vitest
  { cat: 'test', re: /^\s*[1-9]\d* failing\b/m },                                        // mocha
  { cat: 'test', re: /^=+ .*\b[1-9]\d* (failed|errors?)\b.*=+\s*$/m },                    // pytest
  { cat: 'test', re: /^FAILED \((failures|errors)=\d+/m },                               // unittest
  { cat: 'test', re: /^--- FAIL: /m },                                                   // go test
  { cat: 'test', re: /^FAIL(\s+\S+.*)?\s*$/m },                                           // go test package line
  { cat: 'test', re: /^test result: FAILED\./m },                                        // cargo / deno
  { cat: 'test', re: /^\d+ examples?, [1-9]\d* failures?/m },                             // rspec
  { cat: 'test', re: /^\d+ runs, \d+ assertions, ([1-9]\d* failures|\d+ failures, [1-9]\d* errors)/m }, // minitest
  { cat: 'test', re: /^(FAILURES|ERRORS)!\s*$/m },                                       // phpunit
  { cat: 'test', re: /^\[ERROR\] Tests run:.*(Failures: [1-9]|Errors: [1-9])/m },        // maven surefire
  { cat: 'test', re: /^Failed!\s+-\s+Failed:\s+[1-9]/m },                                 // dotnet test
  { cat: 'test', re: /^\s*Test Run Failed\.?\s*$/m },                                     // dotnet
  { cat: 'test', re: /^\d+ (tests?|doctests?|properties)(, \d+ \w+)*, [1-9]\d* failures?/m }, // exunit
  { cat: 'test', re: /Test Suite '.+' failed/ },                                          // xctest
  { cat: 'test', re: /^Some tests failed\.\s*$/m },                                      // dart / flutter
  { cat: 'test', re: /^\s*[1-9]\d* fail\s*$/m },                                          // bun
  { cat: 'test', re: /^FAILED\s*\|/m },                                                  // deno
  { cat: 'test', re: /^(npm ERR!|npm error) Test failed/m },
  { cat: 'typecheck', re: /\berror TS\d{3,5}:/ },                                         // tsc
  { cat: 'typecheck', re: /^Found [1-9]\d* errors?\b/m },                                  // tsc --build / mypy / ruff
  { cat: 'typecheck', re: /^\s*[1-9]\d* errors?, \d+ warnings?/m },                        // pyright
  { cat: 'typecheck', re: /^.+:\d+: error: .+\[[\w-]+\]\s*$/m },                          // mypy line
  { cat: 'lint', re: /^✖ [1-9]\d* problems?/m },                                          // eslint
  { cat: 'lint', re: /\b[1-9]\d* problems? \([1-9]\d* errors?/ },                          // eslint (plain)
  { cat: 'lint', re: /^Found [1-9]\d* errors?\b/m },                                       // ruff
  { cat: 'build', re: /^error(\[E\d{4}\])?: /m },                                         // rustc / swift
  { cat: 'build', re: /^error: could not compile/m },
  { cat: 'build', re: /^(ERROR in |Failed to compile\.?\s*$|Build failed\b|error during build:)/m },
  { cat: 'build', re: /^BUILD (FAILURE|FAILED)\b/m },                                     // maven / gradle
  { cat: 'build', re: /^make(\[\d+\])?: \*\*\* .*Error \d+/m },
  { cat: 'any', re: /^(ERR_PNPM_\w+|error Command failed with exit code [1-9])/m },
  { cat: 'any', re: /^npm (ERR!|error) (code|errno|Lifecycle|command failed)/m },
];

const PASS_SIGNATURES = [
  { cat: 'test', re: /^# pass [1-9]\d*\s*$/m, unless: /^# fail [1-9]/m },
  { cat: 'test', re: /^Tests?:\s+(?!.*failed).*\b\d+ passed/m },
  { cat: 'test', re: /^\s*Tests\s+(?!.*failed).*\b\d+ passed/m },
  { cat: 'test', re: /^\s*\d+ passing\b/m, unless: /^\s*[1-9]\d* failing\b/m },
  { cat: 'test', re: /^=+ (?!.*\b(failed|errors?)\b).*\b\d+ passed\b.*=+\s*$/m },
  { cat: 'test', re: /^Ran \d+ tests? in [\d.]+s\s*\n+\s*OK\b/m },
  { cat: 'test', re: /^ok\s+\S+\s+(\(cached\)|[\d.]+s)/m, unless: /^(--- )?FAIL\b/m },
  { cat: 'test', re: /^PASS\s*$/m, unless: /^(--- )?FAIL\b/m },
  { cat: 'test', re: /^test result: ok\./m, unless: /^test result: FAILED/m },
  { cat: 'test', re: /^\d+ examples?, 0 failures/m },
  { cat: 'test', re: /^\d+ runs, \d+ assertions, 0 failures, 0 errors/m },
  { cat: 'test', re: /^OK \(\d+ tests?, \d+ assertions?\)/m },
  { cat: 'test', re: /^Passed!\s+-\s+Failed:\s+0\b/m },
  { cat: 'test', re: /^\d+ (tests?|doctests?|properties)(, \d+ \w+)*, 0 failures/m },
  { cat: 'test', re: /All tests passed!/ },
  { cat: 'test', re: /^ok \| \d+ passed \| 0 failed/m },
  { cat: 'test', re: /^\s*0 fail\s*$/m },
  { cat: 'any', re: /^BUILD SUCCESS(FUL)?\b/m },
  { cat: 'typecheck', re: /^Found 0 errors\b/m },
  { cat: 'typecheck', re: /^Success: no issues found/m },                                // mypy
  { cat: 'typecheck', re: /^\s*0 errors, \d+ warnings?/m },                                // pyright
  { cat: 'lint', re: /^All checks passed!/m },                                           // ruff
];

/**
 * Pass/fail evidence in command output.
 * @returns {{fail:{cat:string,line:string}|null, pass:{cat:string,line:string}|null}}
 */
export function assessOutput(text, category = null) {
  const t = String(text || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n');
  const body = t.length > 2_000_000 ? t.slice(-2_000_000) : t;
  const fits = (sig) => !category || sig.cat === 'any' || sig.cat === category || (category === 'build' && sig.cat === 'typecheck');
  const lineOf = (m) => oneLine(body.slice(body.lastIndexOf('\n', m.index) + 1, body.indexOf('\n', m.index) === -1 ? undefined : body.indexOf('\n', m.index)), 160);
  let fail = null;
  for (const sig of FAIL_SIGNATURES) {
    if (!fits(sig)) continue;
    const m = sig.re.exec(body);
    if (m) { fail = { cat: sig.cat, line: lineOf(m) }; break; }
  }
  let pass = null;
  for (const sig of PASS_SIGNATURES) {
    if (!fits(sig)) continue;
    const m = sig.re.exec(body);
    if (m && !(sig.unless && sig.unless.test(body))) { pass = { cat: sig.cat, line: lineOf(m) }; break; }
  }
  return { fail, pass };
}

/**
 * Judge a verification run that the shell reported as successful (exit 0).
 * @returns {{ok:boolean|null, basis:string, note?:string}}
 */
export function judgeSuccessfulRun({ commandLine, index, output, category }) {
  const masked = index == null ? null : exitStatusMasked(commandLine, index);
  const { fail, pass } = assessOutput(output, category);
  if (fail) return { ok: false, basis: 'output', masked, note: fail.line };
  if (!masked) return { ok: true, basis: 'exit', masked };
  const echoed = echoedExitStatus(commandLine, index, output);
  if (echoed) return echoed.code === 0 ? { ok: true, basis: 'echoed', masked: null, note: echoed.line } : { ok: false, basis: 'echoed', masked: null, note: echoed.line };
  if (pass) return { ok: true, basis: 'output', masked, note: pass.line };
  if ((category === 'typecheck' || category === 'lint') && !String(output || '').trim()) return { ok: true, basis: 'silent', masked };
  return { ok: null, basis: 'unknown', masked };
}

/** Human description of how an exit status was hidden. */
export function maskLabel(m) {
  return m === 'pipe' ? 'hidden by a pipe' : m === 'or' ? 'overridden by `||`' : m === 'sequence' ? 'replaced by the command that runs after it' : 'unavailable';
}

/** For a failed (non-zero) command covering several categories, which of them actually passed? */
export function judgeFailedRun({ output, category, categories }) {
  if (categories <= 1) return { ok: false, basis: 'exit' };
  const { fail, pass } = assessOutput(output, category);
  if (!fail && pass && pass.cat === category) return { ok: true, basis: 'output', note: pass.line };
  return { ok: false, basis: 'exit' };
}

/** Commands whose output is noisy and safe to condense. */
export function isNoisyCommand(commandLine) {
  return /\b(npm|pnpm|yarn|bun)\s+(i|install|ci|add|update|upgrade)\b|\bpip3?\s+install\b|\buv\s+(sync|pip\s+install|add|lock)\b|\bpoetry\s+(install|add|lock|update)\b|\bcargo\s+(build|fetch|update|install)\b|\bgo\s+(mod\s+(download|tidy)|get|install)\b|\bbundle(\s+install)?\s*$|\bbundle\s+install\b|\bcomposer\s+(install|update|require)\b|\bdotnet\s+(restore|build)\b|\bmvn\b|\bgradlew?\b|\bdocker\s+(build|compose\s+build|pull)\b|\bapt(-get)?\s+install\b|\bbrew\s+install\b|\bpod\s+install\b|\bswift\s+build\b|\bflutter\s+pub\s+get\b/.test(String(commandLine || ''));
}

/** Normalize an error text into a stable signature (to detect repeated identical failures). */
export function failureSignature(text) {
  const t = String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|seconds|m|min)\b/g, '#t')
    .replace(/\b0x[0-9a-f]+\b/gi, '#h')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\b/g, '#d')
    .replace(/:\d+:\d+/g, ':#:#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  const lines = t.split(/(?<=[.!?])\s|\n/).filter((l) => /(error|fail|assert|expected|exception|panic|cannot|undefined|not found)/i.test(l)).slice(0, 12).join('|');
  return shortHash(lines || t.slice(0, 2000), 10);
}

/** Parse "Exit code N" from a PostToolUseFailure error string. */
export function exitCodeOf(errorText) {
  const m = /^Exit code (\d+)/m.exec(String(errorText || ''));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_PATTERNS = [
  { category: 'test', re: /\b(all\s+(of\s+the\s+)?|the\s+(full\s+|entire\s+)?|every\s+)?(\d+\s+)?(unit\s+|integration\s+|e2e\s+)?(tests?|specs?|test\s+suite|suite)\s+(now\s+|still\s+|are\s+(now\s+)?|is\s+(now\s+)?|have\s+(now\s+)?|all\s+|successfully\s+)*(pass(es|ed|ing)?|green|succeed(s|ed)?|ran\s+successfully)\b/i },
  { category: 'test', re: /[✅✓✔]\s*(all\s+)?(\d+\s+)?(tests?|specs?)\b/i },
  { category: 'test', re: /\b(tests?|specs?)\s*[:—–-]\s*(\d+\s+)?(pass(ed|ing)?|green|ok)\b/i },
  { category: 'test', re: /(모든\s*)?테스트(가|를|는|도)?\s*(모두\s*|전부\s*)?(통과|성공)/ },
  { category: 'typecheck', re: /\b(type[- ]?check(s|ing)?|tsc|mypy|pyright|type\s+errors?)\s+(now\s+)?(pass(es|ed)?|clean|succeed(s|ed)?)|\bno\s+(remaining\s+)?type\s+errors\b|\btypes?\s+check\s+(out|cleanly)\b/i },
  { category: 'typecheck', re: /타입\s*(체크|검사)(가|는)?\s*(통과|성공)|타입\s*에러(가)?\s*없/ },
  { category: 'build', re: /\b(the\s+)?build\s+(now\s+)?(pass(es|ed)?|succeed(s|ed)?|is\s+(green|clean|successful)|works|completes?)\b|\bbuilds?\s+(successfully|cleanly)\b|\bcompiles?\s+(successfully|cleanly|without\s+errors?)\b/i },
  { category: 'build', re: /빌드(가|는)?\s*(성공|통과)/ },
  { category: 'lint', re: /\blint(ing|er)?\s+(now\s+)?(pass(es|ed)?|clean|succeeds?)\b|\bno\s+lint\s+(errors|warnings|issues)\b/i },
];

const NEGATION = /\b(not|n't|never|unable|couldn'?t|cannot|can'?t|won'?t|without|haven'?t|hasn'?t|didn'?t|no longer|unverified|untested|skipp?ed|pending|once|until|if|should|would|will|expect(ed)?\s+to|to make|so that|in order to|may|might|need(s)?\s+to|try|attempt)\b|않|못|안\s|실패|아직|예정|필요/i;

// A sentence that reports failing checks ("1 test fails", "the suite is still red", "테스트 1개 실패").
const CHECK_NOUN = String.raw`(tests?|specs?|suites?|checks?|builds?|lint\w*|type[- ]?check\w*|tsc|mypy|compil\w+)`;
const FAIL_WORD = String.raw`(fail(s|ed|ing|ures?)?|red|broken|regress(ed|ions?)?)`;
const FAILURE_REPORT = new RegExp(String.raw`\b${FAIL_WORD}\b[^.!?\n]{0,40}\b${CHECK_NOUN}\b|\b${CHECK_NOUN}\b[^.!?\n]{0,40}\b${FAIL_WORD}\b|\b[1-9]\d*\s+(\w+\s+)?(failing|failed|failures?|errors?)\b|실패|깨지|깨짐`, 'i');
const ZERO_FAILURES = /\b(no|0|zero|without|none of the)\s+(new\s+|remaining\s+|more\s+|type\s+|lint\s+|test\s+)?(fail\w*|errors?|regressions?|broken\s+\w+)\b|\b(fail(ed|ures?)?|errors?)\s*[:=]\s*0\b|\bfail\s+0\b/gi;

function reportsFailure(sentence) {
  return FAILURE_REPORT.test(String(sentence).replace(ZERO_FAILURES, ' '));
}

// Words that name each category, used to tie a disclosure sentence to the check it discloses.
const CATEGORY_WORDS = {
  test: /\b(tests?|specs?|suites?|test\s+suite|checks?|verif(y|ied|ication))\b|테스트|검증/i,
  typecheck: /\b(type[- ]?check(s|ing|er)?|types?|tsc|mypy|pyright|checks?|verif(y|ied|ication))\b|타입|검증/i,
  lint: /\b(lint(s|ing|er)?|eslint|ruff|checks?|verif(y|ied|ication))\b|린트|검증/i,
  build: /\b(build(s|ing)?|compil(e|es|ed|ing|ation)|checks?|verif(y|ied|ication))\b|빌드|컴파일|검증/i,
};
const NOT_RUN = /\b((have|has|had|did|do|was|were|could|can|would)\s*(not|n't)\s+(yet\s+)?(been\s+)?(run|ran|execut\w*|verif\w*|test(ed)?|check(ed)?|compil\w*|buil[dt]))\b|\b(untested|unverified|not\s+(yet\s+)?(been\s+)?(run|executed|verified|tested|checked|compiled|built))\b|\b(unable|not able)\s+to\s+(run|execute|verify|test|build|compile)\b|\bwithout\s+(running|executing|verifying|testing)\b|\bskipped\s+(running|the)\b|(실행|돌리|검증|확인|테스트)[^.。\n]{0,12}(하지\s*(않|못)|안\s*(했|함|됨)|못\s*(했|함)|않았|못했)|미검증|검증되지\s*않/i;

/**
 * Does the final message openly disclose the gap for `cat` (checks not run, or still failing)?
 * An honest disclosure satisfies the gate: its purpose is to stop unverified "done", not honest reports.
 */
export function disclosesGap(message, cat, kind) {
  if (!message) return false;
  const text = String(message).replace(/```[\s\S]*?```/g, ' ');
  const words = CATEGORY_WORDS[cat] || CATEGORY_WORDS.test;
  const sentences = text.split(/(?<=[.!?。])\s+|\n+/);
  return sentences.some((sRaw) => {
    const sent = sRaw.trim();
    if (!sent || !words.test(sent)) return false;
    if (kind === 'failed') return reportsFailure(sent);
    return NOT_RUN.test(sent) || (kind === 'unknown' && /\b(could\s*n[o']t|can\s*n[o']t|unable to)\s+(see|tell|determine|confirm)\b/i.test(sent));
  });
}

/**
 * Find success claims in the final assistant message.
 * @returns {{category:string, text:string}[]}
 */
export function findClaims(message) {
  const out = [];
  if (!message) return out;
  const text = String(message).replace(/```[\s\S]*?```/g, ' ');
  const sentences = text.split(/(?<=[.!?。])\s+|\n+/);
  for (const s of sentences) {
    const trimmed = s.trim();
    if (!trimmed || trimmed.length > 400) continue;
    const found = new Set();
    for (const p of CLAIM_PATTERNS) {
      if (found.has(p.category)) continue;
      const m = p.re.exec(trimmed);
      if (!m) continue;
      // Negation only counts inside the claim's own clause: "I didn't touch the API, and all tests pass" is a claim.
      const head = trimmed.slice(0, m.index).split(/[,;:—–]|\s(?:and|but|so|then|also)\s/i).pop();
      const tail = trimmed.slice(m.index + m[0].length, m.index + m[0].length + 12);
      if (NEGATION.test(head) || /^\s*(not\b|n't|yet\b|하지\s*(않|못)|지\s*(않|못)|못|안\s*됨|실패)/.test(tail)) continue;
      if (/\?\s*$/.test(trimmed)) continue;
      if (reportsFailure(trimmed)) continue; // "3 tests pass, 1 fails" reports the failure honestly
      out.push({ category: p.category, text: oneLine(trimmed, 160) });
      found.add(p.category);
    }
  }
  const seen = new Set();
  return out.filter((c) => (seen.has(c.category) ? false : (seen.add(c.category), true)));
}

// ---------------------------------------------------------------------------
// Completion gate
// ---------------------------------------------------------------------------

function relevantEdit(e, cfg) {
  if (!e || !e.path) return false;
  const kind = e.kind || fileKind(e.path);
  if (!['code', 'test', 'config'].includes(kind)) return false;
  if (matchGlob(e.path, cfg.verify?.ignore || [])) return false;
  return true;
}

export function requiredCategories(project, cfg) {
  const req = cfg.verify?.require;
  const avail = CATEGORIES.filter((c) => project?.commands?.[c]);
  if (Array.isArray(req)) return req.filter((c) => avail.includes(c));
  if (cfg.mode === 'strict') {
    const list = ['test', 'typecheck'].filter((c) => avail.includes(c));
    if (!list.length && avail.includes('build')) list.push('build');
    return list;
  }
  if (avail.includes('test')) return ['test'];
  if (avail.includes('typecheck')) return ['typecheck'];
  if (avail.includes('build')) return ['build'];
  return [];
}

function ago(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 90 * 1000) return `${Math.max(1, Math.round(ms / 1000))}s ago`;
  if (ms < 90 * 60 * 1000) return `${Math.round(ms / 60000)} min ago`;
  return `${Math.round(ms / 3600000)} h ago`;
}

/**
 * Decide whether Claude may stop.
 * @param {{state:any, project:any, cfg:any, input:any}} p
 * @returns {{decision:'allow'|'block', reason?:string, summary?:string, kind?:string}}
 */
export function evaluateStop({ state, project, cfg, input, turnStartAt = null }) {
  if (!cfg || cfg.mode === 'off') return { decision: 'allow' };
  const gate = cfg.verify?.stopGate !== false && cfg.mode !== 'relaxed';
  const claimCheck = cfg.verify?.claimCheck !== false;
  if (!gate && !claimCheck) return { decision: 'allow' };
  if (input?.stop_hook_active) return { decision: 'allow', kind: 'released' };
  const promptId = input?.prompt_id || state.lastPromptId;
  const blocksThisTurn = state.stops.filter((s) => s.decision === 'block' && s.promptId === promptId).length;
  if (blocksThisTurn >= (cfg.verify?.maxBlocksPerTurn ?? 1)) return { decision: 'allow', kind: 'cap' };
  // background verification still running → let it report
  const bg = input?.background_tasks || [];
  if (bg.some((t) => t.type === 'shell' && t.command && classifyCommand(t.command, project).length)) return { decision: 'allow', kind: 'background' };
  if (bg.some((t) => t.type === 'subagent' && /running|pending/i.test(t.status || 'running'))) return { decision: 'allow', kind: 'background' };

  // Only edits from the current turn gate the stop; older unverified work was already surfaced to the user.
  const edits = state.edits.filter((e) => relevantEdit(e, cfg) && (!turnStartAt || e.at >= turnStartAt));
  const lastEditAt = edits.length ? edits[edits.length - 1].at : null;
  const required = requiredCategories(project, cfg);
  const claims = claimCheck ? findClaims(input?.last_assistant_message) : [];
  const problems = [];

  // Newest conclusive run (passed/failed) after `after`; an inconclusive run only when nothing else exists.
  const latestOf = (cat, after) => {
    const list = state.verifications.filter((v) => v.category === cat && !v.baseline && (!after || v.at >= after));
    for (let i = list.length - 1; i >= 0; i--) if (list[i].ok === true || list[i].ok === false) return list[i];
    return list.length ? list[list.length - 1] : null;
  };

  if (gate && lastEditAt && required.length) {
    for (const cat of required) {
      const v = latestOf(cat, lastEditAt);
      if (!v) problems.push({ cat, kind: 'missing' });
      else if (v.ok === false) problems.push({ cat, kind: 'failed', v });
      else if (v.ok !== true) problems.push({ cat, kind: 'unknown', v });
      else if (cfg.mode === 'strict' && v.scope === 'partial' && cat === 'test') problems.push({ cat, kind: 'partial', v });
    }
  }
  // Claims are checked against the whole session: the newest evidence after the newest change.
  const allEdits = state.edits.filter((e) => relevantEdit(e, cfg));
  const sessionLastEditAt = allEdits.length ? allEdits[allEdits.length - 1].at : null;
  const claimProblems = [];
  for (const c of claims) {
    const v = latestOf(c.category, sessionLastEditAt);
    const everRun = state.verifications.some((x) => x.category === c.category);
    if (!v) {
      if (!project?.commands?.[c.category] && !everRun) continue; // this repo has no way to verify that category
      claimProblems.push({ claim: c, kind: 'unverified', afterEdit: !!sessionLastEditAt });
    } else if (v.ok === false) {
      claimProblems.push({ claim: c, kind: 'contradicted', v });
    } else if (v.ok !== true) {
      claimProblems.push({ claim: c, kind: 'unknown', v });
    }
  }
  // Evidence or honest disclosure: a final message that openly says a check was not run / still fails is fine.
  const message = input?.last_assistant_message || '';
  const undisclosed = problems.filter((p) => !(p.kind !== 'partial' && disclosesGap(message, p.cat, p.kind)));
  const disclosed = problems.length - undisclosed.length;
  problems.length = 0;
  problems.push(...undisclosed);
  if (!problems.length && !claimProblems.length) return disclosed ? { decision: 'allow', kind: 'disclosed' } : { decision: 'allow' };

  const files = [...new Set(edits.map((e) => e.path))];
  const fileList = files.slice(0, 6).map((f) => `\`${f}\``).join(', ') + (files.length > 6 ? `, and ${files.length - 6} more` : '');
  const cmdCats = [...new Set([...required, ...claimProblems.map((c) => c.claim.category)])].filter((c) => project?.commands?.[c]);
  const cmds = cmdCats.map((c) => `${c}: \`${project.commands[c]}\``).join(' · ');
  const parts = ['Veridone completion check (evidence from this session\'s tool calls):'];
  for (const p of problems) {
    if (p.kind === 'missing') parts.push(`- ${files.length} file${files.length > 1 ? 's were' : ' was'} changed (${fileList}) and the ${p.cat} step has not run since the last change.`);
    else if (p.kind === 'failed') parts.push(`- The last ${p.cat} run after the latest change failed (\`${oneLine(p.v.cmd, 80)}\`${p.v.exit != null ? `, exit ${p.v.exit}` : ''}, ${ago(p.v.at)}).`);
    else if (p.kind === 'unknown') parts.push(`- The last ${p.cat} run after the latest change (\`${oneLine(p.v.cmd, 80)}\`) had its exit status ${maskLabel(p.v.masked)} and its visible output has no pass/fail summary, so its result is unknown.`);
    else if (p.kind === 'partial') parts.push(`- Only a filtered/partial test run happened after the latest change (\`${oneLine(p.v.cmd, 80)}\`); strict mode requires the full suite.`);
  }
  for (const c of claimProblems) {
    if (c.kind === 'unverified') parts.push(`- The final message claims "${c.claim.text}", but no ${c.claim.category} run was recorded${c.afterEdit ? ' after the last code change' : ' in this session'}.`);
    else if (c.kind === 'unknown') parts.push(`- The final message claims "${c.claim.text}", but the result of the last ${c.claim.category} run (\`${oneLine(c.v.cmd, 80)}\`) was not visible (exit status ${maskLabel(c.v.masked)}, no summary in the output).`);
    else parts.push(`- The final message claims "${c.claim.text}", but the most recent ${c.claim.category} run failed (\`${oneLine(c.v.cmd, 80)}\`, ${ago(c.v.at)}).`);
  }
  if (cmds) parts.push(`Verification commands for this repository — ${cmds}.`);
  const failed = problems.some((p) => p.kind === 'failed') || claimProblems.some((c) => c.kind === 'contradicted');
  const onlyUnknown = !failed && [...problems, ...claimProblems].every((p) => p.kind === 'unknown');
  parts.push(failed
    ? 'Next step: fix the failures and re-run, or tell the user exactly what is still failing. Do not describe the task as complete while checks fail.'
    : onlyUnknown
      ? 'Next step: re-run the check without truncating its output (no `| tail`/`| head`/`|| true`) and base the final message on the actual result.'
      : 'Next step: run the verification now and base the final message on its actual output. If it cannot run here (missing services, credentials, platform), say that explicitly and describe what you verified instead.');
  const summary = problems.length
    ? `Veridone: asked Claude to ${failed ? 'fix failing' : onlyUnknown ? 're-run' : 'run'} ${[...new Set(problems.map((p) => p.cat))].join('/')} before finishing (${files.length} changed file${files.length === 1 ? '' : 's'}).`
    : `Veridone: the final message claimed ${claimProblems.map((c) => c.claim.category).join('/')} success without evidence.`;
  return { decision: 'block', reason: parts.join('\n'), summary, kind: problems.length ? (failed ? 'failed' : 'unverified') : 'claim', problems, claimProblems };
}
