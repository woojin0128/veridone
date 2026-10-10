---
name: map
description: Ranked map of this repository — the most depended-on files and their key symbols with line ranges.
disable-model-invocation: true
argument-hint: "[subdirectory]"
arguments: [dir]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" map --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --path "$dir" --max-tokens 2500 --exit-zero`

Using the map above, give the user a short tour of the codebase in 5 to 10 bullets:

- the entry points
- the core modules and what each is responsible for
- where the tests live
- how the pieces connect

Reference files and line ranges from the map. Don't read additional files unless the user asks a follow-up question.
