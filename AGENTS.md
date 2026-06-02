# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small Telegram bot that bridges Telegram chats to a Pi SDK session. It uses long polling, Pi model refs (for example OpenRouter or OpenAI Codex), optional ElevenLabs voice features, local Pi extensions, and Pi skills.

Key files:

- `main.ts` — entrypoint/orchestrator: chat state, command handling, queueing, polling loop.
- `src/config.ts` — environment variables, paths, constants.
- `src/pi-session.ts` — Pi SDK runtime/session wrapper.
- `src/telegram.ts` — Telegram API helpers and message sending.
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion.
- `src/outbound.ts` — Pi response delivery and generated file uploads.
- `src/resources.ts` — extension/skill discovery, system prompt, memory helpers.
- `src/heartbeat.ts` — scheduled heartbeat controller.
- `extensions/` — local Pi extensions.
- `skills/` — Pi skills.
- `files/` — persistent prompt/memory/heartbeat state.

## Commands

- Install: `npm install`
- Local run: `npm run dev`
- Typecheck: `npm run typecheck`
- Start under PM2: `npm start`
- Stop PM2 process: `npm stop`

Before finishing code changes, run:

```bash
npm run typecheck
```

## Coding conventions

- TypeScript ESM project (`"type": "module"`) using `NodeNext` module resolution.
- Include explicit `.ts` extensions in local TypeScript imports.
- Keep strict TypeScript compatibility; avoid `any` unless there is a clear boundary reason.
- Match existing formatting: tabs for indentation, double quotes, semicolons.
- Prefer small, focused modules and typed helper functions.
- Preserve long-running bot behavior: do not block the polling loop, and keep Telegram/typing/file operations best-effort where appropriate.

## Environment and secrets

- Never commit `.env` or real API keys/tokens.
- Required runtime variables include `TELEGRAM_BOT_TOKEN`, `MODEL`, and `TELEGRAM_ALLOWED_CHAT_ID`; provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.
- Optional integrations include ElevenLabs, Tavily, and KIE API keys; keep these secret.

## Operational notes

- This bot uses Telegram long polling, not webhooks.
- Only one running process should poll a given Telegram bot token.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested.
- Temporary downloads/generated files are under the system temp directory.
- After changing extensions, skills, prompts, or env vars, restart the bot or use the `/reload` command where applicable.

## Pi-specific work

When modifying Pi SDK usage, extensions, skills, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/resources.ts`, `extensions/`, and `skills/`.
