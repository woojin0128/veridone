---
name: review
description: Independent audit of the current changes: does it really do what was asked, is anything faked, do the checks pass?
disable-model-invocation: true
argument-hint: "[what the change is supposed to do]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *) Bash(git status *) Bash(git diff *) Bash(git log *)
---

## Changes under review
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" changes --data "${CLAUDE_PLUGIN_DATA}" --stat --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

## Task

1. Work out the goal of the change. Use `$ARGUMENTS` if it was given. Otherwise, summarize the user's request from this conversation in two or three sentences, including any acceptance criteria that were mentioned.

2. Launch the `veridone:auditor` agent with:
   - the goal and acceptance criteria
   - the list of changed files above
   - an instruction to run the project's verification commands itself and report evidence

3. When it returns, present its verdict and findings to the user, grouped as critical, major and minor, with file:line references.

4. Propose a fix for each critical or major finding. Apply the fixes when they are clearly within the scope of the user's original request. Otherwise, ask first. After fixing, re-run the affected checks and report the results.
