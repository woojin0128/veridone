// End-to-end tests of the `veridone` CLI (used by skills, CI and humans).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gitRepo, isolatedEnv, runCli, runHook, git, tmpDir } from './helpers.mjs';
import { signLicense } from '../scripts/lib/license.mjs';

const TEST_FILE = "test('adds', () => {\n  expect(add(1, 2)).toEqual(3);\n});\n";

function project() {
  const repo = gitRepo({
    'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '1' } }, null, 2),
    'src/add.js': 'export const add = (a, b) => a + b;\n',
    'src/add.test.js': TEST_FILE,
  });
  const iso = isolatedEnv();
  const cli = (...args) => runCli(args, { cwd: repo, env: iso.env });
  return { repo, ...iso, cli };
}

describe('basics', () => {
  test('version, help and unknown commands', () => {
    const { cli } = project();
    assert.match(cli('version').stdout, /^\d+\.\d+\.\d+\n$/);
    assert.match(cli('help').stdout, /Usage: veridone <command>/);
    const bad = cli('frobnicate');
    assert.equal(bad.status, 2);
    assert.match(bad.stdout, /Usage/);
  });

  test('detect and init', () => {
    const { cli, repo } = project();
    const d = cli('detect');
    assert.match(d.stdout, /test {7}npm test {3}\(package\.json#scripts\.test\)/);
    assert.match(d.stdout, /lint {7}npm run lint/);
    assert.equal(JSON.parse(cli('detect', '--json').stdout).commands.test, 'npm test');
    const proposal = cli('init');
    assert.match(proposal.stdout, /run with --write to save/);
    assert.ok(!fs.existsSync(path.join(repo, '.claude/veridone.json')));
    assert.equal(cli('init', '--write').status, 0);
    const cfg = JSON.parse(fs.readFileSync(path.join(repo, '.claude/veridone.json'), 'utf8'));
    assert.equal(cfg.verify.commands.test, 'npm test');
    assert.equal(cfg.mode, 'standard');
  });

  test('--exit-zero keeps skills alive and routes errors to stdout', () => {
    const { cli } = project();
    const r = cli('mode', '--exit-zero');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: veridone mode/);
    assert.equal(r.stderr, '');
    assert.equal(cli('mode').status, 2);
  });

  test('empty option values fall back to defaults', () => {
    const { cli } = project();
    const r = cli('map', '--path', '', '--cwd', '', '--data', '');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Repository map/);
  });
});

describe('scan', () => {
  test('passes on a clean tree and fails on a skipped test', () => {
    const { cli, repo } = project();
    const clean = cli('scan');
    assert.equal(clean.status, 0);
    assert.match(clean.stdout, /no integrity or secret findings/);
    fs.writeFileSync(path.join(repo, 'src/add.test.js'), TEST_FILE.replace("test('adds'", "test.skip('adds'"));
    const dirty = cli('scan');
    assert.equal(dirty.status, 1);
    assert.match(dirty.stdout, /HIGH {3}src\/add\.test\.js:1 {2}\[test-skip\]/);
    assert.equal(cli('scan', '--fail-on', 'none').status, 0);
  });

  test('covers untracked files and hard-coded credentials', () => {
    const { cli, repo } = project();
    const key = 'sk_live_' + crypto.randomBytes(18).toString('base64url').replace(/[^A-Za-z0-9]/g, 'q');
    fs.writeFileSync(path.join(repo, 'src/pay.js'), `export const stripe = "${key}";\n`);
    const r = cli('scan', '--format', 'json');
    const findings = JSON.parse(r.stdout).findings;
    assert.ok(findings.some((f) => f.rule === 'secret:stripe-live-key' && f.file === 'src/pay.js'), r.stdout);
    assert.ok(!r.stdout.includes(key), 'the secret itself is never printed');
  });

  test('compares a branch against its base for CI', () => {
    const { cli, repo } = project();
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'src/add.js'), '// @ts-nocheck\nexport const add = (a, b) => a + b;\n');
    git(repo, 'commit', '-qam', 'suppress');
    const r = cli('scan', '--base', 'main', '--format', 'github');
    assert.match(r.stdout, /^::warning file=src\/add\.js,line=1,title=Veridone%3A Type checker suppressed::/m);
    assert.match(r.stdout, /PASS/, 'medium findings do not fail by default');
    assert.equal(cli('scan', '--base', 'main', '--fail-on', 'medium').status, 1);
    const md = cli('scan', '--base', 'main', '--format', 'markdown').stdout;
    assert.match(md, /\| medium \| `type-suppression` \| `src\/add\.js:1` \|/);
    assert.equal(cli('scan', '--base', 'nope').status, 2);
  });

  test('works in a repository without commits and refuses outside git', () => {
    const repo = gitRepo({ 'a.test.js': "it.only('x', () => {});\n" }, { commit: false });
    const { env } = isolatedEnv();
    const r = runCli(['scan'], { cwd: repo, env });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /test-focus/);
    const plain = tmpDir();
    assert.equal(runCli(['scan'], { cwd: plain, env }).status, 2);
  });

  test('SARIF output is a Pro feature', () => {
    const { cli } = project();
    const r = cli('scan', '--format', 'sarif');
    assert.equal(r.status, 3);
    assert.match(r.stderr, /needs Veridone Pro/);
  });
});

describe('session commands', () => {
  test('mode, status, handoff and report read the ledger the hooks write', () => {
    const { cli, repo, env } = project();
    const session = 'cli-session-1';
    const hook = (event, extra) => runHook(event, { hook_event_name: event, session_id: session, cwd: repo, prompt_id: 'p1', ...extra }, env);
    hook('SessionStart', { source: 'startup' });
    hook('UserPromptSubmit', { prompt: 'Add subtraction support' });
    const before = 'export const add = (a, b) => a + b;\n';
    const after = before + 'export const sub = (a, b) => a - b;\n';
    fs.writeFileSync(path.join(repo, 'src/add.js'), after);
    hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/add.js') }, tool_response: { originalFile: before, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' export const add = (a, b) => a + b;', '+export const sub = (a, b) => a - b;'] }] } });
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } });
    hook('Stop', { stop_hook_active: false, last_assistant_message: 'Done.' });

    const status = cli('status', '--session', session);
    assert.match(status.stdout, /src\/add\.js/);
    assert.match(status.stdout, /not run/i);
    const js = JSON.parse(cli('status', '--session', session, '--json').stdout);
    assert.equal(js.files[0].path, 'src/add.js');
    assert.equal(js.guards[0].rule, 'rm-catastrophic');

    // the most recent session for the project is found without --session (as skills do on older hosts)
    assert.match(cli('status', '--session', '${CLAUDE_SESSION_ID}').stdout, /src\/add\.js/);

    const out = path.join(repo, '.claude/handoff.md');
    assert.equal(cli('handoff', '--session', session, '--out', '.claude/handoff.md').status, 0);
    const note = fs.readFileSync(out, 'utf8');
    assert.match(note, /Original request: Add subtraction support/);
    assert.match(note, /- \[ \] Run test: `npm test`/);

    assert.match(cli('mode', 'strict', '--session', session).stdout, /mode for this session: strict/);
    assert.equal(fs.readFileSync(path.join(env.VERIDONE_DATA_DIR, 'sessions', `${session}.mode`), 'utf8'), 'strict');
    assert.match(cli('mode', 'reset', '--session', session).stdout, /reset/);

    const report = JSON.parse(cli('report', '--json').stdout);
    assert.equal(report.sessions, 1);
    assert.equal(report.stopBlocks, 1);
    assert.equal(report.denies, 1);
    assert.match(cli('report').stdout, /Premature "done" caught \(completion gate\): 1/);
    assert.equal(cli('report', '--html', 'r.html').status, 3, 'HTML report is a Pro feature');
  });

  test('changes and check-command', () => {
    const { cli, repo } = project();
    fs.writeFileSync(path.join(repo, 'src/add.js'), '// changed\n');
    const c = cli('changes', '--stat', '--log', '3');
    assert.match(c.stdout, /Branch: main @ [0-9a-f]{10}/);
    assert.match(c.stdout, /\.M src\/add\.js/);
    assert.match(c.stdout, /Recent commits:\n {2}[0-9a-f]+ initial/);
    const chk = cli('check-command', 'rm -rf /');
    assert.match(chk.stdout, /Decision: deny/);
    assert.match(cli('check-command', 'npm test').stdout, /allow/);
  });
});

describe('licensing', () => {
  test('status, activation errors, and deactivation', () => {
    const { cli, home } = project();
    assert.match(cli('license').stdout, /Plan: free/);
    const bad = cli('license', 'activate', 'VD1.bogus.key');
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /License not activated/);
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/veridone-license.key'), 'garbage\n');
    assert.match(cli('license', 'status').stdout, /not active: malformed license key/);
    assert.match(cli('license', 'deactivate').stdout, /License removed/);
    assert.match(cli('license', 'deactivate').stdout, /No license is activated/);
  });

  test('a key signed by a different vendor key is rejected', () => {
    const { cli } = project();
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const key = signLicense({ id: 'x', email: 'a@b.c', plan: 'pro' }, other);
    assert.equal(cli('license', 'activate', key).status, 1);
  });
});

test('custom rules are ignored (with a warning) without a license', () => {
  const { cli, repo } = project();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude/veridone.json'), JSON.stringify({ integrity: { customRules: [{ id: 'no-todo', pattern: 'TODO', severity: 'high' }] } }));
  assert.match(cli('detect').stdout, /warning: Custom rules .* need a Veridone Pro or Team license/);
  fs.writeFileSync(path.join(repo, 'src/add.js'), '// TODO later\nexport const add = (a, b) => a + b;\n');
  assert.equal(cli('scan').status, 0);
});

test('doctor reports a healthy installation', () => {
  const { cli } = project();
  const r = cli('doctor');
  assert.match(r.stdout, /✔ Node\.js >= 18/);
  assert.match(r.stdout, /✔ Guard hook responds \(rm -rf \/ is denied\)/);
  assert.match(r.stdout, /✔ Verification commands detected/);
});


