import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectProject, describeCommands, fileKind } from '../scripts/lib/project.mjs';
import { tmpDir, writeTree } from './helpers.mjs';

const detect = (files, overrides) => detectProject(writeTree(tmpDir('veridone-proj-'), files), { overrides });

test('JavaScript/TypeScript with npm scripts', () => {
  const p = detect({
    'package.json': JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'vite build' }, devDependencies: { vitest: '1', typescript: '5' } }),
    'tsconfig.json': '{}',
  });
  assert.deepEqual(p.languages, ['typescript']);
  assert.equal(p.packageManager, 'npm');
  assert.deepEqual(p.commands, { test: 'npm test', typecheck: 'npm run typecheck', lint: 'npm run lint', build: 'npm run build' });
  assert.ok(p.frameworks.includes('vitest'));
});

test('package manager detection and dependency-based fallbacks', () => {
  const pnpm = detect({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'pnpm-lock.yaml': '' });
  assert.equal(pnpm.commands.test, 'pnpm test');
  const yarn = detect({ 'package.json': JSON.stringify({ devDependencies: { jest: '29', typescript: '5' } }), 'yarn.lock': '', 'tsconfig.json': '{}' });
  assert.equal(yarn.commands.test, 'yarn jest');
  assert.equal(yarn.commands.typecheck, 'yarn tsc --noEmit');
  const npmDefault = detect({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
  assert.equal(npmDefault.commands.test, null);
  const field = detect({ 'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0', scripts: { test: 'x' } }) });
  assert.equal(field.packageManager, 'pnpm');
});

test('Python with uv, pytest, mypy and ruff', () => {
  const p = detect({ 'pyproject.toml': '[tool.pytest.ini_options]\n[tool.mypy]\nstrict = true\n[tool.ruff]\n', 'uv.lock': '' });
  assert.deepEqual(p.commands, { test: 'uv run pytest', typecheck: 'uv run mypy .', lint: 'uv run ruff check .', build: null });
});

test('Go, Rust, JVM, .NET, Ruby, Elixir, Dart', () => {
  assert.equal(detect({ 'go.mod': 'module x' }).commands.test, 'go test ./...');
  assert.equal(detect({ 'Cargo.toml': '[package]' }).commands.lint, 'cargo clippy --all-targets');
  assert.equal(detect({ 'pom.xml': '<project/>', mvnw: '' }).commands.test, './mvnw -q test');
  assert.equal(detect({ 'build.gradle.kts': '', gradlew: '' }).commands.test, './gradlew test');
  assert.equal(detect({ 'App.sln': '' }).commands.test, 'dotnet test');
  assert.equal(detect({ Gemfile: "gem 'rspec'" }).commands.test, 'bundle exec rspec');
  assert.equal(detect({ 'mix.exs': '' }).commands.test, 'mix test');
  assert.equal(detect({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n' }).commands.test, 'flutter test');
});

test('Makefile targets win in polyglot repositories', () => {
  const p = detect({ 'go.mod': 'module x', 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), Makefile: 'test:\n\tgo test ./... && npm test\nlint:\n\tgolangci-lint run\n' });
  assert.equal(p.commands.test, 'make test');
  assert.equal(p.commands.lint, 'make lint');
  assert.equal(p.sources.test, 'Makefile:test');
});

test('configured overrides replace detection', () => {
  const p = detect({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }) }, { test: 'npm run test:unit', build: '' });
  assert.equal(p.commands.test, 'npm run test:unit');
  assert.equal(p.commands.build, null);
  assert.match(describeCommands(p), /test: `npm run test:unit`/);
});

test('nothing detected in an empty directory', () => {
  const p = detect({ 'notes.txt': 'hi' });
  assert.deepEqual(p.commands, { test: null, typecheck: null, lint: null, build: null });
  assert.equal(describeCommands(p), '');
});

test('fileKind', () => {
  const cases = {
    'src/app.ts': 'code', 'src/app.test.ts': 'test', 'tests/test_x.py': 'test', 'pkg/x_test.go': 'test', 'README.md': 'doc', 'docs/guide.txt': 'doc',
    'package.json': 'config', '.github/workflows/ci.yml': 'config', 'Dockerfile': 'config', 'logo.png': 'asset', '.gitignore': 'meta', 'styles/main.css': 'code',
  };
  for (const [p, kind] of Object.entries(cases)) assert.equal(fileKind(p), kind, p);
});
