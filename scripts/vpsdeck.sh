#!/usr/bin/env bash
#==============================================================================
# VPSDeck — process control
#
#   ./scripts/vpsdeck.sh start     build the web UI if stale, then run the gateway
#   ./scripts/vpsdeck.sh stop      SIGTERM, then SIGKILL after 10s
#   ./scripts/vpsdeck.sh restart
#   ./scripts/vpsdeck.sh status
#   ./scripts/vpsdeck.sh logs      tail -f the gateway log
#
# The whole server is one process: the Rust binary serves TLS, the static web
# UI, the REST API and the terminal WebSocket. Nothing else needs to run.
#
# Paths are derived from this script's location, so the repo can live anywhere.
# Override with: ENV_FILE=... LOG_DIR=... ./scripts/vpsdeck.sh start
#==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_DIR="$ROOT/Tools/backend/gateway-rs"
FRONTEND_DIR="$ROOT/Tools/frontend"
BIN="$GATEWAY_DIR/target/release/gateway-rs"
ENV_FILE="${ENV_FILE:-$GATEWAY_DIR/.env}"
LOG_DIR="${LOG_DIR:-$ROOT/logs}"
GATEWAY_LOG="$LOG_DIR/gateway.log"

# The gateway refuses to boot without its keys, so there is no point starting
# without an env file. See Tools/backend/gateway-rs/ENV.md.
load_env() {
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${RED}[error] no env file at $ENV_FILE${NC}" >&2
        echo "        how to create one: $GATEWAY_DIR/ENV.md" >&2
        exit 1
    fi
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
}

running() {
    pgrep -f "$BIN" > /dev/null 2>&1
}

cmd_start() {
    load_env
    local port="${JAKE_BIND##*:}"

    if running; then
        echo -e "${YELLOW}[warn] already running — use '$0 restart'${NC}"
        exit 0
    fi

    mkdir -p "$LOG_DIR"

    echo -e "${YELLOW}[1/2] web UI${NC}"
    if [ ! -f "$FRONTEND_DIR/out/index.html" ] \
       || [ -n "$(find "$FRONTEND_DIR/src" -newer "$FRONTEND_DIR/out/index.html" -print -quit 2>/dev/null)" ]; then
        echo "      building static export..."
        ( cd "$FRONTEND_DIR" && npm run build ) > "$LOG_DIR/frontend-build.log" 2>&1
        echo -e "${GREEN}      done${NC}"
    else
        echo "      out/ is up to date, skipping build"
    fi

    echo -e "${YELLOW}[2/2] gateway (port $port)${NC}"
    if [ ! -x "$BIN" ]; then
        echo "      building release binary..."
        ( cd "$GATEWAY_DIR" && cargo build --release ) > "$LOG_DIR/gateway-build.log" 2>&1
    fi

    ( cd "$GATEWAY_DIR" && "$BIN" ) > "$GATEWAY_LOG" 2>&1 &
    local pid=$!

    local ready=0
    for _ in $(seq 1 60); do
        if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null; then
            ready=1
            break
        fi
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done

    if [ "$ready" = "1" ]; then
        echo -e "      ${GREEN}running${NC} (pid $pid)"
        if [ -n "${JAKE_TLS_CERT:-}" ]; then
            echo -e "      open ${GREEN}https://<host>:$port${NC}"
        else
            echo -e "      open ${GREEN}http://<host>:$port${NC}"
            echo -e "      ${YELLOW}TLS is off — set JAKE_TLS_CERT / JAKE_TLS_KEY${NC}"
        fi
        echo "      log  $GATEWAY_LOG"
    else
        echo -e "      ${RED}failed to become healthy${NC} — last 15 log lines:" >&2
        tail -n 15 "$GATEWAY_LOG" 2>/dev/null || true
        exit 1
    fi
}

cmd_stop() {
    if ! running; then
        echo "not running"
        return 0
    fi
    pkill -TERM -f "$BIN" 2>/dev/null || true
    # Give it up to 10s to close the open SSH channels by itself.
    for _ in $(seq 1 10); do
        running || break
        sleep 1
    done
    if running; then
        pkill -KILL -f "$BIN" 2>/dev/null || true
        echo -e "${GREEN}stopped${NC} (needed SIGKILL)"
    else
        echo -e "${GREEN}stopped${NC}"
    fi
}

cmd_status() {
    if running; then
        echo -e "gateway ${GREEN}RUNNING${NC} (pid $(pgrep -f "$BIN" | tr '\n' ' '))"
    else
        echo -e "gateway ${RED}STOPPED${NC}"
        return 1
    fi
}

case "${1:-}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start ;;
    status)  cmd_status ;;
    logs)    exec tail -f "$GATEWAY_LOG" ;;
    *)
        echo "usage: $0 {start|stop|restart|status|logs}" >&2
        exit 2
        ;;
esac
