---
name: mode
description: Switch Veridone's strictness for this session — strict, standard, relaxed, off, or reset.
disable-model-invocation: true
argument-hint: strict|standard|relaxed|off|reset
arguments: [level]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" mode --data "${CLAUDE_PLUGIN_DATA}" $level --session "${CLAUDE_SESSION_ID}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

Tell the user the result above in one sentence. If it printed usage instead of a confirmation, list the modes:

- **strict**: medium-severity integrity findings also block; the completion gate needs both tests and typecheck, and a full test run rather than a filtered one; more commands need confirmation.
- **standard** (default): high-severity findings block and medium ones warn; the completion gate needs the project's primary check.
- **relaxed**: findings are only warnings, the completion gate is off, and only claims of success without evidence are challenged. Catastrophic commands are still blocked.
- **off**: Veridone does nothing this session.
- **reset**: return to the configured default.

To make a mode permanent for the repository, set `"mode"` in `.claude/veridone.json`.
