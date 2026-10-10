---
name: doctor
description: Check the installation: Node, hooks, config, detected commands, license, and a live guard test.
disable-model-invocation: true
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" doctor --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

Show the results above. For each ✖, explain the fix in one line:

- **Node.js**: install Node 18 or newer and make sure `node` is on PATH for the shell that runs Claude Code.
- **Config**: fix the JSON in the file that is named.
- **No verification commands**: run `/veridone:init`.
- **Guard hook**: run `/reload-plugins`, check that the plugin is enabled in `/plugin`, and look for hook errors in `claude --debug`.

If everything passed, say so in one sentence.
