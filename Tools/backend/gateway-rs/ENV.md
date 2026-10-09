# Biến môi trường của gateway-rs

Binary đọc cấu hình **chỉ** từ biến môi trường. Không có secret nào nằm trong
code hay trong file cấu hình được commit — khác bản Java, nơi `jwt.secret` và
mật khẩu admin nằm thẳng trong `application.yml`.

## Bắt buộc

| Biến | Cách sinh | Ghi chú |
|---|---|---|
| `JAKE_SECRET_KEY` | `openssl rand -base64 32` | Khoá AES-256-GCM mã hoá mật khẩu SSH trong DB. Phải đúng 32 byte sau khi decode. **Backup cùng file DB** — mất khoá là mất toàn bộ mật khẩu SSH đã lưu. |
| `JAKE_JWT_SECRET` | `openssl rand -base64 48` | Khoá ký JWT. Đổi khoá = mọi người đang đăng nhập bị đăng xuất. Tối thiểu 32 ký tự. |

Thiếu một trong hai, binary từ chối khởi động kèm hướng dẫn sinh khoá — cố ý,
để không bao giờ chạy production với khoá mặc định.

## Tuỳ chọn

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `JAKE_BIND` | `0.0.0.0:8080` | Địa chỉ lắng nghe. |
| `JAKE_DB` | `./data/jake.db` | File SQLite. Thư mục được tạo tự động. |
| `JAKE_JWT_TTL_SECS` | `86400` | Hạn token, giây. |
| `JAKE_STATIC_DIR` | *(không)* | Thư mục frontend đã build. Có giá trị này thì binary serve luôn frontend — bỏ được nginx và node ở production. |
| `JAKE_TLS_CERT` / `JAKE_TLS_KEY` | *(không)* | Đường dẫn PEM. Có cả hai thì chạy HTTPS, thiếu thì chạy HTTP kèm cảnh báo. |
| `JAKE_ADMIN_USER` / `JAKE_ADMIN_PASSWORD` | *(không)* | Đặt/đổi mật khẩu tài khoản admin ở mỗi lần khởi động. Dùng cho lần chạy đầu và cho lúc quên mật khẩu. Bỏ ra sau khi đã đăng nhập được. |
| `JAKE_MAX_INDEX_ENTRIES` | `2000000` | Chặn trên số entry mỗi lần index một thư mục. |
| `RUST_LOG` | `info,russh=warn,sqlx=warn` | Mức log. |

## Tạo file .env lần đầu

```bash
cd Tools/backend/gateway-rs
umask 077
{
  echo "JAKE_SECRET_KEY=$(openssl rand -base64 32)"
  echo "JAKE_JWT_SECRET=$(openssl rand -base64 48)"
  echo "JAKE_BIND=0.0.0.0:8080"
  echo "JAKE_DB=./data/jake.db"
  echo "JAKE_STATIC_DIR=../../frontend/out"
  echo "JAKE_ADMIN_USER=admin"
  echo "JAKE_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
} > .env
grep JAKE_ADMIN_PASSWORD .env   # mật khẩu đăng nhập, lưu vào password manager
```

`.env` đã nằm trong `.gitignore`. Nạp nó khi chạy:

```bash
set -a && . ./.env && set +a && ./target/release/gateway-rs
```

## Chuyển dữ liệu từ bản Java

```bash
./migrate-from-h2.sh        # H2 -> SQLite
```

Mật khẩu SSH vào SQLite ở dạng plaintext, rồi **lần khởi động đầu tiên** gateway
tự mã hoá lại bằng `JAKE_SECRET_KEY` (log sẽ ghi `đã mã hoá lại secret của N
server`). Tài khoản đăng nhập không chuyển được vì hash bcrypt cũ không dùng
lại; đặt mới bằng `JAKE_ADMIN_USER` / `JAKE_ADMIN_PASSWORD`.
