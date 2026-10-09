//! Đăng nhập, JWT và middleware chặn request chưa xác thực.
//!
//! Bản Java để `/ws/**` ở `permitAll()`, nghĩa là WebSocket terminal — đường
//! vào shell root của mọi VPS — không cần token. Ở đây terminal dùng chung một
//! hàm xác thực với REST, chỉ khác chỗ lấy token: browser không đặt được header
//! `Authorization` cho WebSocket, nên token đi qua subprotocol (ưu tiên) hoặc
//! query param.

use crate::db;
use crate::error::{AppError, AppResult};
use argon2::password_hash::{PasswordHasher, PasswordVerifier, phc::PasswordHash};
use argon2::Argon2;
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub fn hash_password(plain: &str) -> AppResult<String> {
    Argon2::default()
        .hash_password(plain.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| AppError::Other(anyhow::anyhow!("băm mật khẩu thất bại: {e}")))
}

pub fn verify_password(plain: &str, stored_hash: &str) -> bool {
    match PasswordHash::new(stored_hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(plain.as_bytes(), &parsed)
            .is_ok(),
        Err(e) => {
            tracing::warn!("hash mật khẩu trong DB không đọc được: {e}");
            false
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub role: String,
    pub exp: i64,
}

pub struct Jwt {
    enc: EncodingKey,
    dec: DecodingKey,
    ttl: i64,
}

impl Jwt {
    pub fn new(secret: &[u8], ttl_secs: i64) -> Self {
        Self {
            enc: EncodingKey::from_secret(secret),
            dec: DecodingKey::from_secret(secret),
            ttl: ttl_secs,
        }
    }

    pub fn issue(&self, username: &str, role: &str) -> AppResult<String> {
        let claims = Claims {
            sub: username.to_string(),
            role: role.to_string(),
            exp: db::now() + self.ttl,
        };
        jsonwebtoken::encode(&Header::default(), &claims, &self.enc)
            .map_err(|e| AppError::Other(anyhow::anyhow!("tạo token thất bại: {e}")))
    }

    pub fn verify(&self, token: &str) -> Option<Claims> {
        let mut v = Validation::new(Algorithm::HS256);
        v.validate_exp = true;
        // jsonwebtoken mặc định cho dư 60s để bù lệch đồng hồ. Ở đây chính
        // process này vừa ký vừa kiểm nên không có lệch, và dư 60s chỉ làm
        // token sống thêm sau khi đã hết hạn. Đặt 0 cho đúng ý.
        v.leeway = 0;
        jsonwebtoken::decode::<Claims>(token, &self.dec, &v)
            .ok()
            .map(|d| d.claims)
    }
}

// ---------------------------------------------------------------------------
// Lấy token từ request
// ---------------------------------------------------------------------------

/// Token cho REST: **chỉ** header `Authorization: Bearer`.
///
/// Trước đây hàm này cũng nhận `?token=` và subprotocol cho mọi route `/api`.
/// Token trong query string bị ghi vào access log của proxy, vào history của
/// browser, vào header `Referer`, và vào span của `TraceLayer` khi bật
/// `RUST_LOG=debug` — tức một bearer sống 24 giờ bị rải ra nhiều nơi. WebSocket
/// vẫn cần hai đường kia vì browser không cho đặt header cho WS; đó là việc của
/// `extract_token_ws`.
pub fn extract_token(req: &Request) -> Option<String> {
    let h = req.headers().get(axum::http::header::AUTHORIZATION)?;
    h.to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(|t| t.trim().to_string())
}

/// Token cho WebSocket: subprotocol `jake-token.<token>` (ưu tiên), rồi
/// `?token=`. Dùng chung hàm này cho cả `/ws/terminal` để hai đường không lệch.
pub fn extract_token_ws(headers: &axum::http::HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(t) = headers
        .get("sec-websocket-protocol")
        .and_then(|h| h.to_str().ok())
        .and_then(|raw| {
            raw.split(',')
                .find_map(|p| p.trim().strip_prefix("jake-token."))
                .map(str::to_string)
        })
    {
        return Some(t);
    }
    query.and_then(|q| {
        q.split('&')
            .find_map(|kv| kv.strip_prefix("token=").map(percent_decode))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            // `is_ascii_hexdigit` trước khi parse: from_str_radix nhận cả dấu
            // (`%+f` thành 0x0f), còn slicing &s[i+1..i+3] sẽ panic nếu cắt
            // giữa một ký tự nhiều byte.
            let hex = &bytes[i + 1..i + 3];
            if let Some(b) = std::str::from_utf8(hex)
                .ok()
                .filter(|h| h.bytes().all(|c| c.is_ascii_hexdigit()))
                .and_then(|h| u8::from_str_radix(h, 16).ok())
            {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Middleware cho toàn bộ `/api/*` trừ `/api/auth/login`.
pub async fn require_auth(
    State(state): State<Arc<crate::AppState>>,
    req: Request,
    next: Next,
) -> Result<Response, AppError> {
    let token = extract_token(&req).ok_or(AppError::Unauthorized)?;
    state.jwt.verify(&token).ok_or(AppError::Unauthorized)?;
    Ok(next.run(req).await)
}

// ---------------------------------------------------------------------------
// Handler đăng nhập
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub token: String,
    pub username: String,
    pub role: String,
}

/// Chặn trên độ dài trước khi băm. Argon2 cấu hình mặc định tốn 19MiB RAM và
/// hàng chục ms CPU mỗi lần gọi, nên một mật khẩu vài trăm MB là đủ để biến
/// endpoint không cần token này thành đường làm cạn tài nguyên.
const MAX_USERNAME_LEN: usize = 256;
const MAX_PASSWORD_LEN: usize = 1024;

pub async fn login(
    State(state): State<Arc<crate::AppState>>,
    axum::Json(body): axum::Json<LoginRequest>,
) -> AppResult<axum::Json<LoginResponse>> {
    if body.username.len() > MAX_USERNAME_LEN || body.password.len() > MAX_PASSWORD_LEN {
        return Err(AppError::BadRequest("tài khoản hoặc mật khẩu quá dài".into()));
    }

    let user = db::find_user(&state.pool, &body.username).await?;

    // Luôn chạy một lần verify dù user không tồn tại, để thời gian phản hồi
    // không tiết lộ username nào có thật.
    let (hash, found) = match &user {
        Some(u) => (u.password_hash.clone(), true),
        None => (DUMMY_HASH.to_string(), false),
    };
    let ok = verify_password(&body.password, &hash);

    if !found || !ok {
        // Không log nguyên văn username: người dùng hay dán nhầm mật khẩu vào
        // ô này, và ký tự điều khiển trong đó có thể làm giả dòng log.
        tracing::warn!("đăng nhập thất bại (username {} ký tự)", body.username.len());
        return Err(AppError::BadRequest("sai tài khoản hoặc mật khẩu".into()));
    }

    let user = user.expect("đã kiểm tra found");
    let token = state.jwt.issue(&user.username, &user.role)?;
    Ok(axum::Json(LoginResponse {
        token,
        username: user.username,
        role: user.role,
    }))
}

/// Hash của một mật khẩu ngẫu nhiên, chỉ dùng để tiêu tốn thời gian bằng với
/// nhánh "user có thật" (chống timing attack dò username).
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2E$\
                          SXetHCBJ6MyPWhVKFBVnLbmUPUqQhTqJ8GS2qPcJdWA";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify() {
        let h = hash_password("mật-khẩu-Rất-Dài-123").unwrap();
        assert!(h.starts_with("$argon2id$"), "phải là argon2id: {h}");
        assert!(verify_password("mật-khẩu-Rất-Dài-123", &h));
        assert!(!verify_password("sai", &h));
    }

    #[test]
    fn same_password_hashes_differently() {
        let a = hash_password("abc").unwrap();
        let b = hash_password("abc").unwrap();
        assert_ne!(a, b, "salt phải khác nhau mỗi lần");
    }

    #[test]
    fn garbage_hash_does_not_panic() {
        assert!(!verify_password("x", "không-phải-phc-string"));
        assert!(!verify_password("x", ""));
    }

    #[test]
    fn dummy_hash_params_match_real_ones() {
        // Nếu tham số của DUMMY_HASH lệch với Argon2::default() thì nhánh chống
        // timing attack sẽ tốn thời gian khác nhánh thật, và lại rò rỉ đúng cái
        // nó định che. Nâng cấp crate argon2 có thể làm lệch âm thầm.
        let parsed = PasswordHash::new(DUMMY_HASH).expect("DUMMY_HASH phải hợp lệ");
        let real = hash_password("x").unwrap();
        let real_parsed = PasswordHash::new(&real).unwrap();
        assert_eq!(
            parsed.algorithm, real_parsed.algorithm,
            "thuật toán của DUMMY_HASH lệch với hash thật"
        );
        assert_eq!(
            parsed.params, real_parsed.params,
            "tham số (m,t,p) của DUMMY_HASH lệch với hash thật"
        );
    }

    #[test]
    fn dummy_hash_is_parseable() {
        // Nếu DUMMY_HASH sai định dạng thì nhánh chống timing sẽ trả về sớm
        // và lại rò rỉ đúng cái ta muốn che.
        assert!(
            PasswordHash::new(DUMMY_HASH).is_ok(),
            "DUMMY_HASH phải là PHC string hợp lệ"
        );
    }

    #[test]
    fn jwt_roundtrip_and_rejection() {
        let jwt = Jwt::new(b"a-secret-that-is-long-enough-for-hs256!!", 3600);
        let t = jwt.issue("admin", "ADMIN").unwrap();
        let c = jwt.verify(&t).expect("token vừa tạo phải hợp lệ");
        assert_eq!(c.sub, "admin");
        assert_eq!(c.role, "ADMIN");

        assert!(jwt.verify("rác").is_none());
        // Token ký bằng khoá khác phải bị từ chối.
        let other = Jwt::new(b"another-secret-also-long-enough-here!!!!", 3600);
        assert!(other.verify(&t).is_none());
    }

    #[test]
    fn expired_token_rejected() {
        let jwt = Jwt::new(b"a-secret-that-is-long-enough-for-hs256!!", -10);
        let t = jwt.issue("admin", "ADMIN").unwrap();
        assert!(jwt.verify(&t).is_none(), "token đã hết hạn phải bị loại");
    }

    #[test]
    fn decodes_percent_encoded_query_token() {
        assert_eq!(percent_decode("a%2Eb%2Dc"), "a.b-c");
        assert_eq!(percent_decode("x+y"), "x y");
        assert_eq!(percent_decode("plain"), "plain");
    }
}
