# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small Telegram bot that bridges one Telegram chat to a Pi SDK session. It uses long polling, Pi model refs (for example OpenRouter or OpenAI Codex), optional voice features (Google GenAI / ElevenLabs), and local Pi extensions. No skills are loaded; when one is needed the user asks the agent to read its SKILL.md.

Key files:

- `main.ts` — entrypoint/orchestrator: constructs the runtimes and sessions, the agent core and the Telegram channel attached to it, wires the modules together, and owns the startup banner, post-restart tasks, and shutdown (which drains every channel). Keep it to wiring and lifecycle; new behavior belongs in a module.
- `src/contract.ts` — the contract between the agent core and the interfaces that use it ("channels"), types only: `AgentCore` (submit, command, attach, snapshot), `Channel`, the ordered `CoreEvent` stream, deliveries with receipts, and `PromptOrigin`. `src/core.ts` — `LocalCore`, the in-process `AgentCore`: owns the prompt queue, runs slash commands, fans events and deliveries out to the attached channels, and records each channel's last action to decide what an event pings (a reply pings the channel the input came from; anything unprompted pings the channel used within `ACTIVE_WINDOW_MS`, else every durable one). Work the bot gives itself (heartbeat, cron, post-restart, job reports) enters through `core.enqueue`.
- `src/prompt-queue.ts` — the queue every prompt goes through regardless of origin (user input, heartbeat, cron, post-restart, background-bash report, sub-agent report) plus the serial worker. It sends nothing itself: `handleIncoming` returns a `SubmitResult` (queued, steered, or rejected) for the channel to show, and a turn is emitted as `turn_start`, every SDK event (`agent`, with the turn's ID), and `turn_end` with the reply or error. User input steers an active chat run; background work and startup/finishing races queue normally. A background run's reply is a `report` delivery through the outbox. `src/prompt-steering.ts` owns accepted steering messages through delivery, cancellation, or safe deferral, retaining their attachments until the run finishes.
- `src/config.ts` — env vars, paths, models, and all non-secret tuning. `src/config-validation.ts` — the startup config checks, shared by `main.ts` and the smoke check so the startup and restart gates cannot drift apart.
- `src/pi-session.ts` — Pi SDK runtime + `AgentSession` wrapper (session reuse, which never resumes a transcript `/new` or `start_new_session` marked cleared; extension wiring; stream collection; an event hook subscribed to every `AgentSession` it creates, since a model switch, `/new` and each session-per-prompt run replace it) and `runWorkerPrompt`, the one-shot worker session sub-agents run in; `src/transport-recovery.ts` classifies the narrow transport failures eligible for one post-SDK continuation.
- `src/session-notes.ts` — notes the bot writes into transcripts so Pi knows what happened outside its turns (restarts, model changes, aborts, messages the background session sent), the unclean-exit check, and the conversation-cleared marker.
- `src/chat-session.ts` — the single chat's state and explicit session disposal (no idle timeout).
- `src/channels/telegram/` — the Telegram channel. `channel.ts` (`TelegramChannel`) turns core events into sends through one ordered queue: per chat turn a typing indicator and tool notifications, then the reply once they have finished; a background turn shows nothing until its report arrives as a delivery. It also shows its own submit feedback (steering ack, queue full). `polling.ts` — the long-polling loop. `telegram.ts` — Bot API transport plus the HTML fallback ladder; `telegram-html.ts` — escaping, sanitizing, tag-aware splitting (pure); `telegram-format.ts` — presentational helpers. `tool-notification-batch.ts` — coalesces a turn's tool-call notifications in the `toolCalls` mode (`collapsed` edits one expandable message per turn, `stream` sends one per batch, `off` drops them); `tool-notifications.ts` — formats one event and renders the collapsed block (pure). `inbound.ts` — message/file/photo/audio ingestion and the detached-ingestion epoch. `types.ts` — Bot API payloads.
- `src/attachments.ts` — cleanup of the temp downloads behind a prompt's attachments; the core owns what a channel submits. `src/outbound.ts` — the noop-sentinel check (`isSilentResponse`); sending is each channel's.
- `src/status.ts` — the /status layout, rendered from a plain snapshot (pure, tested); `commands.ts` gathers the snapshot.
- `src/commands.ts` — slash-command table (menu descriptions, `/help` lines, handlers); `src/openai-usage.ts` and `src/elevenlabs-usage.ts` back `/openaiusage` and `/elevenlabsusage`. `src/callback-menu.ts` — the shared inline-keyboard lifecycle (`CallbackMenu`, `dispatchCallbackQuery`); `src/model-menu.ts`, `src/reasoning-menu.ts`, `src/tool-call-menu.ts`, `src/transcript-menu.ts`, `src/subagent-tool-call-menu.ts` — the keyboards themselves, each supplying only its prefix, texts, and `select`. A `CallbackAction` is the other kind of button, for a message the bot keeps editing itself: it answers the tap at once and leaves the message alone. The only one is `src/job-stop-action.ts`, the Stop buttons on live job messages.
- `src/discovery.ts` — extension discovery. `src/system-prompt.ts` — system prompt and memory blocks. `src/context-gist.ts` — the shared preferences gist (`CONTEXT_GIST_URL`), fetched once at startup and added to the system prompt.
- `src/heartbeat.ts` — scheduled heartbeat controller. `src/cron.ts` + `src/cron-store.ts` — scheduled tasks; `src/scheduled-tasks.ts` — the agent's tools for them, registered only when `cronJobs` is on. Neither waits for the chat, only for the background run before it.
- `src/background-outbox.ts` — holds everything a background run sends to Telegram (its report, an error, and the send_image/send_document/send_voice_note/send_telegram_menu tools, which take the session kind) until the chat has been idle — no turn running or queued, no new message — for `BACKGROUND_DELIVERY_COOLDOWN_MS` (5 min). `deliverToChat` is the door: the chat session sends directly, the background session through the outbox. The chat-session note about a report is written when it is delivered, not when the run ends. Held messages are in memory only, go out in order, and are dropped on restart; `/status` shows how many are waiting.
- `src/background-bash.ts` — background shell sessions; `src/output-buffer.ts` bounds their output in memory and spills the full output to a temp file. `src/subagent.ts` — sub-agent jobs: concurrent worker sessions with their own transcripts under `sessions/subagent-sessions/`, registered only when `ENABLE_SUBAGENTS=true` in `.env`. Each task has its own abort as well as the job's, so one worker can be stopped while the rest of the job carries on. `src/job-registry.ts` — the lifecycle bookkeeping both share: IDs, the yield-then-background step, TTL pruning, cancellation, report routing back to the originating session, and dropping a queued report once that session has read the finished result. `src/job-progress.ts` — the silent, self-updating Telegram message every job started from the chat keeps, from the moment it starts until it ends, with no model call. Changes (a worker's tool call, a line of output) are coalesced into at most one edit per `JOB_PROGRESS_MIN_EDIT_MS`, a heartbeat every `JOB_PROGRESS_UPDATE_MS` moves the clock, and a gate shared by all live messages spaces routine edits `JOB_PROGRESS_GLOBAL_MIN_GAP_MS` apart. With no Telegram 429 handling, those intervals and the wait after a failed edit are the only rate protection. `src/subagent-progress.ts` renders a sub-agent job's message: a line per task while it runs, then a one-line summary with the task lines folded, since the agent's reply carries the results. With the `subagentToolCalls` setting on, each task also folds its worker's recent tool calls into a quote, replaced by its result when it finishes; `main.ts` wires the setting in through `setSubagentToolCallsSetting`, so tests never read `files/settings.json`. Background bash renders its own. Both carry Stop buttons: one for a command, one per unfinished sub-agent task. A stop the user makes there reports to the agent, saying so; the agent's own `*_stop` tools and shutdown go through `JobRegistry.cancel()` and send no report. Background bash also has a wait tool (`background_bash_wait`, through `JobRegistry.waitFor`) that blocks the tool rather than the model; `src/steering-signal.ts` ends such a wait as soon as the user steers a message into that turn, so the message is not held until the wait times out. Sub-agent jobs have no wait tool on purpose: once a job is backgrounded the agent ends its turn and the report resumes it, so the chat is free while the workers run. `src/extension-models.ts` — model lookups shared by the tools that pin work to a model.
- `src/agent-envelope.ts` — shared layout for the internal prompts the bot sends itself (heartbeat, cron, post-restart, background-bash and sub-agent reports).
- `src/uploads.ts`, `src/voice.ts`, `src/speech.ts`, `src/telegram-menu.ts` — agent-facing Telegram tools. `src/session-switch-tool.ts` — `start_new_session`.
- `src/env-guard.ts` — blocks tool access to `.env` files. `src/util.ts` — shared helpers. `src/types.ts` — shared types (`IncomingPrompt`, `Attachment`). `src/tool-result.ts` — the plain-text tool result helper. `src/tool-call-description.ts` — a tool call as one line of plain text, for every interface.
- `src/restart-tool.ts`, `src/restart-flow.ts` (shared `/restart` + `restart_bot` gate), `src/pre-restart-checks.ts`, `src/post-restart-tasks.ts` — restart lifecycle.
- `extensions/` — local Pi extensions (web search, web fetch).
- `files/` — persistent prompt/memory/heartbeat/schedule state, including `files/system.md` and `files/subagent.md`, the chat and worker system prompts (both checked in).
- `scripts/systemd.sh` — installs/removes the systemd `--user` unit. `scripts/smoke.ts` — the smoke check.

The dependency rule points one way: interfaces import the core, and nothing directly in `src/` may import `src/channels/` (or a future `src/tui/`). `tests/boundary.test.ts` enforces it. Its `KNOWN_CROSSINGS` list names the core modules that still talk to Telegram directly — commands, menus, uploads, voice notes, job progress, status and usage rendering — until they move behind the contract; it may only shrink.

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

That runs `npm run lint`, then `npm run typecheck`, then `npm test`, then `npm run smoke` (imports every module, registers every tool, validates env/model config). It is the same gate `/restart` and the `restart_bot` tool use, so a failure there blocks restarts — keep tests fast and free of network or filesystem dependencies. Use `npm run format` to apply Biome formatting; `npm run lint` reports rule violations, which Biome does not fix automatically.

Keep `npm run lint` at zero errors. It went unchecked for a while because no script invoked it, and violations accumulated silently in `src/`.

## Tests

- `tests/` holds unit tests run by Node's built-in runner (`node --test`); there is no test framework dependency. Name files `*.test.ts`.
- Tests must live in `tests/`, not `src/`: `scripts/smoke.ts` imports every `.ts` file under `src/`, subdirectories included, and would execute them during the smoke check. Modules under `src/` must therefore be safe to import: no side effects beyond defining things.
- Coverage centres on the pure Telegram HTML machinery in `src/channels/telegram/telegram-html.ts` (escaping, sanitizing, tag-aware splitting) — the code where a regression is silent because Telegram rejects a whole message on malformed markup — plus the prompt queue and the core (checked against `tests/recording-channel.ts`, a fake channel that records events and returns scripted receipts), the Telegram channel's send order, the session event hook, steering, transport recovery, the background-work tools and their live progress messages, session notes, cron storage, the callback menus, the Telegram transport, and the import boundary. Sub-agent tools are tested against a fake extension API with a fake worker (`tests/subagent.test.ts`); nothing in `tests/` may start a real Pi session.
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
- Keep secrets and deployment-specific values in `.env`, such as `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_ID`, provider API keys, optional ElevenLabs/Tavily API keys, `HEARTBEAT_MODEL` (required when the heartbeat is on), `CONTEXT_GIST_URL`, and the `ENABLE_SUBAGENTS` switch (off by default; any value other than `true`/`false` is a startup error). `.env.example` documents each one.
- Non-secret bot configuration lives in `src/config.ts`, including chat/model choices, queue/timeouts, upload behavior, and heartbeat interval. The exception is runtime state in `files/settings.json`: the active model/reasoning level, `"heartbeat"` and `"cronJobs"` (both default `false`, both gating the ways the bot acts unprompted), and the display preferences `"toolCalls"`, `"showTranscripts"` and `"subagentToolCalls"` (set by `/toolcalls`, `/transcripts` and `/subagent_toolcalls`). That file belongs to Pi's `SettingsManager`, which merges writes into the existing contents, so bot-only keys added there survive `/models` and `/reasoning` — but they must be read through `BotSettings` in `src/config.ts`, not by re-reading the file elsewhere. `files/settings.json` itself is gitignored; `files/settings.json.example` is checked in and must stay byte-identical to what `ensureBotSettingsFile()` writes, so update both together when adding a key. Concurrency limits, timeouts, TTLs, and payload caps for background work (background bash, sub-agents) belong in its "Background work" section — do not add them as module-local constants. Only narrow display widths stay next to the formatter that uses them.
- Provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.

## Operational notes

- This bot uses Telegram long polling, not webhooks.
- Only one running process should poll a given Telegram bot token.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested. Chat transcripts live in `sessions/`. Every chat transcript shares the ID `telegram-chat-<chatId>`, and startup resumes the one with the newest message, unless `/new` or `start_new_session` marked it cleared. The background session is session-per-prompt (`PiRuntime.sessionPerPrompt`): every run starts a fresh transcript with its own ID, and nothing carries over between runs. Heartbeat runs go to `sessions/heartbeat-sessions/` (`telegram-heartbeat-<chatId>-<random>`), scheduled-task runs to `sessions/scheduled-tasks-sessions/` (`telegram-scheduled-task-<chatId>-<random>`, named after the task); `backgroundRunTranscript` in `src/prompt-queue.ts` picks which. A background-bash or sub-agent job started from a background run records that run's transcript in its `JobOrigin`, and its completion report resumes that transcript (`IncomingPrompt.resumeSessionFile`); an interrupted-jobs note at shutdown is likewise written to each originating run's transcript. The SDK writes a new transcript to disk only with its first assistant message, so until then the previous one is still the newest file. Sub-agent worker transcripts under `sessions/subagent-sessions/` are kept indefinitely; each records its parent's transcript path in the session header and a `telegram-bot-subagent` custom entry with the job, task, tool call, and parent leaf entry. `TELEGRAM_ALLOWED_CHAT_ID` in `.env` is the single Telegram chat allowed to use the bot; every other chat is ignored.
- Temporary downloads/generated files are under the system temp directory.
- After changing extensions, prompts, or env vars, restart the bot.
- Deployment is a systemd `--user` unit written by `scripts/systemd.sh` to `~/.config/systemd/user/pi-bot.service`. It is generated, not checked in: change the script, then re-run `npm run systemd:install`. `Restart=always` is what makes `/restart` and `restart_bot` work — both exit 0 on purpose and rely on the supervisor to bring the process back.

## Pi-specific work

When modifying Pi SDK usage, extensions, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/discovery.ts`, `src/system-prompt.ts`, and `extensions/`.
