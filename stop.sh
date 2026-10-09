#!/usr/bin/env bash
#==============================================================================
# VPSDeck - Dừng service
#
# Sau đợt viết lại chỉ còn một tiến trình (gateway-rs). Script vẫn dừng cả các
# tiến trình của bản cũ (Next.js, Spring Boot, VPS Agent) để lần chuyển đổi
# không để lại process mồ côi giữ cổng.
#==============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "==========================================="
echo "  Dừng VPSDeck services..."
echo "==========================================="
echo ""

# $1 = nhãn hiển thị, $2 = pattern cho pkill
dung() {
    local nhan="$1" pattern="$2"
    if pgrep -f "$pattern" > /dev/null 2>&1; then
        pkill -TERM -f "$pattern" 2>/dev/null || true
        # Đợi tối đa 10s để nó tự đóng kết nối SSH đang mở.
        for _ in $(seq 1 10); do
            pgrep -f "$pattern" > /dev/null 2>&1 || break
            sleep 1
        done
        if pgrep -f "$pattern" > /dev/null 2>&1; then
            pkill -KILL -f "$pattern" 2>/dev/null || true
            echo -e "  $nhan ${GREEN}STOPPED${NC} (phải dùng SIGKILL)"
        else
            echo -e "  $nhan ${GREEN}STOPPED${NC}"
        fi
    else
        echo -e "  $nhan ${RED}NOT RUNNING${NC}"
    fi
}

dung "gateway-rs:  " "gateway-rs"

# --- Tiến trình của bản cũ, nếu còn sót ---
dung "Next.js (cũ):" "next start"
dung "Spring (cũ): " "gateway-api-1.0.0-SNAPSHOT.jar"
dung "Agent (cũ):  " "io.vpsmanager.agent.Application"

echo ""
echo "==========================================="
echo "  Xong."
echo "==========================================="
