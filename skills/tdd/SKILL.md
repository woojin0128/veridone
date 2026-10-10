---
name: tdd
description: Test-first workflow for features and bug fixes — write a failing test that captures the requirement, make it pass with the simplest real code, then refactor with tests green. Use when the user asks for TDD or when behavior should be pinned down before implementing.
---

# Test-driven development

Repeat this cycle for each behavior. Keep the cycles small: one behavior, one test, then the code for it.

1. **Red.** Write one test for the next behavior, in the project's existing test style and location. Run it and confirm it fails for the expected reason: the assertion, not a typo or an import error. If it passes before you've written any code, the test is wrong or the behavior already exists.

2. **Green.** Write the simplest production code that makes that test pass. "Simplest" still means general. Never return a value hard-coded to match the test input, and never branch on the test environment. Run the test, then the related tests.

3. **Refactor.** With everything green, remove duplication and improve names. Re-run the tests after each change.

4. **Edges.** Add tests for boundaries and failure paths (empty, invalid, error from a dependency) and repeat the cycle.

Rules:
- Assertions check exact outcomes (`toEqual(expected)`), not just that something exists.
- Mock only external boundaries (network, clock, filesystem, randomness).
- Never weaken, skip, or delete a test to reach green. If a test is wrong, fix it and say so explicitly.
- Finish by running the full test command and the typecheck, and report both results.
