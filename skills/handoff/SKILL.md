---
name: handoff
description: Write .claude/handoff.md for the next session: goal, working tree, verification status, open findings, next steps.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" handoff --data "${CLAUDE_PLUGIN_DATA}" --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" --out .claude/handoff.md --exit-zero`

The ledger-based handoff note has been written to `.claude/handoff.md`. Open it and enrich it with what only you know from this conversation:

- decisions made and why
- approaches that were tried and abandoned
- gotchas you discovered
- the exact next action

Keep it under about 60 lines. Stick to facts backed by the conversation and the ledger; do not speculate. Tell the user where the file is. A new session can resume with: "Read .claude/handoff.md and continue."
