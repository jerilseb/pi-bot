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

Ask it to do something later, once, repeatedly, or on a cron-like schedule. Requires `"cronJobs": true` in `files/settings.json` — see [Configuration](#configuration).

Scheduled tasks run in a separate background session so they cannot disturb your conversation, but every report they send you is also noted in the chat session. Asking "what did this morning's report say?" works without the chat agent having to go and read files.

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
- Scheduled one-time, interval, and cron-like tasks (off by default).
- Heartbeat loop for proactive monitoring instructions (off by default).
- Long-term memory plus daily/session notes.
- Model switching with Telegram inline buttons.
- Tool calls folded into one expandable message per prompt, or streamed, or off.
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

Secrets and deployment-specific values live in `.env`; see `.env.example` for the optional ones, including `SCHEDULED_TASK_MODEL`. `TELEGRAM_ALLOWED_CHAT_ID` is the single Telegram chat allowed to use the bot — messages from any other chat are ignored, and the value is read once at startup, so changing it requires a restart. Your own chat ID is a positive number; you can get it by messaging [@userinfobot](https://t.me/userinfobot).

### 3. Run locally

```bash
npm run dev
```

### 4. Run under systemd

```bash
npm run systemd:install
```

The startup logs show the active chat model, background model, enabled extensions, and discovered skills.

## Configuration

The default chat model is configured in `src/config.ts`:

```ts
export const CHAT_MODEL = "openai-codex/gpt-5.6-luna";
```

The active chat model and reasoning level can be changed from Telegram with `/models` and `/reasoning`, and are persisted in `files/settings.json` as `defaultProvider`/`defaultModel`/`defaultThinkingLevel`. That file wins over `CHAT_MODEL`, and the resolved model must be listed in `ALLOWED_MODELS` or startup fails.

The same file gates the two ways the bot can act unprompted:

```json
{
  "heartbeat": false,
  "cronJobs": false
}
```

Both default to **off** — only a literal `true` enables either. Both are read at startup, so flip and restart. `/status` reports the current state of each.

- `heartbeat` — the hourly heartbeat run. Ticks also need `files/heartbeat.md` to hold instructions beyond its `# Heartbeat` heading; with the switch on but the file empty, every tick is a silent no-op.
- `cronJobs` — the scheduled-task scheduler *and* the `create_schedule_task` / `list_scheduled_tasks` / `cancel_scheduled_task` / `update_scheduled_task` tools. The tools are withheld when it is off, so the agent cannot queue jobs that would never fire; existing entries in `files/cron-jobs.json` are left in place, just not run.

The same file also holds how tool calls reach the chat, switched from Telegram with `/toolcalls`:

```json
{
  "toolCalls": "collapsed"
}
```

- `collapsed` (default) — one silent message per prompt, edited in place as calls arrive, with the calls folded inside an expandable blockquote. Lines past the size budget are counted in the header rather than shown.
- `stream` — a new message per batch.
- `off` — nothing is sent.

Unlike `heartbeat` and `cronJobs`, this one is read fresh at the start of every prompt, so a switch applies from the next prompt and needs no restart.

`files/settings.json` is owned by Pi's `SettingsManager`, which merges writes into the existing file, so these bot-only keys are not clobbered by `/models` or `/reasoning`. Writes from `/toolcalls` merge the same way.

The file is gitignored, but `files/settings.json.example` is checked in and shows the defaults the bot writes on first start. You do not need to copy it — startup creates `files/settings.json` if it is missing — it is there to document the shape.

The two unattended features take their models from `.env`: `HEARTBEAT_MODEL` for heartbeat runs and `SCHEDULED_TASK_MODEL` for scheduled tasks. There is no default and no fallback between them — an unset model means that feature does not run, and turning a feature on in `files/settings.json` without setting its model is a startup error rather than a schedule that quietly never fires. A single task can also be given its own model when it is created ("schedule this with kimi-k2.6"), which the agent validates against Pi's catalogue at creation time, so a typo or a provider without auth fails there rather than when the task fires. Both are separate from the chat model and neither can be changed from Telegram; `/status` shows the current values.

Skills are discovered from both the project `skills/` directory and Pi's global `~/.pi/agent/skills/` directory. The latter follows `PI_CODING_AGENT_DIR` when that environment variable overrides Pi's agent directory. Symlinked skill directories and root Markdown skill files are followed, with cycles and duplicate targets ignored.

Model refs use this form:

```text
provider/model-id
```

Examples:

```text
openai-codex/gpt-6-astra
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

# shared agent preferences, read once at startup from a gist owned by jerilseb
CONTEXT_GIST_URL=https://gist.githubusercontent.com/jerilseb/<gist-id>/raw/<file>
```

`CONTEXT_GIST_URL` points at one gist holding standing preferences that every agent reads, so a change made in one place reaches all of them. It is fetched once at startup and appended to the system prompt inside a `<user-preferences>` block, which means editing the gist takes effect on the bot's next restart.

The URL must be the raw one naming a single file. The fileless `/raw` serves whichever file GitHub orders first, which moves as files are added to the gist, so naming the file keeps a multi-file gist unambiguous. The revision SHA that GitHub's "Raw" button adds is stripped: it pins the file's current content, so that URL would serve the same text after every edit — the bot drops it and says so in the startup log. Only gists owned by `jerilseb` are accepted.

Useful non-secret settings in `src/config.ts` include:

- `CHAT_MODEL` and `ALLOWED_MODELS` (the unattended models are `HEARTBEAT_MODEL` and `SCHEDULED_TASK_MODEL` in `.env`)
- `ELEVENLABS_TTS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, and `ELEVENLABS_TTS_OUTPUT_FORMAT`
- `SPEECH_TO_TEXT_PROVIDER` and `TEXT_TO_SPEECH_PROVIDER`
- `MAX_QUEUED_PROMPTS`, `TRANSPORT_RECOVERY_MAX_CONTINUATIONS`, and `TRANSPORT_RECOVERY_DELAY_MS`
- `TOOL_CALL_BATCH_MS`, `TOOL_CALL_BATCH_MAX_ITEMS`, and `TOOL_CALL_COLLAPSED_MAX_CHARS` (whether and how tool calls are shown at all is the `toolCalls` setting in `files/settings.json` — see below)
- `SEND_LOCAL_IMAGES`, `LOCAL_IMAGE_UPLOAD_DIRS`, `SEND_LOCAL_DOCUMENTS`, `LOCAL_DOCUMENT_UPLOAD_DIRS`, and `DOCUMENT_UPLOAD_EXTS`
- `HEARTBEAT_INTERVAL_SECONDS` (whether the heartbeat runs at all is a `files/settings.json` setting — see below)
- `BACKGROUND_BASH_MAX_RUNNING` and `BACKGROUND_BASH_DEFAULT_MAX_RUNTIME_MS`

Chat and background session state stays loaded between prompts; there is no idle timeout. Conversation resets and bot shutdown/restart still dispose the underlying Pi sessions.

Ordinary Telegram messages sent while the chat agent is running **steer the current task** via the Pi SDK. The bot acknowledges them with “↪️ Steering current task.” They are delivered after the current assistant turn finishes its tool calls, before the next model call; running tools are not cancelled. Text, transcribed voice, and attachments use the same route. Messages arriving during startup or after the run stops accepting steering fall back to the serial queue, as do background jobs and completion reports. There is no explicit queue command. The pending limit includes both queued and undelivered steering messages. `/abort` and `/new` discard both kinds of pending work.

The Pi SDK automatically retries transient provider and transport failures. The bot keeps only the final attempt's text/error, announces recovery once, and—if the SDK exhausts its retry budget on a foreground transport failure—starts one fresh continuation turn after a short delay. That continuation uses the saved conversation/tool results and explicitly avoids blindly replaying completed side effects. It does not run for authentication, quota, rate-limit, context, tool, abort, or background-task failures. `/abort` and `/new` cancel the recovery delay.

## Telegram commands

Inside Telegram:

| Command | What it does |
| --- | --- |
| `/start` | Say hi |
| `/help` | Show commands |
| `/status` | Show the current chat session status |
| `/models` | Choose an allowed chat model |
| `/reasoning` | Choose the chat reasoning level |
| `/toolcalls` | Choose how tool calls are shown: collapsed, stream, or off |
| `/openaiusage` | Show OpenAI Codex usage windows and reset times |
| `/elevenlabsusage` | Show ElevenLabs character/credit usage and subscription details |
| `/abort` | Stop the current response and clear queued/steering messages |
| `/new` | Reset the Pi conversation for this chat |
| `/restart` | Restart the bot process |

The chat runtime also exposes a constrained `restart_bot` Pi tool. It is intended only for explicit natural-language requests such as “restart yourself” and uses the same graceful shutdown path as `/restart`, letting systemd bring the process back up.

## Deployment

This bot uses Telegram long polling, so it does **not** need a public HTTPS URL or webhook. Deploy it as one long-running Node.js process on a VPS, home server, or any process host that allows outbound HTTPS.

Basic VPS deployment:

```bash
git clone <your-repo-url> pi-bot
cd pi-bot
npm ci
cp .env.example .env
# edit .env with your Telegram chat/token and provider keys
npm run systemd:install
```

Long-running deployment is a systemd `--user` unit:

```bash
npm run systemd:install     # write the unit, enable it, start it
npm run systemd:uninstall   # stop, disable, and remove the unit
```

Once installed:

```bash
npm run systemd:start     # systemctl --user start pi-bot
npm run systemd:stop      # systemctl --user stop pi-bot
npm run systemd:restart   # systemctl --user restart pi-bot
npm run systemd:status    # systemctl --user status pi-bot
npm run logs              # journalctl --user -u pi-bot -f
```

`systemd:install` writes `~/.config/systemd/user/pi-bot.service` and enables lingering so the bot
survives logout and comes back after reboot. The unit sets `WorkingDirectory` to the repo, so `.env`
loads through dotenv exactly as under `npm run dev`, and copies the installing shell's `PATH` so the
bot's Bash tool, background shell sessions, and `npm run verify` can still find `node`, `npm`, and
`git`. `Restart=always` covers the deliberate zero-exit used by `/restart` and `restart_bot`.
`systemd:uninstall` removes the unit and leaves `files/` alone.

Keep exactly one instance running per Telegram bot token. Multiple pollers on the same token can steal updates from each other — in particular, stop the unit before running `npm run dev`.

Operational notes:

- Use Node.js 22+ or the same Node version you use locally.
- Keep `.env` on the server only; do not commit bot/API keys.
- Persistent app state lives under `files/`.
- Back up `files/` if you care about memory, heartbeat state, or scheduled tasks.
- Telegram downloads and generated temp files are stored under your system temp directory.
- After changing extensions, skills, prompts, `src/config.ts`, or environment variables, restart with `npm run systemd:restart`. If the unit file itself needs to change (new node path, new repo location), re-run `npm run systemd:install`.

## Memory files

Important persistent paths:

```text
files/memory.md                  Long-term memory
files/memory/YYYY-MM-DD.md       Daily/session notes
files/heartbeat.md               Standing heartbeat instructions
files/heartbeat-state.md         Durable heartbeat state
files/cron-jobs.json             Scheduled tasks
files/post-restart-tasks.json    Tasks queued to run after a restart
files/settings.json              Active chat model, reasoning level, heartbeat/cron switches, tool-call mode
files/settings.json.example      Checked-in reference copy of the above defaults
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
