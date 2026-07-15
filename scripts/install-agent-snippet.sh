#!/usr/bin/env bash
# Installs the memory-mcp-server "Memory MCP Server" snippet into the
# global config files of commonly-used agents (Claude Code, Codex CLI).
# Idempotent -- safe to re-run. Only touches global config, never any
# project-scoped file.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ngquocnhat9317/memory-mcp-server/master/scripts/install-agent-snippet.sh | bash
#
# The snippet below is embedded (this script has no repo to read from when
# piped through curl) -- keep it in sync with README.md's
# <!-- MEMORY_MCP_SERVER_START/END --> block by hand. If you have a repo
# clone instead, prefer `npx @nhatnguyen9317/memory-mcp-server install-agents`,
# which reads README.md live and can't drift.

set -euo pipefail

START_MARKER='<!-- MEMORY_MCP_SERVER_START -->'
END_MARKER='<!-- MEMORY_MCP_SERVER_END -->'

# Written to a temp file rather than a variable via `$(cat <<'EOF' ... )`:
# bash 3.2 (macOS's default /bin/bash) has a parser bug where a heredoc
# nested inside command substitution breaks on an apostrophe in the body
# (e.g. "aren't", "don't") -- and this script is meant to run as plain
# `curl | bash` on exactly that default bash.
SNIPPET_FILE=$(mktemp)
trap 'rm -f "$SNIPPET_FILE"' EXIT

cat <<'EOF' > "$SNIPPET_FILE"
<!-- MEMORY_MCP_SERVER_START -->
## Memory MCP Server

**Hard gate — before anything else, every session, no exceptions:** if
`memory_*` / `reasoning_*` tools are listed (even deferred/lazy-loaded — load
them first, don't skip because schemas aren't visible yet), call
`get_usage_guide` and follow it. Do this unconditionally, before judging
whether the task looks like it needs memory.

| Thought | Reality |
| --- | --- |
| "This task looks simple" | Check first, decide after — the guide says what counts as trivial |
| "Tools aren't loaded yet" | Load them, don't skip the gate |
| "I'll search directly instead" | `get_usage_guide` first — it defines when search vs. a reasoning session applies |

- Non-trivial task (multi-step, debugging, planning, trade-offs)?
  `reasoning_start_session` first — review the `related_memories` it
  returns before working; if one carries a `source`, you can replay its
  origin with `reasoning_get_trace`.
- Log meaningful steps with `reasoning_add_step` (batch mode `steps: [...]`
  is fine for recording finished work).
- Always close with `reasoning_complete_session`; report helpful memories via
  `used_memory_ids`; pass `save_as_memory=true` for durable conclusions.
- Never store secrets, tokens, or raw sensitive data.
<!-- MEMORY_MCP_SERVER_END -->
EOF

install_into() {
  name="$1"
  path="$2"

  mkdir -p "$(dirname "$path")"

  if [ -f "$path" ]; then
    cp "$path" "$path.bak"

    if grep -qF "$START_MARKER" "$path" && grep -qF "$END_MARKER" "$path"; then
      start_line=$(grep -nF "$START_MARKER" "$path" | head -1 | cut -d: -f1)
      end_line=$(grep -nF "$END_MARKER" "$path" | head -1 | cut -d: -f1)
      {
        if [ "$start_line" -gt 1 ]; then
          head -n "$((start_line - 1))" "$path"
        fi
        cat "$SNIPPET_FILE"
        tail -n "+$((end_line + 1))" "$path"
      } > "$path.tmp"
      mv "$path.tmp" "$path"
      echo "[updated] $name -> $path"
    else
      printf '\n\n' >> "$path"
      cat "$SNIPPET_FILE" >> "$path"
      echo "[appended] $name -> $path"
    fi
  else
    cat "$SNIPPET_FILE" > "$path"
    echo "[created] $name -> $path"
  fi
}

install_into "Claude Code" "$HOME/.claude/CLAUDE.md"
install_into "Codex CLI" "$HOME/.codex/AGENTS.md"
