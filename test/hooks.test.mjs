// Integration tests: run scripts/hook.mjs exactly the way Claude Code does (JSON on stdin).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitRepo, isolatedEnv, runHook, runCli } from './helpers.mjs';

const TEST_FILE = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('adds', () => {\n  assert.equal(1 + 1, 2);\n});\n";

function setup() {
  const repo = gitRepo({
    'package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }, null, 2),
    'src/math.js': 'export const add = (a, b) => a + b;\n',
    'test/math.test.js': TEST_FILE,
  });
  const { env } = isolatedEnv();
  const session = `s-${Math.random().toString(36).slice(2, 10)}`;
  const base = (extra) => ({ session_id: session, cwd: repo, prompt_id: 'p1', permission_mode: 'default', ...extra });
  const hook = (event, extra) => runHook(event, { hook_event_name: event, ...base(extra) }, env);
  return { repo, env, session, hook };
}

/** Simulate an Edit: write the new content and send the PostToolUse payload Claude Code would send. */
function edit(ctx, rel, before, after) {
  fs.writeFileSync(path.join(ctx.repo, rel), after);
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const lines = [...oldLines.map((l) => '-' + l), ...newLines.map((l) => '+' + l)];
  return ctx.hook('PostToolUse', {
    tool_name: 'Edit',
    tool_input: { file_path: path.join(ctx.repo, rel), old_string: before, new_string: after },
    tool_response: { filePath: path.join(ctx.repo, rel), originalFile: before, structuredPatch: [{ oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length, lines }] },
  });
}

const bash = (ctx, command, stdout = '', extra = {}) => ctx.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false }, ...extra });

describe('SessionStart', () => {
  test('announces the guardrails and the detected verification command', () => {
    const ctx = setup();
    const r = ctx.hook('SessionStart', { source: 'startup' });
    assert.equal(r.status, 0);
    assert.match(r.json.hookSpecificOutput.additionalContext, /Veridone guardrails are active \(mode: standard\)/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /test: `npm test`/);
  });

  test('restores a session brief after compaction', () => {
    const ctx = setup();
    ctx.hook('SessionStart', { source: 'startup' });
    ctx.hook('UserPromptSubmit', { prompt: 'Make add() handle strings by concatenating them' });
    edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', 'export const add = (a, b) => a + b; // strings too\n');
    const r = ctx.hook('SessionStart', { source: 'compact' });
    const brief = r.json.hookSpecificOutput.additionalContext;
    assert.match(brief, /restored after context compaction/);
    assert.match(brief, /Make add\(\) handle strings/);
    assert.match(brief, /src\/math\.js/);
    assert.ok(brief.length < 3000, String(brief.length));
  });
});

describe('PreToolUse guard', () => {
  test('denies catastrophic commands with a reason for Claude', () => {
    const ctx = setup();
    const r = ctx.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } });
    assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /rm-catastrophic/);
  });
  test('asks before risky commands and stays silent for normal ones', () => {
    const ctx = setup();
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } }).json.hookSpecificOutput.permissionDecision, 'ask');
    const quiet = ctx.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    assert.equal(quiet.stdout, '');
    assert.equal(quiet.status, 0);
  });
  test('guards secret reads and protected writes', () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.repo, '.env'), 'X=1\n');
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(ctx.repo, '.env') } }).json.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(ctx.repo, '.git/config'), content: 'x' } }).json.hookSpecificOutput.permissionDecision, 'deny');
  });
  test('/veridone:mode off disables the hooks for that session only', () => {
    const ctx = setup();
    const r = runCli(['mode', 'off', '--session', ctx.session, '--cwd', ctx.repo], { env: ctx.env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }).stdout, '');
    const other = runHook('PreToolUse', { session_id: 'another', cwd: ctx.repo, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, ctx.env);
    assert.equal(other.json.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('PostToolUse integrity scan', () => {
  test('blocks a skipped test once, with an actionable reason', () => {
    const ctx = setup();
    const after = TEST_FILE.replace("test('adds'", "test.skip('adds'");
    const r = edit(ctx, 'test/math.test.js', TEST_FILE, after);
    assert.equal(r.json.decision, 'block');
    assert.match(r.json.reason, /\[test-skip\] test\/math\.test\.js:4/);
    assert.match(r.json.reason, /veridone-allow/);
    assert.match(r.json.systemMessage, /test-skip/);
    // the same finding is not reported twice
    assert.equal(edit(ctx, 'test/math.test.js', after, after + '\n').stdout, '');
  });
  test('medium findings become notes, not blocks', () => {
    const ctx = setup();
    const r = edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', '// eslint-disable-next-line\nexport const add = (a, b) => a + b;\n');
    assert.equal(r.json.decision, undefined);
    assert.match(r.json.hookSpecificOutput.additionalContext, /lint-suppression/);
  });
});

describe('Stop completion gate', () => {
  test('blocks an unverified finish once, then lets Claude stop', () => {
    const ctx = setup();
    ctx.hook('UserPromptSubmit', { prompt: 'make add variadic' });
    edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', 'export const add = (...xs) => xs.reduce((a, b) => a + b, 0);\n');
    const r = ctx.hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done — add is now variadic.' });
    assert.match(r.json.systemMessage, /asked Claude to run test/);
    assert.equal(r.json.hookSpecificOutput.hookEventName, 'Stop');
    assert.match(r.json.hookSpecificOutput.additionalContext, /test step has not run since the last change/);
    assert.equal(ctx.hook('Stop', { stop_hook_active: true, last_assistant_message: 'Done.' }).stdout, '');
  });
  test('allows the finish after a passing test run', () => {
    const ctx = setup();
    ctx.hook('UserPromptSubmit', { prompt: 'x' });
    edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', 'export const add = (a, b) => b + a;\n');
    assert.equal(bash(ctx, 'npm test', '# tests 1\n# pass 1\n# fail 0\n').stdout, '');
    assert.equal(ctx.hook('Stop', { stop_hook_active: false, last_assistant_message: 'All tests pass.' }).stdout, '');
  });
  test('a failing run recorded by PostToolUseFailure blocks the finish', () => {
    const ctx = setup();
    ctx.hook('UserPromptSubmit', { prompt: 'x' });
    edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', 'export const add = (a, b) => a - b;\n');
    ctx.hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nnot ok 1 - adds\n# fail 1', is_interrupt: false });
    const r = ctx.hook('Stop', { stop_hook_active: false, last_assistant_message: 'Fixed it, all tests pass.' });
    assert.match(r.json.hookSpecificOutput.additionalContext, /failed/);
  });
  test('a piped run with a hidden exit status is flagged immediately and does not count', () => {
    const ctx = setup();
    ctx.hook('UserPromptSubmit', { prompt: 'x' });
    edit(ctx, 'src/math.js', 'export const add = (a, b) => a + b;\n', 'export const add = (a, b) => Number(a) + Number(b);\n');
    const piped = bash(ctx, 'npm test 2>&1 | tail -2', '# todo 0\n# duration_ms 98.1\n');
    assert.match(piped.json.hookSpecificOutput.additionalContext, /not visible/);
    const failing = bash(ctx, 'npm test | tail -20', 'not ok 1 - adds\n# pass 0\n# fail 1\n');
    assert.match(failing.json.hookSpecificOutput.additionalContext, /counts as FAILED/);
    assert.ok(ctx.hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' }).json);
  });
});

describe('PostToolUseFailure loop breaker', () => {
  test('flags the third identical failure in a row', () => {
    const ctx = setup();
    const fail = () => ctx.hook('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1\nAssertionError: expected 3 to equal 4\n    at src/math.test.js:5:3 (12ms)', is_interrupt: false });
    assert.equal(fail().stdout, '');
    assert.equal(fail().stdout, '');
    const third = fail();
    assert.match(third.json.hookSpecificOutput.additionalContext, /failed 3 times in a row/);
    assert.equal(fail().stdout, '', 'reported once per signature');
  });
});

describe('output condensing', () => {
  test('replaces long passing output with failures and the summary', () => {
    const ctx = setup();
    const lines = [];
    for (let i = 0; i < 500; i++) lines.push(`ok ${i + 1} - renders variant ${i}`);
    lines.push('not ok 501 - computes totals', '  ---', '  error: Expected values to be strictly equal: 800 !== 350', '  ...', '1..501', '# tests 501', '# pass 500', '# fail 1');
    const r = bash(ctx, 'npm test', lines.join('\n'));
    const out = r.json.hookSpecificOutput.updatedToolOutput.stdout;
    assert.ok(out.length < lines.join('\n').length / 3);
    assert.match(out, /800 !== 350/);
    assert.match(out, /# fail 1/);
    assert.match(out, /Veridone condensed this output/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /counts as FAILED/, 'exit 0 with failures in the output is still a failure');
  });
});

describe('robustness', () => {
  test('garbage input never breaks Claude Code', () => {
    const { env } = isolatedEnv();
    for (const event of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'Bogus']) {
      const r = runHook(event, null, env);
      assert.equal(r.status, 0);
    }
    const spawn = (input) => runHook('PreToolUse', input, env);
    assert.equal(spawn({}).status, 0);
    assert.equal(spawn({ tool_name: 'Bash' }).status, 0);
    assert.equal(spawn({ tool_name: 'Bash', tool_input: { command: 'echo "unterminated' } }).status, 0);
  });
  test('hooks are fast', () => {
    const ctx = setup();
    const times = [];
    for (let i = 0; i < 7; i++) {
      const t = process.hrtime.bigint();
      ctx.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status && npm test' } });
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    times.sort((a, b) => a - b);
    assert.ok(times[3] < 400, `median ${times[3].toFixed(0)}ms`);
  });
});

describe('Grep guard', () => {
  test('searching a secrets file asks first; ordinary searches pass', () => {
    const ctx = setup();
    fs.writeFileSync(path.join(ctx.repo, '.env'), 'X=1\n');
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'X', path: path.join(ctx.repo, '.env') } }).json.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'URL', glob: '.env*' } }).json.hookSpecificOutput.permissionDecision, 'ask');
    assert.equal(ctx.hook('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'add', path: path.join(ctx.repo, 'src') } }).stdout, '');
  });
});
