#!/usr/bin/env bash
set -euo pipefail

HTML_DIR="${HTML_DIR:-/tmp/html}"
PORT="${PORT:-8080}"
PUBLIC_PREVIEW="false"

usage() {
    cat <<'EOF'
Usage: serve.sh [port] [--public]
       serve.sh [--public] [port]

Starts a local preview server for HTML_DIR (default: /tmp/html). By default,
only the local preview is created. Use --public only after the user confirms
they want a public tunnel.
EOF
}

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

# Kill any existing localtunnel for this port
LT_PID=$(pgrep -f "localtunnel.*--port $PORT" 2>/dev/null || true)
if [ -n "$LT_PID" ]; then
    kill $LT_PID 2>/dev/null || true
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
LT_PID=""
LT_OUT_FILE=""

if [ "$PUBLIC_PREVIEW" = "true" ]; then
    # Start localtunnel and capture the URL
    LT_OUT_FILE=$(mktemp)
    npx localtunnel --port "$PORT" > "$LT_OUT_FILE" 2>&1 &
    LT_PID=$!

    # Poll for the tunnel URL (npx can take several seconds to start)
    for i in $(seq 1 20); do
        sleep 1
        if [ -f "$LT_OUT_FILE" ]; then
            TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.loca\.lt' "$LT_OUT_FILE" 2>/dev/null || true)
            if [ -n "$TUNNEL_URL" ]; then
                break
            fi
        fi
    done

    # Keep the temp file so the URL can be read later if needed
    # (cleaned up on next run or system reboot)
fi

echo "SERVE_PID=$SERVE_PID"
if [ -n "$LT_PID" ]; then
    echo "LT_PID=$LT_PID"
fi
echo "PORT=$PORT"
echo "LOCAL_URL=http://localhost:$PORT"
if [ "$PUBLIC_PREVIEW" = "true" ]; then
    if [ -n "$TUNNEL_URL" ]; then
        echo "TUNNEL_URL=$TUNNEL_URL"
    else
        echo "TUNNEL_URL=(not available - localtunnel may have failed)"
    fi
else
    echo "TUNNEL_URL=(not requested)"
fi
echo "HTML_DIR=$HTML_DIR"
