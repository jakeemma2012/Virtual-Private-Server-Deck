//! So sánh 2 cách liệt kê thư mục: SFTP read_dir (cách bản Java dùng) vs
//! `find -maxdepth 1 -printf` qua exec. Chỉ ĐỌC, không tạo/xoá gì trên VPS.
//!
//! Chạy: SSH_HOST=... SSH_USER=root SSH_PASS=... cargo run --example bench_list

use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use std::time::Instant;

struct H;
impl client::Handler for H {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _k: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn exec(h: &client::Handle<H>, cmd: &str) -> anyhow::Result<String> {
    let mut ch = h.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out = Vec::new();
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("SSH_HOST")?;
    let port: u16 = std::env::var("SSH_PORT").unwrap_or("22".into()).parse()?;
    let user = std::env::var("SSH_USER").unwrap_or("root".into());
    let pass = std::env::var("SSH_PASS")?;

    let cfg = client::Config {
        nodelay: true,
        window_size: 2 * 1024 * 1024,
        ..Default::default()
    };
    let mut h = client::connect(Arc::new(cfg), (host.as_str(), port), H).await?;
    anyhow::ensure!(
        h.authenticate_password(&user, &pass).await?.success(),
        "auth fail"
    );

    // Tìm thư mục đông file nhất đang có sẵn (chỉ đọc metadata, không mở file).
    let probe = exec(
        &h,
        "for d in /usr/share/man/man1 /usr/lib/x86_64-linux-gnu /usr/bin \
                  /usr/share/doc /var/lib/dpkg/info /usr/include; do \
           [ -d \"$d\" ] && echo \"$(find \"$d\" -maxdepth 1 -mindepth 1 2>/dev/null | wc -l) $d\"; \
         done | sort -rn | head -4",
    )
    .await?;
    println!("thư mục có sẵn, theo số entry:\n{}", probe.trim());

    let dir = probe
        .lines()
        .next()
        .and_then(|l| l.split_once(' '))
        .map(|(_, d)| d.trim().to_string())
        .unwrap_or("/usr/bin".to_string());
    println!("\n=== đo trên {dir} ===");

    // Cách 1: SFTP read_dir — mỗi lần là nhiều round-trip SSH_FXP_READDIR.
    let ch = h.channel_open_session().await?;
    ch.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(ch.into_stream()).await?;
    let t1 = Instant::now();
    let c1 = sftp.read_dir(&dir).await?.count();
    let d1 = t1.elapsed();
    println!("SFTP read_dir : {c1} entry trong {d1:?}");

    // Cách 2: find -printf — một round-trip, server tự in sẵn size/mtime.
    let t2 = Instant::now();
    let out = exec(
        &h,
        &format!(
            "find {} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null",
            shell_quote(&dir)
        ),
    )
    .await?;
    let c2 = out.lines().count();
    let d2 = t2.elapsed();
    println!("find -printf  : {c2} entry trong {d2:?}  ({} byte truyền)", out.len());

    if d2.as_secs_f64() > 0.0 {
        println!("\n=> find nhanh hơn {:.1}x", d1.as_secs_f64() / d2.as_secs_f64());
    }

    h.disconnect(russh::Disconnect::ByApplication, "", "en").await?;
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
