//! Liệt kê, sắp xếp, index và tìm kiếm file trên VPS.
//!
//! Ba thay đổi cốt lõi so với bản Java:
//!
//! 1. **Liệt kê bằng `find -printf`, không bằng SFTP `read_dir`.** Đo trên VPS
//!    thật (Ubuntu 22.04, 4971 entry): SFTP 1,47s — `find` 138ms, nhanh hơn
//!    10,6 lần, vì SFTP tốn nhiều round-trip `SSH_FXP_READDIR` còn `find` chỉ
//!    một lượt và server in sẵn size/mtime/quyền.
//! 2. **mtime là số nguyên epoch**, không phải chuỗi. Bản Java trả
//!    `getMtimeString()` rồi frontend so sánh chuỗi, nên "sắp xếp theo ngày"
//!    cho ra thứ tự ngẫu nhiên.
//! 3. **Phân trang ở server.** Thư mục 50k file vẫn chỉ gửi ~1k dòng về browser;
//!    phần còn lại nằm trong cache đã sắp xếp, và index SQLite lo tìm kiếm đệ quy.

use crate::db::VpsServer;
use crate::error::{AppError, AppResult};
use crate::ssh::{SshPool, shell_quote};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// Định dạng in của `find`: kiểu, quyền (octal), chủ, nhóm, cỡ, mtime, tên.
/// `%T@` ra giây kèm phần thập phân; ta chỉ lấy phần nguyên.
/// Bản ghi kết thúc bằng NUL, không bằng newline: tên file trên Linux được
/// phép chứa `\n`, và khi đó một dòng bị tách làm hai. Nửa sau có thể cố ý
/// được tạo thành một bản ghi hợp lệ — ai ghi được vào thư mục (web root,
/// thư mục upload) sẽ chèn được entry GIẢ vào cả listing và index.
/// Cột cuối (tên / đường dẫn) được tách bằng `splitn` nên TAB trong tên cũng
/// không làm mất phần sau của tên.
const FIND_FORMAT: &str = r"%y\t%m\t%u\t%g\t%s\t%T@\t%f\0";
const FIND_FORMAT_FULL: &str = r"%y\t%m\t%u\t%g\t%s\t%T@\t%p\0";
/// Số cột của hai định dạng trên.
const FIND_COLS: usize = 7;

/// Thư mục đã đọc được giữ lại bấy lâu trước khi đọc lại.
const DIR_CACHE_TTL: Duration = Duration::from_secs(15);
/// Số thư mục tối đa giữ trong cache cùng lúc.
const MAX_CACHED_DIRS: usize = 64;

// ---------------------------------------------------------------------------
// Kiểu dữ liệu
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// "directory" | "file" | "link" — giữ nguyên tên như API cũ để frontend
    /// không phải đổi toàn bộ chỗ so sánh `type === 'directory'`.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub size: u64,
    /// Epoch giây. Đây là thứ sửa được lỗi sắp xếp theo thời gian.
    pub mtime: i64,
    pub permissions: String,
    pub owner: String,
    pub group: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortKey {
    #[default]
    Name,
    Size,
    Mtime,
    Type,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SortOrder {
    #[default]
    Asc,
    Desc,
}

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default = "root_path")]
    pub path: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub sort: SortKey,
    #[serde(default)]
    pub order: SortOrder,
    /// Lọc theo tên trong chính thư mục này (không đệ quy). Rỗng = không lọc.
    #[serde(default)]
    pub q: String,
    /// `true` buộc đọc lại từ VPS, bỏ qua cache.
    #[serde(default)]
    pub refresh: bool,
}

fn root_path() -> String {
    "/".to_string()
}
fn default_limit() -> usize {
    1000
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    pub path: String,
    /// Tổng số entry trong thư mục sau khi lọc theo `q`.
    pub total: usize,
    /// Tổng số entry thật trong thư mục, chưa lọc.
    pub total_unfiltered: usize,
    pub offset: usize,
    pub limit: usize,
    pub entries: Vec<FileEntry>,
    /// Trạng thái index đệ quy cho thư mục này: "none" | "running" | "done" | "failed".
    pub index_state: String,
    pub indexed_entries: i64,
}

// ---------------------------------------------------------------------------
// Sắp xếp
// ---------------------------------------------------------------------------

/// So sánh tên file kiểu "tự nhiên": cụm chữ số được so theo GIÁ TRỊ, không
/// theo từng ký tự. Nhờ vậy `file2` đứng trước `file10`, và `log_9` trước
/// `log_10` — thứ tự mà bản cũ (`localeCompare` thuần) làm sai.
///
/// So sánh không phân biệt hoa thường; khi bằng nhau thì dùng thứ tự gốc để
/// kết quả ổn định.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());

    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) => {
                if ca.is_ascii_digit() && cb.is_ascii_digit() {
                    // Gom trọn cụm số ở cả hai bên rồi so theo giá trị.
                    let na = take_digits(&mut ai);
                    let nb = take_digits(&mut bi);
                    // Bỏ số 0 ở đầu khi so giá trị. Giá trị bằng nhau thì bên
                    // nhiều số 0 đệm hơn đứng trước ("010" trước "10") — đúng
                    // theo `sort -V` của GNU, đã đối chiếu thực tế.
                    let ta = na.trim_start_matches('0');
                    let tb = nb.trim_start_matches('0');
                    match ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb)) {
                        Ordering::Equal => match nb.len().cmp(&na.len()) {
                            Ordering::Equal => continue,
                            other => return other,
                        },
                        other => return other,
                    }
                }

                let la = ca.to_lowercase().next().unwrap_or(ca);
                let lb = cb.to_lowercase().next().unwrap_or(cb);
                // ponytail: so theo codepoint sau khi hạ chữ thường. Chữ có dấu
                // tiếng Việt vì thế xếp sau 'z' thay vì xen đúng bảng chữ cái.
                // Muốn đúng tuyệt đối thì cần collation Unicode (icu), nặng hơn
                // nhiều so với giá trị thu được cho một trình quản lý file.
                match la.cmp(&lb) {
                    Ordering::Equal => {
                        ai.next();
                        bi.next();
                    }
                    other => return other,
                }
            }
        }
    }
    // Hai tên chỉ khác nhau ở hoa/thường: chốt bằng so sánh thô để ổn định.
    a.cmp(b)
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek().copied() {
        if c.is_ascii_digit() {
            s.push(c);
            it.next();
        } else {
            break;
        }
    }
    s
}

fn is_dir(e: &FileEntry) -> bool {
    e.kind == "directory"
}

/// Sắp xếp theo quy ước quen thuộc của trình quản lý file:
/// `..` luôn đầu tiên → thư mục trước file → rồi mới tới cột được chọn.
/// Giữ thư mục lên trên kể cả khi sắp theo cỡ hay ngày, giống Explorer/aaPanel.
pub fn sort_entries(entries: &mut [FileEntry], key: SortKey, order: SortOrder) {
    entries.sort_by(|a, b| {
        if a.name == ".." {
            return Ordering::Less;
        }
        if b.name == ".." {
            return Ordering::Greater;
        }
        match is_dir(b).cmp(&is_dir(a)) {
            Ordering::Equal => {}
            other => return other,
        }

        let cmp = match key {
            SortKey::Name => natural_cmp(&a.name, &b.name),
            SortKey::Size => a.size.cmp(&b.size).then_with(|| natural_cmp(&a.name, &b.name)),
            SortKey::Mtime => a.mtime.cmp(&b.mtime).then_with(|| natural_cmp(&a.name, &b.name)),
            SortKey::Type => {
                let ea = extension_of(&a.name);
                let eb = extension_of(&b.name);
                natural_cmp(ea, eb).then_with(|| natural_cmp(&a.name, &b.name))
            }
        };
        match order {
            SortOrder::Asc => cmp,
            SortOrder::Desc => cmp.reverse(),
        }
    });
}

fn extension_of(name: &str) -> &str {
    match name.rfind('.') {
        // ".bashrc" là tên file ẩn, không phải phần mở rộng.
        Some(i) if i > 0 => &name[i + 1..],
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// Đọc thư mục
// ---------------------------------------------------------------------------

fn parse_find_line(line: &str) -> Option<FileEntry> {
    // splitn: cột thứ 7 giữ nguyên mọi TAB có trong tên file.
    let mut f = line.splitn(FIND_COLS, '\t');
    let kind = match f.next()? {
        "d" => "directory",
        "l" => "link",
        _ => "file",
    };
    let permissions = f.next()?.to_string();
    let owner = f.next()?.to_string();
    let group = f.next()?.to_string();
    let size = f.next()?.parse().unwrap_or(0);
    // "%T@" ra dạng "1759900000.1234567890"; chỉ cần phần giây.
    let mtime = f
        .next()?
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let name = f.next()?.to_string();
    if name.is_empty() {
        return None;
    }
    Some(FileEntry {
        name,
        kind,
        size,
        mtime,
        permissions,
        owner,
        group,
    })
}

struct CachedDir {
    entries: Arc<Vec<FileEntry>>,
    at: Instant,
}

#[derive(Default)]
pub struct DirCache {
    inner: RwLock<HashMap<(String, String), CachedDir>>,
}

impl DirCache {
    pub fn new() -> Self {
        Self::default()
    }

    async fn get(&self, server_id: &str, path: &str) -> Option<Arc<Vec<FileEntry>>> {
        let g = self.inner.read().await;
        let c = g.get(&(server_id.to_string(), path.to_string()))?;
        (c.at.elapsed() < DIR_CACHE_TTL).then(|| c.entries.clone())
    }

    async fn put(&self, server_id: &str, path: &str, entries: Arc<Vec<FileEntry>>) {
        let mut g = self.inner.write().await;
        // Dọn entry hết hạn ở mỗi lần ghi. Không có bước này, mọi thư mục từng
        // duyệt được giữ nguyên trong RAM tới khi bị invalidate — một thư mục
        // 50k file là vài chục MB, nhân với số thư mục đã mở và 11 server thì
        // bộ nhớ chỉ có tăng.
        g.retain(|_, c| c.at.elapsed() < DIR_CACHE_TTL);
        // Trần cứng để một lần duyệt cây rất rộng không phình bộ nhớ ngay trong
        // cùng một cửa sổ TTL.
        if g.len() >= MAX_CACHED_DIRS {
            // ponytail: xoá sạch thay vì LRU. Cache chỉ sống 15s nên mất nó chỉ
            // tốn một lần đọc lại; thêm LRU chưa đáng cho tới khi đo thấy cần.
            g.clear();
        }
        g.insert(
            (server_id.to_string(), path.to_string()),
            CachedDir {
                entries,
                at: Instant::now(),
            },
        );
    }

    /// Gọi sau mọi thao tác làm đổi nội dung thư mục (tạo/xoá/đổi tên/upload),
    /// nếu không người dùng sẽ thấy danh sách cũ tới 15 giây.
    pub async fn invalidate(&self, server_id: &str, path: &str) {
        self.inner
            .write()
            .await
            .remove(&(server_id.to_string(), path.to_string()));
    }

    pub async fn invalidate_server(&self, server_id: &str) {
        self.inner.write().await.retain(|(s, _), _| s != server_id);
    }
}

/// Đọc trọn một thư mục (không đệ quy) từ VPS.
pub async fn read_dir(
    ssh: &SshPool,
    server: &VpsServer,
    path: &str,
) -> AppResult<Vec<FileEntry>> {
    let cmd = format!(
        "LC_ALL=C.UTF-8 find {} -maxdepth 1 -mindepth 1 -printf '{}' 2>/dev/null",
        shell_quote(path),
        FIND_FORMAT
    );
    let out = ssh.exec(server, &cmd).await?;

    // `find` trả mã khác 0 khi có mục không đọc được, nhưng phần đọc được vẫn
    // in ra. Chỉ coi là lỗi khi hoàn toàn không có dòng nào.
    if out.stdout.is_empty() && out.exit_code != 0 {
        // Phân biệt "thư mục rỗng" với "không tồn tại / không có quyền".
        let probe = ssh
            .exec(
                server,
                &format!("test -d {} && echo ok", shell_quote(path)),
            )
            .await?;
        if !probe.stdout.contains("ok") {
            return Err(AppError::NotFound(format!("thư mục {path}")));
        }
    }

    let mut entries: Vec<FileEntry> = out
        .stdout
        .split('\0')
        .filter(|r| !r.is_empty())
        .filter_map(parse_find_line)
        .collect();

    // Thêm ".." để đi lên, trừ khi đang ở gốc.
    if path != "/" {
        entries.insert(
            0,
            FileEntry {
                name: "..".into(),
                kind: "directory",
                size: 0,
                mtime: 0,
                permissions: String::new(),
                owner: String::new(),
                group: String::new(),
            },
        );
    }
    Ok(entries)
}

/// Liệt kê có phân trang. Đọc trọn thư mục một lần (và nhớ trong cache), sắp
/// xếp ở server, rồi chỉ trả về lát cắt mà frontend cần.
pub async fn list(
    ssh: &SshPool,
    pool: &SqlitePool,
    cache: &DirCache,
    server: &VpsServer,
    q: &ListQuery,
) -> AppResult<ListResponse> {
    let path = normalize_path(&q.path);

    let all = match (q.refresh, cache.get(&server.id, &path).await) {
        (false, Some(hit)) => hit,
        _ => {
            let entries = Arc::new(read_dir(ssh, server, &path).await?);
            cache.put(&server.id, &path, entries.clone()).await;
            entries
        }
    };
    let total_unfiltered = all.len();

    let needle = q.q.trim().to_lowercase();
    let mut filtered: Vec<FileEntry> = if needle.is_empty() {
        all.as_ref().clone()
    } else {
        all.iter()
            .filter(|e| e.name == ".." || e.name.to_lowercase().contains(&needle))
            .cloned()
            .collect()
    };

    sort_entries(&mut filtered, q.sort, q.order);

    let total = filtered.len();
    let limit = q.limit.clamp(1, 5000);
    let offset = q.offset.min(total);
    let entries = filtered[offset..(offset + limit).min(total)].to_vec();

    let (index_state, indexed_entries) = index_status(pool, &server.id, &path).await?;

    Ok(ListResponse {
        path,
        total,
        total_unfiltered,
        offset,
        limit,
        entries,
        index_state,
        indexed_entries,
    })
}

pub fn normalize_path(p: &str) -> String {
    let p = p.trim();
    if p.is_empty() {
        return "/".into();
    }
    let mut out = p.replace("//", "/");
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    if out.starts_with('/') { out } else { format!("/{out}") }
}

pub fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

// ---------------------------------------------------------------------------
// Index đệ quy + tìm kiếm
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    pub parent: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: i64,
    pub mtime: i64,
}

pub async fn index_status(
    pool: &SqlitePool,
    server_id: &str,
    path: &str,
) -> AppResult<(String, i64)> {
    use sqlx::Row;
    // Thư mục này được phủ bởi lần quét nào? Gốc quét phải là chính nó hoặc tổ tiên.
    // KHÔNG dùng LIKE ở đây. Trong LIKE, `_` khớp một ký tự bất kỳ và SQLite
    // bỏ qua hoa thường với ASCII — nên root `/srv/my_app` sẽ khớp nhầm
    // `/srv/myXapp/...` và `/srv/MY_APP/...`, khiến thư mục chưa index bị báo
    // là `done` rồi search trả kết quả rỗng thay vì rơi về quét trực tiếp.
    // `substr` so sánh byte chính xác, phân biệt hoa thường như Linux.
    let row = sqlx::query(
        "SELECT state, entries, root FROM index_runs
         WHERE server_id = ?1
           AND (root = ?2
                OR (root = '/' AND substr(?2, 1, 1) = '/')
                OR substr(?2, 1, length(root) + 1) = root || '/')
         ORDER BY LENGTH(root) DESC LIMIT 1",
    )
    .bind(server_id)
    .bind(path)
    .fetch_optional(pool)
    .await?;

    Ok(match row {
        Some(r) => (
            r.get::<String, _>("state"),
            r.get::<i64, _>("entries"),
        ),
        None => ("none".to_string(), 0),
    })
}

/// Lần quét nào đang phủ `path`, kèm trạng thái. Trả `root` để truy vấn search
/// lọc đúng một lần quét.
async fn covering_run(
    pool: &SqlitePool,
    server_id: &str,
    path: &str,
) -> AppResult<Option<(String, String)>> {
    use sqlx::Row;
    let row = sqlx::query(
        "SELECT state, root FROM index_runs
         WHERE server_id = ?1
           AND (root = ?2
                OR (root = '/' AND substr(?2, 1, 1) = '/')
                OR substr(?2, 1, length(root) + 1) = root || '/')
         ORDER BY LENGTH(root) DESC LIMIT 1",
    )
    .bind(server_id)
    .bind(path)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.get::<String, _>("state"), r.get::<String, _>("root"))))
}

/// Quét đệ quy `root` rồi nạp vào bảng `file_index`. Chạy nền; gọi lại khi đang
/// chạy thì bỏ qua.
pub async fn build_index(
    ssh: Arc<SshPool>,
    pool: SqlitePool,
    server: VpsServer,
    root: String,
    max_entries: usize,
) -> AppResult<i64> {
    let root = normalize_path(&root);
    let started = crate::db::now();

    // Chiếm quyền chạy một cách NGUYÊN TỬ.
    //
    // Việc kiểm "đang running thì bỏ qua" ở routes.rs là check-then-act: hai
    // request cùng lúc đều qua được, rồi cùng DELETE và cùng ghi vào
    // file_index, và lần xong trước đặt state='done' trong khi lần kia còn
    // chạy — search khi đó thấy `done` trên dữ liệu nửa chừng. `WHERE` dưới đây
    // đẩy việc tranh chấp xuống SQLite: chỉ một bên ghi được.
    let claimed = sqlx::query(
        "INSERT INTO index_runs (server_id, root, state, entries, message, started_at, finished_at)
         VALUES (?, ?, 'running', 0, '', ?, NULL)
         ON CONFLICT(server_id, root) DO UPDATE
           SET state='running', entries=0, message='', started_at=excluded.started_at,
               finished_at=NULL
         WHERE index_runs.state <> 'running'",
    )
    .bind(&server.id)
    .bind(&root)
    .bind(started)
    .execute(&pool)
    .await?
    .rows_affected();

    if claimed == 0 {
        tracing::debug!("index {root} đã có tiến trình khác đang chạy, bỏ qua");
        return Ok(0);
    }

    let result = run_index_scan(&ssh, &pool, &server, &root, max_entries).await;

    match &result {
        Ok(n) => {
            // Chạm trần = index KHÔNG đầy đủ. Đánh 'done' ở đây sẽ làm search
            // tin vào index thiếu và trả kết quả cụt mà không báo gì; 'partial'
            // giữ cho search rơi về quét trực tiếp (xem `search`).
            let truncated = *n as usize >= max_entries;
            let state = if truncated { "partial" } else { "done" };
            let message = if truncated {
                format!("đã dừng ở trần {max_entries} entry, index chưa đầy đủ")
            } else {
                String::new()
            };
            sqlx::query(
                "UPDATE index_runs SET state=?, entries=?, message=?, finished_at=?
                 WHERE server_id=? AND root=?",
            )
            .bind(state)
            .bind(*n)
            .bind(&message)
            .bind(crate::db::now())
            .bind(&server.id)
            .bind(&root)
            .execute(&pool)
            .await?;
            if truncated {
                tracing::warn!("index {root}: {message}");
            }
        }
        Err(e) => {
            sqlx::query(
                "UPDATE index_runs SET state='failed', message=?, finished_at=?
                 WHERE server_id=? AND root=?",
            )
            .bind(e.to_string())
            .bind(crate::db::now())
            .bind(&server.id)
            .bind(&root)
            .execute(&pool)
            .await?;
        }
    }
    result
}

async fn run_index_scan(
    ssh: &SshPool,
    pool: &SqlitePool,
    server: &VpsServer,
    root: &str,
    max_entries: usize,
) -> AppResult<i64> {
    sqlx::query("DELETE FROM file_index WHERE server_id = ? AND root = ?")
        .bind(&server.id)
        .bind(root)
        .execute(pool)
        .await?;

    // `-xdev` để không lạc sang mount khác (procfs, bind mount của docker...),
    // tránh quét vô tận và tránh đếm trùng.
    let cmd = format!(
        "LC_ALL=C.UTF-8 find {} -xdev -mindepth 1 -printf '{}' 2>/dev/null",
        shell_quote(root),
        FIND_FORMAT_FULL
    );

    let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(16);
    let scan = {
        let server = server.clone();
        async move { ssh.exec_to_channel(&server, &cmd, tx).await }
    };

    // `async move` là bắt buộc, không phải trang trí: block này phải SỞ HỮU `rx`.
    // Khi nó chỉ mượn, `rx` còn sống tới cuối hàm, nên lúc block thoát sớm
    // (chạm max_entries, hoặc `flush_batch` trả lỗi qua `?`) thì `tx.send()` ở
    // phía quét không bao giờ nhận được Err — nó chờ mãi trên một kênh đầy, và
    // `tokio::join!` dưới đây treo vĩnh viễn. Hệ quả: task nền giữ một channel
    // SSH, `find` trên VPS bị chặn ghi, và `index_runs.state` kẹt ở 'running'
    // nên thư mục đó không bao giờ index lại được.
    let consume = async move {
        let mut rx = rx;
        let mut pending = Vec::<u8>::new();
        let mut batch: Vec<IndexRow> = Vec::with_capacity(BATCH);
        let mut count: i64 = 0;
        let mut stopped = false;

        while let Some(chunk) = rx.recv().await {
            pending.extend_from_slice(&chunk);
            // Xử lý từng bản ghi trọn vẹn (phân tách bằng NUL); phần đuôi dở
            // dang để lại cho chunk sau. Chính lỗi "cắt giữa chừng" này, ở mức
            // byte UTF-8, là nguyên nhân terminal bản Java làm hỏng chữ có dấu.
            let mut start = 0;
            while let Some(nl) = pending[start..].iter().position(|&b| b == 0) {
                let line = &pending[start..start + nl];
                start += nl + 1;
                if let Some(row) = parse_index_line(line, root) {
                    batch.push(row);
                    count += 1;
                }
                if batch.len() >= BATCH {
                    flush_batch(pool, &server.id, root, &mut batch).await?;
                }
                if count as usize >= max_entries {
                    stopped = true;
                    break;
                }
            }
            pending.drain(..start);
            if stopped {
                break;
            }
        }
        if !batch.is_empty() {
            flush_batch(pool, &server.id, root, &mut batch).await?;
        }
        Ok::<i64, AppError>(count)
    };

    let (scan_res, count) = tokio::join!(scan, consume);
    let count = count?;
    // find thường trả 1 khi gặp thư mục cấm đọc; vẫn coi là thành công nếu có dữ liệu.
    if let Err(e) = scan_res {
        if count == 0 {
            return Err(e);
        }
        tracing::warn!("index {root} kết thúc có lỗi nhưng đã lấy được {count} entry: {e}");
    }
    Ok(count)
}

const BATCH: usize = 2000;

struct IndexRow {
    path: String,
    name: String,
    parent: String,
    kind: String,
    size: i64,
    mtime: i64,
}

fn parse_index_line(line: &[u8], _root: &str) -> Option<IndexRow> {
    let s = std::str::from_utf8(line).ok()?;
    let mut f = s.splitn(FIND_COLS, '\t');
    let kind = match f.next()? {
        "d" => "d",
        "l" => "l",
        _ => "f",
    }
    .to_string();
    let _perm = f.next()?;
    let _owner = f.next()?;
    let _group = f.next()?;
    let size: i64 = f.next()?.parse().unwrap_or(0);
    let mtime: i64 = f
        .next()?
        .split('.')
        .next()
        .and_then(|x| x.parse().ok())
        .unwrap_or(0);
    let path = f.next()?.to_string();
    if path.is_empty() {
        return None;
    }
    let (parent, name) = match path.rfind('/') {
        Some(0) => ("/".to_string(), path[1..].to_string()),
        Some(i) => (path[..i].to_string(), path[i + 1..].to_string()),
        None => ("/".to_string(), path.clone()),
    };
    Some(IndexRow {
        path,
        name: name.to_lowercase(),
        parent,
        kind,
        size,
        mtime,
    })
}

async fn flush_batch(
    pool: &SqlitePool,
    server_id: &str,
    root: &str,
    batch: &mut Vec<IndexRow>,
) -> AppResult<()> {
    let mut tx = pool.begin().await?;
    for r in batch.iter() {
        sqlx::query(
            "INSERT OR REPLACE INTO file_index
             (server_id, root, path, name, parent, kind, size, mtime)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(server_id)
        .bind(root)
        .bind(&r.path)
        .bind(&r.name)
        .bind(&r.parent)
        .bind(&r.kind)
        .bind(r.size)
        .bind(r.mtime)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    batch.clear();
    Ok(())
}

/// Tìm kiếm đệ quy trong `path`.
///
/// Dùng index nếu `path` nằm trong một lần quét đã xong. Chưa có index thì chạy
/// `find` trực tiếp để người dùng vẫn ra kết quả ngay — chậm hơn, nhưng không
/// bao giờ trả về "chưa index nên chịu".
pub async fn search(
    ssh: &SshPool,
    pool: &SqlitePool,
    server: &VpsServer,
    path: &str,
    needle: &str,
    limit: usize,
) -> AppResult<(Vec<SearchHit>, &'static str)> {
    use sqlx::Row;

    let path = normalize_path(path);
    let needle_lc = needle.trim().to_lowercase();
    if needle_lc.is_empty() {
        return Ok((Vec::new(), "empty"));
    }
    let limit = limit.clamp(1, 2000) as i64;

    let covering = covering_run(pool, &server.id, &path).await?;
    if let Some((_state, root)) = covering.filter(|(st, _)| st == "done") {
        let like = format!("%{}%", escape_like(&needle_lc));
        // Prefix so sánh bằng `substr`, không bằng LIKE: `_` trong tên thư mục
        // (ví dụ /srv/app_1) sẽ khớp nhầm /srv/appX1 và rò kết quả sang thư mục
        // anh em.
        let prefix = if path == "/" {
            "/".to_string()
        } else {
            format!("{path}/")
        };
        // `root = ?2` là bắt buộc: khoá chính của file_index là
        // (server_id, root, path), nên cùng một file nằm trong nhiều lần quét
        // chồng nhau (ví dụ đã index `/` rồi index thêm `/etc`) sẽ trả về nhiều
        // lần và ăn hết LIMIT bằng các dòng trùng.
        let rows = sqlx::query(
            "SELECT path, name, parent, kind, size, mtime FROM file_index
             WHERE server_id = ?1 AND root = ?2
               AND (path = ?3 OR substr(path, 1, length(?4)) = ?4)
               AND name LIKE ?5 ESCAPE '\\'
             ORDER BY kind DESC, LENGTH(path), path
             LIMIT ?6",
        )
        .bind(&server.id)
        .bind(&root)
        .bind(&path)
        .bind(&prefix)
        .bind(&like)
        .bind(limit)
        .fetch_all(pool)
        .await?;

        let hits = rows
            .iter()
            .map(|r| SearchHit {
                path: r.get("path"),
                name: basename(&r.get::<String, _>("path")),
                parent: r.get("parent"),
                kind: kind_label(&r.get::<String, _>("kind")),
                size: r.get("size"),
                mtime: r.get("mtime"),
            })
            .collect();
        return Ok((hits, "index"));
    }

    // Chưa có index — hỏi thẳng VPS. `-iname` để không phân biệt hoa thường.
    // Không dùng `| head -n`: head cắt theo dòng, còn bản ghi của ta phân tách
    // bằng NUL. Giới hạn số kết quả bằng `-print` rồi `.take()` ở phía Rust.
    let cmd = format!(
        "LC_ALL=C.UTF-8 find {} -xdev -mindepth 1 -iname {} -printf '{}' 2>/dev/null",
        shell_quote(&path),
        shell_quote(&format!("*{}*", needle.trim())),
        FIND_FORMAT_FULL
    );
    let out = ssh.exec(server, &cmd).await?;
    let hits = out
        .stdout
        .split('\0')
        .filter(|r| !r.is_empty())
        .filter_map(|l| parse_index_line(l.as_bytes(), &path))
        .take(limit as usize)
        .map(|r| SearchHit {
            name: basename(&r.path),
            path: r.path,
            parent: r.parent,
            kind: kind_label(&r.kind),
            size: r.size,
            mtime: r.mtime,
        })
        .collect();
    Ok((hits, "live"))
}

fn basename(p: &str) -> String {
    p.rsplit('/').next().unwrap_or(p).to_string()
}

fn kind_label(k: &str) -> String {
    match k {
        "d" => "directory",
        "l" => "link",
        _ => "file",
    }
    .to_string()
}

/// Vô hiệu hoá `%` và `_` do người dùng nhập, nếu không gõ `%` sẽ khớp mọi thứ.
fn escape_like(s: &str) -> String {
    s.replace('\\', r"\\").replace('%', r"\%").replace('_', r"\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: &'static str, size: u64, mtime: i64) -> FileEntry {
        FileEntry {
            name: name.into(),
            kind,
            size,
            mtime,
            permissions: "644".into(),
            owner: "root".into(),
            group: "root".into(),
        }
    }

    #[test]
    fn natural_sort_orders_numbers_by_value() {
        let mut v = vec!["file10", "file2", "file1"];
        v.sort_by(|a, b| natural_cmp(a, b));
        // Bản cũ dùng localeCompare thuần cho ra file1, file10, file2.
        assert_eq!(v, vec!["file1", "file2", "file10"]);
    }

    #[test]
    fn natural_sort_handles_embedded_and_padded_numbers() {
        let mut v = vec!["log_100.txt", "log_9.txt", "log_010.txt", "log_10.txt"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec!["log_9.txt", "log_010.txt", "log_10.txt", "log_100.txt"]
        );
    }

    #[test]
    fn natural_sort_is_case_insensitive() {
        assert_eq!(natural_cmp("Apple", "apple"), Ordering::Less); // chốt ổn định
        assert_eq!(natural_cmp("apple", "Banana"), Ordering::Less);
        assert_eq!(natural_cmp("Zebra", "apple"), Ordering::Greater);
    }

    #[test]
    fn dotdot_first_then_dirs_then_files() {
        let mut v = vec![
            entry("zzz.txt", "file", 1, 1),
            entry("aaa", "directory", 0, 1),
            entry("..", "directory", 0, 0),
            entry("bbb.txt", "file", 1, 1),
            entry("mmm", "directory", 0, 1),
        ];
        sort_entries(&mut v, SortKey::Name, SortOrder::Asc);
        let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["..", "aaa", "mmm", "bbb.txt", "zzz.txt"]);
    }

    #[test]
    fn sorting_by_mtime_uses_numbers_not_strings() {
        // Đây đúng là ca mà bản cũ làm sai: so chuỗi thì "9" > "10".
        let mut v = vec![
            entry("cu.txt", "file", 0, 1_600_000_000),
            entry("moi.txt", "file", 0, 1_700_000_000),
            entry("giua.txt", "file", 0, 1_650_000_000),
        ];
        sort_entries(&mut v, SortKey::Mtime, SortOrder::Desc);
        let names: Vec<_> = v.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["moi.txt", "giua.txt", "cu.txt"]);
    }

    #[test]
    fn dirs_stay_on_top_even_when_sorting_by_size() {
        let mut v = vec![
            entry("big.bin", "file", 999_999, 1),
            entry("adir", "directory", 0, 1),
        ];
        sort_entries(&mut v, SortKey::Size, SortOrder::Desc);
        assert_eq!(v[0].name, "adir");
    }

    #[test]
    fn parses_find_output() {
        let e = parse_find_line("d\t755\troot\troot\t4096\t1759900000.1234\tetc").unwrap();
        assert_eq!(e.name, "etc");
        assert_eq!(e.kind, "directory");
        assert_eq!(e.mtime, 1_759_900_000);
        assert_eq!(e.permissions, "755");

        let f = parse_find_line("f\t644\tjake\tstaff\t120\t1700000000.0\tghi chú.txt").unwrap();
        assert_eq!(f.name, "ghi chú.txt", "tên có dấu phải giữ nguyên");
        assert_eq!(f.size, 120);
    }

    #[test]
    fn path_helpers() {
        assert_eq!(normalize_path(""), "/");
        assert_eq!(normalize_path("/var/www/"), "/var/www");
        assert_eq!(normalize_path("var/www"), "/var/www");
        assert_eq!(normalize_path("/"), "/");
        assert_eq!(join_path("/", "etc"), "/etc");
        assert_eq!(join_path("/var", "www"), "/var/www");
    }

    #[test]
    fn like_wildcards_from_user_are_escaped() {
        // Không escape thì gõ "%" sẽ khớp toàn bộ index.
        assert_eq!(escape_like("100%_x"), r"100\%\_x");
    }

    #[test]
    fn index_line_splits_parent_and_name() {
        let r = parse_index_line(
            b"f\t644\troot\troot\t10\t1700000000.0\t/var/www/Index.HTML",
            "/var",
        )
        .unwrap();
        assert_eq!(r.parent, "/var/www");
        assert_eq!(r.name, "index.html", "tên lưu lowercase để search không phân biệt hoa thường");
        assert_eq!(r.path, "/var/www/Index.HTML");
    }
}
