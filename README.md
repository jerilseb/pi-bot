# pi-bot

A tiny Telegram bot that pipes your chats into [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Send it a message on Telegram, it spins up a Pi SDK session for that chat, and sends the answer back.

It is basically a personal AI assistant in Telegram, with support for images, files, voice notes, web search, and a couple of handy Pi skills.

## What it does

- Polls the Telegram Bot API for messages
- Keeps a separate Pi conversation per Telegram chat
- Uses OpenRouter models through Pi
- Handles photos as image attachments
- Downloads documents/audio/video to local temp files for Pi to inspect
- Can transcribe voice/audio with ElevenLabs
- Can send Telegram voice-note replies with ElevenLabs when the agent decides it is appropriate
- Can upload generated local images/documents back to Telegram
- Includes a Tavily `web_search` extension
- Includes skills for image generation and HTML visualizations

## Setup

Install dependencies:

```bash
npm install
```

Create a `.env` file:

```bash
TELEGRAM_BOT_TOKEN=123456:your-telegram-token
OPENROUTER_API_KEY=sk-or-your-key
OPENROUTER_MODEL=openai/gpt-5.4-mini

# required: the only Telegram chat allowed to use this bot
TELEGRAM_ALLOWED_CHAT_ID=123456789
```

For local foreground development:

```bash
npm run dev
```

For normal pm2-managed startup:

```bash
npm start
```

If everything is happy, the bridge logs will show the model, enabled extensions, and skills.

## Deployment

This bot uses Telegram long polling, so it does **not** need a public HTTPS URL or webhook. Deploy it as one long-running Node.js process on a VPS, home server, or any process host that allows outbound HTTPS.

Basic VPS deployment:

```bash
git clone <your-repo-url> pi-bot
cd pi-bot
npm ci
cp .env.example .env
# edit .env with your Telegram/OpenRouter keys and TELEGRAM_ALLOWED_CHAT_ID
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
- Persistent app state lives under `files/` (memory and heartbeat state). Back it up if you care about it.
- Telegram downloads and generated temp files are stored under your system temp directory.
- After changing extensions, skills, prompts, or environment variables, restart with `npx pm2 restart pi-bot --update-env` or `npm stop && npm start`.

## Code layout

- `main.ts` — small entrypoint/orchestrator: chat state, queueing, commands, polling loop
- `src/config.ts` — environment variables, paths, constants
- `src/pi-session.ts` — Pi SDK runtime/session wrapper
- `src/telegram.ts` — Telegram API helpers and message sending
- `src/inbound.ts` — Telegram message/file/photo/audio ingestion
- `src/outbound.ts` — Pi response delivery and generated file uploads
- `src/resources.ts` — extension/skill discovery, system prompt, memory, heartbeat prompt helpers
- `src/heartbeat.ts` — scheduled heartbeat controller

## Telegram commands

Inside Telegram:

- `/start` — say hi
- `/help` — show commands
- `/status` — see the current chat session status
- `/abort` — stop the current response and clear the queue
- `/new` — reset the Pi conversation for this chat
- `/reload` — re-scan extensions/skills and reset all chats
- `/update` — `git pull` this repo and restart the app
- `/restart` — restart the bot process

## Optional extras

Add any of these to `.env` if you want the extra features:

```bash
# required: limit access to one specific chat/group
TELEGRAM_ALLOWED_CHAT_ID=123456789

# voice/audio transcription
ELEVENLABS_API_KEY=your-elevenlabs-key

# optional voice-note replies using ElevenLabs TTS
# gives the agent a send_voice_note tool; it uses it when asked or when appropriate
ELEVENLABS_TTS_VOICE_ID=your-elevenlabs-voice-id
# optional overrides:
# ELEVENLABS_TTS_MODEL=eleven_multilingual_v2
# ELEVENLABS_TTS_OUTPUT_FORMAT=opus_48000_32
# PI_CHANNEL_MAX_TTS_CHARS=2500

# Tavily web search extension
TAVILY_API_KEY_1=tvly-your-key
# TAVILY_API_KEY_2=another-key-if-you-want

# image generation skill
KIE_API_KEY=your-kie-api-key
```

A few useful knobs:

```bash
PI_CHANNEL_IDLE_TIMEOUT_MINUTES=30
PI_CHANNEL_MAX_QUEUE_PER_CHAT=5
PI_CHANNEL_SEND_LOCAL_DOCUMENTS=true
PI_CHANNEL_SEND_TOOL_CALLS=true # send Pi tool starts to Telegram; skill reads show as 📗 skill-name

# optional scheduled agent wake-up; uses TELEGRAM_ALLOWED_CHAT_ID and files/heartbeat.md
PI_HEARTBEAT_ENABLED=false
PI_HEARTBEAT_INTERVAL_SECONDS=60
```

## Notes

- This uses long polling, not webhooks.
- Telegram files are downloaded to your system temp directory.
- `TELEGRAM_ALLOWED_CHAT_ID` is required; the bot always allows exactly one chat.
- Keep `.env` private. Bot/API keys are not fun to rotate.
