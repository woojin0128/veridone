---
name: prove
description: Evidence-based completion — choose and run the checks that prove a code change works (related tests, full suite, typecheck, lint), add a regression test for bug fixes, and report real results. Use before telling the user a coding task is done.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

# Prove the change works

A task is done when evidence says so, not when the code looks right. Work through these steps and keep the output of every command you run.

1. **Know the checks.** Use the verification commands Veridone listed at session start. If you don't have them, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" detect`.

2. **Find what the change touches.** Call the `impact` tool (veridone intel MCP) or run `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" impact` to list dependents and related tests.

3. **Bug fix? Add a regression test first.** Write a test for the exact failing input and confirm it fails without the fix and passes with it (for example `git stash` the fix, run, `git stash pop`).

4. **Run the checks, narrow to wide:**
   1. the related tests,
   2. the full test command,
   3. typecheck, then lint, then build if the project has them.
   Fix failures at the root cause. Never skip, weaken or delete a test, add a type or lint suppression, or special-case the test environment to get green.

5. **Self-audit the diff.** Run `git diff` and read it end to end. Then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" scan` and resolve every high-severity finding.

6. **Report honestly.** In your final message, list each command you ran with its actual result (pass/fail and counts). State explicitly what you could not verify and why, such as missing services, credentials or platform. Never write "all tests pass" unless you just saw them pass after your last edit.

For large or risky changes, also ask the `veridone:auditor` agent for an independent check before you report.
