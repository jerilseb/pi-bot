# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

`pi-bot` is a small web app that bridges a browser chat UI to a Pi SDK session. The
browser talks to the Node server over a WebSocket, giving live token streaming, rich
tool-call/thinking display, file/image rendering, voice in/out, a model picker, and
Web Push (PWA). It uses Pi model refs (for example OpenRouter or OpenAI Codex),
optional ElevenLabs/Google GenAI voice features, local Pi extensions, and Pi skills.

Key files:

- `main.ts` — entrypoint/orchestrator: chat state, command handling, queueing, web server boot, process lifecycle.
- `src/config.ts` — environment variables, paths, constants.
- `src/pi-session.ts` — Pi SDK runtime/session wrapper; streams normalized events via `onEvent`.
- `src/web/protocol.ts` — enveloped (`seq`/`runId`) WebSocket protocol; durable-vs-live split; `ClientMessage` schema.
- `src/web/gateway.ts` — the client gateway: the single seam owning all browser I/O (live stream + replay buffer + Web Push).
- `src/web/server.ts` — HTTP + WebSocket server; `/api/upload`, `/api/transcribe`, `/api/files/:id`, `/api/push/subscribe`; serves `web/dist`.
- `src/web/{assets,history-buffer,push,menu}.ts` — asset manifest store, replay buffer, Web Push, button menus.
- `src/outbound.ts` — final Pi response delivery via the gateway.
- `src/heartbeat.ts` / `src/cron.ts` — scheduled background prompts.
- `web/` — React + Vite PWA frontend (own `package.json`, builds to `web/dist`).
- `extensions/` — local Pi extensions.
- `skills/` — Pi skills.
- `files/` — persistent prompt/memory/heartbeat state and web runtime state (`web-assets/`, `web-history/`).

## Commands

- Install: `npm install` (npm workspaces install the `web/` package too)
- Local dev: `npm run dev` — runs the Node backend (API + WS on 8787) and the Vite dev server (5173) concurrently. Open **http://localhost:5173** (Vite proxies `/ws` and `/api/*` to 8787, with HMR).
- Build the web UI: `npm run build` (→ `web/dist`). **Required** before production serving.
- Production serve: `npm start` (builds then starts under PM2). Open **http://localhost:8787**.
- Typecheck: `npm run typecheck` (root + `web/`)
- Smoke/verify: `npm run verify`

Before finishing code changes, run:

```bash
npm run typecheck
```

## Coding conventions

- TypeScript ESM project (`"type": "module"`) using `NodeNext` module resolution (backend).
- Include explicit `.ts` extensions in local TypeScript imports.
- Keep strict TypeScript compatibility; avoid `any` unless there is a clear boundary reason.
- Match existing formatting, enforced by Biome (`biome.json`): 2-space indentation, single quotes, semicolons, 100-char line width. Run `npm run format` to apply. (web/ uses Vite/React defaults).
- Prefer small, focused modules and typed helper functions.
- Preserve long-running behavior: do not block the per-chat queue, and keep file/upload operations best-effort where appropriate.
- The gateway is the only module that knows about WebSocket/push; extensions and core never import `ws`.

## Environment and secrets

- Never commit `.env` or real API keys/tokens.
- Keep secrets and deployment-specific values in `.env`: provider API keys, optional ElevenLabs/Google GenAI/Tavily/KIE keys, and Web Push VAPID keys.
- Non-secret bot configuration lives in `src/config.ts`, including chat/model choices, queue/timeouts, upload behavior, web port, and heartbeat interval.
- Provider-specific auth such as `OPENROUTER_API_KEY` or Pi auth storage is required for the selected model.
- Web Push is opt-in via `WEB_PUSH_ENABLED=true` plus `WEB_PUSH_VAPID_PUBLIC` / `WEB_PUSH_VAPID_PRIVATE` / `WEB_PUSH_SUBJECT`.

## Operational notes

- The server binds `127.0.0.1:8787` and serves plain HTTP. Remote access is over Tailscale; there is no app-level auth.
- Web Push and microphone capture require a secure origin (HTTPS/WSS) in the browser. Set `WEB_TLS_HOST` (+ `certs/<host>.{crt,key}`, e.g. a `tailscale cert`) so `npm run dev:web` serves HTTPS directly on 5173. The `certs/` dir is gitignored.
- Persistent app state lives under `files/`; avoid deleting or rewriting it unless explicitly requested. Web runtime state lives in `files/web-assets/`, `files/web-history/`, and `files/web-push-subscriptions.json`.
- A single default web conversation is used (`chatId = "web"`). The registry is keyed by chatId, so named conversations can be added later.
- After changing extensions, skills, prompts, or env vars, restart the server. After changing `web/`, rebuild (`npm run build`) for the production path.

## Pi-specific work

When modifying Pi SDK usage, extensions, skills, themes, TUI code, or Pi agent behavior, consult the installed Pi documentation/examples before implementing. Follow existing project patterns in `src/pi-session.ts`, `src/web/`, `extensions/`, and `skills/`.
