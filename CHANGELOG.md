# Changelog

## 1.0.0

First public release.

- **Completion gate.** Evidence-based Stop hook: code changed in a turn must be followed by a passing run of the project's checks, or by an explicit disclosure. Claims such as "all tests pass" are checked against the session's evidence in English and Korean. It blocks at most once per turn.
- **Honest test results.** Exit statuses hidden by `| tail`, `|| true` or `; echo` are detected and the runner's own summary line decides the result (TAP/node:test, Jest, Vitest, Mocha, pytest, unittest, Go, Cargo, RSpec, Minitest, PHPUnit, Maven, .NET, ExUnit, XCTest, Dart, Bun, Deno). Runs against a `git stash`ed tree count as baselines, not evidence.
- **Integrity scanner.** 23 rules across 12+ languages: skipped/focused tests, removed or weakened assertions, tautologies, changed expectations, gutted test files, test-environment special cases, elided code, placeholders, stubs, type/lint/coverage suppressions, swallowed errors, neutered test scripts, weakened CI and config, flaky retries, large deletions, debugger leftovers.
- **Command and file guard.** 38 rules on a POSIX shell parser that unwraps sudo/env/xargs/parallel/busybox, `bash -c`, `eval`, `$(which …)`, quoted assignments and commands embedded in inline Python/Node/Perl/Ruby code. Protected paths are enforced for the file tools and for shell writes, moves and deletes.
- **Secret guard.** 28 detectors; name-only reads of `.env` files stay allowed.
- **Output condensing**, **loop breaker**, and **session brief** after compaction and on resume.
- **Code intelligence MCP server:** `repo_map`, `outline`, `find_symbol`, `impact`, `verification_status`.
- **Skills:** status, init, mode, ship, review, scan, map, handoff, report, doctor, license, prove, debug, tdd. **Agents:** auditor, test-author, debugger.
- **CLI and CI:** `scan` with text, JSON, GitHub annotations, Markdown and SARIF output; a GitHub Action; a pre-commit hook.
- **Pro/Team:** team rules, HTML value dashboard, SARIF, locked organization policy.
- **Licensing:** store keys sold through Polar (`VERIDONE-PRO-…`, `VERIDONE-TEAM-…`) with online activation, a background re-check every 3 days that never blocks a hook, a 14-day offline grace period, and automatic shutdown of paid features after a refund or cancellation. Offline Ed25519 keys for invoiced customers. A one-time 14-day trial of every paid feature, no card needed.
- **Precision:** rule patterns inside string literals are ignored, an empty `catch` with a comment that explains why is accepted, and `cmd; echo "exit=$?"` is read back as the command's real exit status.
- **Website and store automation:** a static site with pricing and policies (`site/`), `tools/store-setup.mjs` to create the Polar products, license-key benefits and checkout links, and GitHub workflows for CI, releases, the website and connecting the store.
