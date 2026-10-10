---
name: scan
description: Scan uncommitted changes (or a branch) for skipped tests, weakened assertions, suppressions, placeholders and secrets.
disable-model-invocation: true
argument-hint: "[base branch to compare against]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" scan --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

Present the findings above grouped by severity, highest first. For each HIGH finding, open the file at that line and propose the fix; apply it if it is clearly within scope of the current task.

If the user supplied a base branch (`$ARGUMENTS`), also run `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" scan --base $ARGUMENTS` to cover committed changes, and present those findings the same way.
