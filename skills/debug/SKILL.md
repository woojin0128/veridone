---
name: debug
description: Systematic root-cause debugging — reproduce, read the full error, narrow, test one hypothesis at a time, fix the cause, add a regression test. Use when a test or command keeps failing, or the cause of a bug is unclear.
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/veridone.mjs" *)
---

# Debug to the root cause

Stop trying variations of the same fix. Follow this loop instead.

1. **Reproduce minimally.** Find the smallest command that fails, such as a single test file or test name (`-t`, `-k`, `-run`). Run it and keep the full output.

2. **Read the whole error.** Start with the first error, not the last one. Read the assertion diff and every stack frame that belongs to this project, and open the code at each of those frames.

3. **Ask what changed.** Check `git diff` and `git log -p -3 -- <file>`. If there is a known-good commit, use `git bisect`.

4. **Narrow.** Shrink the input or the test until the failure just stops; what you removed last is involved. Compare a passing case with the failing one line by line.

5. **Write down one falsifiable hypothesis.** For example: "`parseDate` treats `2024-03-10` as local time, so the DST shift moves it to the previous day."

6. **Prove it before changing code.** Add a temporary log or assertion, or a tiny failing test that isolates the cause. If the experiment contradicts the hypothesis, go back to step 4.

7. **Fix the cause.** Workarounds are not fixes: no wider try/catch, retries, sleeps, skipped or loosened tests, or special cases for the test input.

8. **Verify and clean up.** Re-run the reproduction, then the related tests, then the full suite. Remove all temporary instrumentation, check `git diff` for leftovers, and keep or add a regression test.

If the failure survives two cycles of this loop, delegate to the `veridone:debugger` agent with the reproduction command and what you have ruled out.
