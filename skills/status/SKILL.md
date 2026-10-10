---
name: status
description: Session evidence: changed files, which checks ran and passed after the last change, open findings, blocked commands.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" status --data "${CLAUDE_PLUGIN_DATA}" --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

Show the status report above to the user as-is; it is already formatted. After it, add at most three short, concrete next steps drawn only from the report, such as re-running a check marked stale or resolving an open finding. Do not run any commands.
