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

Then start it:

```bash
npm start
```

If everything is happy, you should see the bridge start up and print the model, enabled extensions, and skills.

## Code layout

- `channel.ts` — small entrypoint/orchestrator: chat state, queueing, commands, polling loop
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
FAL_KEY=your-fal-key
```

A few useful knobs:

```bash
PI_CHANNEL_IDLE_TIMEOUT_MINUTES=30
PI_CHANNEL_MAX_QUEUE_PER_CHAT=5
PI_CHANNEL_SEND_LOCAL_DOCUMENTS=true

# optional scheduled agent wake-up; uses TELEGRAM_ALLOWED_CHAT_ID and files/heartbeat.md
PI_HEARTBEAT_ENABLED=false
PI_HEARTBEAT_INTERVAL_SECONDS=60
```

## Notes

- This uses long polling, not webhooks.
- Telegram files are downloaded to your system temp directory.
- `TELEGRAM_ALLOWED_CHAT_ID` is required; the bot always allows exactly one chat.
- Keep `.env` private. Bot/API keys are not fun to rotate.
