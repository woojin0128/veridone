---
name: report
description: What Veridone caught across recent sessions: false 'done' claims, shortcuts, risky commands, tokens saved.
disable-model-invocation: true
argument-hint: "[days, default 30]"
arguments: [days]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" report --data "${CLAUDE_PLUGIN_DATA}" --days "$days" --exit-zero`

Show the report above to the user. Then briefly explain what the numbers mean:

- Each "premature done" was a turn where code had changed but the checks had not passed.
- Each integrity finding was a shortcut such as a skipped test or a suppression, caught at the moment it was written.

If they want a shareable HTML dashboard, it needs Pro or the free 14-day trial (`/veridone:license trial`): `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" report --html veridone-report.html`. Do not run any other commands.
