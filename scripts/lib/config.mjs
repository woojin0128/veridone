// Veridone — configuration: defaults, modes, layered loading.
//
// Precedence (low -> high):
//   built-in defaults < ~/.claude/veridone.json < <project>/.claude/veridone.json
//   < <project>/.claude/veridone.local.json < session mode (/veridone:mode) < VERIDONE_MODE env
//   < organization policy file (Team license; its "locked" keys cannot be overridden)

import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, homeDir, dirExists, fileExists } from './util.mjs';

export const MODES = ['strict', 'standard', 'relaxed', 'off'];

export const DEFAULT_CONFIG = Object.freeze({
  mode: 'standard',
  guard: {
    enabled: true,
    rules: {},
    allowCommands: [],
    protectedBranches: ['main', 'master', 'trunk', 'develop', 'production', 'prod', 'release', 'release/*', 'stable'],
    disposableDirs: [
      'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
      'coverage', '.nyc_output', 'target', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox',
      '.venv', 'venv', '.gradle', '.dart_tool', 'tmp', '.tmp', 'temp', 'logs', '.expo', '.angular', 'storybook-static',
      '.eslintcache', '.vite', '.docusaurus', '.serverless', '.terraform', 'bin', 'obj', 'DerivedData', '.build', 'Pods',
    ],
    sensitiveFiles: [
      '**/.env', '**/.env.*', '**/.envrc', '**/.dev.vars', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/*.jks', '**/*.keystore',
      '**/id_rsa', '**/id_rsa_*', '**/id_dsa', '**/id_ecdsa', '**/id_ed25519', '**/id_ed25519_*', '**/.ssh/**',
      '**/.aws/credentials', '**/.aws/config', '**/.azure/**', '**/.config/gcloud/**', '**/.kube/config', '**/.docker/config.json',
      '**/.npmrc', '**/.pypirc', '**/.netrc', '**/.git-credentials', '**/.gnupg/**', '**/credentials.json',
      '**/service-account*.json', '**/*serviceaccount*.json', '**/secrets.yml', '**/secrets.yaml', '**/secrets.json',
      '**/.vault-token', '**/terraform.tfstate', '**/terraform.tfstate.backup', '**/*.tfvars',
    ],
    sensitiveExceptions: [
      '**/.env.example', '**/.env.sample', '**/.env.template', '**/.env.dist', '**/.env.defaults', '**/.env.schema',
      '**/*.pub', '**/.ssh/known_hosts', '**/.ssh/config', '**/*.example.*', '**/example.tfvars',
    ],
    protectedFiles: {
      deny: ['**/.git/**'],
      ask: [
        '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lock', '**/bun.lockb', '**/Cargo.lock', '**/poetry.lock',
        '**/Pipfile.lock', '**/composer.lock', '**/Gemfile.lock', '**/go.sum', '**/uv.lock', '**/pdm.lock', '**/mix.lock',
        '**/Package.resolved', '**/flake.lock', '**/packages.lock.json', '**/gradle.lockfile',
        '**/node_modules/**', '**/vendor/**', '**/*.min.js', '**/*.min.css',
      ],
    },
    guardrailFiles: [
      '**/.claude/settings.json', '**/.claude/settings.local.json', '**/.claude/veridone.json', '**/.claude/veridone.local.json',
      '**/.claude/hooks/**', '**/.husky/**', '**/.pre-commit-config.yaml', '**/lefthook.yml', '**/.lefthook.yml',
      '**/.git/hooks/**', '**/.claude/veridone-policy.json', '**/.claude/plugins/**',
    ],
    migrationDirs: ['**/migrations/**', '**/db/migrate/**', '**/prisma/migrations/**', '**/alembic/versions/**', '**/migrate/**/*.sql', '**/flyway/**/*.sql', '**/liquibase/**'],
    scanScripts: true,
    customRules: [],
  },
  secrets: {
    enabled: true,
    block: 'high',
    allowFiles: ['**/*.test.*', '**/*.spec.*', '**/test/**/fixtures/**', '**/__fixtures__/**', '**/testdata/**'],
  },
  integrity: {
    enabled: true,
    rules: {},
    customRules: [],
    ignore: ['**/node_modules/**', '**/vendor/**', '**/dist/**', '**/build/**', '**/*.min.js', '**/*.lock', '**/*.snap', '**/CHANGELOG.md'],
  },
  verify: {
    stopGate: true,
    claimCheck: true,
    commands: {},
    require: 'auto',
    maxBlocksPerTurn: 1,
    ignore: ['**/*.md', '**/*.mdx', '**/*.txt', '**/*.rst', '**/docs/**', '**/LICENSE*', '**/.gitignore', '**/*.png', '**/*.jpg', '**/*.svg', '**/.claude/**'],
  },
  condense: { enabled: true, minChars: 6000, targetChars: 3500 },
  context: { onStart: true, afterCompact: true },
  loopBreaker: { enabled: true, threshold: 3 },
});

const UNION_KEYS = new Set([
  'guard.allowCommands', 'guard.protectedBranches', 'guard.disposableDirs', 'guard.sensitiveFiles', 'guard.sensitiveExceptions',
  'guard.protectedFiles.deny', 'guard.protectedFiles.ask', 'guard.guardrailFiles', 'guard.migrationDirs',
  'secrets.allowFiles', 'integrity.ignore', 'verify.ignore', 'guard.customRules', 'integrity.customRules',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, over, prefix = '') {
  if (!isPlainObject(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === '$schema' || k === 'locked' || k === 'extends') continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out[k] = UNION_KEYS.has(key) && Array.isArray(base?.[k]) ? [...new Set([...base[k], ...v])] : [...v];
    } else if (isPlainObject(v)) {
      out[k] = deepMerge(isPlainObject(base?.[k]) ? base[k] : {}, v, key);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/** Find the project root: nearest ancestor containing .git, else CLAUDE_PROJECT_DIR, else cwd. */
export function findProjectRoot(cwd) {
  const start = path.resolve(cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let dir = start;
  for (let i = 0; i < 64; i++) {
    if (dirExists(path.join(dir, '.git')) || fileExists(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (process.env.CLAUDE_PROJECT_DIR && start.startsWith(path.resolve(process.env.CLAUDE_PROJECT_DIR))) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }
  return start;
}

export function configPaths(projectRoot) {
  const home = homeDir();
  return {
    user: path.join(home, '.claude', 'veridone.json'),
    project: path.join(projectRoot, '.claude', 'veridone.json'),
    local: path.join(projectRoot, '.claude', 'veridone.local.json'),
    policy: process.env.VERIDONE_POLICY_FILE || path.join(home, '.claude', 'veridone-policy.json'),
  };
}

/**
 * Load the effective configuration.
 * @param {{projectRoot:string, sessionMode?:string|null, policyAllowed?:boolean}} opts
 * @returns {{config:any, sources:string[], warnings:string[], policy:any}}
 */
export function loadConfig({ projectRoot, sessionMode = null, policyAllowed = null }) {
  const paths = configPaths(projectRoot);
  const sources = [];
  const warnings = [];
  let cfg = structuredClone(DEFAULT_CONFIG);

  for (const [label, p] of [['user', paths.user], ['project', paths.project], ['local', paths.local]]) {
    if (!fileExists(p)) continue;
    const data = readJsonFile(p, undefined);
    if (data === undefined || !isPlainObject(data)) {
      warnings.push(`Ignored invalid JSON in ${label} config: ${p}`);
      continue;
    }
    cfg = deepMerge(cfg, data);
    sources.push(`${label}:${p}`);
  }

  if (sessionMode && MODES.includes(sessionMode)) {
    cfg.mode = sessionMode;
    sources.push(`session:mode=${sessionMode}`);
  }
  const envMode = process.env.VERIDONE_MODE;
  if (envMode && MODES.includes(envMode)) {
    cfg.mode = envMode;
    sources.push(`env:VERIDONE_MODE=${envMode}`);
  }
  if (process.env.VERIDONE_DISABLE === '1' || process.env.VERIDONE_DISABLE === 'true') {
    cfg.mode = 'off';
    sources.push('env:VERIDONE_DISABLE');
  }

  // Organization policy (Team feature). Locked keys override everything.
  let policy = null;
  if (fileExists(paths.policy)) {
    const data = readJsonFile(paths.policy, undefined);
    if (!isPlainObject(data)) {
      warnings.push(`Ignored invalid policy file: ${paths.policy}`);
    } else if (policyAllowed === false) {
      warnings.push(`Organization policy ${paths.policy} requires a Veridone Team license (or the free trial: \`/veridone:license trial\`); it was not applied.`);
    } else {
      policy = data;
      cfg = deepMerge(cfg, data);
      if (data.locked && data.mode && MODES.includes(data.mode)) cfg.mode = data.mode;
      sources.push(`policy:${paths.policy}`);
    }
  }

  if (!MODES.includes(cfg.mode)) {
    warnings.push(`Unknown mode "${cfg.mode}", using "standard".`);
    cfg.mode = 'standard';
  }
  return { config: cfg, sources, warnings, policy };
}

/** Mode helpers */
export function isOff(cfg) { return cfg.mode === 'off'; }

/** Does this config use features that need a license check (custom rules)? */
export function usesCustomRules(cfg) {
  return !!(cfg?.guard?.customRules?.length || cfg?.integrity?.customRules?.length);
}

/** Drop licensed-only settings when no license covers them. Returns a warning or null. */
export function applyEntitlements(cfg, hasCustomRules) {
  if (!usesCustomRules(cfg) || hasCustomRules) return null;
  cfg.guard.customRules = [];
  cfg.integrity.customRules = [];
  return 'Custom rules (guard.customRules / integrity.customRules) need a Veridone Pro or Team license; they are ignored. Try them free for 14 days with `/veridone:license trial`.';
}

/**
 * Resolve the level for a rule given mode defaults and user overrides.
 * @param {Record<string, any>} table rule -> {strict, standard, relaxed} or {all}
 * @param {string} ruleId
 * @param {any} cfg effective config
 * @param {Record<string,string>} overrides e.g. cfg.guard.rules
 */
export function ruleLevel(table, ruleId, cfg, overrides = {}) {
  if (cfg.mode === 'off') return 'off';
  const o = overrides?.[ruleId];
  if (typeof o === 'string') return o;
  const def = table[ruleId];
  if (!def) return 'off';
  if (def.all) return def.all;
  return def[cfg.mode] ?? def.standard ?? 'off';
}

export function writeProjectConfig(projectRoot, data, { local = false } = {}) {
  const p = local ? configPaths(projectRoot).local : configPaths(projectRoot).project;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}
