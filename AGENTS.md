# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small Telegram bot that bridges one Telegram chat to a Pi SDK session. It uses long polling, Pi model refs (for example OpenRouter or OpenAI Codex), optional voice features (Google GenAI / ElevenLabs), local Pi extensions, and Pi skills.

Key files:

- `main.ts` — entrypoint/orchestrator: foreground + background chat sessions, command dispatch, prompt queue, polling loop, tool-notification batching, shutdown.
- `src/config.ts` — env vars, paths, models, and all non-secret tuning.
- `src/pi-session.ts` — Pi SDK runtime + `AgentSession` wrapper (session reuse, extension wiring, stream collection).
- `src/chat-session.ts` — the single chat's state and idle-session disposal.
- `src/telegram.ts` — Telegram Bot API transport plus the HTML fallback ladder; `src/telegram-html.ts` — escaping, sanitizing, tag-aware splitting (pure); `src/telegram-format.ts` — presentational helpers.
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion and ingestion epochs.
- `src/outbound.ts` — Pi response delivery and noop-sentinel suppression.
- `src/commands.ts` — slash-command table (menu descriptions, `/help` lines, handlers); `src/model-menu.ts`, `src/reasoning-menu.ts` — their inline keyboards.
- `src/discovery.ts` — extension/skill discovery. `src/system-prompt.ts` — system prompt and memory blocks.
- `src/heartbeat.ts` — scheduled heartbeat controller. `src/cron.ts` + `src/cron-store.ts` — scheduled tasks.
- `src/subagents.ts` — isolated background sub-agents. `src/background-bash.ts` — background shell sessions. `src/job-registry.ts` — lifecycle bookkeeping shared by both.
- `src/agent-envelope.ts` — shared layout for the internal prompts the bot sends itself (heartbeat, cron, post-restart, sub-agent and background-bash reports).
- `src/uploads.ts`, `src/voice.ts`, `src/speech.ts`, `src/telegram-menu.ts` — agent-facing Telegram tools.
- `src/env-guard.ts` — blocks tool access to `.env` files. `src/util.ts` — shared helpers.
- `src/restart-tool.ts`, `src/restart-flow.ts` (shared `/restart` + `restart_bot` gate), `src/pre-restart-checks.ts`, `src/post-restart-tasks.ts` — restart lifecycle.
- `extensions/` — local Pi extensions (web search, web fetch).
- `skills/` — Pi skills.
- `files/` — persistent prompt/memory/heartbeat/schedule state.
- `scripts/systemd.sh` — installs/removes the systemd `--user` unit. `scripts/smoke.ts` — the smoke check.

## Commands

- Install: `npm install`
- Local run: `npm run dev`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Install/remove the systemd `--user` unit: `npm run systemd:install` / `npm run systemd:uninstall`
- Control the running service: `npm run systemd:start` / `systemd:stop` / `systemd:restart` / `systemd:status`
- Tail logs: `npm run logs` (`journalctl --user -u pi-bot -f`)

Before finishing code changes, run:

```bash
npm run verify
```

That runs `npm run lint`, then `npm run typecheck`, then `npm test`, then `npm run smoke` (imports every module, registers every tool, validates env/model/skill config). It is the same gate `/restart` and the `restart_bot` tool use, so a failure there blocks restarts — keep tests fast and free of network or filesystem dependencies. Use `npm run format` to apply Biome formatting; `npm run lint` reports rule violations, which Biome does not fix automatically.

Keep `npm run lint` at zero errors. It went unchecked for a while because no script invoked it, and violations accumulated silently in `src/` and `skills/`.

## Tests

- `tests/` holds unit tests run by Node's built-in runner (`node --test`); there is no test framework dependency. Name files `*.test.ts`.
- Tests must live in `tests/`, not `src/`: `scripts/smoke.ts` imports every `.ts` file under `src/` and would execute them during the smoke check.
- Current coverage is the pure Telegram HTML machinery in `src/telegram-html.ts` (escaping, sanitizing, tag-aware splitting) — the code where a regression is silent because Telegram rejects a whole message on malformed markup.
- Prefer invariants over golden strings for the splitter (chunk fits the limit, chunk is independently balanced, no tag or entity cut in half, content preserved). They survive refactors and catch the failure modes that matter.

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
- Non-secret bot configuration lives in `src/config.ts`, including chat/model choices, queue/timeouts, upload behavior, and heartbeat interval. The exception is runtime state in `files/settings.json`: the active model/reasoning level plus `"heartbeat"` and `"cronJobs"` (both default `false`, both gating the ways the bot acts unprompted). That file belongs to Pi's `SettingsManager`, which merges writes into the existing contents, so bot-only keys added there survive `/models` and `/reasoning` — but they must be read through `BotSettings` in `src/config.ts`, not by re-reading the file elsewhere. `files/settings.json` itself is gitignored; `files/settings.json.example` is checked in and must stay byte-identical to what `ensureBotSettingsFile()` writes, so update both together when adding a key. Concurrency limits, timeouts, TTLs, and payload caps for background work (sub-agents and background bash) belong in its "Background work" section — do not add them as module-local constants. Only narrow display widths stay next to the formatter that uses them.
- Provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.

## Operational notes

- This bot uses Telegram long polling, not webhooks.
- Only one running process should poll a given Telegram bot token.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested. `TELEGRAM_ALLOWED_CHAT_ID` in `.env` is the single Telegram chat allowed to use the bot; every other chat is ignored.
- Temporary downloads/generated files are under the system temp directory.
- After changing extensions, skills, prompts, or env vars, restart the bot.
- Deployment is a systemd `--user` unit written by `scripts/systemd.sh` to `~/.config/systemd/user/pi-bot.service`. It is generated, not checked in: change the script, then re-run `npm run systemd:install`. `Restart=always` is what makes `/restart` and `restart_bot` work — both exit 0 on purpose and rely on the supervisor to bring the process back.

## Pi-specific work

When modifying Pi SDK usage, extensions, skills, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/discovery.ts`, `src/system-prompt.ts`, `extensions/`, and `skills/`.
