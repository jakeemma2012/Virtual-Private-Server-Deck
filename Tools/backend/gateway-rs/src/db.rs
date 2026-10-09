//! Kết nối SQLite + model. Thay cho H2 file DB của bản Java.
//!
//! Lưu ý bảo mật quan trọng: `ServerDto` (cái trả ra API) KHÔNG chứa
//! `ssh_password`/`ssh_private_key`. Bản Java trả thẳng entity JPA ra
//! `GET /api/servers`, nghĩa là mật khẩu root của 11 VPS nằm trong response
//! JSON cho bất kỳ ai đăng nhập được.

use crate::crypto::Secrets;
use crate::error::{AppError, AppResult};
use anyhow::Context;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;

pub async fn init(path: &str) -> anyhow::Result<SqlitePool> {
    if let Some(dir) = std::path::Path::new(path)
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
    {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("không tạo được thư mục DB {}", dir.display()))?;
    }

    let opts = SqliteConnectOptions::from_str(path)?
        .create_if_missing(true)
        // WAL: đọc không chặn ghi — cần vì quá trình index file ghi liên tục
        // trong khi frontend vẫn đang query danh sách.
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal)
        .busy_timeout(std::time::Duration::from_secs(10))
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .with_context(|| format!("không mở được SQLite tại {path}"))?;

    // Schema toàn bộ là CREATE ... IF NOT EXISTS nên chạy lại vô hại.
    //
    // HỢP ĐỒNG với 001_init.sql: tách câu bằng `split(';')` nên file schema
    // KHÔNG được chứa `;` bên trong chuỗi, bên trong comment, hay trong body
    // TRIGGER/BEGIN...END. Vi phạm là câu lệnh bị cắt sai và lỗi rất khó truy.
    // Thêm trigger hoặc muốn có `;` trong chuỗi thì phải thay bằng parser thật.
    for stmt in include_str!("../migrations/001_init.sql")
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty() && !s.lines().all(|l| l.trim_start().starts_with("--")))
    {
        sqlx::query(stmt)
            .execute(&pool)
            .await
            // Cắt theo KÝ TỰ. `&stmt[..80]` cắt theo byte và panic nếu byte thứ
            // 80 rơi giữa một ký tự tiếng Việt trong comment.
            .with_context(|| {
                let head: String = stmt.chars().take(80).collect();
                format!("migration lỗi ở câu lệnh: {head}")
            })?;
    }

    // Cột thêm sau này.
    //
    // File schema ở trên toàn `CREATE ... IF NOT EXISTS` nên chạy lại vô hại,
    // nhưng `ALTER TABLE ADD COLUMN` thì KHÔNG idempotent — lần khởi động thứ
    // hai sẽ lỗi "duplicate column". Vì vậy phải hỏi PRAGMA trước khi thêm.
    ensure_column(&pool, "vps_servers", "pinned_path", "TEXT").await?;

    Ok(pool)
}

/// Thêm cột nếu bảng chưa có. An toàn khi gọi lại nhiều lần.
async fn ensure_column(
    pool: &SqlitePool,
    table: &'static str,
    column: &'static str,
    decl: &'static str,
) -> anyhow::Result<()> {
    // AssertSqlSafe: `table`/`column`/`decl` đều là &'static str do chính code
    // này truyền vào, không phải dữ liệu người dùng. PRAGMA và ALTER TABLE
    // không nhận tham số bind nên buộc phải nội suy tên.
    let rows = sqlx::query(sqlx::AssertSqlSafe(format!(
        "PRAGMA table_info({table})"
    )))
        .fetch_all(pool)
        .await
        .with_context(|| format!("không đọc được cấu trúc bảng {table}"))?;
    let has = rows
        .iter()
        .any(|r| r.get::<String, _>("name").eq_ignore_ascii_case(column));
    if has {
        return Ok(());
    }
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "ALTER TABLE {table} ADD COLUMN {column} {decl}"
    )))
        .execute(pool)
        .await
        .with_context(|| format!("không thêm được cột {table}.{column}"))?;
    tracing::info!("đã thêm cột {table}.{column}");
    Ok(())
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

pub struct User {
    pub username: String,
    pub password_hash: String,
    pub role: String,
}

pub async fn find_user(pool: &SqlitePool, username: &str) -> AppResult<Option<User>> {
    let row = sqlx::query("SELECT username, password_hash, role FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| User {
        username: r.get("username"),
        password_hash: r.get("password_hash"),
        role: r.get("role"),
    }))
}

pub async fn count_users(pool: &SqlitePool) -> AppResult<i64> {
    Ok(sqlx::query("SELECT COUNT(*) AS n FROM users")
        .fetch_one(pool)
        .await?
        .get::<i64, _>("n"))
}

pub async fn upsert_user(
    pool: &SqlitePool,
    username: &str,
    password_hash: &str,
    role: &str,
) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash,
                                             role = excluded.role",
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(username)
    .bind(password_hash)
    .bind(role)
    .bind(now())
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// VPS server
// ---------------------------------------------------------------------------

/// Bản ghi đầy đủ, chỉ dùng trong nội bộ server (để mở SSH). Không serialize.
#[derive(Clone)]
pub struct VpsServer {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub os: String,
    pub status: String,
    pub location: String,
    pub provider: String,
    pub tags: String,
    pub ssh_username: String,
    /// Đã giải mã, chỉ tồn tại trong RAM.
    pub ssh_password: Option<String>,
    pub ssh_private_key: Option<String>,
    /// Thư mục được ghim; File Manager mở thẳng vào đây thay vì /root.
    pub pinned_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Cái trả ra cho frontend. Không có secret.
/// camelCase để khớp đúng kiểu TypeScript mà frontend đang dùng.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerDto {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub ip: String,
    pub port: u16,
    pub os: String,
    pub status: String,
    pub location: String,
    pub provider: String,
    pub tags: String,
    pub ssh_username: String,
    pub has_password: bool,
    pub has_private_key: bool,
    pub pinned_path: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl VpsServer {
    pub fn to_dto(&self) -> ServerDto {
        ServerDto {
            id: self.id.clone(),
            name: self.name.clone(),
            hostname: self.hostname.clone(),
            ip: self.ip.clone(),
            port: self.port,
            os: self.os.clone(),
            status: self.status.clone(),
            location: self.location.clone(),
            provider: self.provider.clone(),
            tags: self.tags.clone(),
            ssh_username: self.ssh_username.clone(),
            has_password: self.ssh_password.is_some(),
            has_private_key: self.ssh_private_key.is_some(),
            pinned_path: self.pinned_path.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInput {
    pub name: String,
    #[serde(default)]
    pub hostname: String,
    pub ip: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub os: String,
    #[serde(default)]
    pub location: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub tags: String,
    #[serde(default = "default_user")]
    pub ssh_username: String,
    /// `null` hoặc không gửi field = GIỮ mật khẩu cũ.
    /// Gửi chuỗi rỗng `""` = XOÁ mật khẩu (server sẽ không SSH được nữa).
    #[serde(default)]
    pub ssh_password: Option<String>,
    #[serde(default)]
    pub ssh_private_key: Option<String>,
}

fn default_port() -> u16 {
    22
}
fn default_user() -> String {
    "root".to_string()
}

fn row_to_server(r: &sqlx::sqlite::SqliteRow, secrets: &Secrets) -> AppResult<VpsServer> {
    let stored_pw: Option<String> = r.get("ssh_password");
    let stored_key: Option<String> = r.get("ssh_private_key");
    Ok(VpsServer {
        id: r.get("id"),
        name: r.get("name"),
        hostname: r.get("hostname"),
        ip: r.get("ip"),
        port: r.get::<i64, _>("port") as u16,
        os: r.get("os"),
        status: r.get("status"),
        location: r.get("location"),
        provider: r.get("provider"),
        tags: r.get("tags"),
        ssh_username: r.get("ssh_username"),
        ssh_password: secrets.open(stored_pw.as_deref()).map_err(AppError::Other)?,
        ssh_private_key: secrets.open(stored_key.as_deref()).map_err(AppError::Other)?,
        pinned_path: r.get("pinned_path"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    })
}

// Macro thay vì const &str: sqlx 0.9 chỉ nhận string literal (chặn SQL injection
// qua chuỗi dựng động), nên danh sách cột phải nối ở compile time bằng concat!.
macro_rules! server_cols {
    () => {
        "id, name, hostname, ip, port, os, status, location, provider, tags, \
         ssh_username, ssh_password, ssh_private_key, pinned_path, created_at, updated_at"
    };
}

pub async fn list_servers(pool: &SqlitePool, secrets: &Secrets) -> AppResult<Vec<VpsServer>> {
    let rows = sqlx::query(concat!(
        "SELECT ",
        server_cols!(),
        " FROM vps_servers ORDER BY name COLLATE NOCASE"
    ))
    .fetch_all(pool)
    .await?;
    rows.iter().map(|r| row_to_server(r, secrets)).collect()
}

pub async fn get_server(pool: &SqlitePool, id: &str, secrets: &Secrets) -> AppResult<VpsServer> {
    let row = sqlx::query(concat!(
        "SELECT ",
        server_cols!(),
        " FROM vps_servers WHERE id = ?"
    ))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("server {id}")))?;
    row_to_server(&row, secrets)
}

pub async fn insert_server(
    pool: &SqlitePool,
    input: &ServerInput,
    secrets: &Secrets,
) -> AppResult<VpsServer> {
    let id = uuid::Uuid::new_v4().to_string();
    let ts = now();
    sqlx::query(
        "INSERT INTO vps_servers
         (id, name, hostname, ip, port, os, status, location, provider, tags,
          ssh_username, ssh_password, ssh_private_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'OFFLINE', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.hostname)
    .bind(&input.ip)
    .bind(input.port as i64)
    .bind(&input.os)
    .bind(&input.location)
    .bind(&input.provider)
    .bind(&input.tags)
    .bind(&input.ssh_username)
    .bind(secrets.seal(input.ssh_password.as_deref()).map_err(AppError::Other)?)
    .bind(secrets.seal(input.ssh_private_key.as_deref()).map_err(AppError::Other)?)
    .bind(ts)
    .bind(ts)
    .execute(pool)
    .await?;
    get_server(pool, &id, secrets).await
}

pub async fn update_server(
    pool: &SqlitePool,
    id: &str,
    input: &ServerInput,
    secrets: &Secrets,
) -> AppResult<VpsServer> {
    let current = get_server(pool, id, secrets).await?;
    // Bỏ trống password/key khi update = giữ giá trị cũ, không xoá mất.
    let pw = input.ssh_password.clone().or(current.ssh_password);
    let key = input.ssh_private_key.clone().or(current.ssh_private_key);

    sqlx::query(
        "UPDATE vps_servers SET name=?, hostname=?, ip=?, port=?, os=?, location=?,
         provider=?, tags=?, ssh_username=?, ssh_password=?, ssh_private_key=?, updated_at=?
         WHERE id=?",
    )
    .bind(&input.name)
    .bind(&input.hostname)
    .bind(&input.ip)
    .bind(input.port as i64)
    .bind(&input.os)
    .bind(&input.location)
    .bind(&input.provider)
    .bind(&input.tags)
    .bind(&input.ssh_username)
    .bind(secrets.seal(pw.as_deref()).map_err(AppError::Other)?)
    .bind(secrets.seal(key.as_deref()).map_err(AppError::Other)?)
    .bind(now())
    .bind(id)
    .execute(pool)
    .await?;
    get_server(pool, id, secrets).await
}

pub async fn delete_server(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM vps_servers WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM file_index WHERE server_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM index_runs WHERE server_id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Đặt hoặc bỏ thư mục ghim. `None` = bỏ ghim.
pub async fn set_pinned_path(
    pool: &SqlitePool,
    id: &str,
    path: Option<&str>,
) -> AppResult<()> {
    let n = sqlx::query("UPDATE vps_servers SET pinned_path = ?, updated_at = ? WHERE id = ?")
        .bind(path)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound(format!("server {id}")));
    }
    Ok(())
}

pub async fn set_status(pool: &SqlitePool, id: &str, status: &str) -> AppResult<()> {
    sqlx::query("UPDATE vps_servers SET status = ?, updated_at = ? WHERE id = ?")
        .bind(status)
        .bind(now())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Mã hoá lại những giá trị còn ở dạng plaintext (dữ liệu import từ H2).
/// Chạy một lần khi khởi động; không log giá trị nào.
pub async fn reseal_legacy_secrets(pool: &SqlitePool, secrets: &Secrets) -> AppResult<usize> {
    let rows = sqlx::query("SELECT id, ssh_password, ssh_private_key FROM vps_servers")
        .fetch_all(pool)
        .await?;
    let mut fixed = 0usize;
    for r in &rows {
        let pw: Option<String> = r.get("ssh_password");
        let key: Option<String> = r.get("ssh_private_key");
        if !Secrets::is_legacy_plaintext(pw.as_deref())
            && !Secrets::is_legacy_plaintext(key.as_deref())
        {
            continue;
        }
        let id: String = r.get("id");
        // Chỉ seal cột NÀO thật sự còn plaintext.
        //
        // Seal cả hai là sai khi một cột đã mã hoá: `seal("v1:abc...")` sẽ mã
        // hoá luôn cả tiền tố, thành `v1:<mã hoá của "v1:abc...">`. Lần `open`
        // sau trả về chuỗi `"v1:abc..."` và dùng nó làm mật khẩu SSH — sai mật
        // khẩu mà không có lỗi giải mã nào để lần ra nguyên nhân.
        let new_pw = if Secrets::is_legacy_plaintext(pw.as_deref()) {
            secrets.seal(pw.as_deref()).map_err(AppError::Other)?
        } else {
            pw.clone()
        };
        let new_key = if Secrets::is_legacy_plaintext(key.as_deref()) {
            secrets.seal(key.as_deref()).map_err(AppError::Other)?
        } else {
            key.clone()
        };
        sqlx::query("UPDATE vps_servers SET ssh_password = ?, ssh_private_key = ? WHERE id = ?")
            .bind(new_pw)
            .bind(new_key)
            .bind(&id)
            .execute(pool)
            .await?;
        fixed += 1;
    }
    Ok(fixed)
}
