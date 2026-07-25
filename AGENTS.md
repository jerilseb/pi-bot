# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small Telegram bot that bridges one Telegram chat to a Pi SDK session. It uses long polling, Pi model refs (for example OpenRouter or OpenAI Codex), optional voice features (Google GenAI / ElevenLabs), local Pi extensions, and Pi skills.

Key files:

- `main.ts` — entrypoint/orchestrator: foreground + background chat sessions, command dispatch, prompt queue, polling loop, tool-notification batching, shutdown.
- `src/config.ts` — env vars, paths, models, and all non-secret tuning.
- `src/pi-session.ts` — Pi SDK runtime + `AgentSession` wrapper (session reuse, extension wiring, stream collection).
- `src/chat-session.ts` — the single chat's state and idle-session disposal.
- `src/telegram.ts` — Telegram API helpers, HTML sanitizing, tag-aware message splitting.
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion and ingestion epochs.
- `src/outbound.ts` — Pi response delivery and noop-sentinel suppression.
- `src/commands.ts` — slash commands; `src/model-menu.ts`, `src/reasoning-menu.ts` — their inline keyboards.
- `src/discovery.ts` — extension/skill discovery. `src/system-prompt.ts` — system prompt and memory blocks.
- `src/heartbeat.ts` — scheduled heartbeat controller. `src/cron.ts` + `src/cron-store.ts` — scheduled tasks.
- `src/subagents.ts` — isolated background sub-agents. `src/background-bash.ts` — background shell sessions.
- `src/uploads.ts`, `src/voice.ts`, `src/speech.ts`, `src/telegram-menu.ts` — agent-facing Telegram tools.
- `src/env-guard.ts` — blocks tool access to `.env` files. `src/util.ts` — shared helpers.
- `src/restart-tool.ts`, `src/pre-restart-checks.ts`, `src/post-restart-tasks.ts` — restart lifecycle.
- `extensions/` — local Pi extensions (web search, web fetch).
- `skills/` — Pi skills.
- `files/` — persistent prompt/memory/heartbeat/schedule state.

## Commands

- Install: `npm install`
- Local run: `npm run dev`
- Typecheck: `npm run typecheck`
- Start under PM2: `npm start`
- Stop PM2 process: `npm stop`

Before finishing code changes, run:

```bash
npm run verify
```

That runs `npm run typecheck` plus `npm run smoke` (imports every module, registers every tool, validates env/model/skill config). It is the same gate `/restart` and the `restart_bot` tool use, so a failure there blocks restarts. Use `npm run format` to apply Biome formatting.

## Coding conventions

- TypeScript ESM project (`"type": "module"`) using `NodeNext` module resolution.
- Include explicit `.ts` extensions in local TypeScript imports.
- Keep strict TypeScript compatibility; avoid `any` unless there is a clear boundary reason.
- Match `biome.json`: 2-space indentation, single quotes, semicolons, 100-char lines.
- Prefer small, focused modules and typed helper functions.
- Preserve long-running bot behavior: do not block the polling loop, and keep Telegram/typing/file operations best-effort where appropriate.

## Environment and secrets

- Never commit `.env` or real API keys/tokens.
- Keep secrets and deployment-specific values in `.env`, such as `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, provider API keys, and optional ElevenLabs/Tavily/KIE API keys.
- Non-secret bot configuration lives in `src/config.ts`, including chat/model choices, queue/timeouts, upload behavior, and heartbeat interval.
- Provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.

## Operational notes

- This bot uses Telegram long polling, not webhooks.
- Only one running process should poll a given Telegram bot token.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested. `TELEGRAM_ALLOWED_CHAT_ID` in `.env` is the single Telegram chat allowed to use the bot; every other chat is ignored.
- Temporary downloads/generated files are under the system temp directory.
- After changing extensions, skills, prompts, or env vars, restart the bot.

## Pi-specific work

When modifying Pi SDK usage, extensions, skills, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/discovery.ts`, `src/system-prompt.ts`, `extensions/`, and `skills/`.
