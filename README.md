# pi-bot

> Your private AI operator in the browser — always nearby, able to chat, code, research, remember, schedule work, inspect files, create visuals, and restart itself when you ask.

`pi-bot` turns a browser tab into a practical personal AI workspace powered by the [Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent). You talk to it over a WebSocket, so you get live token streaming, rich tool-call and thinking display, inline files/images, voice in/out, a model picker, and — as an installable PWA — Web Push notifications even when the tab is closed.

## Why this exists

Most AI tools are either chat-only assistants that cannot touch your local files, coding agents stuck in a terminal, automation tools that need ceremony for simple reminders, or bots that forget everything once the conversation ends.

`pi-bot` combines those into one lightweight personal assistant:

- **Available from any browser** — type, attach screenshots/PDFs/documents, or record a voice note.
- **Useful on your machine** — it can inspect files, edit code, run tests, use local skills, and work inside a real repository.
- **Proactive when needed** — schedule future tasks, run recurring checks, and keep heartbeat-style monitoring instructions. Background results arrive via Web Push and are replayed when you reopen the app.
- **Persistent enough to be personal** — long-term memory and daily work notes so context does not vanish every session.
- **Still under your control** — it binds to localhost and secrets stay in your `.env`; reach it remotely over your Tailscale tailnet.

## Architecture

```
Browser (React PWA)
   │  WebSocket  (prompts, commands, menu select, model, visibility)
   │  HTTP: GET /, /api/files/:id, POST /api/upload, /api/transcribe, /api/push/subscribe
   ▼
Node HTTP + WS server (src/web/server.ts)
   ├── inbound: WS prompt / uploaded file ──► IncomingPrompt ──► handleIncoming() ──► per-chat queue
   │                                                                    │
   │                                              chat.pi.runPrompt(..., { onEvent })  (streamed)
   │                                                                    │
   └── outbound: gateway.emit(event)  ◄── streamed Pi events + final response
            ├── live → connected WebSocket clients
            ├── persist → replay buffer (files/web-history/<chatId>.jsonl)
            └── notify → Web Push when no client is visible
```

The protocol is enveloped (`{ seq, runId, chatId, ts, type, payload }`) and split into **live-only** events (deltas, tool start/update) that animate the active run, and **durable records** (user/assistant messages, tool records, files, voice, menus, notices) that are persisted and replayed on reconnect.

## Feature highlights

- Browser chat UI over a WebSocket — live token-by-token streaming.
- Collapsible tool-call cards (name, args, result, error state) and thinking blocks.
- Inline images/documents and an audio player for voice replies; Markdown rendering.
- File/image upload and microphone capture (speech-to-text) from the composer.
- Model picker, plus `/status`, `/abort`, `/new`, `/restart`, usage commands.
- Buffer-and-replay: reconnecting restores recent history; background output triggers Web Push.
- Installable PWA with a service worker for Web Push (opt-in via VAPID keys).
- Scheduled one-time, interval, and cron-like tasks; heartbeat loop for proactive monitoring.
- Long-term memory plus daily/session notes.
- Tavily `web_search`, browser-style `web_fetch`, and Pi skills (PDF, image generation, browser automation, HTML visualizations, email).
- Graceful self-restart through `/restart` or an explicit natural-language restart request.

## Quick start

### 1. Install dependencies

```bash
npm install
```

This is an npm workspace; it installs the `web/` frontend package too.

### 2. Create your environment file

```bash
cp .env.example .env
# then set OPENROUTER_API_KEY (or authenticate openai-codex via Pi)
```

### 3. Run locally (dev)

```bash
npm run dev
```

This runs the Node backend (API + WS on **8787**) and the Vite dev server (**5173**) concurrently. Open **http://localhost:5173** — Vite proxies `/ws` and `/api/*` to 8787 and gives you HMR for the UI.

### 4. Production serve

```bash
npm start   # builds web/dist, then starts under pm2
```

Then open **http://localhost:8787** (the Node server serves the built `web/dist`). The startup logs show the active chat model, background model, enabled extensions, and discovered skills.

## Configuration

The default chat model is configured in `src/config.ts`:

```ts
export const CHAT_MODEL = "openai-codex/gpt-5.4-mini";
```

The active chat model can be changed from the web UI model picker and is persisted in `.active_model`. Background heartbeat/cron prompts use `CONFIG_BACKGROUND_MODEL` and cannot be changed from the UI.

Model refs use `provider/model-id` form, for example:

```text
openai-codex/gpt-5.5
openrouter/openai/gpt-5.4-mini
openrouter/moonshotai/kimi-k2.6
```

For `openai-codex/...`, authenticate through Pi with `/login openai-codex`, or set `OPENAI_CODEX_API_KEY`.

### Web server and Web Push

```bash
# Web UI server (defaults)
WEB_UI_HOST=127.0.0.1
WEB_UI_PORT=8787

# Web Push (PWA) — opt-in. Generate keys: npx web-push generate-vapid-keys
WEB_PUSH_ENABLED=true
WEB_PUSH_VAPID_PUBLIC=...
WEB_PUSH_VAPID_PRIVATE=...
WEB_PUSH_SUBJECT=mailto:you@example.com

# Dev-server HTTPS (secure origin for mic + Web Push on real devices).
# Issue a cert with `tailscale cert <host>` into certs/<host>.{crt,key}.
WEB_TLS_HOST=your-machine.your-tailnet.ts.net
```

Web Push and microphone capture require a **secure origin** (HTTPS/WSS) in the browser. Set `WEB_TLS_HOST` and drop a Tailscale cert in `certs/<host>.{crt,key}`; `npm run web:dev` then serves HTTPS on 5173, reachable over your tailnet.

### Optional integrations

```bash
ELEVENLABS_API_KEY=your-elevenlabs-key   # speech-to-text + voice-note replies
GOOGLE_GENAI_API_KEY=your-gemini-key     # speech features (GEMINI_API_KEY also accepted)
TAVILY_API_KEY_1=tvly-your-key           # web search
KIE_API_KEY=your-kie-api-key             # image generation skill
OPENAI_CODEX_API_KEY=your-codex-token    # optional Codex runtime override
```

## Commands

Type these in the composer:

| Command | What it does |
| --- | --- |
| `/help` | Show commands |
| `/status` | Show the current chat session status |
| `/models` | List allowed chat models (switch via the model picker) |
| `/openaiusage` | Show OpenAI Codex usage windows and reset times |
| `/elevenlabsusage` | Show ElevenLabs character/credit usage |
| `/abort` | Stop the current response and clear the queue |
| `/new` | Reset the Pi conversation for this chat |
| `/restart` | Restart the bot process |

The chat runtime also exposes a constrained `restart_bot` Pi tool for explicit natural-language requests such as "restart yourself", using the same graceful shutdown path as `/restart`.

## Deployment

Deploy as one long-running Node.js process, reachable over your Tailscale tailnet:

```bash
git clone <your-repo-url> pi-bot
cd pi-bot
npm ci
cp .env.example .env   # set provider keys (and VAPID keys if using push)
npm start              # builds web/dist + pm2 start
```

Production is managed through npm scripts that wrap `pm2` and `ecosystem.config.cjs`:

```bash
npm start   # npm run build && pm2 start ecosystem.config.cjs --update-env && pm2 save
npm stop    # pm2 delete pi-bot || true && pm2 save
```

For a secure origin (required for Web Push and microphone access), serve HTTPS over your tailnet: issue a cert with `tailscale cert <host>` into `certs/<host>.{crt,key}`, set `WEB_TLS_HOST`, and run the dev server (`npm run web:dev`) on 5173 — or terminate TLS with `tailscale serve` in front of the production server on 8787.

Operational notes:

- Use Node.js 22+ (Node can run the `.ts` entrypoint directly).
- Keep `.env` on the server only; do not commit keys.
- `npm run build` is **required** before production serving; the server fails fast with a clear message if `web/dist` is missing.
- Persistent app state lives under `files/`. Back it up if you care about memory, heartbeat state, scheduled tasks, replay history, or stored assets.
- After changing extensions, skills, prompts, `src/config.ts`, or environment variables, restart. After changing `web/`, rebuild.

## Persistent paths

```text
files/memory.md                      Long-term memory
files/memory/YYYY-MM-DD.md           Daily/session notes
files/heartbeat.md                   Standing heartbeat instructions
files/heartbeat-state.md             Durable heartbeat state
files/cron-jobs.json                 Scheduled tasks
files/web-history/<chatId>.jsonl     Replay buffer (durable records)
files/web-assets/                    Stored uploads + generated files (manifest.json)
files/web-push-subscriptions.json    Web Push subscriptions
.active_model                        Active chat model
```

## Safety notes

- The server binds `127.0.0.1` and has no app-level auth — restrict access at the network/proxy layer.
- Do not commit `.env` or real API keys.
- Uploaded and generated files are referenced by opaque asset ids, never filesystem paths, over the wire.
- Tool args and results are capped and secret-masked before they are streamed or persisted.
