#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
Usage: tunnel.sh start <port>   Start a Cloudflare quick tunnel for localhost:<port>
       tunnel.sh stop <port>    Stop the tunnel for <port>
       tunnel.sh list           List active tunnels
EOF
}

CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
if [ ! -x "$CLOUDFLARED" ]; then
    echo "ERROR: cloudflared not found. Install it with:" >&2
    echo "  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared" >&2
    exit 1
fi

CMD="${1:-}"

require_port() {
    PORT="${1:-}"
    if [ -z "$PORT" ] || ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
        echo "ERROR: Missing or invalid port" >&2
        usage >&2
        exit 1
    fi
}

case "$CMD" in
    start)
        require_port "${2:-}"

        if ! curl -s -o /dev/null --max-time 2 "http://localhost:$PORT" 2>/dev/null; then
            echo "WARNING: Nothing responded on http://localhost:$PORT - starting the tunnel anyway"
        fi

        # Replace any existing tunnel for this port
        CF_PID=$(pgrep -f "cloudflared.*--url http://localhost:$PORT" 2>/dev/null || true)
        if [ -n "$CF_PID" ]; then
            kill $CF_PID 2>/dev/null || true
            sleep 0.5
        fi

        CF_OUT_FILE=$(mktemp)
        "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" --no-autoupdate > "$CF_OUT_FILE" 2>&1 &
        CF_PID=$!

        TUNNEL_URL=""
        for i in $(seq 1 20); do
            sleep 1
            TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CF_OUT_FILE" 2>/dev/null | head -1 || true)
            if [ -n "$TUNNEL_URL" ]; then
                break
            fi
        done

        if [ -z "$TUNNEL_URL" ]; then
            echo "ERROR: cloudflared did not produce a tunnel URL" >&2
            tail -20 "$CF_OUT_FILE" >&2 || true
            kill $CF_PID 2>/dev/null || true
            exit 1
        fi

        echo "CF_PID=$CF_PID"
        echo "PORT=$PORT"
        echo "TUNNEL_URL=$TUNNEL_URL"
        ;;
    stop)
        require_port "${2:-}"
        CF_PID=$(pgrep -f "cloudflared.*--url http://localhost:$PORT" 2>/dev/null || true)
        if [ -n "$CF_PID" ]; then
            kill $CF_PID 2>/dev/null || true
            echo "Stopped tunnel for port $PORT"
        else
            echo "No active tunnel for port $PORT"
        fi
        ;;
    list)
        TUNNELS=$(pgrep -af 'cloudflared.*--url' 2>/dev/null || true)
        if [ -n "$TUNNELS" ]; then
            echo "$TUNNELS"
        else
            echo "No active tunnels"
        fi
        ;;
    -h|--help|"")
        usage
        ;;
    *)
        echo "ERROR: Unknown command: $CMD" >&2
        usage >&2
        exit 1
        ;;
esac
