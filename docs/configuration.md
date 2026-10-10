# Configuration

Veridone works with no configuration: it detects your project's verification commands and uses the `standard` mode. Configure it when you want to pin the commands, tighten or relax rules, or add team rules.

## Where settings live

Settings are merged in this order; later layers win:

| Layer | File | Typical use |
|---|---|---|
| Built-in defaults | — | Everything below starts from these |
| User | `~/.claude/veridone.json` | Your personal defaults for every project |
| Project | `.claude/veridone.json` | Shared team settings (commit it) |
| Local | `.claude/veridone.local.json` | Personal overrides for one project (git-ignore it) |
| Session | `/veridone:mode <mode>` | Temporary, this session only |
| Environment | `VERIDONE_MODE=strict`, `VERIDONE_DISABLE=1` | CI, scripts |
| Organization policy (Team) | `~/.claude/veridone-policy.json` or `VERIDONE_POLICY_FILE` | Company-wide rules; with `"locked": true` its mode can't be overridden |

Lists such as `guard.protectedBranches`, `integrity.ignore` or `integrity.customRules` **extend** the defaults instead of replacing them. Files may contain `//` comments. Add `"$schema"` for editor autocomplete:

```json
{ "$schema": "https://raw.githubusercontent.com/woojin0128/veridone/main/schemas/veridone.schema.json" }
```

`/veridone:init` writes a starting `.claude/veridone.json` with the detected commands.

## mode

`"strict" | "standard" | "relaxed" | "off"` (default `standard`). See the [modes table](../README.md#modes).

## verify: the completion gate

```json
{
  "verify": {
    "commands": { "test": "pnpm test --run", "typecheck": "pnpm tsc --noEmit", "lint": null },
    "require": ["test", "typecheck"],
    "stopGate": true,
    "claimCheck": true,
    "maxBlocksPerTurn": 1,
    "ignore": ["**/*.md", "docs/**"]
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `commands` | detected | Override a detected command, or set it to `null` to disable the category. Detection covers npm/pnpm/yarn/bun scripts, Deno, pytest/unittest (uv, poetry, pipenv, pdm), mypy/pyright, ruff/flake8, Go, Cargo, Maven/Gradle, .NET, Bundler/RSpec, Composer/PHPUnit/Pest/PHPStan, Mix, SwiftPM, Dart/Flutter, CMake/CTest, Zig, Make and just. |
| `require` | `"auto"` | Checks that must have passed after the last change: `auto` means the test suite (else typecheck, else build); in strict mode, test **and** typecheck. |
| `stopGate` | `true` | Send Claude back when a code change is unverified. |
| `claimCheck` | `true` | Challenge "all tests pass"-style claims that the evidence contradicts. Stays active in relaxed mode. |
| `maxBlocksPerTurn` | `1` | How often the gate may push back in one turn. |
| `ignore` | docs, images, `.claude/` | Changed files that never require verification. |

A run counts as evidence only when it ran **after** the last edit and its result is known. Filtered runs (`| tail`, `|| true`, `; echo`) are judged from the runner's summary line, and runs against a `git stash`ed tree are treated as baselines, not evidence. An explicit statement in Claude's final message that a check couldn't run, or is still failing, also satisfies the gate.

## guard: commands and files

```json
{
  "guard": {
    "rules": { "publish-release": "deny", "git-branch-force-delete": "off" },
    "allowCommands": ["^terraform plan( |$)"],
    "protectedBranches": ["main", "release/*"],
    "protectedFiles": { "deny": ["infra/prod/**"], "ask": ["src/payments/**"] },
    "sensitiveFiles": ["config/credentials/*.yml"],
    "disposableDirs": ["generated"]
  }
}
```

| Key | Meaning |
|---|---|
| `rules` | Per-rule level: `deny`, `ask`, `warn` or `off`. Rule names are in [rules.md](rules.md). |
| `allowCommands` | Regular expressions; a matching command line is never guarded. Keep them anchored and narrow. |
| `protectedBranches` | Force-pushing to these needs confirmation (denied in strict mode). |
| `protectedFiles.deny` / `.ask` | Paths Claude may never edit / must ask before editing. `.git/**`, lockfiles and `node_modules/**` are protected by default. |
| `sensitiveFiles` / `sensitiveExceptions` | Files whose contents must not be read into the conversation, and exceptions such as `.env.example`. |
| `guardrailFiles` | Safety configuration Claude must not change on its own (Claude settings, git hooks, this config). |
| `migrationDirs` | Editing an already committed migration needs confirmation. |
| `disposableDirs` | Directory names that are always safe to delete (build output, caches). |
| `scanScripts` | Also analyze local scripts Claude runs, such as `./scripts/reset.sh` (default `true`). |

### Team command rules (Pro)

```json
{
  "guard": {
    "customRules": [
      { "id": "prod-db", "pattern": "psql\\s.*prod", "level": "deny", "message": "Never touch the production database from an agent." },
      { "id": "deploy", "pattern": "^make deploy", "level": "ask", "message": "Deploys need a human." }
    ]
  }
}
```

Each rule's `pattern` is a JavaScript regular expression tested against the whole command line. `level` is `deny`, `ask` (the default) or `warn`.

## integrity: the anti-cheat scanner

```json
{
  "integrity": {
    "rules": { "console-log": "off", "any-cast": "warn", "expectation-changed": "warn" },
    "ignore": ["legacy/**", "**/*.generated.ts"]
  }
}
```

`rules` sets a per-rule action (`block`, `warn`, `info` or `off`) that replaces the mode default. `ignore` lists paths that are never scanned.

Opt a single line out with a comment on that line or the line above, and say why:

```ts
// veridone-allow: test-skip upstream sandbox is down, tracked in #482
it.skip('charges the card', async () => { … });
```

### Team code rules (Pro)

```json
{
  "integrity": {
    "customRules": [
      { "id": "no-raw-sql", "pattern": "db\\.raw\\(", "paths": ["src/**"], "severity": "high", "message": "Raw SQL bypasses the query builder.", "fix": "Use the repository layer." },
      { "id": "no-moment", "pattern": "from ['\"]moment['\"]", "severity": "low", "message": "Use date-fns." }
    ]
  }
}
```

Patterns are tested against each line an edit adds. `severity` maps to an action through the mode, exactly like the built-in rules (high blocks in standard mode). `paths` and `exclude` scope a rule to files.

## secrets

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Scan new file content for credentials. |
| `block` | `"high"` | Deny writes that add high-confidence credentials to source files; `"off"` downgrades them to notes. |
| `allowFiles` | test files, fixtures | Files where credential-looking values are expected. |

## Other settings

| Key | Default | Meaning |
|---|---|---|
| `condense.enabled` / `minChars` / `targetChars` | `true` / `6000` / `3500` | Condense noisy test/build/install output. The full log is always saved and its path is included. |
| `context.onStart` | `true` | Tell Claude the verification commands at session start. |
| `context.afterCompact` | `true` | Restore the session brief after `/compact` or on resume. |
| `loopBreaker.enabled` / `threshold` | `true` / `3` | Nudge Claude to debug after N identical failures in a row. |

## Environment variables

| Variable | Effect |
|---|---|
| `VERIDONE_MODE` | Force a mode (`strict`, `standard`, `relaxed`, `off`). |
| `VERIDONE_DISABLE=1` | Turn Veridone off (unless a locked organization policy applies). |
| `VERIDONE_LICENSE_KEY` | License key, useful in CI. |
| `VERIDONE_POLICY_FILE` | Path to an organization policy file. |
| `VERIDONE_DATA_DIR` | Where session logs and caches go (default: Claude Code's plugin data directory). |
| `VERIDONE_DEBUG=1` | Write hook timings and internal errors to `debug.log` in the data directory. |
