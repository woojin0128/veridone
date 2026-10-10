import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from './helpers.mjs';

process.env.VERIDONE_DATA_DIR = tmpDir('veridone-ledger-');
const { Ledger, deriveState, listSessions, readSessionMode, writeSessionMode, gcSessions, sessionsDir } = await import('../scripts/lib/ledger.mjs');

test('appends events and derives state', () => {
  const l = new Ledger('sess-1');
  l.append({ t: 'start', projectRoot: '/p', baselineHead: 'abc' });
  l.append({ t: 'prompt', promptId: 'p1', text: 'add feature' });
  l.append({ t: 'edit', path: 'src/a.js', kind: 'code', added: 3, removed: 1 });
  l.append({ t: 'edit', path: 'src/a.js', kind: 'code', added: 2, removed: 0 });
  l.append({ t: 'verify', category: 'test', ok: true, cmd: 'npm test' });
  l.append({ t: 'finding', key: 'k1', rule: 'test-skip', path: 'a.test.js' });
  l.append({ t: 'guard', rule: 'rm-catastrophic', level: 'deny' });
  l.append({ t: 'stop', decision: 'block', kind: 'unverified', promptId: 'p1' });
  l.append({ t: 'condense', before: 10000, after: 2000 });
  const s = new Ledger('sess-1').state();
  assert.equal(s.projectRoot, '/p');
  assert.equal(s.baselineHead, 'abc');
  assert.equal(s.lastPromptId, 'p1');
  assert.equal(s.edits.length, 2);
  assert.deepEqual({ ...s.files.get('src/a.js'), firstAt: 0, lastAt: 0 }, { path: 'src/a.js', kind: 'code', edits: 2, added: 5, removed: 1, firstAt: 0, lastAt: 0 });
  assert.equal(s.verifications.length, 1);
  assert.ok(s.reported.has('k1'));
  assert.equal(s.guards[0].level, 'deny');
  assert.equal(s.stops[0].kind, 'unverified');
  assert.deepEqual(s.condensed, { count: 1, before: 10000, after: 2000 });
});

test('long fields are truncated so each append stays atomic', () => {
  const l = new Ledger('sess-long');
  l.append({ t: 'bash', cmd: 'x'.repeat(10000), ok: true });
  const line = fs.readFileSync(l.file, 'utf8').trim();
  assert.ok(line.length < 4000, String(line.length));
  assert.equal(JSON.parse(line).cmd.length <= 600, true);
});

test('torn or corrupt lines are skipped', () => {
  const l = new Ledger('sess-torn');
  l.append({ t: 'prompt', text: 'a' });
  fs.appendFileSync(l.file, '{"t":"edit","pa');
  fs.appendFileSync(l.file, '\n{"t":"prompt","text":"b"}\n');
  assert.equal(new Ledger('sess-torn').state().prompts.length, 2);
});

test('concurrent appends from many processes never interleave', async () => {
  const { spawn } = await import('node:child_process');
  const script = `import('${path.resolve('scripts/lib/ledger.mjs').replace(/\\/g, '/')}').then(({Ledger}) => { const l = new Ledger('sess-conc'); for (let i = 0; i < 200; i++) l.append({ t: 'bash', cmd: 'echo ' + 'y'.repeat(300) + i, ok: true }); });`;
  await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  })));
  const lines = fs.readFileSync(new Ledger('sess-conc').file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1600);
  for (const line of lines) JSON.parse(line);
});

test('session mode sidecar', () => {
  assert.equal(readSessionMode('sess-mode'), null);
  writeSessionMode('sess-mode', 'strict');
  assert.equal(readSessionMode('sess-mode'), 'strict');
  writeSessionMode('sess-mode', null);
  assert.equal(readSessionMode('sess-mode'), null);
});

test('session ids are sanitized into safe file names', () => {
  const l = new Ledger('../../etc/passwd');
  assert.equal(path.dirname(l.file), sessionsDir());
});

test('listing and garbage collection', () => {
  const old = new Ledger('sess-old');
  old.append({ t: 'prompt', text: 'old' });
  const past = Date.now() / 1000 - 30 * 86400;
  fs.utimesSync(old.file, past, past);
  assert.ok(listSessions(100).some((s) => s.id === 'sess-old'));
  assert.ok(gcSessions(14) >= 1);
  assert.ok(!fs.existsSync(old.file));
  assert.equal(gcSessions(14), 0, 'runs at most once a day');
});

test('deriveState tolerates unknown events', () => {
  const s = deriveState([{ t: 'future-thing', x: 1 }, { t: 'loop', sig: 's1' }]);
  assert.ok(s.loopNotices.has('s1'));
});
