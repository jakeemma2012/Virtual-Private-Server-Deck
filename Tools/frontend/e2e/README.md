# Test chức năng bằng trình duyệt thật

Chạy Chromium thật qua Playwright. Bắt được loại lỗi mà kiểm HTTP status không
thấy: trang lỗi của Next vẫn trả **200 OK**, và WebGL renderer vẽ terminal vào
canvas nên DOM không có text để kiểm.

## Chuẩn bị

```bash
npm i -D playwright && npx playwright install chromium
```

## Chạy

```bash
# Gateway phải đang chạy và đã trỏ JAKE_STATIC_DIR vào out/
BASE=http://127.0.0.1:8099 PW='<mật khẩu admin>' node e2e/test.mjs
BASE=http://127.0.0.1:8099 PW='<mật khẩu admin>' SID='<id server test>' node e2e/func.mjs
```

| File | Kiểm gì |
|---|---|
| `test.mjs` | Mọi trang có load được không (bắt error boundary của Next), đăng nhập, token |
| `func.mjs` | Điều hướng thư mục, virtualize, sắp xếp, tìm kiếm, terminal tiếng Việt, font, WebGL |
| `upload.mjs` | Kéo-thả: overlay có nháy không, thả ngoài vùng danh sách, kéo nhiều file cùng lúc |
| `pin.mjs` | Ghim thư mục: lưu ở server, vào lại VPS mở đúng chỗ ghim, không rò sang VPS khác |
| `split.mjs` | Hai cột: duyệt local, sắp xếp, Tải lên, KÉO phải→trái, đường dự phòng cho Brave, và split độc lập theo từng tab |
| `probe3.mjs` | Dump chuỗi layout từ `<table>` lên `<body>` — dùng khi nghi ngờ lỗi chiều cao/cuộn |

`upload.mjs` và `split.mjs` cần thư mục trống trên VPS (`/tmp/jake-upload-test`,
`/tmp/jake-split-test`), tạo trước bằng `POST /api/servers/<id>/execute`.

`split.mjs` **giả lập** `window.showDirectoryPicker`: headless Chromium không
phát sự kiện filechooser cho API này. Hộp thoại chọn thư mục là code của trình
duyệt; phần được test là code của mình — liệt kê, sắp xếp, chọn, đọc File, kéo,
upload. Bước [6] còn **xoá hẳn** API đó để mô phỏng Brave và kiểm đường dự
phòng `<input webkitdirectory>`.

Ảnh chụp màn hình lưu ở `/tmp/jake-e2e`.

## Những lỗi bộ test này đã tìm ra

1. `redirect()` trong static export → `out/index.html` bị nướng sẵn trang lỗi, vẫn trả 200.
2. `/api/system/stats` thiếu field so với interface TS → `undefined.toFixed()` làm cả trang Overview chết.
3. `h-[calc(100vh-4rem)]` là CSS KHÔNG hợp lệ (trong `calc()` dấu `-` phải có khoảng trắng hai bên). Tailwind cần `h-[calc(100vh_-_4rem)]`.
4. `flex-1` ghi đè `height` khi container cha không bị chặn chiều cao → không có phần tử nào cuộn → virtualizer render HẾT 4.972 dòng.
5. `resolveMonoFont` đọc biến CSS ở `documentElement` trong khi `next/font` gắn biến vào `<body>` → terminal âm thầm dùng font mặc định.
6. `dragleave` bắn mỗi lần con trỏ rời một `<tr>` con → overlay kéo-thả bật/tắt liên tục ("nháy nháy").
7. `startXhr` cấp id mới cho dòng upload đã xếp hàng → React key đổi → dòng unmount/mount lại → bảng upload nhấp nháy khi kéo nhiều file.
8. Không có handler `dragover`/`drop` ở tầng window → thả file ngoài vùng danh sách làm trình duyệt ĐIỀU HƯỚNG tới file, mất trang đang làm việc.
9. Kiểm trùng tên dùng state `files` (chỉ 1000/4972 đã nạp) → file trùng ngoài trang đầu bị ghi đè im lặng.
10. Brave tắt sẵn File System Access API → panel local vô dụng; phải có đường dự phòng `<input webkitdirectory>`.
11. Điều kiện render cột phải đặt theo TAB ĐANG XEM → chuyển sang tab chưa mở split làm unmount cả cột, xoá sạch thư mục đang đứng của các tab khác.
