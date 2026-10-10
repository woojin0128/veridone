---
name: init
description: Detect this repo's test/typecheck/lint/build commands and create .claude/veridone.json for the team.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

## Detection
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" detect --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

## Proposed configuration
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" init --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

Walk the user through the setup:

1. Summarize the detected verification commands in a short table (category → command → where it was detected). Point out anything that looks wrong or missing. For example, a monorepo may need a root-level command, and a slow end-to-end suite may belong outside the `test` category.
2. Confirm that each command is safe and fast enough to run after every change. If a command needs services such as a database or Docker, suggest a faster unit-test command for `verify.commands.test`.
3. Ask the user to confirm or adjust. Then write the file: run `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" init --write` for the proposal as-is, or write the edited JSON to `.claude/veridone.json`.
4. Explain briefly:
   - `.claude/veridone.json` should be committed so teammates share it.
   - `.claude/veridone.local.json` holds personal overrides and should be git-ignored.
   - `/veridone:mode` switches between strict, standard, relaxed and off.
