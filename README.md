# VPSDeck

Bảng điều khiển web để quản lý nhiều VPS qua SSH: duyệt file, terminal, theo
dõi tài nguyên. Toàn bộ phía server là **một binary Rust duy nhất** — tự phục
vụ TLS, giao diện web, REST API và WebSocket terminal.

```
Trình duyệt ──HTTPS/WSS──> gateway-rs ──SSH/SFTP──> VPS 1..N
                           (1 tiến trình)
```

Không cần nginx, không cần Node.js chạy nền, không cần cài agent lên VPS được
quản lý — chỉ cần chúng mở SSH.

---

## Vì sao có dự án này

Bản đầu viết bằng Spring Boot + Next.js chạy sau nginx, và dùng thực tế thì lộ
ra bốn vấn đề. Chúng đều đã được sửa tận gốc, không phải vá triệu chứng:

| Triệu chứng | Nguyên nhân thật | Cách xử lý |
|---|---|---|
| Terminal hỏng chữ tiếng Việt | Decode từng chunk 8KB, ký tự 3 byte bị cắt ngang biên | Gửi **binary frame**, để `xterm.js` tự ghép bằng bộ decode UTF-8 có trạng thái |
| `tar`/`zip` làm đứt terminal | Bộ đệm WebSocket có trần, vượt là **đóng session** | Backpressure thật: `.await` trên `send`, cửa sổ SSH nhỏ — tiến trình trên VPS tự chậm lại |
| Thư mục chục nghìn file làm treo trang | Trả cả thư mục, sort ở client, render mọi dòng ra DOM | Phân trang + sắp xếp ở server, virtual scrolling, index SQLite cho tìm kiếm đệ quy |
| Sắp xếp theo ngày sai | `mtime` là **chuỗi** đã format, so sánh chuỗi trên ngày tháng | `mtime` là epoch số; tên file so theo thứ tự tự nhiên (`file2` trước `file10`) |

Một số đo đáng chú ý trên VPS thật (Ubuntu 22.04, 4.971 entry): liệt kê thư mục
bằng `find -printf` mất **138ms**, bằng SFTP `read_dir` mất **1,47s** — nhanh
hơn 10,6 lần, nên tầng liệt kê dùng `find`, còn SFTP chỉ lo nội dung file.

---

## Tính năng

**File manager**
- Phân trang phía server, mặc định 1.000 dòng mỗi trang, cuộn tới đâu nạp tới đó
- Virtual scrolling: thư mục 4.972 file chỉ dựng ~33 `<tr>` trong DOM
- Sắp xếp ở server: thư mục trước, tên theo thứ tự tự nhiên, ngày theo epoch
- Tìm trong thư mục hiện tại, và **tìm đệ quy cả cây con** qua index SQLite;
  chưa có index thì tự chạy `find` để vẫn ra kết quả ngay
- Tải lên bằng kéo-thả (cả trang là vùng thả), tải xuống theo luồng tới 10GB
- Sửa file bằng Monaco, xem trước ảnh/video, nén, đổi quyền
- **Ghim thư mục** theo từng VPS: vào máy đó là mở thẳng chỗ đã ghim
- **Panel hai cột** kiểu FileZilla: duyệt thư mục trên máy bạn ở bên phải, kéo
  sang trái để tải lên. Mỗi tab có panel và thư mục riêng.

**Terminal**
- `xterm.js` với WebGL renderer, `unicode11`, và khôi phục màn hình khi reconnect
- Gõ và hiển thị tiếng Việt đúng; reconnect có backoff tăng dần
- Nhiều tab, mỗi tab một phiên SSH riêng

**Vận hành**
- Mật khẩu SSH mã hoá AES-256-GCM, khoá nằm ở biến môi trường (không ở trong DB)
- Đăng nhập Argon2id + JWT; WebSocket cũng bắt buộc có token
- Theo dõi CPU/RAM/disk của từng VPS và của chính máy chạy panel

---

## Yêu cầu

| | Phiên bản | Dùng cho |
|---|---|---|
| Rust | 1.90+ | Build gateway |
| Node.js | 20+ | Build giao diện (chỉ lúc build, không cần ở production) |
| VPS được quản lý | SSH + GNU coreutils | Không cần cài gì thêm lên chúng |

---

## Chạy thử

```bash
# 1. Build giao diện thành file tĩnh
cd Tools/frontend
npm install
npm run build            # ra thư mục out/

# 2. Cấu hình gateway
cd ../backend/gateway-rs
umask 077
{
  echo "JAKE_SECRET_KEY=$(openssl rand -base64 32)"
  echo "JAKE_JWT_SECRET=$(openssl rand -base64 48)"
  echo "JAKE_BIND=127.0.0.1:8080"
  echo "JAKE_DB=./data/jake.db"
  echo "JAKE_STATIC_DIR=../../frontend/out"
  echo "JAKE_ADMIN_USER=admin"
  echo "JAKE_ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
} > .env
grep JAKE_ADMIN_PASSWORD .env    # lưu mật khẩu này lại

# 3. Chạy
cargo build --release
set -a && . ./.env && set +a
./target/release/gateway-rs
```

Mở `http://127.0.0.1:8080`, đăng nhập, thêm VPS đầu tiên.

Danh sách đầy đủ biến môi trường: [`Tools/backend/gateway-rs/ENV.md`](Tools/backend/gateway-rs/ENV.md).

### Bật HTTPS

```bash
JAKE_TLS_CERT=/đường/dẫn/fullchain.pem
JAKE_TLS_KEY=/đường/dẫn/privkey.pem
```

Nên bật, vì hai lý do ngoài chuyện mã hoá đường truyền: token đi qua WebSocket,
và panel hai cột cần secure context mới mở được thư mục trên máy người dùng.

---

## Cấu trúc

```
Tools/
├── backend/gateway-rs/        Gateway Rust — toàn bộ phía server
│   ├── src/
│   │   ├── main.rs            Bootstrap, router, TLS, phục vụ file tĩnh
│   │   ├── config.rs          Cấu hình từ biến môi trường
│   │   ├── crypto.rs          AES-256-GCM cho mật khẩu SSH
│   │   ├── auth.rs            Argon2id + JWT, middleware
│   │   ├── db.rs              SQLite, model, migration cột
│   │   ├── ssh.rs             Pool kết nối russh, exec, SFTP
│   │   ├── terminal.rs        WebSocket terminal
│   │   ├── files.rs           Liệt kê, phân trang, index, tìm kiếm
│   │   └── routes.rs          REST handler
│   ├── migrations/            Schema SQLite
│   └── migrate-from-h2.sh     Chuyển dữ liệu từ bản Java cũ
│
└── frontend/                  Next.js 16, build ra file tĩnh
    ├── src/lib/
    │   ├── terminal-core.ts   xterm + addon + giao thức WebSocket
    │   ├── local-fs.ts        Duyệt file trên máy người dùng
    │   └── api.ts             Client REST
    ├── src/app/dashboard/     Các trang
    └── e2e/                   Test chạy trình duyệt thật
```

---

## Test

```bash
# Backend
cd Tools/backend/gateway-rs
cargo test
cargo clippy -- -D warnings

# Giao diện, chạy Chromium thật
cd Tools/frontend
npm i -D playwright && npx playwright install chromium
BASE=http://127.0.0.1:8080 PW='<mật khẩu admin>' node e2e/test.mjs
```

Bộ test trình duyệt tồn tại vì typecheck và HTTP status **không đủ**: trang lỗi
của Next.js vẫn trả 200 OK, và WebGL vẽ terminal vào canvas nên DOM không có
text để kiểm. Chi tiết và danh sách lỗi mà nó đã bắt được: [`Tools/frontend/e2e/README.md`](Tools/frontend/e2e/README.md).

---

## Bảo mật

Những gì dự án làm:

- Mật khẩu SSH mã hoá AES-256-GCM; khoá ở biến môi trường, **không** nằm trong
  file DB. Có file DB mà không có khoá thì không giải mã được.
- API không bao giờ trả mật khẩu hay khoá riêng ra client, chỉ trả cờ có/không.
- Mọi đường dẫn do người dùng nhập đều được bọc trước khi vào lệnh shell.
- `rm -rf` bị chặn ở 18 thư mục hệ thống.
- WebSocket bắt buộc có token, kiểm trước khi upgrade.
- Gateway từ chối khởi động nếu thiếu khoá — không có khoá mặc định.

Những gì **chưa** có, cần biết trước khi mở ra Internet:

- Không giới hạn số lần đăng nhập sai. Hãy đặt mật khẩu mạnh và/hoặc để panel
  sau VPN, hoặc thêm rate limit ở reverse proxy.
- Token chưa thu hồi được trước hạn; đổi mật khẩu không làm token cũ hết hiệu
  lực. Muốn kick ngay thì đổi `JAKE_JWT_SECRET` rồi khởi động lại.
- Host key của SSH không được ghim (tương đương `StrictHostKeyChecking=no`).

**Backup `JAKE_SECRET_KEY` cùng với file DB.** Mất khoá là mất toàn bộ mật khẩu
SSH đã lưu, không có đường khôi phục.

---

## Chuyển từ bản Java cũ

```bash
cd Tools/backend/gateway-rs
./migrate-from-h2.sh        # H2 -> SQLite
```

Script chỉ chạy một lần và từ chối chạy lại khi DB đích đã có dữ liệu. Mật khẩu
SSH vào SQLite ở dạng rõ, rồi **lần khởi động đầu tiên** gateway tự mã hoá lại.
Tài khoản đăng nhập không chuyển được (hash bcrypt cũ không tái sử dụng); đặt
lại bằng `JAKE_ADMIN_USER` / `JAKE_ADMIN_PASSWORD`.

---

## Review code

Dự án có bộ luật riêng cho [Open Code Review](https://github.com/alibaba/open-code-review)
ở `.opencodereview/`, ghi lại những bẫy đã thực sự gặp — UTF-8 cắt ngang biên
chunk, `calc()` thiếu khoảng trắng, `flex-1` đè `height`, deadlock khi block
`async` chỉ mượn receiver của mpsc, và nhiều thứ khác.

```bash
npm i -g @alibaba-group/open-code-review
ocr delegate preview
```

---

## Giấy phép

MIT — xem [LICENSE](LICENSE).
