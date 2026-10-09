#!/usr/bin/env bash
# Chuyển dữ liệu từ H2 (bản Java) sang SQLite (bản Rust).
#
# Chạy MỘT LẦN. Mật khẩu SSH đi vào SQLite ở dạng plaintext, rồi lần khởi động
# đầu tiên gateway-rs sẽ tự mã hoá lại (xem db::reseal_legacy_secrets). File CSV
# trung gian chứa mật khẩu nên được tạo với quyền 600 và xoá ngay sau đó.
#
#   ./migrate-from-h2.sh [đường-dẫn-h2-không-đuôi] [đường-dẫn-sqlite]
#
# Mặc định: ../gateway-api/data/vpsmanager  ->  ./data/jake.db

set -euo pipefail

# File DB sẽ chứa mật khẩu root dạng rõ cho tới khi gateway boot lần đầu và mã
# hoá lại. Không có umask này, sqlite3 tạo jake.db / -wal / -shm ở mode 644 và
# mọi user cục bộ đọc được.
umask 077

H2_BASE="${1:-$(cd "$(dirname "$0")" && pwd)/../gateway-api/data/vpsmanager}"
SQLITE_DB="${2:-$(cd "$(dirname "$0")" && pwd)/data/jake.db}"
JAR="${JAR:-$(cd "$(dirname "$0")" && pwd)/../gateway-api/target/gateway-api-1.0.0-SNAPSHOT.jar}"

command -v java >/dev/null  || { echo "cần java để đọc file H2 (chỉ lần migrate này)"; exit 1; }
command -v sqlite3 >/dev/null || { echo "cần sqlite3"; exit 1; }
[ -f "${H2_BASE}.mv.db" ] || { echo "không thấy ${H2_BASE}.mv.db"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

# H2 driver nằm trong fat jar của bản Java; không cần cài gì thêm.
if [ -f "$JAR" ]; then
    unzip -o -q "$JAR" 'BOOT-INF/lib/h2-*.jar' -d "$TMP"
    H2_JAR="$(find "$TMP" -name 'h2-*.jar' | head -1)"
else
    H2_JAR="$(find ~/.m2 "$HOME/.cargo" / -maxdepth 6 -name 'h2-2*.jar' 2>/dev/null | head -1)"
fi
[ -n "${H2_JAR:-}" ] || { echo "không tìm thấy h2 jar (đặt JAR=... trỏ tới fat jar bản Java)"; exit 1; }

echo "==> xuất CSV từ H2"
# Bản sao để không chạm vào file gốc, và để H2 không đòi khoá ghi.
cp "${H2_BASE}.mv.db" "$TMP/src.mv.db"
# Chỉ chọn cột thuần, không dùng biểu thức: CSVWRITE lấy tên cột từ chính
# biểu thức, nên IFNULL(...) sẽ ra tên "?" và phần .import bên dưới hỏng.
# NULL được xử lý bằng COALESCE ở phía SQLite. Câu SELECT lồng phải nằm trên
# MỘT dòng: H2 Shell cắt theo dòng nên query nhiều dòng sẽ bị hiểu sai.
java -cp "$H2_JAR" org.h2.tools.Shell \
     -url "jdbc:h2:file:$TMP/src" -user sa -password "" -sql "
CALL CSVWRITE('$TMP/servers.csv', 'SELECT ID, NAME, HOSTNAME, IP, PORT, OS, STATUS, LOCATION, PROVIDER, TAGS, SSH_USERNAME, SSH_PASSWORD, SSH_PRIVATE_KEY FROM VPS_SERVERS');
" >/dev/null
chmod 600 "$TMP/servers.csv"

# Chống chạy lại. `INSERT OR REPLACE` sẽ ghi đè các bản ghi ĐÃ mã hoá bằng
# plaintext cũ từ H2 và đặt lại created_at — chạy lại sau khi đã sửa mật khẩu
# trong app là mất thay đổi, im lặng.
if [ -f "$SQLITE_DB" ]; then
    SO_SERVER=$(sqlite3 "$SQLITE_DB" \
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vps_servers';" 2>/dev/null || echo 0)
    if [ "$SO_SERVER" != "0" ]; then
        DANG_CO=$(sqlite3 "$SQLITE_DB" 'SELECT COUNT(*) FROM vps_servers;' 2>/dev/null || echo 0)
        if [ "$DANG_CO" != "0" ]; then
            echo "$SQLITE_DB đã có $DANG_CO server." >&2
            echo "Script này chỉ chạy MỘT LẦN. Chạy lại sẽ ghi đè dữ liệu hiện tại" >&2
            echo "bằng bản cũ từ H2. Muốn làm lại thì xoá/đổi tên file DB trước." >&2
            exit 1
        fi
    fi
fi

echo "==> nạp vào SQLite: $SQLITE_DB"
mkdir -p "$(dirname "$SQLITE_DB")"
# Tạo schema nếu DB còn trống (gateway-rs cũng tự tạo, nhưng cần sẵn để INSERT).
sqlite3 "$SQLITE_DB" < "$(dirname "$0")/migrations/001_init.sql"

# Tạo bảng tạm TRƯỚC khi import. Nếu để sqlite3 tự tạo thì `--skip 1` làm nó
# lấy dòng dữ liệu đầu tiên làm tên cột, và toàn bộ INSERT bên dưới hỏng.
sqlite3 "$SQLITE_DB" <<SQL
DROP TABLE IF EXISTS h2_import;
CREATE TABLE h2_import (
  ID TEXT, NAME TEXT, HOSTNAME TEXT, IP TEXT, PORT TEXT, OS TEXT, STATUS TEXT,
  LOCATION TEXT, PROVIDER TEXT, TAGS TEXT, SSH_USERNAME TEXT,
  SSH_PASSWORD TEXT, SSH_PRIVATE_KEY TEXT
);
.mode csv
.import --skip 1 '$TMP/servers.csv' h2_import
INSERT OR REPLACE INTO vps_servers
  (id, name, hostname, ip, port, os, status, location, provider, tags,
   ssh_username, ssh_password, ssh_private_key, created_at, updated_at)
SELECT ID, NAME, COALESCE(HOSTNAME,''), IP, CAST(PORT AS INTEGER),
       COALESCE(OS,''), COALESCE(NULLIF(STATUS,''),'OFFLINE'),
       COALESCE(LOCATION,''), COALESCE(PROVIDER,''), COALESCE(TAGS,''),
       COALESCE(NULLIF(SSH_USERNAME,''),'root'),
       NULLIF(SSH_PASSWORD,''), NULLIF(SSH_PRIVATE_KEY,''),
       strftime('%s','now'), strftime('%s','now')
FROM h2_import;
DROP TABLE h2_import;
SQL

# secure_delete + VACUUM: SQLite mặc định không xoá sạch trang đã giải phóng,
# nên byte plaintext của bảng h2_import vừa DROP có thể còn nằm trong file.
sqlite3 "$SQLITE_DB" 'PRAGMA secure_delete=ON; VACUUM;'
chmod 600 "$SQLITE_DB"

COUNT=$(sqlite3 "$SQLITE_DB" 'SELECT COUNT(*) FROM vps_servers;')
echo "==> xong: $COUNT server trong $SQLITE_DB"
echo
echo "Bước tiếp: chạy gateway-rs một lần để nó mã hoá lại mật khẩu SSH."
echo "Tài khoản đăng nhập KHÔNG được chuyển (hash bcrypt cũ không dùng lại);"
echo "đặt lại bằng JAKE_ADMIN_USER / JAKE_ADMIN_PASSWORD."
