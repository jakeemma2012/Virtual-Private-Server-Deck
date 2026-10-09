//! VPSDeck — gateway.
//!
//! Một binary duy nhất: TLS + frontend tĩnh + REST + WebSocket terminal.
//! Thay cho bộ ba nginx (5678) + Node/Next.js (4567) + JVM/Spring (8080).

mod auth;
mod config;
mod crypto;
mod db;
mod error;
mod files;
mod routes;
mod ssh;
mod terminal;

use axum::Router;
use axum::routing::{delete, get, post, put};
use config::Config;
use crypto::Secrets;
use files::DirCache;
use sqlx::SqlitePool;
use ssh::SshPool;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub struct AppState {
    pub pool: SqlitePool,
    pub secrets: Secrets,
    pub jwt: auth::Jwt,
    pub ssh: Arc<SshPool>,
    pub cache: Arc<DirCache>,
    pub tasks: RwLock<HashMap<String, routes::Task>>,
    pub max_index_entries: usize,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,russh=warn,sqlx=warn".into()),
        )
        .init();

    // russh và rustls đều cần provider mật mã được chọn tường minh.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let cfg = Config::from_env()?;
    let pool = db::init(&cfg.db_path).await?;
    let secrets = Secrets::new(&cfg.secret_key);

    // Dữ liệu import từ H2 còn plaintext -> mã hoá lại ngay lần chạy đầu.
    match db::reseal_legacy_secrets(&pool, &secrets).await {
        Ok(0) => {}
        Ok(n) => tracing::info!("đã mã hoá lại secret của {n} server"),
        Err(e) => tracing::error!("không mã hoá lại được secret: {e}"),
    }

    // Khoá sai thì DỪNG ngay, đừng chạy tiếp rồi trả 500 cho mọi request.
    // Quan trọng hơn: nếu chạy tiếp, người dùng thêm server mới sẽ làm DB lẫn
    // hai khoá khác nhau và không khoá nào giải mã được tất cả.
    verify_secret_key(&pool, &secrets).await?;

    // Quét bị ngắt giữa chừng (restart, crash, task panic) để lại
    // index_runs.state='running' vĩnh viễn, và từ đó mọi lần index lại thư mục
    // đó đều bị bỏ qua với thông báo "đang quét".
    match sqlx::query(
        "UPDATE index_runs SET state='failed', message='bị ngắt do khởi động lại'
         WHERE state='running'",
    )
    .execute(&pool)
    .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            tracing::info!("đặt lại {} lần index bị ngắt giữa chừng", r.rows_affected());
        }
        Ok(_) => {}
        Err(e) => tracing::error!("không đặt lại được index_runs: {e}"),
    }

    bootstrap_admin(&pool, &cfg).await?;

    let state = Arc::new(AppState {
        pool,
        secrets,
        jwt: auth::Jwt::new(&cfg.jwt_secret, cfg.jwt_ttl_secs),
        ssh: Arc::new(SshPool::new()),
        cache: Arc::new(DirCache::new()),
        tasks: RwLock::new(HashMap::new()),
        max_index_entries: std::env::var("JAKE_MAX_INDEX_ENTRIES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2_000_000),
    });

    let app = build_router(state.clone(), &cfg);
    serve(app, &cfg).await
}

fn build_router(state: Arc<AppState>, cfg: &Config) -> Router {
    // Mọi thứ dưới /api cần token, trừ /api/auth/login.
    let protected = Router::new()
        .route("/servers", get(routes::list_servers).post(routes::create_server))
        .route(
            "/servers/{id}",
            get(routes::get_server)
                .put(routes::update_server)
                .delete(routes::delete_server),
        )
        .route("/servers/{id}/test", post(routes::test_connection))
        .route("/servers/{id}/pin", put(routes::set_pin))
        .route("/servers/{id}/stats", get(routes::server_stats))
        .route("/servers/{id}/execute", post(routes::execute))
        // --- file ---
        .route("/servers/{id}/files/list", get(routes::list_files))
        .route("/servers/{id}/files/search", get(routes::search_files))
        .route(
            "/servers/{id}/files/index",
            get(routes::index_status).post(routes::start_index),
        )
        .route("/servers/{id}/files/read", get(routes::read_file))
        .route("/servers/{id}/files/write", post(routes::write_file))
        .route("/servers/{id}/files/download", get(routes::download_file))
        // 10GB CHỈ cho route upload. Trước đây giới hạn này được gắn cho cả
        // router, nên `POST /api/auth/login` — endpoint không cần token — cũng
        // nhận body 10GB, mà extractor Json gom hết vào RAM trước khi parse:
        // một request vài GB là đủ làm OOM gateway đang giữ 11 phiên SSH.
        .route(
            "/servers/{id}/files/upload",
            post(routes::upload_file)
                .layer(axum::extract::DefaultBodyLimit::max(10 * 1024 * 1024 * 1024)),
        )
        .route("/servers/{id}/files", delete(routes::delete_file))
        .route("/servers/{id}/files/mkdir", post(routes::mkdir))
        .route("/servers/{id}/files/rename", post(routes::rename))
        .route("/servers/{id}/files/chmod", post(routes::chmod))
        .route("/servers/{id}/files/compress", post(routes::compress))
        .route(
            "/servers/{id}/files/compress/status/{taskId}",
            get(routes::compress_status),
        )
        // --- khác ---
        .route("/system/stats", get(routes::system_stats))
        .route("/alerts", get(routes::list_alerts).post(routes::create_alert))
        .route(
            "/alerts/{id}",
            put(routes::update_alert).delete(routes::delete_alert),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    let api = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/health", get(routes::health))
        .merge(protected);

    let mut app = Router::new()
        .nest("/api", api)
        .route("/ws/terminal", get(terminal::handler))
        // Trần mặc định cho mọi route còn lại. Route upload tự nới riêng ở trên.
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(TraceLayer::new_for_http())
        // 4,2MB JS của frontend nén gzip còn khoảng một phần tư.
        .layer(tower_http::compression::CompressionLayer::new().gzip(true))
        // CORS mở chỉ cần khi dev (frontend chạy port khác). Ở production
        // frontend do chính binary này serve nên cùng origin. Không bật
        // allow_credentials, và auth bằng Bearer header chứ không bằng cookie,
        // nên đây không phải đường CSRF.
        .layer(CorsLayer::permissive())
        .with_state(state);

    // Serve frontend đã build. `fallback` để route client-side (/dashboard/...)
    // trả về index.html thay vì 404.
    if let Some(dir) = &cfg.static_dir {
        let index = dir.join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(dir)
                .append_index_html_on_directories(true)
                .fallback(tower_http::services::ServeFile::new(index)),
        );
        tracing::info!("serve frontend từ {}", dir.display());
    }

    app
}

/// Thử giải mã mọi secret đã mã hoá trong DB. Một giá trị không mở được nghĩa
/// là `JAKE_SECRET_KEY` không phải khoá đã dùng để ghi DB này.
async fn verify_secret_key(pool: &SqlitePool, secrets: &Secrets) -> anyhow::Result<()> {
    use sqlx::Row;
    let rows = sqlx::query("SELECT name, ssh_password, ssh_private_key FROM vps_servers")
        .fetch_all(pool)
        .await?;
    for r in &rows {
        for col in ["ssh_password", "ssh_private_key"] {
            let v: Option<String> = r.get(col);
            if secrets.open(v.as_deref()).is_err() {
                let name: String = r.get("name");
                anyhow::bail!(
                    "JAKE_SECRET_KEY không khớp với dữ liệu trong DB (lỗi ở server '{name}', cột {col}).\n\
                     Dùng lại đúng khoá đã mã hoá DB, hoặc nhập lại mật khẩu SSH nếu khoá cũ đã mất."
                );
            }
        }
    }
    Ok(())
}

async fn bootstrap_admin(pool: &SqlitePool, cfg: &Config) -> anyhow::Result<()> {
    let n = db::count_users(pool).await?;
    match (&cfg.bootstrap_admin, n) {
        (Some((user, pass)), _) => {
            // Có env thì luôn áp dụng — đây cũng là cách đổi mật khẩu đã quên.
            let hash = auth::hash_password(pass)?;
            db::upsert_user(pool, user, &hash, "ADMIN").await?;
            tracing::warn!(
                "đã đặt lại mật khẩu tài khoản '{user}' từ biến môi trường. \
                 BỎ JAKE_ADMIN_PASSWORD sau khi đăng nhập được — còn đặt thì mỗi \
                 lần khởi động lại sẽ ghi đè mật khẩu."
            );
        }
        (None, 0) => {
            anyhow::bail!(
                "DB chưa có tài khoản nào. Chạy lần đầu với:\n  \
                 JAKE_ADMIN_USER=admin JAKE_ADMIN_PASSWORD='<mật khẩu mạnh>' ./gateway-rs"
            );
        }
        (None, _) => {}
    }
    Ok(())
}

async fn serve(app: Router, cfg: &Config) -> anyhow::Result<()> {
    let addr: std::net::SocketAddr = cfg.bind.parse()?;

    match &cfg.tls {
        Some((cert, key)) => {
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key).await?;
            tracing::info!("HTTPS trên https://{addr}");
            axum_server::bind_rustls(addr, tls)
                .serve(app.into_make_service())
                .await?;
        }
        None => {
            tracing::warn!(
                "chạy HTTP (chưa có TLS). Đặt JAKE_TLS_CERT và JAKE_TLS_KEY để bật HTTPS — \
                 không có TLS thì token và mật khẩu đi dạng rõ trên đường truyền."
            );
            let listener = tokio::net::TcpListener::bind(addr).await?;
            tracing::info!("HTTP trên http://{addr}");
            axum::serve(listener, app).await?;
        }
    }
    Ok(())
}
