---
name: claude-headless
description: Run Claude Code non-interactively from the shell with `claude -p` (headless mode). Use when the user asks to delegate a task to Claude Code, run claude on a repo or file, get a code review/fix/summary from Claude, or script Claude Code as a tool.
---

# Claude Code Headless Mode

Run the `claude` CLI non-interactively with `-p` / `--print`. Claude Code prints the result and exits — never start it without `-p` from the bot, since the interactive TUI would hang the shell.

## Golden rules

1. **Always pass `-p`** and a prompt. Never run bare `claude`.
2. **Set `CLAUDE_CONFIG_DIR` and `--model`** from memory or the conversation; if either is unknown, ask the user, then save the answer to memory (see below).
3. **Always wrap in `timeout`** (e.g. `timeout 300`) — a stuck run would otherwise block this chat's queue indefinitely.
4. **Pre-approve the tools the task needs** with `--allowedTools` or `--permission-mode`; headless runs cannot answer permission prompts, so an unapproved tool call aborts the run.

## Choosing the config directory (CLAUDE_CONFIG_DIR)

`CLAUDE_CONFIG_DIR` points Claude Code at its config directory (default `~/.claude`). It holds the login credentials, settings, plugins, and session history for that identity. Setting it selects which authenticated account/profile the run uses and keeps the bot's sessions separate from interactive ones.

**Use the config directory you already know** — from your memory or from what the user told you in this conversation — and pass it on every invocation. If you don't know which directory to use, ask the user. Do not scan the filesystem for config directories or guess one.

```bash
CLAUDE_CONFIG_DIR="<dir from memory>" timeout 300 \
  claude -p "Summarize what this repo does"
```

If a run fails with an authentication error, that directory is not logged in — report it to the user and ask how to proceed; do not try other directories on your own.

## Choosing the model

The preferred model for headless runs follows the same rule: use what you know from memory or the conversation, and pass it with `--model`. If you don't know the preferred model, ask the user.

Use exact Claude Code/API model IDs, not display names. Latest high-capability model IDs to prefer when requested:

- Claude Opus 4.8: `claude-opus-4-8`
- Claude Fable 5: `claude-fable-5`

```bash
CLAUDE_CONFIG_DIR="<dir from memory>" timeout 300 \
  claude -p "Review this diff" --model "<model from memory>"
```

Once the user tells you a config directory or preferred model, **store it in memory** so future runs don't need to ask again.

## Basic usage

```bash
# Ask about a codebase (run from the repo directory — cwd matters)
cd /path/to/repo && CLAUDE_CONFIG_DIR="<dir from memory>" timeout 300 \
  claude -p "What does the auth module do?"

# Pipe data in, redirect out (stdin is capped at 10MB; for bigger inputs
# write a file and reference its path in the prompt)
cat build-error.txt | CLAUDE_CONFIG_DIR="<dir from memory>" timeout 300 \
  claude -p "concisely explain the root cause of this build error"
```

The working directory matters: Claude Code loads that project's CLAUDE.md, settings, and session history from the cwd. Pick it deliberately — don't accidentally run inside this bot's own repo when the task is about something else.

## Permissions

```bash
# Allow specific tools without prompting
claude -p "Run the test suite and fix any failures" --allowedTools "Bash,Read,Edit"

# Permission rule syntax supports prefix matching (note the space before *)
claude -p "Look at my staged changes and create an appropriate commit" \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *),Bash(git commit *)"

# Or set a session-wide baseline
claude -p "Apply the lint fixes" --permission-mode acceptEdits   # file writes + mkdir/touch/mv/cp
```

For read-only questions, no permission flags are usually needed.

## Structured output

```bash
# JSON envelope: result text, session_id, total_cost_usd, usage
claude -p "Summarize this project" --output-format json | jq -r '.result'

# Enforce a schema; answer lands in .structured_output
claude -p "Extract the main function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}},"required":["functions"]}' \
  | jq '.structured_output'

# Real-time streaming (newline-delimited JSON events)
claude -p "Explain recursion" --output-format stream-json --verbose --include-partial-messages
```

For bot use, `--output-format json` is usually best: parse `.result` for the answer and keep `.session_id` for follow-ups.

## Multi-turn conversations

```bash
# Continue the most recent conversation in this directory
claude -p "Now focus on the database queries" --continue

# Resume a specific session (capture session_id from a JSON run)
session_id=$(claude -p "Start a review" --output-format json | jq -r '.session_id')
claude -p "Continue that review" --resume "$session_id"
```

Run follow-ups from the same directory — session lookup is scoped to the project directory. When the user has an ongoing Claude Code task, save the `session_id` (e.g. in memory) so later requests can resume it.

## System prompt and bare mode

```bash
# Add instructions on top of the default system prompt
gh pr diff 42 | claude -p --append-system-prompt "You are a security engineer. Review for vulnerabilities." --output-format json

# Bare mode: skip hooks/skills/plugins/MCP/CLAUDE.md discovery for fast, reproducible runs
claude --bare -p "Summarize this file" --allowedTools "Read"
```

**Bare mode caveat:** `--bare` skips OAuth and keychain reads, so it ignores the login stored in `CLAUDE_CONFIG_DIR` — auth must come from `ANTHROPIC_API_KEY` (or an `apiKeyHelper` via `--settings`). If you're relying on the config dir's subscription login, do **not** use `--bare`. In bare mode, load only what you need via `--append-system-prompt`, `--settings`, `--mcp-config`, `--agents`, or `--plugin-dir`.

## Checking Claude usage limits

Claude Code slash commands can be run in headless mode by passing the slash command as the prompt. Use `/usage` to check subscription usage/quota windows, such as the current 5-hour session and current week percentages and reset times.

```bash
CLAUDE_CONFIG_DIR="<dir from memory>" timeout 60 \
  claude -p "/usage" --model "<model from memory>" --output-format json
```

Parse `.result` from the JSON output and report the usage summary. This command does not consume model tokens in normal use. If it fails, report the authentication/model error and ask how to proceed.

## Other useful flags

- `--max-turns <n>` — cap agentic turns on `-p` runs.
- `--input-format stream-json` — streaming input (advanced).
- Skills/commands work in prompts: include `/skill-name` in the prompt string. Interactive-only commands like `/login` and `/config` do not work in `-p` mode.
- Background processes Claude starts (dev servers etc.) are killed ~5s after the run finishes.

## Reporting back

Relay Claude's result to the user, prefixed with what was run. Include the cost from `.total_cost_usd` if the user cares about spend. If the run timed out or hit a permission abort, say so explicitly and suggest the fix (longer timeout, extra `--allowedTools` entry).
