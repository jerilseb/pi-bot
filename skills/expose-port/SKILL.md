---
name: expose-port
description: Expose a local port (dev server, API, web app) as a public https URL using a Cloudflare quick tunnel. Use when the user asks to access localhost:<port> from their phone, share or expose a dev server, open a tunnel to a local service, or stop/list running tunnels.
---

# Expose Port

Turn a service running on `localhost:<port>` into a public `https://<random>.trycloudflare.com` URL using a Cloudflare quick tunnel. No account, no signup, no confirmation page.

## When to Use

- User wants to open a local dev server (e.g. `localhost:8000`) on their phone or share it
- User asks to "expose", "tunnel", or "make public" a local port
- User asks which tunnels are running, or to stop one

## Usage

Run the tunnel script from the skill directory:

```bash
./scripts/tunnel.sh start <port>   # start a tunnel, prints TUNNEL_URL=...
./scripts/tunnel.sh stop <port>    # stop the tunnel for that port
./scripts/tunnel.sh list           # show active tunnels
```

If your current working directory is the project root, use:

```bash
.pi/skills/expose-port/scripts/tunnel.sh start <port>
```

After `start`, share the `TUNNEL_URL` with the user as a tappable link:

```text
✅ localhost:8000 is live at https://random-words.trycloudflare.com
```

## Notes

- The URL is public but unguessable. Anyone with the link can reach the service — remind the user of this if the service looks sensitive.
- A fresh random URL is generated each time a tunnel starts; old URLs die when the tunnel stops.
- Starting a tunnel for a port replaces any existing tunnel on that port.
- If nothing is listening on the port yet, the script warns but still starts the tunnel — the URL will work once the local server is up.
- Tunnels keep running in the background until stopped; they do not block anything.
