// Veridone — project detection: languages, package manager, and the commands that
// verify a change (test / typecheck / lint / build).

import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, fileExists, dirExists, readTextSafe } from './util.mjs';

const NPM_DEFAULT_TEST = /no test specified/i;

function exists(root, ...names) {
  return names.some((n) => fileExists(path.join(root, n)) || dirExists(path.join(root, n)));
}

function listDir(root) {
  try { return fs.readdirSync(root); } catch { return []; }
}

function makeTargets(text) {
  const out = new Set();
  if (!text) return out;
  for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) out.add(m[1]);
  return out;
}

function tomlHas(text, section) {
  return text ? new RegExp(`^\\[${section.replace(/[.[\]]/g, '\\$&')}(\\]|\\.)`, 'm').test(text) : false;
}

/**
 * Detect project profile.
 * @param {string} root
 * @param {{overrides?:Record<string,string>}} [opts]
 */
export function detectProject(root, opts = {}) {
  const profile = {
    root,
    languages: [],
    packageManager: null,
    frameworks: [],
    monorepo: false,
    commands: { test: null, typecheck: null, lint: null, build: null },
    sources: {},
  };
  const setCmd = (cat, cmd, source) => {
    if (!cmd || profile.commands[cat]) return;
    profile.commands[cat] = cmd;
    profile.sources[cat] = source;
  };
  const entries = listDir(root);
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((f) => entries.includes(f));
  const makeT = makeTargets(makefile ? readTextSafe(path.join(root, makefile)) : null);
  const justfile = ['justfile', 'Justfile', '.justfile'].find((f) => entries.includes(f));
  const justT = makeTargets(justfile ? readTextSafe(path.join(root, justfile)) : null);

  // --- JavaScript / TypeScript ---------------------------------------------
  const pkg = readJsonFile(path.join(root, 'package.json'), null);
  const deno = exists(root, 'deno.json', 'deno.jsonc');
  if (pkg) {
    profile.languages.push(exists(root, 'tsconfig.json') || hasDep(pkg, 'typescript') ? 'typescript' : 'javascript');
    const pmField = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
    const pm = pmField || (exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : exists(root, 'bun.lockb', 'bun.lock') ? 'bun' : 'npm');
    profile.packageManager = pm;
    profile.monorepo = !!(pkg.workspaces || exists(root, 'pnpm-workspace.yaml', 'lerna.json', 'nx.json', 'turbo.json', 'rush.json'));
    const scripts = pkg.scripts || {};
    const run = (s) => (pm === 'npm' ? (s === 'test' ? 'npm test' : `npm run ${s}`) : pm === 'bun' ? `bun run ${s}` : `${pm} ${s === 'test' ? 'test' : 'run ' + s}`);
    const exec = (bin) => (pm === 'pnpm' ? `pnpm exec ${bin}` : pm === 'yarn' ? `yarn ${bin}` : pm === 'bun' ? `bunx ${bin}` : `npx ${bin}`);
    for (const f of ['vitest', 'jest', 'mocha', 'ava', '@playwright/test', 'cypress', 'karma', 'uvu', 'tap', 'node:test']) if (hasDep(pkg, f)) profile.frameworks.push(f.replace('@playwright/test', 'playwright'));
    if (scripts.test && !NPM_DEFAULT_TEST.test(scripts.test)) setCmd('test', run('test'), 'package.json#scripts.test');
    else if (hasDep(pkg, 'vitest')) setCmd('test', exec('vitest run'), 'vitest dependency');
    else if (hasDep(pkg, 'jest')) setCmd('test', exec('jest'), 'jest dependency');
    for (const s of ['typecheck', 'type-check', 'check-types', 'types', 'tsc', 'check:types', 'lint:types', 'typecheck:all']) {
      if (scripts[s]) { setCmd('typecheck', run(s), `package.json#scripts.${s}`); break; }
    }
    if (!profile.commands.typecheck && scripts.check && /tsc|svelte-check|vue-tsc|astro check/.test(scripts.check)) setCmd('typecheck', run('check'), 'package.json#scripts.check');
    if (!profile.commands.typecheck && exists(root, 'tsconfig.json') && (hasDep(pkg, 'typescript') || fileExists(path.join(root, 'node_modules', '.bin', 'tsc')))) {
      setCmd('typecheck', exec(pkgUsesProjectRefs(root) ? 'tsc -b' : 'tsc --noEmit'), 'tsconfig.json');
    }
    for (const s of ['lint', 'lint:all', 'eslint', 'check:lint']) {
      if (scripts[s]) { setCmd('lint', run(s), `package.json#scripts.${s}`); break; }
    }
    if (!profile.commands.lint && (hasDep(pkg, '@biomejs/biome'))) setCmd('lint', exec('biome check .'), 'biome dependency');
    if (!profile.commands.lint && hasDep(pkg, 'eslint') && entries.some((e) => /^(\.eslintrc|eslint\.config)/.test(e))) setCmd('lint', exec('eslint .'), 'eslint config');
    if (scripts.build) setCmd('build', run('build'), 'package.json#scripts.build');
  } else if (deno) {
    profile.languages.push('typescript');
    setCmd('test', 'deno test', 'deno.json');
    setCmd('typecheck', 'deno check .', 'deno.json');
    setCmd('lint', 'deno lint', 'deno.json');
  }

  // --- Python ---------------------------------------------------------------
  const pyproject = readTextSafe(path.join(root, 'pyproject.toml'));
  const setupCfg = readTextSafe(path.join(root, 'setup.cfg'));
  const isPy = pyproject !== null || exists(root, 'setup.py', 'requirements.txt', 'Pipfile', 'tox.ini', 'pytest.ini', 'conftest.py', 'requirements-dev.txt');
  if (isPy) {
    profile.languages.push('python');
    const prefix = exists(root, 'uv.lock') ? 'uv run ' : exists(root, 'poetry.lock') || (pyproject && /\[tool\.poetry\]/.test(pyproject)) ? 'poetry run ' : exists(root, 'Pipfile') ? 'pipenv run ' : exists(root, 'pdm.lock') ? 'pdm run ' : '';
    const pytest = exists(root, 'pytest.ini', 'conftest.py') || tomlHas(pyproject, 'tool.pytest') || /\[tool:pytest\]/.test(setupCfg || '') || /pytest/.test(pyproject || '') || /pytest/.test(readTextSafe(path.join(root, 'requirements-dev.txt')) || '') || /pytest/.test(readTextSafe(path.join(root, 'requirements.txt')) || '');
    if (pytest) { setCmd('test', `${prefix}pytest`, 'pytest config'); profile.frameworks.push('pytest'); }
    else if (exists(root, 'tests', 'test')) setCmd('test', `${prefix}python -m unittest discover`, 'tests directory');
    if (tomlHas(pyproject, 'tool.mypy') || exists(root, 'mypy.ini', '.mypy.ini') || /\[mypy\]/.test(setupCfg || '')) setCmd('typecheck', `${prefix}mypy .`, 'mypy config');
    else if (tomlHas(pyproject, 'tool.pyright') || exists(root, 'pyrightconfig.json')) setCmd('typecheck', `${prefix}pyright`, 'pyright config');
    if (tomlHas(pyproject, 'tool.ruff') || exists(root, 'ruff.toml', '.ruff.toml')) setCmd('lint', `${prefix}ruff check .`, 'ruff config');
    else if (exists(root, '.flake8') || /\[flake8\]/.test(setupCfg || '')) setCmd('lint', `${prefix}flake8`, 'flake8 config');
  }

  // --- Go ---------------------------------------------------------------------
  if (exists(root, 'go.mod', 'go.work')) {
    profile.languages.push('go');
    setCmd('test', 'go test ./...', 'go.mod');
    setCmd('typecheck', 'go build ./...', 'go.mod');
    if (entries.some((e) => /^\.golangci\./.test(e))) setCmd('lint', 'golangci-lint run', '.golangci config');
    else setCmd('lint', 'go vet ./...', 'go.mod');
  }

  // --- Rust -------------------------------------------------------------------
  if (exists(root, 'Cargo.toml')) {
    profile.languages.push('rust');
    setCmd('test', 'cargo test', 'Cargo.toml');
    setCmd('typecheck', 'cargo check --all-targets', 'Cargo.toml');
    setCmd('lint', 'cargo clippy --all-targets', 'Cargo.toml');
    setCmd('build', 'cargo build', 'Cargo.toml');
  }

  // --- JVM --------------------------------------------------------------------
  if (exists(root, 'pom.xml')) {
    profile.languages.push('java');
    const mvn = exists(root, 'mvnw') ? './mvnw' : 'mvn';
    setCmd('test', `${mvn} -q test`, 'pom.xml');
    setCmd('build', `${mvn} -q -DskipTests package`, 'pom.xml');
    setCmd('typecheck', `${mvn} -q compile`, 'pom.xml');
  } else if (exists(root, 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts')) {
    profile.languages.push(exists(root, 'build.gradle.kts') ? 'kotlin' : 'java');
    const gradle = exists(root, 'gradlew') ? './gradlew' : 'gradle';
    setCmd('test', `${gradle} test`, 'build.gradle');
    setCmd('build', `${gradle} build -x test`, 'build.gradle');
    setCmd('typecheck', `${gradle} compileJava compileTestJava`, 'build.gradle');
  }

  // --- .NET -----------------------------------------------------------------
  if (entries.some((e) => /\.(sln|slnx|csproj|fsproj)$/.test(e))) {
    profile.languages.push('csharp');
    setCmd('test', 'dotnet test', '*.sln/*.csproj');
    setCmd('build', 'dotnet build', '*.sln/*.csproj');
  }

  // --- Ruby ---------------------------------------------------------------------
  if (exists(root, 'Gemfile')) {
    profile.languages.push('ruby');
    const gem = readTextSafe(path.join(root, 'Gemfile')) || '';
    if (exists(root, 'spec', '.rspec') || /rspec/.test(gem)) setCmd('test', 'bundle exec rspec', 'Gemfile/rspec');
    else setCmd('test', 'bundle exec rake test', 'Gemfile');
    if (/rubocop/.test(gem) || exists(root, '.rubocop.yml')) setCmd('lint', 'bundle exec rubocop', 'rubocop');
    if (/sorbet/.test(gem)) setCmd('typecheck', 'bundle exec srb tc', 'sorbet');
  }

  // --- PHP --------------------------------------------------------------------
  const composer = readJsonFile(path.join(root, 'composer.json'), null);
  if (composer) {
    profile.languages.push('php');
    if (composer.scripts?.test) setCmd('test', 'composer test', 'composer.json#scripts.test');
    else if (exists(root, 'vendor/bin/pest') || JSON.stringify(composer['require-dev'] || {}).includes('pestphp')) setCmd('test', 'vendor/bin/pest', 'pest');
    else if (exists(root, 'phpunit.xml', 'phpunit.xml.dist')) setCmd('test', 'vendor/bin/phpunit', 'phpunit.xml');
    if (exists(root, 'phpstan.neon', 'phpstan.neon.dist')) setCmd('typecheck', 'vendor/bin/phpstan analyse', 'phpstan');
    else if (exists(root, 'psalm.xml')) setCmd('typecheck', 'vendor/bin/psalm', 'psalm');
  }

  // --- Others -------------------------------------------------------------------
  if (exists(root, 'mix.exs')) {
    profile.languages.push('elixir');
    setCmd('test', 'mix test', 'mix.exs');
    setCmd('build', 'mix compile --warnings-as-errors', 'mix.exs');
  }
  if (exists(root, 'Package.swift')) {
    profile.languages.push('swift');
    setCmd('test', 'swift test', 'Package.swift');
    setCmd('build', 'swift build', 'Package.swift');
  }
  const pubspec = readTextSafe(path.join(root, 'pubspec.yaml'));
  if (pubspec !== null) {
    profile.languages.push('dart');
    const flutter = /\bflutter\s*:/.test(pubspec);
    setCmd('test', flutter ? 'flutter test' : 'dart test', 'pubspec.yaml');
    setCmd('typecheck', flutter ? 'flutter analyze' : 'dart analyze', 'pubspec.yaml');
  }
  if (exists(root, 'CMakeLists.txt') && !profile.commands.build) {
    profile.languages.push('cpp');
    setCmd('build', 'cmake --build build', 'CMakeLists.txt');
    if (dirExists(path.join(root, 'build'))) setCmd('test', 'ctest --test-dir build', 'CMakeLists.txt');
  }
  if (exists(root, 'build.zig')) {
    profile.languages.push('zig');
    setCmd('test', 'zig build test', 'build.zig');
    setCmd('build', 'zig build', 'build.zig');
  }

  // --- Make / just take precedence in polyglot repos or when nothing else matched
  const polyglot = new Set(profile.languages).size > 1;
  for (const [targets, tool, file] of [[makeT, 'make', makefile], [justT, 'just', justfile]]) {
    if (!file) continue;
    for (const [cat, names] of [['test', ['test', 'tests', 'check']], ['lint', ['lint']], ['typecheck', ['typecheck', 'type-check', 'types']], ['build', ['build']]]) {
      const t = names.find((n) => targets.has(n));
      if (!t) continue;
      if (polyglot || !profile.commands[cat]) {
        profile.commands[cat] = `${tool} ${t}`;
        profile.sources[cat] = `${file}:${t}`;
      }
    }
  }

  // --- User overrides ----------------------------------------------------------
  for (const [cat, cmd] of Object.entries(opts.overrides || {})) {
    if (!['test', 'typecheck', 'lint', 'build'].includes(cat)) continue;
    profile.commands[cat] = cmd || null;
    profile.sources[cat] = 'config';
  }
  profile.languages = [...new Set(profile.languages)];
  return profile;
}

function hasDep(pkg, name) {
  return !!(pkg.dependencies?.[name] || pkg.devDependencies?.[name] || pkg.peerDependencies?.[name] || pkg.optionalDependencies?.[name]);
}

function pkgUsesProjectRefs(root) {
  const ts = readTextSafe(path.join(root, 'tsconfig.json')) || '';
  return /"references"\s*:\s*\[\s*\{/.test(ts) && /"files"\s*:\s*\[\s*\]/.test(ts);
}

export function describeCommands(profile) {
  const parts = [];
  for (const cat of ['test', 'typecheck', 'lint', 'build']) {
    if (profile.commands[cat]) parts.push(`${cat}: \`${profile.commands[cat]}\``);
  }
  return parts.join(' · ');
}

/** Categorize a changed file for verification purposes. */
export function fileKind(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  const base = p.split('/').pop() || '';
  if (/(^|\/)(__tests__|tests?|specs?|e2e)\/|\.(test|spec|e2e)\.[a-z]+$|_test\.(go|py|rb|exs|dart)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(java|kt|cs|swift)$/i.test(p)) return 'test';
  if (/\.(md|mdx|rst|txt|adoc|org)$/i.test(base) || /(^|\/)docs?\//i.test(p) || /^(LICENSE|NOTICE|AUTHORS|CODEOWNERS)/i.test(base)) return 'doc';
  if (/\.(png|jpe?g|gif|svg|ico|webp|avif|mp4|mp3|woff2?|ttf|otf|pdf|zip)$/i.test(base)) return 'asset';
  if (/^(\.gitignore|\.gitattributes|\.editorconfig|\.prettierrc.*|\.prettierignore|\.nvmrc|\.node-version|\.tool-versions)$/i.test(base)) return 'meta';
  if (/\.(json|ya?ml|toml|ini|cfg|conf|env\..*|xml|gradle|kts|properties|lock)$/i.test(base) || /^(Dockerfile.*|Makefile|justfile|Procfile|\.env.*)$/i.test(base)) return 'config';
  if (/\.(c|cc|cpp|cxx|h|hpp|cs|fs|go|rs|java|kt|scala|groovy|swift|m|mm|py|pyi|rb|php|js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|astro|dart|ex|exs|erl|hs|ml|clj|cljs|lua|r|jl|zig|nim|sh|bash|zsh|ps1|sql|graphql|gql|proto|css|scss|sass|less|html|htm|hbs|ejs|jinja2?|tf)$/i.test(base)) return 'code';
  return 'other';
}
