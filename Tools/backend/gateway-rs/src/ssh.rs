//! Tầng SSH: pool kết nối, exec lệnh, SFTP, và shell cho terminal.
//!
//! Những điểm sửa so với bản Java (JSch):
//!
//! * `nodelay = true` — JSch để Nagle bật, nên mỗi ký tự gõ phải chờ gộp gói.
//!   Đây là một phần của cảm giác "gõ bị lag".
//! * `channel_buffer_size` nhỏ — russh tự truyền backpressure xuống TCP khi
//!   consumer đọc chậm. Bản Java dùng `ConcurrentWebSocketSessionDecorator` với
//!   buffer 512KB và khi vượt thì **đóng session**; đó là lý do `tar -czf` làm
//!   terminal mất kết nối.
//! * keepalive ở tầng SSH + pool kiểm tra `is_closed()` trước khi tái dùng.

use crate::db::VpsServer;
use crate::error::{AppError, AppResult};
use russh::keys::{PrivateKeyWithHashAlg, decode_secret_key};
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// Cửa sổ flow-control cho session dùng chạy lệnh / SFTP: lớn để throughput cao.
const BULK_WINDOW: u32 = 2 * 1024 * 1024;
/// Cửa sổ cho terminal: nhỏ hơn nhiều. Khi client (browser) đọc chậm, ta muốn
/// tiến trình trên VPS bị chặn lại sớm — y hệt hành vi của một terminal thật
/// khi bạn bấm Ctrl+S — thay vì phình bộ đệm rồi vỡ.
const PTY_WINDOW: u32 = 256 * 1024;

pub struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // ponytail: chấp nhận mọi host key, giống StrictHostKeyChecking=no của bản
        // Java. Nâng cấp khi cần: lưu fingerprint lần đầu (TOFU) vào bảng
        // known_hosts rồi so sánh, cảnh báo khi đổi.
        let _ = key; // fingerprint sẽ dùng khi bật TOFU
        Ok(true)
    }
}

pub type Handle = client::Handle<Client>;

fn base_config(window_size: u32, channel_buffer_size: usize) -> client::Config {
    client::Config {
        window_size,
        channel_buffer_size,
        // Không có gì từ server trong 20s thì gửi keepalive; mất 3 lần thì đóng.
        keepalive_interval: Some(Duration::from_secs(20)),
        keepalive_max: 3,
        // Tắt Nagle: ký tự gõ vào terminal đi ngay, không chờ gộp gói.
        nodelay: true,
        ..Default::default()
    }
}

async fn authenticate(session: &mut Handle, server: &VpsServer) -> AppResult<()> {
    if let Some(key_pem) = server.ssh_private_key.as_deref().filter(|s| !s.is_empty()) {
        let key = decode_secret_key(key_pem, None)
            .map_err(|e| AppError::Ssh(format!("khoá riêng không đọc được: {e}")))?;
        let hash = session.best_supported_rsa_hash().await?.flatten();
        if session
            .authenticate_publickey(
                &server.ssh_username,
                PrivateKeyWithHashAlg::new(Arc::new(key), hash),
            )
            .await?
            .success()
        {
            return Ok(());
        }
        tracing::warn!(
            "xác thực bằng khoá riêng thất bại cho {}, thử mật khẩu",
            server.ip
        );
    }

    let Some(password) = server.ssh_password.as_deref().filter(|s| !s.is_empty()) else {
        return Err(AppError::Ssh(
            "server chưa có mật khẩu lẫn khoá riêng SSH".into(),
        ));
    };

    if session
        .authenticate_password(&server.ssh_username, password)
        .await?
        .success()
    {
        Ok(())
    } else {
        Err(AppError::Ssh(format!(
            "sai mật khẩu SSH cho {}@{}",
            server.ssh_username, server.ip
        )))
    }
}

async fn connect(server: &VpsServer, config: client::Config) -> AppResult<Handle> {
    let addr = (server.ip.as_str(), server.port);
    let mut session = tokio::time::timeout(
        Duration::from_secs(15),
        client::connect(Arc::new(config), addr, Client),
    )
    .await
    .map_err(|_| AppError::Ssh(format!("hết thời gian kết nối tới {}:{}", server.ip, server.port)))??;

    authenticate(&mut session, server).await?;
    Ok(session)
}

/// Pool giữ một session SSH dùng chung cho mỗi (ip, port, user), phục vụ exec và
/// SFTP. Terminal KHÔNG dùng pool — mỗi tab mở session riêng, để một tab chết
/// không kéo theo file manager.
#[derive(Default)]
pub struct SshPool {
    conns: RwLock<HashMap<String, Arc<Handle>>>,
}

fn pool_key(s: &VpsServer) -> String {
    format!("{}:{}:{}", s.ip, s.port, s.ssh_username)
}

impl SshPool {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn get(&self, server: &VpsServer) -> AppResult<Arc<Handle>> {
        let key = pool_key(server);

        if let Some(h) = self
            .conns
            .read()
            .await
            .get(&key)
            .filter(|h| !h.is_closed())
        {
            return Ok(h.clone());
        }

        let handle = Arc::new(connect(server, base_config(BULK_WINDOW, 256)).await?);
        self.conns.write().await.insert(key, handle.clone());
        Ok(handle)
    }

    pub async fn drop_conn(&self, server: &VpsServer) {
        self.conns.write().await.remove(&pool_key(server));
    }

    /// Session riêng cho terminal, cửa sổ nhỏ để backpressure đến sớm.
    pub async fn connect_pty(&self, server: &VpsServer) -> AppResult<Handle> {
        connect(server, base_config(PTY_WINDOW, 32)).await
    }

    /// Chạy một lệnh, trả (exit_code, stdout, stderr).
    pub async fn exec(&self, server: &VpsServer, command: &str) -> AppResult<CommandOutput> {
        match self.exec_once(server, command).await {
            Ok(out) => Ok(out),
            // Session trong pool có thể đã chết giữa lúc kiểm tra và lúc dùng;
            // bỏ nó đi rồi thử lại đúng một lần.
            Err(e) => {
                tracing::debug!("exec lỗi ({e}), thử lại với session mới");
                self.drop_conn(server).await;
                self.exec_once(server, command).await
            }
        }
    }

    async fn exec_once(&self, server: &VpsServer, command: &str) -> AppResult<CommandOutput> {
        let handle = self.get(server).await?;
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut code = None;

        let mut signal: Option<String> = None;

        // KHÔNG break ở `Eof`. Server gửi EOF khi tiến trình đóng stdout, và
        // `exit-status` thường tới SAU đó. Thoát sớm ở Eof nghĩa là `code` còn
        // None rồi bị `unwrap_or(0)` biến thành "thành công" — lệnh thất bại sẽ
        // được báo là xong, với output cụt.
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
                ChannelMsg::ExtendedData { ref data, .. } => stderr.extend_from_slice(data),
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                ChannelMsg::ExitSignal { ref signal_name, .. } => {
                    signal = Some(format!("{signal_name:?}"));
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        // Bị kill bằng signal thì không có exit-status; đó là thất bại, không
        // phải thành công im lặng.
        if let Some(sig) = signal {
            return Err(AppError::Ssh(format!("lệnh bị kết thúc bởi signal {sig}")));
        }
        let Some(code) = code else {
            // Mất kết nối giữa chừng cũng rơi vào đây.
            return Err(AppError::Ssh(
                "không nhận được exit status (kết nối đứt giữa lúc chạy lệnh?)".into(),
            ));
        };

        Ok(CommandOutput {
            exit_code: code as i32,
            // from_utf8_lossy ở ĐÂY thì an toàn: đã có trọn vẹn output, không
            // phải decode từng chunk 8KB như bản Java (chỗ làm hỏng chữ có dấu).
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
        })
    }

    /// Chạy lệnh và đẩy stdout ra `tx` theo từng chunk, thay vì gom hết vào RAM.
    ///
    /// Cần cho việc index: `find /` trên box test trả 1,1 triệu dòng (~100MB).
    /// `exec()` sẽ ngốn 100MB RAM cho một server; bản này giữ bộ nhớ gần như
    /// hằng số, và vì `tx.send().await` chặn khi consumer chậm nên backpressure
    /// tự truyền về tới tiến trình `find` trên VPS.
    pub async fn exec_to_channel(
        &self,
        server: &VpsServer,
        command: &str,
        tx: tokio::sync::mpsc::Sender<Vec<u8>>,
    ) -> AppResult<i32> {
        // Kết nối RIÊNG, không lấy từ pool.
        //
        // russh chặn vòng lặp session khi bộ đệm của một channel đầy. Nếu quét
        // chạy trên session dùng chung và consumer (ghi SQLite) chậm lại một
        // nhịp, thì MỌI channel khác trên cùng kết nối — liệt kê thư mục, tải
        // file, cả keepalive — đứng theo. Backpressure là cố ý, nhưng nó phải
        // bị cô lập trong kết nối của chính việc quét.
        let session = connect(server, base_config(BULK_WINDOW, 32)).await?;
        let mut channel = session.channel_open_session().await?;
        channel.exec(true, command).await?;

        let mut code = None;
        let mut consumer_gone = false;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    if tx.send(data.to_vec()).await.is_err() {
                        consumer_gone = true;
                        break;
                    }
                }
                ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                // Như ở exec_once: Eof tới trước exit-status, không được thoát ở đó.
                ChannelMsg::Close => break,
                _ => {}
            }
        }

        if consumer_gone {
            // Drop channel KHÔNG gửi close cho server, nên `find` sẽ chạy tới
            // hết (1,1 triệu dòng trên box test) và giữ một slot MaxSessions.
            // Phải đóng tường minh.
            let _ = channel.eof().await;
            let _ = channel.close().await;
            return Err(AppError::Ssh("người nhận đã huỷ, đã dừng lệnh".into()));
        }

        let _ = session
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        Ok(code.unwrap_or(0) as i32)
    }

    /// Mở một phiên SFTP. Mỗi lần gọi là một channel mới trên session dùng chung.
    pub async fn sftp(&self, server: &VpsServer) -> AppResult<SftpSession> {
        match self.sftp_once(server).await {
            Ok(s) => Ok(s),
            Err(e) => {
                tracing::debug!("mở SFTP lỗi ({e}), thử lại với session mới");
                self.drop_conn(server).await;
                self.sftp_once(server).await
            }
        }
    }

    async fn sftp_once(&self, server: &VpsServer) -> AppResult<SftpSession> {
        let handle = self.get(server).await?;
        let channel = handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        Ok(SftpSession::new(channel.into_stream()).await?)
    }
}

pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl CommandOutput {
    /// stdout nếu lệnh thành công, ngược lại lỗi kèm stderr.
    pub fn ok_stdout(self) -> AppResult<String> {
        if self.exit_code == 0 {
            Ok(self.stdout)
        } else {
            let msg = if self.stderr.trim().is_empty() {
                self.stdout
            } else {
                self.stderr
            };
            Err(AppError::Ssh(format!(
                "lệnh thoát với mã {}: {}",
                self.exit_code,
                msg.trim()
            )))
        }
    }
}

/// Bọc một chuỗi thành single-quoted argument an toàn cho shell POSIX.
/// Cần vì mọi thao tác file đều ghép đường dẫn do người dùng nhập vào lệnh shell;
/// bản Java ghép thẳng (`"chmod " + mode + " " + path`) nên một tên file chứa
/// `; rm -rf /` là chạy thật.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::shell_quote;

    #[test]
    fn quotes_plain_path() {
        assert_eq!(shell_quote("/var/www/html"), "'/var/www/html'");
    }

    #[test]
    fn neutralises_command_injection() {
        // Tên file độc: nếu ghép thẳng thì `rm -rf /` sẽ chạy.
        let q = shell_quote("a'; rm -rf / #");
        assert_eq!(q, r"'a'\''; rm -rf / #'");
        // Sau khi bọc, không còn dấu nháy nào "hở" để kết thúc chuỗi sớm.
        assert!(q.starts_with('\'') && q.ends_with('\''));
    }

    #[test]
    fn handles_spaces_and_unicode() {
        assert_eq!(shell_quote("/tmp/thư mục của tôi"), "'/tmp/thư mục của tôi'");
    }
}
