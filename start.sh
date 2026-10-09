#!/usr/bin/env bash
#==============================================================================
# VPSDeck - VPS Management Dashboard
#
# Một tiến trình duy nhất: binary Rust phục vụ TLS + frontend tĩnh + REST + WS.
#
# Trước đây script này chạy ba tiến trình trên ba runtime:
#   nginx:5678  ->  Next.js:4567 (node)  ->  Spring Boot:8080 (jvm)
# cộng một VPS Agent ở 9090 mà không ai gọi tới. Giờ chỉ còn:
#   gateway-rs:8080
#
# Dừng bằng ./stop.sh
#==============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="${PROJECT_DIR:-/opt/vpsdeck}"
GATEWAY_DIR="$PROJECT_DIR/Tools/backend/gateway-rs"
FRONTEND_DIR="$PROJECT_DIR/Tools/frontend"
LOG_DIR="${LOG_DIR:-/tmp/jake-logs}"

mkdir -p "$LOG_DIR"

echo "==========================================="
echo "  VPSDeck - VPS Management Dashboard"
echo "==========================================="
echo ""

# --- Cấu hình: bắt buộc có .env, không có khoá mặc định ---
if [ ! -f "$GATEWAY_DIR/.env" ]; then
    echo -e "${RED}[LỖI] Chưa có $GATEWAY_DIR/.env${NC}"
    echo "       Xem hướng dẫn tạo ở $GATEWAY_DIR/ENV.md"
    exit 1
fi

set -a
# shellcheck disable=SC1091
. "$GATEWAY_DIR/.env"
set +a

PORT="${JAKE_BIND##*:}"

# --- Đã chạy rồi thì thôi ---
if pgrep -f "$GATEWAY_DIR/target/release/gateway-rs" > /dev/null 2>&1; then
    echo -e "${YELLOW}[WARN] gateway-rs đang chạy. Dừng bằng ./stop.sh trước.${NC}"
    exit 0
fi

# --- 1. Frontend: build static nếu chưa có hoặc đã cũ hơn source ---
echo -e "${YELLOW}[1/2] Kiểm tra frontend...${NC}"
if [ ! -f "$FRONTEND_DIR/out/index.html" ] \
   || [ -n "$(find "$FRONTEND_DIR/src" -newer "$FRONTEND_DIR/out/index.html" -print -quit 2>/dev/null)" ]; then
    echo "      Đang build static (next build -> out/)..."
    ( cd "$FRONTEND_DIR" && npm run build ) > "$LOG_DIR/frontend-build.log" 2>&1
    echo -e "${GREEN}      Build xong.${NC}"
else
    echo "      out/ đã mới, bỏ qua build."
fi

# --- 2. Gateway: build nếu chưa có binary ---
echo -e "${YELLOW}[2/2] Khởi động gateway-rs (port $PORT)...${NC}"
if [ ! -x "$GATEWAY_DIR/target/release/gateway-rs" ]; then
    echo "      Binary chưa có, đang build release..."
    ( cd "$GATEWAY_DIR" && cargo build --release ) > "$LOG_DIR/gateway-build.log" 2>&1
fi

( cd "$GATEWAY_DIR" && ./target/release/gateway-rs ) > "$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
echo -e "${GREEN}      Đã khởi động (PID: $GATEWAY_PID)${NC}"

# --- Đợi sẵn sàng ---
echo ""
echo "Đang đợi service sẵn sàng..."
READY=0
for _ in $(seq 1 60); do
    if curl -fsS -m 1 -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then
        READY=1
        break
    fi
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
        break
    fi
    sleep 1
done

echo ""
echo "==========================================="
if [ "$READY" = "1" ]; then
    echo -e "  gateway-rs: ${GREEN}RUNNING${NC} (port $PORT)"
    echo ""
    if [ -n "${JAKE_TLS_CERT:-}" ]; then
        echo -e "  Truy cập: ${GREEN}https://<host>:$PORT${NC}"
    else
        echo -e "  Truy cập: ${GREEN}http://<host>:$PORT${NC}"
        echo -e "  ${YELLOW}Chưa bật TLS — đặt JAKE_TLS_CERT/JAKE_TLS_KEY trong .env${NC}"
    fi
    echo "  Log:      $LOG_DIR/gateway.log"
else
    echo -e "  gateway-rs: ${RED}FAILED${NC}"
    echo -e "  ${RED}-> Xem log: $LOG_DIR/gateway.log${NC}"
    echo ""
    tail -n 15 "$LOG_DIR/gateway.log" 2>/dev/null || true
fi
echo "==========================================="
echo ""
