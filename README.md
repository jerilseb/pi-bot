# pi-bot

A tiny Telegram bot that pipes your chats into [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Send it a message on Telegram, it spins up a Pi RPC session for that chat, and sends the answer back.

It is basically a personal AI assistant in Telegram, with support for images, files, voice notes, web search, and a couple of handy Pi skills.

## What it does

- Polls the Telegram Bot API for messages
- Keeps a separate Pi conversation per Telegram chat
- Uses OpenRouter models through Pi
- Handles photos as image attachments
- Downloads documents/audio/video to local temp files for Pi to inspect
- Can transcribe voice/audio with ElevenLabs
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

# optional, but recommended if this is just for you
TELEGRAM_ALLOWED_CHAT_IDS=123456789
```

Then start it:

```bash
npm start
```

If everything is happy, you should see the bridge start up and print the model, enabled extensions, and skills.

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
# limit access to specific chats/groups
TELEGRAM_ALLOWED_CHAT_IDS=123456789,-1001234567890

# voice/audio transcription
ELEVENLABS_API_KEY=your-elevenlabs-key

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
PI_CHANNEL_SEND_LOCAL_IMAGES=true
PI_CHANNEL_SEND_LOCAL_DOCUMENTS=true
```

## Notes

- This uses long polling, not webhooks.
- Telegram files are downloaded to your system temp directory.
- Use `TELEGRAM_ALLOWED_CHAT_IDS` if you do not want random people using your bot.
- Keep `.env` private. Bot/API keys are not fun to rotate.
