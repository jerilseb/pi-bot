# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small Telegram bot that bridges one Telegram chat to a Pi SDK session. It uses long polling, Pi model refs (for example OpenRouter or OpenAI Codex), optional voice features (Google GenAI / ElevenLabs), local Pi extensions, and Pi skills.

Key files:

- `main.ts` — entrypoint/orchestrator: constructs the runtimes and sessions, wires the modules together, owns the polling loop, startup banner, post-restart tasks, and shutdown. Keep it to wiring and lifecycle; new behavior belongs in a module.
- `src/prompt-queue.ts` — the single entry point for all work (`handleIncoming`) plus the serial worker. Ordinary Telegram messages steer an active chat run; background work and startup/finishing races queue normally. Every prompt goes through here regardless of origin: Telegram, heartbeat, cron, post-restart, background-bash report, sub-agent report. `src/prompt-steering.ts` owns accepted steering messages through delivery, cancellation, or safe deferral, retaining their attachments until the run finishes.
- `src/tool-notification-batch.ts` — coalesces tool-call notifications and delivers them in the `toolCalls` mode (`collapsed` edits one expandable message per prompt, `stream` sends one per batch, `off` drops them); `src/tool-notifications.ts` — formats a single event and renders the collapsed block (pure).
- `src/config.ts` — env vars, paths, models, and all non-secret tuning. `src/config-validation.ts` — the startup config checks, shared by `main.ts` and the smoke check so the startup and restart gates cannot drift apart.
- `src/pi-session.ts` — Pi SDK runtime + `AgentSession` wrapper (session reuse, which never resumes a transcript `/new` or `start_new_session` marked cleared; extension wiring; stream collection) and `runWorkerPrompt`, the one-shot worker session sub-agents run in; `src/transport-recovery.ts` classifies the narrow transport failures eligible for one post-SDK continuation.
- `src/session-notes.ts` — notes the bot writes into transcripts so Pi knows what happened outside its turns (restarts, model changes, aborts, messages the background session sent), the unclean-exit check, and the conversation-cleared marker.
- `src/chat-session.ts` — the single chat's state and explicit session disposal (no idle timeout).
- `src/telegram.ts` — Telegram Bot API transport plus the HTML fallback ladder; `src/telegram-html.ts` — escaping, sanitizing, tag-aware splitting (pure); `src/telegram-format.ts` — presentational helpers.
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion, the detached-ingestion epoch, and cleanup of the temp downloads it creates.
- `src/outbound.ts` — Pi response delivery and noop-sentinel suppression.
- `src/commands.ts` — slash-command table (menu descriptions, `/help` lines, handlers); `src/openai-usage.ts` and `src/elevenlabs-usage.ts` back `/openaiusage` and `/elevenlabsusage`. `src/callback-menu.ts` — the shared inline-keyboard lifecycle (`CallbackMenu`, `dispatchCallbackQuery`); `src/model-menu.ts`, `src/reasoning-menu.ts`, `src/tool-call-menu.ts`, `src/transcript-menu.ts` — the keyboards themselves, each supplying only its prefix, texts, and `select`.
- `src/discovery.ts` — extension/skill discovery. `src/system-prompt.ts` — system prompt and memory blocks. `src/context-gist.ts` — the shared preferences gist (`CONTEXT_GIST_URL`), fetched once at startup and added to the system prompt.
- `src/heartbeat.ts` — scheduled heartbeat controller. `src/cron.ts` + `src/cron-store.ts` — scheduled tasks; `src/scheduled-tasks.ts` — the agent's tools for them, registered only when `cronJobs` is on.
- `src/background-bash.ts` — background shell sessions; `src/output-buffer.ts` bounds their output in memory and spills the full output to a temp file. `src/subagent.ts` — sub-agent jobs: concurrent worker sessions with their own transcripts under `sessions/subagent-sessions/`, registered only when `ENABLE_SUBAGENTS=true` in `.env`. `src/job-registry.ts` — the lifecycle bookkeeping both share: IDs, the yield-then-background step, TTL pruning, cancellation, report routing back to the originating session, and dropping a queued report once that session has read the finished result. `src/extension-models.ts` — model lookups shared by the tools that pin work to a model.
- `src/agent-envelope.ts` — shared layout for the internal prompts the bot sends itself (heartbeat, cron, post-restart, background-bash and sub-agent reports).
- `src/uploads.ts`, `src/voice.ts`, `src/speech.ts`, `src/telegram-menu.ts` — agent-facing Telegram tools. `src/session-switch-tool.ts` — `start_new_session`.
- `src/env-guard.ts` — blocks tool access to `.env` files. `src/util.ts` — shared helpers. `src/types.ts` — shared types (Telegram payloads, `IncomingPrompt`). `src/tool-result.ts` — the plain-text tool result helper.
- `src/restart-tool.ts`, `src/restart-flow.ts` (shared `/restart` + `restart_bot` gate), `src/pre-restart-checks.ts`, `src/post-restart-tasks.ts` — restart lifecycle.
- `extensions/` — local Pi extensions (web search, web fetch).
- `skills/` — Pi skills.
- `files/` — persistent prompt/memory/heartbeat/schedule state, including `files/subagent.md`, the worker system prompt (created with a default on first start).
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
- Coverage centres on the pure Telegram HTML machinery in `src/telegram-html.ts` (escaping, sanitizing, tag-aware splitting) — the code where a regression is silent because Telegram rejects a whole message on malformed markup — plus the prompt queue, steering, transport recovery, the background-work tools, session notes, cron storage, the callback menus, and the Telegram transport. Sub-agent tools are tested against a fake extension API with a fake worker (`tests/subagent.test.ts`); nothing in `tests/` may start a real Pi session.
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
- Keep secrets and deployment-specific values in `.env`, such as `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, provider API keys, optional ElevenLabs/Tavily/KIE API keys, `HEARTBEAT_MODEL` (required when the heartbeat is on), `CONTEXT_GIST_URL`, and the `ENABLE_SUBAGENTS` switch (off by default; any value other than `true`/`false` is a startup error). `.env.example` documents each one.
- Non-secret bot configuration lives in `src/config.ts`, including chat/model choices, queue/timeouts, upload behavior, and heartbeat interval. The exception is runtime state in `files/settings.json`: the active model/reasoning level, `"heartbeat"` and `"cronJobs"` (both default `false`, both gating the ways the bot acts unprompted), and the display preferences `"toolCalls"` and `"showTranscripts"` (set by `/toolcalls` and `/transcripts`). That file belongs to Pi's `SettingsManager`, which merges writes into the existing contents, so bot-only keys added there survive `/models` and `/reasoning` — but they must be read through `BotSettings` in `src/config.ts`, not by re-reading the file elsewhere. `files/settings.json` itself is gitignored; `files/settings.json.example` is checked in and must stay byte-identical to what `ensureBotSettingsFile()` writes, so update both together when adding a key. Concurrency limits, timeouts, TTLs, and payload caps for background work (background bash, sub-agents) belong in its "Background work" section — do not add them as module-local constants. Only narrow display widths stay next to the formatter that uses them.
- Provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.

## Operational notes

- This bot uses Telegram long polling, not webhooks.
- Only one running process should poll a given Telegram bot token.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested. Chat and background transcripts live in `sessions/`. Every chat transcript shares the ID `telegram-chat-<chatId>` (background: `telegram-background-<chatId>`), and startup resumes the one with the newest message, unless `/new` or `start_new_session` marked it cleared. The SDK writes a new transcript to disk only with its first assistant message, so until then the previous one is still the newest file. Sub-agent worker transcripts under `sessions/subagent-sessions/` are kept indefinitely; each records its parent's transcript path in the session header and a `telegram-bot-subagent` custom entry with the job, task, tool call, and parent leaf entry. `TELEGRAM_ALLOWED_CHAT_ID` in `.env` is the single Telegram chat allowed to use the bot; every other chat is ignored.
- Temporary downloads/generated files are under the system temp directory.
- After changing extensions, skills, prompts, or env vars, restart the bot.
- Deployment is a systemd `--user` unit written by `scripts/systemd.sh` to `~/.config/systemd/user/pi-bot.service`. It is generated, not checked in: change the script, then re-run `npm run systemd:install`. `Restart=always` is what makes `/restart` and `restart_bot` work — both exit 0 on purpose and rely on the supervisor to bring the process back.

## Pi-specific work

When modifying Pi SDK usage, extensions, skills, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/discovery.ts`, `src/system-prompt.ts`, `extensions/`, and `skills/`.
