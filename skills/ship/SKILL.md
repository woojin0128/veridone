---
name: ship
description: Pre-merge pipeline: run every check, scan the diff, get an independent audit, then draft the commit message and PR.
disable-model-invocation: true
argument-hint: "[base branch, default: the repo's default branch]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *) Bash(git status *) Bash(git diff *) Bash(git log *)
---

## Context
### Verification commands
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" detect --data "${CLAUDE_PLUGIN_DATA}" --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

### Working tree and recent history (match the commit style)
!`node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" changes --data "${CLAUDE_PLUGIN_DATA}" --stat --log 8 --cwd "${CLAUDE_PROJECT_DIR}" --exit-zero`

## Pipeline

Base branch: `$ARGUMENTS` (if empty, use the repository's default branch, e.g. `main`).

Run the stages in order and track them with a todo list. Record the exact command and result for each stage.

1. **Checks.** Run each verification command that was detected: typecheck, lint, test, build. Run them for real, with no filtering. If one fails, fix the root cause and re-run everything from the start. Never skip, weaken or delete tests or add suppressions to get green. If a check cannot run in this environment, write down why.

2. **Integrity scan.** Run both of these and resolve every HIGH finding:
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" scan --base <base>` for committed changes
   - `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" scan` for uncommitted changes
   Fix each finding. Keep one only if it is truly intended, and then justify it inline with `veridone-allow: <rule> <reason>`.

3. **Independent audit.** Launch the `veridone:auditor` agent. Give it the goal of this work, which you can summarize from the conversation, and the base branch. Address every critical or major finding it confirms, then repeat stage 1 for anything you changed.

4. **Readiness report.** Show a table of each stage with ✅ or ❌, the evidence, and any remaining risks or unverified areas.

5. **Drafts.** Write, without committing or pushing:
   - a commit message that matches the repository's style (look at the history above)
   - a PR description with Summary, Changes, How it was tested (the commands and results from stage 1), and Risks / follow-ups.

Only commit, push or open a PR if the user explicitly asks.
