# Security policy

## Reporting a vulnerability

Please report security issues privately, by email to the address in `.claude-plugin/plugin.json`, or through GitHub's **Report a vulnerability** button on this repository. Don't open a public issue. You'll get a reply within five working days.

Useful details:

- the Veridone version (`node scripts/veridone.mjs version`), Claude Code version and OS
- the command, file edit or hook payload involved
- what you expected Veridone to do, and what it did

## Scope

Veridone is a guardrail for a cooperating agent, not a sandbox. In scope:

- A command or edit that bypasses a rule that should catch it: for example, a catastrophic delete that isn't denied, or a secret that isn't detected.
- A crash or hang in a hook, the CLI or the MCP server caused by crafted input.
- Paths through which Veridone could leak data it reads, or execute untrusted code.
- Weaknesses in license-key verification.

Out of scope: bypasses that need you to approve a confirmation prompt, deliberately disabling the plugin, or attacks that already require arbitrary code execution on your machine.
