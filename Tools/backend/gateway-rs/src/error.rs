use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),
    #[error("chưa đăng nhập hoặc token hết hạn")]
    Unauthorized,
    #[error("không tìm thấy {0}")]
    NotFound(String),
    #[error("lỗi SSH: {0}")]
    Ssh(String),
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match &self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized => StatusCode::UNAUTHORIZED,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Ssh(_) => StatusCode::BAD_GATEWAY,
            AppError::Db(_) | AppError::Other(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        // Chi tiết ở LOG, thông điệp chung cho client.
        //
        // Trước đây dòng dưới trả `self.to_string()` cho mọi lỗi, nên client
        // nhận nguyên văn thông điệp của sqlx ("UNIQUE constraint failed:
        // vps_servers.name", "unable to open database file") và của russh —
        // kể cả khi chưa đăng nhập, vì `find_user` lỗi cũng đi qua đây. Với
        // người đã đăng nhập thì lỗi russh thô còn là oracle dò cổng nội bộ.
        let client_msg = match &self {
            // Những lỗi này do người dùng gây ra và an toàn để nói thẳng.
            AppError::BadRequest(m) => m.clone(),
            AppError::Unauthorized | AppError::NotFound(_) => self.to_string(),
            // Lỗi SSH: chỉ trả nhóm, không trả chuỗi thô của russh.
            AppError::Ssh(detail) => {
                tracing::warn!("lỗi SSH: {detail}");
                classify_ssh(detail).to_string()
            }
            AppError::Db(_) | AppError::Other(_) => {
                tracing::error!("{status}: {self}");
                "lỗi nội bộ của server, xem log để biết chi tiết".to_string()
            }
        };
        let body = axum::Json(serde_json::json!({ "error": client_msg }));
        (status, body).into_response()
    }
}

/// Gom lỗi SSH về vài nhóm người dùng hiểu được, không phơi chuỗi thô.
fn classify_ssh(detail: &str) -> &'static str {
    let d = detail.to_lowercase();
    if d.contains("mật khẩu") || d.contains("auth") || d.contains("khoá riêng") {
        "xác thực SSH thất bại — kiểm tra lại user/mật khẩu/khoá của server"
    } else if d.contains("hết thời gian") || d.contains("timed out") || d.contains("timeout") {
        "hết thời gian kết nối tới server"
    } else if d.contains("refused") || d.contains("connect") {
        "không kết nối được tới server"
    } else if d.contains("no such file") || d.contains("not found") {
        "không tìm thấy đường dẫn trên server"
    } else if d.contains("permission") {
        "không có quyền thao tác trên đường dẫn đó"
    } else {
        "thao tác trên server thất bại"
    }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for AppError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        AppError::Ssh(e.to_string())
    }
}
