use anyhow::{Context, Result};
use std::path::PathBuf;

/// Toàn bộ cấu hình đọc từ biến môi trường. Không hardcode secret nào trong code
/// — đây là điểm khác bản Java (jwt.secret và admin password nằm thẳng trong
/// application.yml, ai đọc được repo là đọc được khoá).
pub struct Config {
    pub bind: String,
    pub db_path: String,
    /// Khoá AES-256 (32 byte) để mã hoá mật khẩu SSH.
    pub secret_key: [u8; 32],
    /// Khoá ký JWT.
    pub jwt_secret: Vec<u8>,
    pub jwt_ttl_secs: i64,
    /// Thư mục chứa frontend đã build. Có thì axum serve luôn, không cần nginx/node.
    pub static_dir: Option<PathBuf>,
    pub tls: Option<(PathBuf, PathBuf)>,
    /// Chỉ dùng khi DB chưa có user nào.
    pub bootstrap_admin: Option<(String, String)>,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let secret_b64 = std::env::var("JAKE_SECRET_KEY").context(
            "thiếu JAKE_SECRET_KEY (32 byte base64). Sinh bằng: \
             openssl rand -base64 32",
        )?;
        let raw = base64_decode(&secret_b64).context("JAKE_SECRET_KEY không phải base64 hợp lệ")?;
        let secret_key: [u8; 32] = raw
            .try_into()
            .map_err(|_| anyhow::anyhow!("JAKE_SECRET_KEY phải đúng 32 byte sau khi decode"))?;

        let jwt_secret = std::env::var("JAKE_JWT_SECRET")
            .context("thiếu JAKE_JWT_SECRET (sinh bằng: openssl rand -base64 48)")?
            .into_bytes();
        if jwt_secret.len() < 32 {
            anyhow::bail!("JAKE_JWT_SECRET quá ngắn, cần >= 32 ký tự");
        }

        let tls = match (std::env::var("JAKE_TLS_CERT"), std::env::var("JAKE_TLS_KEY")) {
            (Ok(c), Ok(k)) => Some((PathBuf::from(c), PathBuf::from(k))),
            _ => None,
        };

        let bootstrap_admin = match (
            std::env::var("JAKE_ADMIN_USER"),
            std::env::var("JAKE_ADMIN_PASSWORD"),
        ) {
            (Ok(u), Ok(p)) if !u.is_empty() && !p.is_empty() => Some((u, p)),
            _ => None,
        };

        Ok(Self {
            bind: env_or("JAKE_BIND", "0.0.0.0:8080"),
            db_path: env_or("JAKE_DB", "./data/jake.db"),
            secret_key,
            jwt_secret,
            jwt_ttl_secs: env_or("JAKE_JWT_TTL_SECS", "86400").parse().unwrap_or(86400),
            static_dir: std::env::var("JAKE_STATIC_DIR").ok().map(PathBuf::from),
            tls,
            bootstrap_admin,
        })
    }
}

fn base64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.decode(s.trim())?)
}
