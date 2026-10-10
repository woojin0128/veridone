#!/bin/sh
# .git/hooks/pre-commit — refuse commits that skip tests, weaken assertions, suppress
# checks or add hard-coded secrets. Works with or without Claude Code running.
#
# Install:  cp examples/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# Bypass once (you, not the agent — Veridone asks before `--no-verify`):  git commit --no-verify

find_veridone() {
  if [ -n "$VERIDONE" ] && [ -f "$VERIDONE" ]; then echo "$VERIDONE"; return; fi
  for f in "$HOME"/.claude/plugins/marketplaces/*/scripts/veridone.mjs \
           "$HOME"/.claude/plugins/cache/*/veridone/*/scripts/veridone.mjs; do
    [ -f "$f" ] && latest="$f"
  done
  [ -n "$latest" ] && echo "$latest"
}

cli="$(find_veridone)"
if [ -z "$cli" ]; then
  echo "veridone: CLI not found (set VERIDONE=/path/to/veridone/scripts/veridone.mjs); skipping integrity scan" >&2
  exit 0
fi
exec node "$cli" scan --staged --fail-on high
