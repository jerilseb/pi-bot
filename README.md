# pi-bot

A small Telegram bot that pipes your chats into [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Send it a message on Telegram, it spins up or reuses a Pi SDK session for that chat, and sends the answer back.

It is basically a personal AI assistant in Telegram, with support for images, files, voice notes, web search, scheduled background work, local memory, and Pi skills.

## What it does

- Polls the Telegram Bot API for messages
- Keeps a separate Pi conversation per Telegram chat
- Uses Pi model refs such as `openrouter/openai/gpt-5.4-mini` or `openai-codex/gpt-5.5`
- Handles photos as image attachments
- Downloads documents/audio/video to local temp files for Pi to inspect
- Can transcribe voice/audio with ElevenLabs
- Can send Telegram voice-note replies with ElevenLabs when explicitly requested or clearly appropriate
- Can upload generated local images/documents back to Telegram
- Includes Tavily `web_search` and browser-style `web_fetch` tools
- Can create one-time, interval, and cron-like scheduled tasks
- Has a heartbeat loop for broad proactive monitoring tasks
- Maintains long-term memory in `files/memory.md` and daily/session notes in `files/memory/YYYY-MM-DD.md`
- Includes usage commands for OpenAI Codex and ElevenLabs
- Includes skills for browser automation, image generation, HTML visualizations, email via Himalaya, and PDF work

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```bash
TELEGRAM_BOT_TOKEN=123456:your-telegram-token
TELEGRAM_ALLOWED_CHAT_ID=123456789
OPENROUTER_API_KEY=sk-or-your-key
```

Secrets and deployment-specific values live in `.env`. Non-secret defaults and toggles live in `src/config.ts`, including model choices, queue limits, TTS voice/model settings, upload allowlists, and heartbeat interval.

For local foreground development:

```bash
npm run dev
```

For normal pm2-managed startup:

```bash
npm start
```

If everything is happy, the bridge logs will show the chat model, background model, enabled extensions, and skills.

`CHAT_MODEL` in `src/config.ts` is the default model for normal Telegram chat prompts. The active chat model can be changed with `/models` and is persisted in `.active_model`. `CONFIG_BACKGROUND_MODEL` controls heartbeat and cron prompts and can only be changed in `src/config.ts`. `CHAT_MODEL`, the active chat model, and `CONFIG_BACKGROUND_MODEL` must be included in `CONFIG_ALLOWED_MODELS`.

Model refs use `provider/model-id` form. OpenRouter model IDs can contain slashes, so include the provider prefix, e.g. `openrouter/openai/gpt-5.4-mini`. For `openai-codex/...`, authenticate through Pi first with `/login openai-codex` so credentials are available in `~/.pi/agent/auth.json`, or set `OPENAI_CODEX_API_KEY` as a runtime override.

## Deployment

This bot uses Telegram long polling, so it does **not** need a public HTTPS URL or webhook. Deploy it as one long-running Node.js process on a VPS, home server, or any process host that allows outbound HTTPS.

Basic VPS deployment:

```bash
git clone <your-repo-url> pi-bot
cd pi-bot
npm ci
cp .env.example .env
# edit .env with your Telegram chat/token and provider keys
npm start
```

Production is managed through the npm scripts, which wrap `pm2` and `ecosystem.config.cjs`:

```bash
npm start   # pm2 start ecosystem.config.cjs --update-env && pm2 save
npm stop    # pm2 delete pi-bot || true && pm2 save
```

Useful pm2 commands:

```bash
npx pm2 logs pi-bot
npx pm2 restart pi-bot --update-env
```

On a new server, enable pm2 startup once so the bot comes back after reboot:

```bash
npx pm2 startup
```

Keep exactly one `pm2` instance running per Telegram bot token; multiple pollers on the same token can steal updates from each other.

Operational notes:

- Use Node.js 22+ or the same Node version you use locally.
- Keep `.env` on the server only; do not commit bot/API keys.
- Persistent app state lives under `files/`. Important paths include `files/memory.md`, `files/memory/YYYY-MM-DD.md`, `files/heartbeat.md`, `files/heartbeat-state.md`, and `files/cron-jobs.json`.
- Back up `files/` if you care about memory, heartbeat state, or scheduled tasks.
- Telegram downloads and generated temp files are stored under your system temp directory.
- After changing extensions, skills, prompts, `src/config.ts`, or environment variables, restart with `npx pm2 restart pi-bot --update-env` or `npm stop && npm start`.

## Code layout

- `main.ts` — entrypoint/orchestrator: chat state, queueing, polling loop, startup/shutdown
- `src/commands.ts` — Telegram slash-command handlers
- `src/config.ts` — non-secret app config, runtime paths, and secret/env wiring
- `src/pi-session.ts` — Pi SDK runtime/session wrapper
- `src/telegram.ts` — Telegram API helpers and message sending
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion
- `src/outbound.ts` — Pi response delivery and generated file uploads
- `src/discovery.ts` — extension and skill discovery
- `src/system-prompt.ts` — system prompt loading, long-term memory, daily notes, and active model prompt
- `src/heartbeat.ts` — scheduled heartbeat controller
- `src/cron.ts` and `src/cron-store.ts` — scheduled task runner and durable cron job store
- `src/model-menu.ts` — inline keyboard model switching
- `src/openai-usage.ts` — OpenAI Codex usage helper
- `src/elevenlabs-usage.ts` — ElevenLabs subscription/credit usage helper

## Telegram commands

Inside Telegram:

- `/start` — say hi
- `/help` — show commands
- `/status` — see the current chat session status
- `/models` — choose an allowed chat model
- `/openaiusage` — show OpenAI Codex usage windows and reset times
- `/elevenlabsusage` — show ElevenLabs character/credit usage and subscription details
- `/abort` — stop the current response and clear the queue
- `/new` — reset the Pi conversation for this chat
- `/reload` — re-scan extensions/skills and reset all chats
- `/update` — `git pull` this repo and restart the app
- `/restart` — restart the bot process

## Memory

The bot has two memory layers:

- `files/memory.md` — curated long-term memory: durable user preferences, stable facts, standing instructions, and recurring project context.
- `files/memory/YYYY-MM-DD.md` — daily notes: work logs, commands run, commits, temporary findings, research summaries, and detailed context that should not always live in the prompt forever.

On each agent start, the prompt includes long-term memory plus today's and yesterday's daily notes. Older daily notes stay on disk and can be read later if needed, but are not injected automatically.

## Optional integrations and config

Add any of these to `.env` if you want the extra integrations:

```bash
# voice/audio transcription and Telegram voice-note replies
ELEVENLABS_API_KEY=your-elevenlabs-key

# Tavily web search extension
TAVILY_API_KEY_1=tvly-your-key
# TAVILY_API_KEY_2=another-key-if-you-want

# image generation skill
KIE_API_KEY=your-kie-api-key

# optional OpenAI Codex runtime override
OPENAI_CODEX_API_KEY=your-codex-bearer-token
```

Non-secret config is in `src/config.ts`. Useful settings include:

- `CHAT_MODEL`, `CONFIG_BACKGROUND_MODEL`, and `CONFIG_ALLOWED_MODELS`
- `CONFIG_ELEVENLABS_TTS_VOICE_ID`, `CONFIG_ELEVENLABS_TTS_MODEL`, and `CONFIG_ELEVENLABS_TTS_OUTPUT_FORMAT`
- `PI_CHANNEL_IDLE_TIMEOUT_MINUTES` and `PI_CHANNEL_MAX_QUEUE_PER_CHAT`
- `PI_CHANNEL_SEND_TOOL_CALLS`, `PI_CHANNEL_TOOL_CALL_BATCH_MS`, and `PI_CHANNEL_TOOL_CALL_BATCH_MAX_ITEMS`
- `PI_CHANNEL_SEND_LOCAL_IMAGES`, `PI_CHANNEL_IMAGE_UPLOAD_DIRS`, `PI_CHANNEL_SEND_LOCAL_DOCUMENTS`, `PI_CHANNEL_DOCUMENT_UPLOAD_DIRS`, and `PI_CHANNEL_DOCUMENT_UPLOAD_EXTS`
- `CONFIG_HEARTBEAT_ENABLED` and `PI_HEARTBEAT_INTERVAL_SECONDS`

## Notes

- This uses long polling, not webhooks.
- Telegram files are downloaded to your system temp directory.
- `TELEGRAM_ALLOWED_CHAT_ID` is required; the bot always allows exactly one chat.
- Keep `.env` private. Bot/API keys are not fun to rotate.
