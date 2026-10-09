-- VPSDeck — schema gốc (SQLite), thay cho H2 của bản Java.
-- Mật khẩu/khoá SSH được mã hoá AES-256-GCM trước khi ghi (xem crypto.rs),
-- nên cột vẫn là TEXT nhưng nội dung là "v1:<base64>".

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'ADMIN',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vps_servers (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    hostname        TEXT NOT NULL DEFAULT '',
    ip              TEXT NOT NULL,
    port            INTEGER NOT NULL DEFAULT 22,
    os              TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'OFFLINE',
    location        TEXT NOT NULL DEFAULT '',
    provider        TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '',
    ssh_username    TEXT NOT NULL DEFAULT 'root',
    ssh_password    TEXT,
    ssh_private_key TEXT,
    -- Thư mục được ghim. Có giá trị thì File Manager mở thẳng vào đây thay vì
    -- /root. NULL = chưa ghim.
    pinned_path     TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
    id         TEXT PRIMARY KEY,
    server_id  TEXT,
    level      TEXT NOT NULL,
    message    TEXT NOT NULL,
    acked      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

-- ---------------------------------------------------------------------------
-- Index file: nguồn dữ liệu cho search đệ quy mà KHÔNG phải đọc lại SFTP.
-- Một hàng = một file/thư mục đã quét được trên VPS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS file_index (
    server_id TEXT NOT NULL,
    root      TEXT NOT NULL,   -- thư mục gốc của lần quét (để biết subtree nào đã index)
    path      TEXT NOT NULL,   -- đường dẫn tuyệt đối
    name      TEXT NOT NULL,   -- tên file, đã lowercase để search không phân biệt hoa thường
    parent    TEXT NOT NULL,
    kind      TEXT NOT NULL,   -- 'd' | 'f' | 'l'
    size      INTEGER NOT NULL DEFAULT 0,
    mtime     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, root, path)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_file_index_name   ON file_index(server_id, root, name);
CREATE INDEX IF NOT EXISTS idx_file_index_parent ON file_index(server_id, parent);

-- Trạng thái của từng lần quét, để frontend biết index xong chưa.
CREATE TABLE IF NOT EXISTS index_runs (
    server_id   TEXT NOT NULL,
    root        TEXT NOT NULL,
    state       TEXT NOT NULL,   -- 'running' | 'done' | 'failed'
    entries     INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    PRIMARY KEY (server_id, root)
) WITHOUT ROWID;
