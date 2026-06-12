#!/usr/bin/env bash
set -euo pipefail

HTML_DIR="${HTML_DIR:-/tmp/html}"
PORT="${PORT:-8080}"
PUBLIC_PREVIEW="true"

usage() {
    cat <<'EOF'
Usage: serve.sh [port] [--public]
       serve.sh [--public] [port]

Starts a preview server for HTML_DIR (default: /tmp/html) and always creates
a public Cloudflare quick tunnel URL. --public is accepted for backwards
compatibility.
EOF
}

CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
if [ ! -x "$CLOUDFLARED" ]; then
    echo "ERROR: cloudflared not found. Install it with:" >&2
    echo "  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared" >&2
    exit 1
fi

for arg in "$@"; do
    case "$arg" in
        --public)
            PUBLIC_PREVIEW="true"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        ''|*[!0-9]*)
            echo "ERROR: Unknown argument: $arg" >&2
            usage >&2
            exit 1
            ;;
        *)
            PORT="$arg"
            ;;
    esac
done

mkdir -p "$HTML_DIR"

# Kill any existing server on this port
PID=$(lsof -ti :"$PORT" 2>/dev/null || true)
if [ -n "$PID" ]; then
    kill $PID 2>/dev/null || true
    sleep 0.5
fi

# Kill any existing tunnel for this port
CF_PID=$(pgrep -f "cloudflared.*--url http://localhost:$PORT" 2>/dev/null || true)
if [ -n "$CF_PID" ]; then
    kill $CF_PID 2>/dev/null || true
    sleep 0.5
fi

# Start the local preview server in the background
SERVE_LOG=$(mktemp)
npx serve "$HTML_DIR" -l "$PORT" --no-clipboard &> "$SERVE_LOG" &
SERVE_PID=$!

# Poll for serve to be ready
SERVE_READY=false
for i in $(seq 1 20); do
    sleep 1
    if curl -s -o /dev/null -w '' http://localhost:"$PORT" 2>/dev/null; then
        SERVE_READY=true
        break
    fi
done

if [ "$SERVE_READY" != "true" ]; then
    echo "ERROR: Failed to start serve on port $PORT"
    cat "$SERVE_LOG" 2>/dev/null || true
    rm -f "$SERVE_LOG"
    exit 1
fi
rm -f "$SERVE_LOG"

TUNNEL_URL=""
CF_PID=""
CF_OUT_FILE=""

if [ "$PUBLIC_PREVIEW" = "true" ]; then
    # Start a Cloudflare quick tunnel and capture the URL
    CF_OUT_FILE=$(mktemp)
    "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" --no-autoupdate > "$CF_OUT_FILE" 2>&1 &
    CF_PID=$!

    # Poll for the tunnel URL (cloudflared can take several seconds to start)
    for i in $(seq 1 20); do
        sleep 1
        if [ -f "$CF_OUT_FILE" ]; then
            TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CF_OUT_FILE" 2>/dev/null | head -1 || true)
            if [ -n "$TUNNEL_URL" ]; then
                break
            fi
        fi
    done

    # Keep the temp file so the URL can be read later if needed
    # (cleaned up on next run or system reboot)
fi

echo "SERVE_PID=$SERVE_PID"
if [ -n "$CF_PID" ]; then
    echo "CF_PID=$CF_PID"
fi
echo "PORT=$PORT"
if [ "$PUBLIC_PREVIEW" = "true" ]; then
    if [ -n "$TUNNEL_URL" ]; then
        echo "TUNNEL_URL=$TUNNEL_URL"
    else
        echo "TUNNEL_URL=(not available - cloudflared may have failed)"
    fi
fi
echo "HTML_DIR=$HTML_DIR"
