//! Toàn bộ endpoint REST.
//!
//! Chỉ port những endpoint frontend thật sự gọi. Bản Java còn 7 controller nữa
//! (docker, nginx, ssl, ftp, cron, database, firewall) nhưng đã kiểm: các page
//! tương ứng không gọi API lần nào — chúng là UI mock. Port chúng là port code
//! chết. Khi nào các page đó nối thật thì thêm sau, vì mọi thứ chúng làm đều
//! chạy qua `POST /execute` được rồi (page `website` đang làm đúng vậy: 24 lời
//! gọi `executeCommand`).

use crate::AppState;
use crate::db::{self, ServerInput};
use crate::error::{AppError, AppResult};
use crate::files::{self, DirCache, ListQuery};
use crate::ssh::shell_quote;
use axum::Json;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

type St = State<Arc<AppState>>;

// ---------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------

pub async fn list_servers(State(s): St) -> AppResult<Json<Vec<db::ServerDto>>> {
    let servers = db::list_servers(&s.pool, &s.secrets).await?;
    Ok(Json(servers.iter().map(|v| v.to_dto()).collect()))
}

pub async fn get_server(State(s): St, Path(id): Path<String>) -> AppResult<Json<db::ServerDto>> {
    Ok(Json(
        db::get_server(&s.pool, &id, &s.secrets).await?.to_dto(),
    ))
}

pub async fn create_server(
    State(s): St,
    Json(input): Json<ServerInput>,
) -> AppResult<Json<db::ServerDto>> {
    if input.ip.trim().is_empty() {
        return Err(AppError::BadRequest("thiếu địa chỉ IP".into()));
    }
    Ok(Json(
        db::insert_server(&s.pool, &input, &s.secrets).await?.to_dto(),
    ))
}

pub async fn update_server(
    State(s): St,
    Path(id): Path<String>,
    Json(input): Json<ServerInput>,
) -> AppResult<Json<db::ServerDto>> {
    let dto = db::update_server(&s.pool, &id, &input, &s.secrets)
        .await?
        .to_dto();
    // Thông tin kết nối đổi -> session cũ trong pool không còn đúng.
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    s.ssh.drop_conn(&server).await;
    s.cache.invalidate_server(&id).await;
    Ok(Json(dto))
}

pub async fn delete_server(State(s): St, Path(id): Path<String>) -> AppResult<Json<serde_json::Value>> {
    if let Ok(server) = db::get_server(&s.pool, &id, &s.secrets).await {
        s.ssh.drop_conn(&server).await;
    }
    s.cache.invalidate_server(&id).await;
    db::delete_server(&s.pool, &id).await?;
    Ok(Json(json!({ "message": "đã xoá" })))
}

pub async fn test_connection(
    State(s): St,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let connected = match s.ssh.exec(&server, "echo ok").await {
        Ok(o) => o.stdout.contains("ok"),
        Err(e) => {
            tracing::info!("test kết nối {} thất bại: {e}", server.ip);
            s.ssh.drop_conn(&server).await;
            false
        }
    };
    db::set_status(&s.pool, &id, if connected { "ONLINE" } else { "OFFLINE" }).await?;
    Ok(Json(json!({ "connected": connected })))
}

#[derive(Deserialize)]
pub struct PinBody {
    /// `null` hoặc chuỗi rỗng = bỏ ghim.
    pub path: Option<String>,
}

/// Ghim một thư mục cho server. File Manager sẽ mở thẳng vào đó thay vì /root.
///
/// Đường dẫn được kiểm TỒN TẠI và phải là thư mục trước khi lưu: ghim một chỗ
/// không mở được chỉ làm lần sau vào là báo lỗi mà không hiểu vì sao.
pub async fn set_pin(
    State(s): St,
    Path(id): Path<String>,
    Json(body): Json<PinBody>,
) -> AppResult<Json<serde_json::Value>> {
    let raw = body.path.unwrap_or_default();
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        db::set_pinned_path(&s.pool, &id, None).await?;
        return Ok(Json(json!({ "pinnedPath": null, "message": "đã bỏ ghim" })));
    }

    let path = files::normalize_path(trimmed);
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let probe = s
        .ssh
        .exec(&server, &format!("test -d {} && echo ok", shell_quote(&path)))
        .await?;
    if !probe.stdout.contains("ok") {
        return Err(AppError::BadRequest(format!(
            "{path} không tồn tại hoặc không phải thư mục"
        )));
    }

    db::set_pinned_path(&s.pool, &id, Some(&path)).await?;
    Ok(Json(json!({ "pinnedPath": path, "message": "đã ghim" })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub hostname: String,
    pub os: String,
    pub uptime: String,
    pub cpu_usage: f64,
    pub ram_total_mb: u64,
    pub ram_used_mb: u64,
    pub ram_usage_percent: f64,
    pub disk_total_gb: u64,
    pub disk_used_gb: u64,
    pub disk_usage_percent: f64,
    pub load_avg: String,
}

pub async fn server_stats(State(s): St, Path(id): Path<String>) -> AppResult<Json<ServerStats>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;

    // Một lệnh duy nhất, phân mục bằng dấu hiệu rõ ràng. Đọc /proc thay vì
    // `top -bn1` vì top cần ~1s để lấy mẫu, và định dạng của nó khác nhau giữa
    // các bản phân phối (bản Java parse `Cpu(s)` nên hỏng trên nhiều distro).
    let script = "\
echo '@@CPU'; grep -m1 '^cpu ' /proc/stat; sleep 0.3; grep -m1 '^cpu ' /proc/stat; \
echo '@@MEM'; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; \
echo '@@DISK'; df -B1 / | tail -1; \
echo '@@UP'; cat /proc/uptime; \
echo '@@LOAD'; cat /proc/loadavg; \
echo '@@HOST'; cat /etc/hostname 2>/dev/null; \
echo '@@OS'; (grep -m1 PRETTY_NAME /etc/os-release 2>/dev/null | cut -d'\"' -f2)";

    let out = s.ssh.exec(&server, script).await?;
    let stats = parse_stats(&out.stdout);

    // OS phát hiện được thì ghi lại, để trang servers không còn cột trống.
    if !stats.os.is_empty() && stats.os != server.os {
        sqlx::query("UPDATE vps_servers SET os = ?, updated_at = ? WHERE id = ?")
            .bind(&stats.os)
            .bind(db::now())
            .bind(&id)
            .execute(&s.pool)
            .await?;
    }
    db::set_status(&s.pool, &id, "ONLINE").await?;
    Ok(Json(stats))
}

/// Tách riêng để test được mà không cần VPS.
fn parse_stats(out: &str) -> ServerStats {
    let mut sec = "";
    let mut cpu_samples: Vec<Vec<u64>> = Vec::new();
    let (mut mem_total, mut mem_avail) = (0u64, 0u64);
    let (mut disk_total, mut disk_used) = (0u64, 0u64);
    let mut uptime_secs = 0f64;
    let mut load = String::new();
    let mut hostname = String::new();
    let mut os = String::new();

    for line in out.lines() {
        let l = line.trim();
        if let Some(tag) = l.strip_prefix("@@") {
            sec = match tag {
                "CPU" => "cpu",
                "MEM" => "mem",
                "DISK" => "disk",
                "UP" => "up",
                "LOAD" => "load",
                "HOST" => "host",
                "OS" => "os",
                _ => "",
            };
            continue;
        }
        if l.is_empty() {
            continue;
        }
        match sec {
            "cpu" => {
                let nums: Vec<u64> = l
                    .split_whitespace()
                    .skip(1)
                    .filter_map(|x| x.parse().ok())
                    .collect();
                if nums.len() >= 4 {
                    cpu_samples.push(nums);
                }
            }
            "mem" => {
                let v: u64 = l
                    .split_whitespace()
                    .nth(1)
                    .and_then(|x| x.parse().ok())
                    .unwrap_or(0);
                if l.starts_with("MemTotal") {
                    mem_total = v;
                } else if l.starts_with("MemAvailable") {
                    mem_avail = v;
                }
            }
            "disk" => {
                let f: Vec<&str> = l.split_whitespace().collect();
                if f.len() >= 4 {
                    disk_total = f[1].parse().unwrap_or(0);
                    disk_used = f[2].parse().unwrap_or(0);
                }
            }
            "up" => {
                uptime_secs = l
                    .split_whitespace()
                    .next()
                    .and_then(|x| x.parse().ok())
                    .unwrap_or(0.0)
            }
            "load" => {
                load = l
                    .split_whitespace()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join(" ")
            }
            "host" => hostname = l.to_string(),
            "os" => os = l.to_string(),
            _ => {}
        }
    }

    // CPU từ hai mẫu /proc/stat cách nhau 0.3s — chính xác hơn và không phụ
    // thuộc định dạng của `top`.
    let cpu_usage = match (cpu_samples.first(), cpu_samples.get(1)) {
        (Some(a), Some(b)) => {
            let idle_a = a.get(3).copied().unwrap_or(0) + a.get(4).copied().unwrap_or(0);
            let idle_b = b.get(3).copied().unwrap_or(0) + b.get(4).copied().unwrap_or(0);
            let tot_a: u64 = a.iter().sum();
            let tot_b: u64 = b.iter().sum();
            let dt = tot_b.saturating_sub(tot_a);
            let di = idle_b.saturating_sub(idle_a);
            if dt > 0 {
                (((dt - di.min(dt)) as f64 / dt as f64) * 1000.0).round() / 10.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    };

    let mem_used = mem_total.saturating_sub(mem_avail);
    ServerStats {
        hostname,
        os,
        uptime: humanize_uptime(uptime_secs),
        cpu_usage,
        ram_total_mb: mem_total / 1024,
        ram_used_mb: mem_used / 1024,
        ram_usage_percent: pct(mem_used, mem_total),
        disk_total_gb: disk_total / 1_073_741_824,
        disk_used_gb: disk_used / 1_073_741_824,
        disk_usage_percent: pct(disk_used, disk_total),
        load_avg: load,
    }
}

fn pct(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        ((used as f64 / total as f64) * 1000.0).round() / 10.0
    }
}

fn humanize_uptime(secs: f64) -> String {
    let s = secs as u64;
    let (d, h, m) = (s / 86400, (s % 86400) / 3600, (s % 3600) / 60);
    match (d, h) {
        (0, 0) => format!("{m} phút"),
        (0, _) => format!("{h} giờ {m} phút"),
        _ => format!("{d} ngày {h} giờ"),
    }
}

#[derive(Deserialize)]
pub struct ExecRequest {
    pub command: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResponse {
    pub exit_code: i32,
    pub output: String,
    pub error: String,
}

pub async fn execute(
    State(s): St,
    Path(id): Path<String>,
    Json(body): Json<ExecRequest>,
) -> AppResult<Json<ExecResponse>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let out = s.ssh.exec(&server, &body.command).await?;
    // Lệnh tuỳ ý có thể đổi nội dung thư mục; đừng để cache trả dữ liệu cũ.
    s.cache.invalidate_server(&id).await;
    Ok(Json(ExecResponse {
        exit_code: out.exit_code,
        output: out.stdout,
        error: out.stderr,
    }))
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

pub async fn list_files(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<files::ListResponse>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    Ok(Json(
        files::list(&s.ssh, &s.pool, &s.cache, &server, &q).await?,
    ))
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default = "slash")]
    pub path: String,
    pub q: String,
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

fn slash() -> String {
    "/".into()
}
fn default_search_limit() -> usize {
    500
}

pub async fn search_files(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<SearchQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let (hits, source) = files::search(&s.ssh, &s.pool, &server, &q.path, &q.q, q.limit).await?;
    Ok(Json(json!({
        "hits": hits,
        "source": source,       // "index" = từ index; "live" = find trực tiếp
        "truncated": hits.len() >= q.limit.clamp(1, 2000),
    })))
}

/// Bắt đầu index đệ quy cho một thư mục. Trả về ngay, quét chạy nền.
pub async fn start_index(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let path = files::normalize_path(&q.path);

    let (state, _) = files::index_status(&s.pool, &id, &path).await?;
    if state == "running" {
        return Ok(Json(json!({ "state": "running", "message": "đang quét" })));
    }

    let ssh = s.ssh.clone();
    let pool = s.pool.clone();
    let max = s.max_index_entries;
    let p = path.clone();
    tokio::spawn(async move {
        match files::build_index(ssh, pool, server, p.clone(), max).await {
            Ok(n) => tracing::info!("index {p}: {n} entry"),
            Err(e) => tracing::warn!("index {p} lỗi: {e}"),
        }
    });

    Ok(Json(json!({ "state": "running", "path": path })))
}

pub async fn index_status(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let path = files::normalize_path(&q.path);
    let (state, entries) = files::index_status(&s.pool, &id, &path).await?;
    Ok(Json(json!({ "state": state, "entries": entries, "path": path })))
}

pub async fn read_file(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    const MAX_EDIT_BYTES: u64 = 8 * 1024 * 1024;
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let sftp = s.ssh.sftp(&server).await?;

    let meta = sftp.metadata(&q.path).await?;
    let size = meta.size.unwrap_or(0);
    if size > MAX_EDIT_BYTES {
        return Err(AppError::BadRequest(format!(
            "file {:.1} MB, quá lớn để mở trong editor (giới hạn {} MB) — hãy tải về",
            size as f64 / 1_048_576.0,
            MAX_EDIT_BYTES / 1_048_576
        )));
    }

    let file = sftp.open(&q.path).await?;
    // `take(MAX+1)` là giới hạn THẬT. Kiểm bằng `meta.size` là không đủ:
    // /proc/* và /dev/zero báo size 0, còn file log đang phình thì size cũ đã
    // lạc hậu — `read_to_end` khi đó không có trần và gateway bị OOM, kéo sập
    // panel của cả 11 VPS.
    let mut buf = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(
        &mut tokio::io::AsyncReadExt::take(file, MAX_EDIT_BYTES + 1),
        &mut buf,
    )
    .await
    // KHÔNG `.ok()`. Đọc đứt giữa chừng mà vẫn trả 200 thì người dùng bấm Save
    // và ghi đè file thật bằng bản cụt — mất dữ liệu, im lặng.
    .map_err(|e| AppError::Ssh(format!("đọc file thất bại: {e}")))?;

    if buf.len() as u64 > MAX_EDIT_BYTES {
        return Err(AppError::BadRequest(format!(
            "file lớn hơn {} MB, hãy tải về thay vì mở trong editor",
            MAX_EDIT_BYTES / 1_048_576
        )));
    }

    // from_utf8_lossy biến byte nhị phân thành U+FFFD; lưu lại là hỏng file.
    // Thà từ chối mở còn hơn để người dùng lưu một bản đã bị thay ký tự.
    let content = String::from_utf8(buf).map_err(|_| {
        AppError::BadRequest("file không phải UTF-8 (nhị phân?), không mở được trong editor".into())
    })?;

    Ok(Json(json!({
        "content": content,
        "path": q.path,
        "size": size,
    })))
}

#[derive(Deserialize)]
pub struct WriteBody {
    pub content: String,
}

pub async fn write_file(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
    Json(body): Json<WriteBody>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let sftp = s.ssh.sftp(&server).await?;
    let mut file = sftp.create(&q.path).await?;
    tokio::io::AsyncWriteExt::write_all(&mut file, body.content.as_bytes()).await
        .map_err(|e| AppError::Ssh(format!("ghi file thất bại: {e}")))?;
    // KHÔNG `.ok()`. SFTP báo lỗi đầy đĩa ở bước CLOSE, nên nuốt lỗi ở đây
    // nghĩa là API trả "đã lưu" cho một file đã bị cắt.
    tokio::io::AsyncWriteExt::shutdown(&mut file)
        .await
        .map_err(|e| AppError::Ssh(format!("đóng file thất bại, nội dung có thể chưa lưu đủ: {e}")))?;

    invalidate_parent(&s.cache, &id, &q.path).await;
    Ok(Json(json!({ "message": "đã lưu", "path": q.path })))
}

pub async fn download_file(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> Result<Response, AppError> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let sftp = s.ssh.sftp(&server).await?;
    let size = sftp.metadata(&q.path).await?.size.unwrap_or(0);
    let file = sftp.open(&q.path).await?;
    let filename = q.path.rsplit('/').next().unwrap_or("download").to_string();

    // Stream thẳng từ SFTP ra HTTP: file 10GB cũng không nằm trong RAM.
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024);

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_DISPOSITION,
        content_disposition(&filename)
            .parse()
            .unwrap_or_else(|_| "attachment".parse().unwrap()),
    );
    headers.insert(header::CONTENT_LENGTH, size.into());
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(
        "access-control-expose-headers",
        "Content-Length, Content-Disposition".parse().unwrap(),
    );

    // `sftp` phải sống tới khi stream xong, nên giữ nó trong body.
    Ok((headers, Body::from_stream(KeepAlive { stream, _sftp: sftp })).into_response())
}

/// Bọc stream kèm `SftpSession` để session không bị drop giữa lúc tải.
struct KeepAlive<S> {
    stream: S,
    _sftp: russh_sftp::client::SftpSession,
}

impl<S> futures::Stream for KeepAlive<S>
where
    S: futures::Stream + Unpin,
{
    type Item = S::Item;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        std::pin::Pin::new(&mut self.stream).poll_next(cx)
    }
}

/// RFC 6266: tên file không ASCII phải đi bằng `filename*`, nếu không tên tiếng
/// Việt sẽ về máy dưới dạng rác.
fn content_disposition(filename: &str) -> String {
    let ascii: String = filename
        .chars()
        .map(|c| if c.is_ascii() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    format!(
        "attachment; filename=\"{ascii}\"; filename*=UTF-8''{}",
        percent_encode(filename)
    )
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub async fn upload_file(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
    mut multipart: Multipart,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let sftp = s.ssh.sftp(&server).await?;

    let mut written = 0u64;
    let mut target = q.path.clone();
    let mut got_field = false;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("multipart lỗi: {e}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        // Tên file do client đặt: chỉ lấy basename, chặn `../` leo thư mục.
        let name = field
            .file_name()
            .map(sanitize_filename)
            .unwrap_or_else(|| "upload.bin".to_string());

        // Hỏi server xem đích là thư mục hay file, đừng ĐOÁN theo dấu chấm.
        // Cách đoán cũ (`!path.contains('.')`) sai ở hai ca rất thường gặp:
        // `/var/www/example.com` là thư mục nhưng bị coi là file, còn
        // `/etc/hosts` là file nhưng bị coi là thư mục.
        let base = files::normalize_path(&q.path);
        let is_dir = q.path.ends_with('/')
            || sftp
                .metadata(&base)
                .await
                .map(|m| m.is_dir())
                .unwrap_or(false);
        target = if is_dir {
            files::join_path(&base, &name)
        } else {
            base.clone()
        };

        let mut file = sftp.create(&target).await?;
        // Ghi theo chunk: RAM không phình theo kích thước file.
        while let Some(chunk) = field
            .chunk()
            .await
            .map_err(|e| AppError::BadRequest(format!("đọc upload lỗi: {e}")))?
        {
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|e| AppError::Ssh(format!("ghi SFTP thất bại: {e}")))?;
            written += chunk.len() as u64;
        }
        tokio::io::AsyncWriteExt::shutdown(&mut file)
            .await
            .map_err(|e| AppError::Ssh(format!("đóng file thất bại, file có thể bị cắt: {e}")))?;
        got_field = true;
    }

    if !got_field {
        return Err(AppError::BadRequest(
            "request không có field 'file' nào".into(),
        ));
    }

    invalidate_parent(&s.cache, &id, &target).await;
    Ok(Json(
        json!({ "message": "đã tải lên", "path": target, "bytes": written }),
    ))
}

fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned = base.trim().trim_start_matches('.');
    if cleaned.is_empty() {
        "upload.bin".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Những đường dẫn không bao giờ được xoá qua API.
///
/// `shell_quote` chặn được chèn lệnh, nhưng không chặn được việc GỌI ĐÚNG lệnh
/// với đường dẫn sai. `rm -rf -- '/'` hiện chỉ sống nhờ `--preserve-root` của
/// GNU rm — trên BusyBox/Alpine không có cờ đó và nó xoá sạch VPS. Một bug
/// frontend gửi `path=/` hay `path=/etc` là đủ để mất máy.
const PROTECTED_PATHS: &[&str] = &[
    "/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib64", "/opt",
    "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var",
];

fn guard_destructive(path: &str) -> AppResult<String> {
    let p = files::normalize_path(path);
    if PROTECTED_PATHS.contains(&p.as_str()) {
        return Err(AppError::BadRequest(format!(
            "từ chối xoá {p}: đây là thư mục hệ thống. Xoá từng mục con nếu thật sự cần."
        )));
    }
    Ok(p)
}

pub async fn delete_file(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    // normalize_path cũng quan trọng ở đây: path tương đối như `foo` sẽ xoá
    // `~/foo` nhưng invalidate_parent lại làm mới `/foo`, để lại cache sai.
    let path = guard_destructive(&q.path)?;
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    // `rm -rf` cho thư mục: bản Java dùng SFTP rmdir nên xoá thư mục có nội dung
    // là lỗi. Đường dẫn được bọc shell_quote nên tên file lạ không thành lệnh.
    let out = s
        .ssh
        .exec(&server, &format!("rm -rf -- {}", shell_quote(&path)))
        .await?;
    out.ok_stdout()?;
    invalidate_parent(&s.cache, &id, &path).await;
    Ok(Json(json!({ "message": "đã xoá", "path": path })))
}

pub async fn mkdir(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    s.ssh
        .exec(&server, &format!("mkdir -p -- {}", shell_quote(&q.path)))
        .await?
        .ok_stdout()?;
    invalidate_parent(&s.cache, &id, &q.path).await;
    Ok(Json(json!({ "message": "đã tạo thư mục", "path": q.path })))
}

#[derive(Deserialize)]
pub struct RenameQuery {
    #[serde(alias = "oldPath")]
    pub old_path: String,
    #[serde(alias = "newPath")]
    pub new_path: String,
}

pub async fn rename(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<RenameQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let sftp = s.ssh.sftp(&server).await?;
    sftp.rename(&q.old_path, &q.new_path).await?;
    invalidate_parent(&s.cache, &id, &q.old_path).await;
    invalidate_parent(&s.cache, &id, &q.new_path).await;
    Ok(Json(json!({ "message": "đã đổi tên" })))
}

#[derive(Deserialize)]
pub struct ChmodQuery {
    pub path: String,
    pub mode: String,
}

pub async fn chmod(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<ChmodQuery>,
) -> AppResult<Json<serde_json::Value>> {
    // Chỉ cho 3-4 chữ số octal. Không kiểm thì `mode` là chỗ chèn lệnh.
    if !(3..=4).contains(&q.mode.len()) || !q.mode.chars().all(|c| ('0'..='7').contains(&c)) {
        return Err(AppError::BadRequest(
            "mode phải là 3-4 chữ số octal, ví dụ 644 hoặc 0755".into(),
        ));
    }
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    s.ssh
        .exec(
            &server,
            &format!("chmod {} -- {}", q.mode, shell_quote(&q.path)),
        )
        .await?
        .ok_stdout()?;
    invalidate_parent(&s.cache, &id, &q.path).await;
    Ok(Json(json!({ "message": "đã đổi quyền" })))
}

// --- nén ---

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    /// Để `compress_status` không trả task của server khác.
    #[serde(skip)]
    pub server_id: String,
    pub status: String,
    pub message: String,
    pub started_at: i64,
}

pub async fn compress(
    State(s): St,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> AppResult<Json<serde_json::Value>> {
    let server = db::get_server(&s.pool, &id, &s.secrets).await?;
    let path = files::normalize_path(&q.path);
    let (dir, name) = match path.rfind('/') {
        Some(0) => ("/".to_string(), path[1..].to_string()),
        Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
        None => return Err(AppError::BadRequest("đường dẫn không hợp lệ".into())),
    };
    if name.is_empty() {
        // path = "/" rơi vào đây: lệnh sẽ thành `tar -czf '.tar.gz' -- ''`,
        // tar lỗi nhưng để lại file rác `/.tar.gz` ở gốc.
        return Err(AppError::BadRequest("không nén được thư mục gốc".into()));
    }
    let out_name = format!("{name}.tar.gz");
    // UUID đầy đủ, không cắt 8 ký tự: 32 bit vừa có thể va chạm (ghi đè task
    // của người khác) vừa đoán được.
    let task_id = uuid::Uuid::new_v4().to_string();

    {
        let mut tasks = s.tasks.write().await;
        // Dọn task cũ hơn 1 giờ. Map này trước đây chỉ có insert, không bao giờ
        // xoá, nên nó chỉ lớn lên theo số lần nén.
        let cutoff = db::now() - 3600;
        tasks.retain(|_, t| t.started_at >= cutoff);
        tasks.insert(
            task_id.clone(),
            Task {
                id: task_id.clone(),
                server_id: id.clone(),
                status: "running".into(),
                message: "đang nén".into(),
                started_at: db::now(),
            },
        );
    }

    let cmd = format!(
        "cd {} && tar -czf {} -- {}",
        shell_quote(&dir),
        shell_quote(&out_name),
        shell_quote(&name)
    );

    let st = s.clone();
    let tid = task_id.clone();
    let sid = id.clone();
    let dir_for_cache = dir.clone();
    tokio::spawn(async move {
        let (status, message) = match st.ssh.exec(&server, &cmd).await {
            Ok(o) if o.exit_code == 0 => ("done".to_string(), "xong".to_string()),
            Ok(o) => ("failed".to_string(), truncate(&o.stderr, 500)),
            Err(e) => ("failed".to_string(), e.to_string()),
        };
        if let Some(t) = st.tasks.write().await.get_mut(&tid) {
            t.status = status;
            t.message = message;
        }
        st.cache.invalidate(&sid, &dir_for_cache).await;
    });

    Ok(Json(json!({
        "taskId": task_id,
        "message": "đã bắt đầu nén",
        "path": files::join_path(&dir, &out_name),
    })))
}

fn truncate(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        t.chars().take(n).collect::<String>() + "…"
    }
}

pub async fn compress_status(
    State(s): St,
    Path((id, task_id)): Path<(String, String)>,
) -> AppResult<Json<serde_json::Value>> {
    let t = s
        .tasks
        .read()
        .await
        .get(&task_id)
        // Kiểm server khớp: không để task của server A đọc được qua server B.
        .filter(|t| t.server_id == id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("task {task_id}")))?;
    Ok(Json(json!({
        "taskId": t.id,
        "status": t.status,
        "message": t.message,
    })))
}

async fn invalidate_parent(cache: &DirCache, server_id: &str, path: &str) {
    let p = files::normalize_path(path);
    let parent = match p.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => p[..i].to_string(),
    };
    cache.invalidate(server_id, &parent).await;
    // Nếu path là thư mục thì chính nó cũng cần làm mới.
    cache.invalidate(server_id, &p).await;
}

// ---------------------------------------------------------------------------
// Máy chủ gateway (không phải VPS)
// ---------------------------------------------------------------------------

/// Thông tin máy chạy gateway (không phải VPS).
///
/// Shape phải khớp ĐÚNG interface `SystemStats` mà frontend dùng. Thiếu một
/// field là trang Overview throw: nó gọi thẳng `sys.loadAvg1.toFixed(2)`, và
/// `undefined.toFixed` làm error boundary của Next hiện "This page couldn't
/// load". Đơn vị cũng phải đúng: ram tính theo MB (`formatMbToDisplay`), disk
/// tính theo GB (page nhân 1073741824 để ra byte).
pub async fn system_stats() -> Json<serde_json::Value> {
    use sysinfo::{Disks, Networks, System};

    let mut sys = System::new_all();
    // global_cpu_usage cần hai lần lấy mẫu cách nhau, lần đầu luôn trả 0.
    sys.refresh_cpu_usage();
    tokio::time::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL).await;
    sys.refresh_cpu_usage();
    sys.refresh_memory();

    let ram_total = sys.total_memory();
    let ram_used = ram_total.saturating_sub(sys.available_memory());

    // Chỉ tính phân vùng gốc; cộng hết mọi mount sẽ đếm trùng (snap, APFS
    // volume dùng chung store) và ra số vô nghĩa.
    let disks = Disks::new_with_refreshed_list();
    let root = disks
        .list()
        .iter()
        .find(|d| d.mount_point() == std::path::Path::new("/"));
    let (disk_total, disk_used) = match root {
        Some(d) => {
            let t = d.total_space();
            (t, t.saturating_sub(d.available_space()))
        }
        None => (0, 0),
    };

    let nets = Networks::new_with_refreshed_list();
    let (rx, tx) = nets.list().values().fold((0u64, 0u64), |(r, t), n| {
        (r + n.total_received(), t + n.total_transmitted())
    });

    let load = System::load_average();

    Json(json!({
        "hostname": System::host_name().unwrap_or_default(),
        "os": format!(
            "{} {}",
            System::name().unwrap_or_default(),
            System::os_version().unwrap_or_default()
        ).trim().to_string(),
        "kernel": System::kernel_version().unwrap_or_default(),
        "uptime": humanize_uptime(System::uptime() as f64),

        "cpuUsage": (sys.global_cpu_usage() as f64 * 10.0).round() / 10.0,
        "cpuCores": sys.cpus().len(),
        "loadAvg1": (load.one * 100.0).round() / 100.0,
        "loadAvg5": (load.five * 100.0).round() / 100.0,
        "loadAvg15": (load.fifteen * 100.0).round() / 100.0,

        // MB — frontend format bằng formatMbToDisplay.
        "ramTotal": ram_total / 1_048_576,
        "ramUsed": ram_used / 1_048_576,
        "ramUsagePercent": pct(ram_used, ram_total),

        // GB — frontend nhân 1073741824 để ra byte.
        "diskTotal": disk_total / 1_073_741_824,
        "diskUsed": disk_used / 1_073_741_824,
        "diskUsagePercent": pct(disk_used, disk_total),

        "processCount": sys.processes().len(),
        "networkRxBytes": rx,
        "networkTxBytes": tx,
    }))
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: String,
    pub server_id: Option<String>,
    pub level: String,
    pub message: String,
    pub acked: bool,
    pub created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlertInput {
    #[serde(default)]
    pub server_id: Option<String>,
    #[serde(default = "info_level")]
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub acked: bool,
}

fn info_level() -> String {
    "INFO".into()
}

pub async fn list_alerts(State(s): St) -> AppResult<Json<Vec<Alert>>> {
    use sqlx::Row;
    let rows = sqlx::query(
        "SELECT id, server_id, level, message, acked, created_at
         FROM alerts ORDER BY created_at DESC LIMIT 500",
    )
    .fetch_all(&s.pool)
    .await?;
    Ok(Json(
        rows.iter()
            .map(|r| Alert {
                id: r.get("id"),
                server_id: r.get("server_id"),
                level: r.get("level"),
                message: r.get("message"),
                acked: r.get::<i64, _>("acked") != 0,
                created_at: r.get("created_at"),
            })
            .collect(),
    ))
}

pub async fn create_alert(
    State(s): St,
    Json(input): Json<AlertInput>,
) -> AppResult<Json<serde_json::Value>> {
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO alerts (id, server_id, level, message, acked, created_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&input.server_id)
    .bind(&input.level)
    .bind(&input.message)
    .bind(input.acked as i64)
    .bind(db::now())
    .execute(&s.pool)
    .await?;
    Ok(Json(json!({ "id": id })))
}

pub async fn update_alert(
    State(s): St,
    Path(id): Path<String>,
    Json(input): Json<AlertInput>,
) -> AppResult<Json<serde_json::Value>> {
    let n = sqlx::query("UPDATE alerts SET level = ?, message = ?, acked = ? WHERE id = ?")
        .bind(&input.level)
        .bind(&input.message)
        .bind(input.acked as i64)
        .bind(&id)
        .execute(&s.pool)
        .await?
        .rows_affected();
    if n == 0 {
        return Err(AppError::NotFound(format!("alert {id}")));
    }
    Ok(Json(json!({ "message": "đã cập nhật" })))
}

pub async fn delete_alert(
    State(s): St,
    Path(id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM alerts WHERE id = ?")
        .bind(&id)
        .execute(&s.pool)
        .await?;
    Ok(Json(json!({ "message": "đã xoá" })))
}

pub async fn health() -> impl IntoResponse {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_based_stats() {
        let out = "\
@@CPU
cpu  1000 50 300 8000 100 0 20 0 0 0
cpu  1100 55 320 8500 105 0 22 0 0 0
@@MEM
MemTotal:       16305040 kB
MemAvailable:    8152520 kB
@@DISK
/dev/vda1 107374182400 53687091200 48318382080 53% /
@@UP
123456.78 987654.00
@@LOAD
0.52 0.48 0.44 1/234 5678
@@HOST
nroz-test
@@OS
Ubuntu 22.04.5 LTS
";
        let s = parse_stats(out);
        assert_eq!(s.hostname, "nroz-test");
        assert_eq!(s.os, "Ubuntu 22.04.5 LTS");
        assert_eq!(s.ram_total_mb, 15922);
        assert_eq!(s.ram_usage_percent, 50.0, "MemAvailable là nửa MemTotal");
        assert_eq!(s.disk_total_gb, 100);
        assert_eq!(s.disk_used_gb, 50);
        assert_eq!(s.load_avg, "0.52 0.48 0.44");
        assert_eq!(s.uptime, "1 ngày 10 giờ");
        // delta total = 632, delta idle = 505 -> ~20.1%
        assert!(
            (s.cpu_usage - 20.1).abs() < 0.2,
            "cpu tính từ 2 mẫu /proc/stat, được {}",
            s.cpu_usage
        );
    }

    #[test]
    fn stats_survive_missing_sections() {
        // VPS thiếu /proc/loadavg hay /etc/hostname thì không được panic.
        let s = parse_stats("@@MEM\nMemTotal: 1024 kB\n");
        assert_eq!(s.ram_total_mb, 1);
        assert_eq!(s.cpu_usage, 0.0);
        assert_eq!(s.disk_total_gb, 0);
        assert_eq!(s.load_avg, "");
    }

    #[test]
    fn divide_by_zero_guarded() {
        assert_eq!(pct(5, 0), 0.0);
        assert_eq!(pct(50, 100), 50.0);
    }

    #[test]
    fn content_disposition_handles_vietnamese() {
        let cd = content_disposition("báo cáo.txt");
        assert!(cd.contains("filename=\"b_o c_o.txt\""), "fallback ASCII: {cd}");
        assert!(
            cd.contains("filename*=UTF-8''b%C3%A1o%20c%C3%A1o.txt"),
            "phải có filename* để tên tiếng Việt về đúng: {cd}"
        );
    }

    #[test]
    fn upload_filename_cannot_escape_directory() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("/etc/shadow"), "shadow");
        assert_eq!(sanitize_filename("..\\..\\win.ini"), "win.ini");
        assert_eq!(sanitize_filename("   "), "upload.bin");
        assert_eq!(sanitize_filename("bình thường.zip"), "bình thường.zip");
    }

    #[test]
    fn uptime_humanised() {
        assert_eq!(humanize_uptime(90.0), "1 phút");
        assert_eq!(humanize_uptime(3700.0), "1 giờ 1 phút");
        assert_eq!(humanize_uptime(90000.0), "1 ngày 1 giờ");
    }
}
