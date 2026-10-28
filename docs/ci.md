# Veridone in CI, pre-commit and the terminal

The integrity and secret scanner that runs inside Claude Code is also a standalone CLI, so the same rules can guard pull requests from any author: human, Claude, or another agent.

## GitHub Action

```yaml
# .github/workflows/veridone.yml
name: Veridone
on:
  pull_request:

permissions:
  contents: read

jobs:
  veridone:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # the scan compares the PR with its merge base
      - uses: woojin0128/veridone@v1
        with:
          fail-on: high           # high | medium | low | none
```

What you get:

- Inline annotations on the pull request for every finding: errors for high severity, warnings for medium, notices for low.
- A Markdown table of findings in the job summary.
- A failing check when a finding at or above `fail-on` is present.

| Input | Default | Meaning |
|---|---|---|
| `base` | PR base branch (or the previous commit on push) | Ref to compare against |
| `fail-on` | `high` | Lowest severity that fails the job |
| `mode` | from `.claude/veridone.json` | `strict`, `standard` or `relaxed` |
| `summary` | `true` | Write the findings table to the job summary |
| `sarif` | — | Also write SARIF to this path (Pro/Team) |
| `license-key` | — | Your license key; pass it from a secret |

### Code scanning (Pro/Team)

```yaml
permissions:
  contents: read
  security-events: write
steps:
  - uses: actions/checkout@v4
    with: { fetch-depth: 0 }
  - uses: woojin0128/veridone@v1
    id: veridone
    with:
      sarif: veridone.sarif
      license-key: ${{ secrets.VERIDONE_LICENSE_KEY }}
  - uses: github/codeql-action/upload-sarif@v3
    if: always() && steps.veridone.outputs.sarif-file != ''
    with:
      sarif_file: veridone.sarif
```

Findings then appear in the repository's **Security → Code scanning** view, with history and dismissals. Pull requests from forks don't receive secrets; there the SARIF step is skipped with a warning and the scan itself still runs.

## Pre-commit hook

```bash
cp examples/pre-commit-hook.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

The hook scans what is staged, so it checks exactly what will be committed. It finds the CLI in your Claude Code plugin folder, or wherever `VERIDONE` points.

## CLI

```bash
node scripts/veridone.mjs <command> [options]
```

| Command | Purpose |
|---|---|
| `scan` | Integrity and secret scan of uncommitted changes. `--base main` for a branch, `--staged` for the index, `--files a,b` for specific files. `--format text\|json\|github\|markdown\|sarif`, `--fail-on high\|medium\|low\|none`. Exit code 1 on failing findings, 2 on usage errors, 3 when a feature needs a license. |
| `check-command "<cmd>"` | Show what the command guard would decide, and why. |
| `detect` | Detected languages and verification commands. |
| `map`, `outline`, `symbol`, `impact` | Code intelligence from the terminal. |
| `changes` | Branch, uncommitted files, diff stat and recent history. |
| `status`, `handoff`, `report` | Session evidence from Claude Code sessions on this machine. |
| `doctor` | Installation self-check. |
| `license` | `activate <key>`, `status`, `deactivate`. |

Examples:

```bash
node scripts/veridone.mjs scan --base origin/main --format markdown
node scripts/veridone.mjs check-command 'find . -name "*.log" -delete'
node scripts/veridone.mjs impact src/billing/invoice.ts
```
