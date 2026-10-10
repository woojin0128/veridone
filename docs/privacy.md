# Privacy and data handling

**Veridone collects no telemetry, and its hooks and MCP server make no network requests.** Everything that watches your session runs on your machine.

The one exception is paid store license keys: activating one (`/veridone:license activate`) and the background re-check every 3 days contact Polar's public license API with the key, the store's organization id, the activation id and, at activation only, a label for the computer, the Veridone version and the OS name. Nothing about your code, prompts or files is sent. The free version, the trial and offline `VD1` keys never touch the network. See [licensing](licensing.md#how-keys-are-checked).

## What is stored, and where

Veridone keeps one event log per Claude Code session so it can tell what actually happened in the session (the completion gate, `/veridone:status` and the post-compaction brief all read it).

- **Location:** Claude Code's persistent data directory for the plugin (`~/.claude/plugins/data/veridone-<marketplace>/`), or `VERIDONE_DATA_DIR`.
- **Retention:** session logs older than 14 days are deleted automatically. Uninstalling the plugin removes the directory.
- **Contents:** the first 500 characters of each prompt; commands Claude ran (truncated); which files changed and how many lines; results of test/typecheck/lint/build runs; integrity findings; guard decisions; and counts of condensed output.
- **Not stored:** file contents, command output (except the condensed-output logs described below), or credential values. When the secret guard finds a credential, only a redacted preview (`sk_l…8Q (32 chars)`) is kept.

When Veridone condenses a long command output, the full original output is saved to a log file (in Claude Code's scratchpad directory when available, otherwise under the data directory) so Claude can read it if needed. These logs are deleted with the session data.

The code-intelligence index (symbol names, line numbers and import graph, not file contents) is cached under the data directory to keep `repo_map` fast.

## What Veridone reads

- The Claude Code hook payloads: tool names and inputs, tool results, and the final assistant message at the end of a turn.
- Your project's manifests (package.json, pyproject.toml, go.mod, …) to detect verification commands.
- Source files, to build the code-intelligence index and to scan edits.
- `git status` and `git diff` output.

Veridone never reads files that match `guard.sensitiveFiles` (such as `.env`, `~/.aws/credentials` or SSH keys), except to check whether a file that Claude is writing to is git-ignored.
