---
name: license
description: Activate, inspect or remove a Veridone Pro/Team license key, or start the free 14-day trial of the paid features.
disable-model-invocation: true
argument-hint: "activate <key> | status | trial | refresh | deactivate"
arguments: [action, key]
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" license --data "${CLAUDE_PLUGIN_DATA}" $action $key --exit-zero`

Report the result above to the user in one or two sentences. Never repeat a license key back in full. If activation failed, pass on the reason given; store keys look like `VERIDONE-PRO-…` or `VERIDONE-TEAM-…` (from the purchase receipt or the customer portal), offline keys start with `VD1.`.
