import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { gitRepo, tmpDir } from './helpers.mjs';

process.env.VERIDONE_DATA_DIR = tmpDir('veridone-intel-data-');
const { parseFile } = await import('../scripts/lib/intel/symbols.mjs');
const { buildIndex, repoMap, outline, findSymbol, impact, scopedTestCommand } = await import('../scripts/lib/intel/index.mjs');

let repo;
before(() => {
  repo = gitRepo({
    'package.json': '{"name":"shop","scripts":{"test":"vitest run"},"devDependencies":{"vitest":"1"}}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@core/*":["src/core/*"]}}}',
    'src/core/db.ts': [
      'export interface QueryResult { rows: unknown[] }',
      'export class Database {',
      '  constructor(private url: string) {}',
      '  async query(sql: string): Promise<QueryResult> {',
      '    return { rows: [] };',
      '  }',
      '}',
      'export function connectDatabase(url: string): Database {',
      '  const helper = () => url.trim();',
      '  return new Database(helper());',
      '}',
    ].join('\n'),
    'src/services/users.ts': "import { Database, connectDatabase } from '../core/db';\nexport class UserService {\n  constructor(private db: Database = connectDatabase('x')) {}\n  findUser(id: string) { return this.db.query(id); }\n}\n",
    'src/services/orders.ts': "import { connectDatabase } from '@core/db';\nexport function listOrders() { return connectDatabase('y').query('select'); }\n",
    'src/api/routes.ts': "import { UserService } from '../services/users';\nimport { listOrders } from '../services/orders';\nexport const routes = { users: new UserService(), orders: listOrders };\n",
    'src/index.ts': "import { routes } from './api/routes';\nexport default routes;\n",
    'tests/users.test.ts': "import { UserService } from '../src/services/users';\ntest('finds', () => { expect(new UserService()).toBeTruthy(); });\n",
    'examples/demo.ts': "import { connectDatabase } from '../src/core/db';\nexport function demo() { return connectDatabase('demo'); }\n",
    'app/models.py': 'class Account:\n    def balance(self):\n        return 0\n\n\ndef open_account():\n    return Account()\n',
    'app/views.py': 'from app.models import Account, open_account\n\n\ndef show():\n    return open_account().balance()\n',
    'go.mod': 'module example.com/shop\n\ngo 1.22\n',
    'pkg/store/store.go': 'package store\n\ntype Store struct{}\n\nfunc NewStore() *Store { return &Store{} }\n\nfunc (s *Store) Get(k string) string { return k }\n',
    'pkg/store/store_test.go': 'package store\n\nimport "testing"\n\nfunc TestGet(t *testing.T) {}\n',
    'cmd/main.go': 'package main\n\nimport "example.com/shop/pkg/store"\n\nfunc main() { store.NewStore() }\n',
  });
});

test('parses symbols with line ranges, nesting and exports', () => {
  const ts = parseFile('src/core/db.ts', [
    'export class Database {',
    '  query(sql: string) {',
    '    const inner = () => 1;',
    '    return inner();',
    '  }',
    '}',
    'function local() {}',
  ].join('\n'));
  const byName = Object.fromEntries(ts.symbols.map((s) => [s.name, s]));
  assert.equal(byName.Database.kind, 'class');
  assert.equal(byName.Database.exported, true);
  assert.equal(byName.Database.endLine, 6);
  assert.equal(byName.query.kind, 'method');
  assert.equal(byName.query.parent, 'Database');
  assert.equal(byName.local.exported, false);
  assert.ok(!byName.inner, 'nested helpers are not listed as top-level symbols');

  const py = parseFile('a.py', 'import os\nfrom .models import X\n\nclass A:\n    def m(self):\n        def inner():\n            pass\n\n\ndef top():\n    pass\n');
  assert.deepEqual(py.symbols.map((s) => `${s.kind}:${s.name}`), ['class:A', 'method:m', 'function:top']);
  assert.deepEqual(py.imports.map((i) => i.spec), ['os', '.models']);

  const go = parseFile('x.go', 'package x\n\nimport (\n\t"fmt"\n\t"example.com/m/pkg"\n)\n\ntype S struct{}\n\nfunc (s *S) Run() error { return nil }\n\nfunc New() *S { return &S{} }\n');
  assert.deepEqual(go.symbols.map((s) => `${s.kind}:${s.name}`).sort(), ['function:New', 'method:Run', 'type:S'].sort());
  assert.deepEqual(go.imports.map((i) => i.spec), ['fmt', 'example.com/m/pkg']);
});

test('indexes incrementally', () => {
  const first = buildIndex(repo);
  assert.ok(first.stats.total >= 12);
  const again = buildIndex(repo);
  assert.equal(again.stats.parsed, 0);
  assert.equal(again.stats.reused, again.stats.total);
});

test('the repo map ranks the most depended-on code first and skips examples', () => {
  const { text } = repoMap(repo, { maxTokens: 3000 });
  const pos = (f) => text.indexOf(`\n${f} `);
  assert.ok(pos('src/core/db.ts') > 0, text);
  assert.ok(pos('src/core/db.ts') < pos('src/api/routes.ts'), 'db.ts ranks above the modules that use it');
  assert.equal(pos('src/index.ts'), -1, 'files without definitions are left out');
  assert.ok(pos('src/core/db.ts') < pos('examples/demo.ts'), 'examples are peripheral');
  assert.match(text, /class Database \(L2-7\)/);
  assert.match(text, /function connectDatabase \(L8-11\)/);
});

test('the repo map respects its budget and subdirectory', () => {
  const small = repoMap(repo, { maxTokens: 200 });
  assert.ok(small.text.length <= 200 * 4 + 400);
  assert.match(small.text, /more files not shown/);
  const sub = repoMap(repo, { subdir: 'app' });
  assert.match(sub.text, /app\/models\.py/);
  assert.doesNotMatch(sub.text, /src\/core\/db\.ts/);
});

test('outline and findSymbol', () => {
  const o = outline(repo, ['src/core/db.ts', 'missing.ts']);
  assert.match(o, /src\/core\/db\.ts \(11 lines/);
  assert.match(o, /method Database\.query \(L4-6\)/);
  assert.match(o, /missing\.ts: not found/);
  const f = findSymbol(repo, 'UserService');
  assert.match(f.split('\n')[0], /^src\/services\/users\.ts:2 {2}class UserService/);
  assert.match(findSymbol(repo, 'cd'), /connectDatabase/, 'camelCase initials');
  assert.match(findSymbol(repo, 'zzzz'), /No symbol matching/);
});

test('impact follows imports (relative, tsconfig aliases, Python, Go) and finds tests', () => {
  const r = impact(repo, ['src/core/db.ts']);
  const deps = Object.fromEntries(r.dependents);
  assert.equal(deps['src/services/users.ts'], 1);
  assert.equal(deps['src/services/orders.ts'], 1, 'resolved through the @core/* alias');
  assert.equal(deps['src/api/routes.ts'], 2);
  assert.ok(r.tests.includes('tests/users.test.ts'));
  assert.deepEqual(Object.fromEntries(impact(repo, ['app/models.py']).dependents), { 'app/views.py': 1 });
  const g = impact(repo, ['pkg/store/store.go']);
  assert.ok(g.dependents.some(([f]) => f === 'cmd/main.go'));
  assert.ok(g.tests.includes('pkg/store/store_test.go'));
});

test('scopedTestCommand builds a runner-specific command', () => {
  assert.equal(scopedTestCommand({ frameworks: ['vitest'], packageManager: 'pnpm' }, ['a.test.ts']), 'pnpm exec vitest run a.test.ts');
  assert.equal(scopedTestCommand({ frameworks: [], commands: { test: 'uv run pytest' } }, ['tests/test_a.py']), 'uv run pytest tests/test_a.py');
  assert.equal(scopedTestCommand({}, ['pkg/a_test.go']), 'go test ./pkg');
  assert.equal(scopedTestCommand({}, []), null);
});
