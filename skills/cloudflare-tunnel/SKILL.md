---
name: cloudflare-tunnel
description: Expose a local port as a public https URL using a Cloudflare quick tunnel. Use when the user asks for a tunnel by name - "create a tunnel for port 8000", "tunnel localhost:3000", "start a cloudflare tunnel", "stop/list my tunnels", "cloudflared". Do NOT use it for generic requests to expose, share, or make public a local port when the user never says "tunnel" (or Cloudflare).
---

# Cloudflare Tunnel

Turn a service running on `localhost:<port>` into a public `https://<random>.trycloudflare.com` URL using a Cloudflare quick tunnel. No account, no signup, no confirmation page.

## When to Use

Use this skill when the user asks for a **tunnel** (or names Cloudflare / `cloudflared` / trycloudflare). Examples:

- "Create a tunnel for port 8000" / "Tunnel localhost:3000"
- "Start a cloudflare tunnel for port 3000"
- "Which tunnels are running?" / "Stop the tunnel on 8000"

Do **not** invoke this skill when the user asks to expose, share, or make public a local port without saying "tunnel" or naming Cloudflare. Handle those with whatever tool the user prefers, or ask them.

## Usage

Run the tunnel script from the skill directory:

```bash
./scripts/tunnel.sh start <port>   # start a tunnel, prints TUNNEL_URL=...
./scripts/tunnel.sh stop <port>    # stop the tunnel for that port
./scripts/tunnel.sh list           # show active tunnels
```

If your current working directory is the project root, use:

```bash
.pi/skills/cloudflare-tunnel/scripts/tunnel.sh start <port>
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
