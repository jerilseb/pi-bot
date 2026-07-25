# pi-bot

> Your private AI operator in Telegram — always nearby, able to chat, code, research, remember, schedule work, inspect files, create visuals, and restart itself when you ask.

`pi-bot` turns a normal Telegram chat into a practical personal AI workspace powered by the [Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). Instead of opening a terminal, a browser, a separate AI app, and a task manager, you can message one bot and let it coordinate the work.

It is designed for people who want an assistant that lives where they already communicate: Telegram. Think of it as a lightweight alternative to heavier agent setups like OpenClaw or Hermes agents when you mainly want a private, practical assistant you can message from anywhere.

## Why this exists

Most AI tools are either:

- chat-only assistants that cannot touch your local files or tools,
- coding agents that live in a terminal and are awkward to use from a phone,
- automation tools that need a lot of ceremony for simple reminders or checks,
- or bots that forget everything once the conversation ends.

`pi-bot` exists to combine those into one lightweight personal assistant:

- **Available from your phone** — send voice notes, screenshots, PDFs, documents, and quick instructions from Telegram.
- **Useful on your machine** — it can inspect files, edit code, run tests, use local skills, and work inside a real repository.
- **Proactive when needed** — it can schedule future tasks, run recurring checks, and keep heartbeat-style monitoring instructions.
- **Persistent enough to be personal** — it has long-term memory and daily work notes so context does not vanish every session.
- **Still under your control** — it answers only the single Telegram chat in `TELEGRAM_ALLOWED_CHAT_ID` and secrets stay in your `.env`.

## What you can do with it

### Talk to your AI from anywhere

Send a text message, voice note, screenshot, file, or PDF from Telegram. The bot forwards the request to a Pi agent session and replies back in the same chat.

Examples:

```text
Summarize this document.
What is wrong with this screenshot?
Turn this voice note into an action list.
Explain this error like I am debugging it on my phone.
```

### Use it as a coding assistant

Because the bot runs on your machine, it can work with local repositories, inspect files, run commands, make edits, and typecheck changes.

Examples:

```text
Check the failing TypeScript errors and fix them.
Find where the Telegram upload limit is configured.
Add a README section for deployment.
Commit and push the changes.
```

### Research the web without leaving Telegram

`pi-bot` includes web search and browser-style page fetching tools, so it can look up current information and summarize it for you.

Examples:

```text
Search for the latest OpenAI Codex pricing changes.
Compare these two libraries and tell me which one fits this project.
Fetch this URL and summarize the key points.
```

### Create and inspect rich artifacts

The bot can use skills for PDFs, image generation, browser automation, HTML visualizations, and more.

Examples:

```text
Extract the tables from this PDF.
Make an interactive chart from this CSV.
Generate a simple poster for this event.
Open this site and test the login flow.
```

### Schedule work and reminders

Ask it to do something later, once, repeatedly, or on a cron-like schedule.

Examples:

```text
Remind me tomorrow at 9 AM to send the proposal.
Every weekday morning, check my heartbeat instructions.
Every 30 minutes, check whether this service is back online.
```

### Keep a useful memory trail

`pi-bot` separates memory into two layers:

- `files/memory.md` for durable facts and preferences.
- `files/memory/YYYY-MM-DD.md` for daily work logs, commands, commits, and temporary findings.

That means it can remember stable context without stuffing every temporary detail into the long-term prompt.

## Feature highlights

- Telegram long-polling bot — no public webhook required.
- One Pi conversation per Telegram chat.
- Restricted to explicitly allowed Telegram chat IDs.
- Text, photo, document, audio, and voice-note ingestion.
- ElevenLabs speech-to-text for voice/audio transcription.
- ElevenLabs text-to-speech for voice-note replies when requested.
- Generated local image and document uploads back to Telegram.
- Tavily `web_search` and browser-style `web_fetch` tools.
- Scheduled one-time, interval, and cron-like tasks.
- Heartbeat loop for proactive monitoring instructions.
- Long-term memory plus daily/session notes.
- Model switching with Telegram inline buttons.
- Usage commands for OpenAI Codex and ElevenLabs.
- Pi skills for browser automation, image generation, HTML visualizations, email via Himalaya, and PDF work.
- Graceful self-restart through `/restart` or an explicit natural-language restart request.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

Create `.env`:

```bash
TELEGRAM_BOT_TOKEN=123456:your-telegram-token
TELEGRAM_ALLOWED_CHAT_ID=123456789
OPENROUTER_API_KEY=sk-or-your-key
```

Secrets and deployment-specific values live in `.env`. `TELEGRAM_ALLOWED_CHAT_ID` is the single Telegram chat allowed to use the bot — messages from any other chat are ignored, and the value is read once at startup, so changing it requires a restart. Your own chat ID is a positive number; you can get it by messaging [@userinfobot](https://t.me/userinfobot).

### 3. Run locally

```bash
npm run dev
```

### 4. Run under pm2

```bash
npm start
```

The startup logs show the active chat model, background model, enabled extensions, and discovered skills.

## Configuration

The default chat model is configured in `src/config.ts`:

```ts
export const CHAT_MODEL = "openai-codex/gpt-5.6-luna";
```

The active chat model and reasoning level can be changed from Telegram with `/models` and `/reasoning`, and are persisted in `files/settings.json` as `defaultProvider`/`defaultModel`/`defaultThinkingLevel`. That file wins over `CHAT_MODEL`, and the resolved model must be listed in `ALLOWED_MODELS` or startup fails.

Background heartbeat and cron prompts use `BACKGROUND_MODEL` in `src/config.ts`. The background model is intentionally separate from the chat model and cannot be changed from Telegram.

Model refs use this form:

```text
provider/model-id
```

Examples:

```text
openai-codex/gpt-5.5
openrouter/openai/gpt-5.4-mini
openrouter/moonshotai/kimi-k2.6
```

For `openai-codex/...`, authenticate through Pi with `/login openai-codex`, or set `OPENAI_CODEX_API_KEY` as a runtime override.

## Optional integrations

Add any of these to `.env` to enable extra capabilities:

```bash
# voice/audio transcription and Telegram voice-note replies
ELEVENLABS_API_KEY=your-elevenlabs-key

# Google GenAI transcription and voice-note replies
GOOGLE_GENAI_API_KEY=your-google-genai-key

# Tavily web search extension
TAVILY_API_KEY_1=tvly-your-key
# TAVILY_API_KEY_2=another-key-if-you-want

# image generation skill
KIE_API_KEY=your-kie-api-key

# optional OpenAI Codex runtime override
OPENAI_CODEX_API_KEY=your-codex-bearer-token
```

Useful non-secret settings in `src/config.ts` include:

- `CHAT_MODEL`, `BACKGROUND_MODEL`, `SUBAGENT_MODEL`, and `ALLOWED_MODELS`
- `ELEVENLABS_TTS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, and `ELEVENLABS_TTS_OUTPUT_FORMAT`
- `SPEECH_TO_TEXT_PROVIDER` and `TEXT_TO_SPEECH_PROVIDER`
- `IDLE_TIMEOUT_MINUTES` and `MAX_QUEUE_PER_CHAT`
- `SEND_TOOL_CALLS`, `TOOL_CALL_BATCH_MS`, and `TOOL_CALL_BATCH_MAX_ITEMS`
- `SEND_LOCAL_IMAGES`, `LOCAL_IMAGE_UPLOAD_DIRS`, `SEND_LOCAL_DOCUMENTS`, `LOCAL_DOCUMENT_UPLOAD_DIRS`, and `DOCUMENT_UPLOAD_EXTS`
- `HEARTBEAT_ENABLED` and `HEARTBEAT_INTERVAL_SECONDS`
- `SUBAGENT_MAX_RUNNING`, `SUBAGENT_DEFAULT_MAX_RUNTIME_MS`, and `SUBAGENT_SKILLS`

## Telegram commands

Inside Telegram:

| Command | What it does |
| --- | --- |
| `/start` | Say hi |
| `/help` | Show commands |
| `/status` | Show the current chat session status |
| `/models` | Choose an allowed chat model |
| `/reasoning` | Choose the chat reasoning level |
| `/openaiusage` | Show OpenAI Codex usage windows and reset times |
| `/elevenlabsusage` | Show ElevenLabs character/credit usage and subscription details |
| `/abort` | Stop the current response and clear the queue |
| `/new` | Reset the Pi conversation for this chat |
| `/restart` | Restart the bot process |

The chat runtime also exposes a constrained `restart_bot` Pi tool. It is intended only for explicit natural-language requests such as “restart yourself” and uses the same graceful shutdown path as `/restart`, letting pm2 bring the process back up.

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

Production is managed through npm scripts that wrap `pm2` and `ecosystem.config.cjs`:

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

Keep exactly one `pm2` instance running per Telegram bot token. Multiple pollers on the same token can steal updates from each other.

Operational notes:

- Use Node.js 22+ or the same Node version you use locally.
- Keep `.env` on the server only; do not commit bot/API keys.
- Persistent app state lives under `files/`.
- Back up `files/` if you care about memory, heartbeat state, or scheduled tasks.
- Telegram downloads and generated temp files are stored under your system temp directory.
- After changing extensions, skills, prompts, `src/config.ts`, or environment variables, restart with `npx pm2 restart pi-bot --update-env` or `npm stop && npm start`.

## Memory files

Important persistent paths:

```text
files/memory.md                  Long-term memory
files/memory/YYYY-MM-DD.md       Daily/session notes
files/heartbeat.md               Standing heartbeat instructions
files/heartbeat-state.md         Durable heartbeat state
files/cron-jobs.json             Scheduled tasks
files/post-restart-tasks.json    Tasks queued to run after a restart
files/settings.json              Active chat model and reasoning level
```

## Safety notes

- The bot is intentionally restricted to the single chat in `TELEGRAM_ALLOWED_CHAT_ID`.
- Do not commit `.env` or real API keys.
- Bots cannot participate in Telegram Secret Chats.
- True disappearing messages are Telegram chat-level behavior; bot-simulated disappearing messages would require sending and later deleting a normal bot message.
- Long polling means only one running process should use a given Telegram bot token.

## Why Telegram?

Because the best assistant is the one you can reach immediately.

Telegram gives you voice notes, screenshots, quick files, mobile access, and a familiar chat interface. `pi-bot` adds local tools, code execution, memory, scheduling, and agent skills behind that interface.

That makes it less like a chatbot and more like a personal operating layer for your work.
