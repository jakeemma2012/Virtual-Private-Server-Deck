//! Kiểm tra tầng SSH thật: exec, chữ có dấu, SFTP, đếm file.
//! Chạy: SSH_HOST=... SSH_PORT=22 SSH_USER=root SSH_PASS=... cargo run --example probe
//! Chỉ dùng để verify trong lúc phát triển, không nằm trong binary production.

use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, client};
use russh_sftp::client::SftpSession;
use std::sync::Arc;
use std::time::{Duration, Instant};

struct H;
impl client::Handler for H {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _k: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn exec(h: &client::Handle<H>, cmd: &str) -> anyhow::Result<(i32, String)> {
    let mut ch = h.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out = Vec::new();
    let mut code = 0;
    while let Some(m) = ch.wait().await {
        match m {
            ChannelMsg::Data { ref data } => out.extend_from_slice(data),
            ChannelMsg::ExitStatus { exit_status } => code = exit_status as i32,
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    Ok((code, String::from_utf8_lossy(&out).into_owned()))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let host = std::env::var("SSH_HOST")?;
    let port: u16 = std::env::var("SSH_PORT").unwrap_or("22".into()).parse()?;
    let user = std::env::var("SSH_USER").unwrap_or("root".into());
    let pass = std::env::var("SSH_PASS")?;

    let cfg = client::Config {
        nodelay: true,
        keepalive_interval: Some(Duration::from_secs(20)),
        ..Default::default()
    };

    let t = Instant::now();
    let mut h = client::connect(Arc::new(cfg), (host.as_str(), port), H).await?;
    println!("connect       : {:?}", t.elapsed());

    anyhow::ensure!(
        h.authenticate_password(&user, &pass).await?.success(),
        "auth thất bại"
    );
    println!("auth          : OK ({:?})", t.elapsed());

    let (_, os) = exec(&h, "cat /etc/os-release | grep -m1 PRETTY_NAME | cut -d'\"' -f2").await?;
    println!("os            : {}", os.trim());

    // Chữ có dấu phải về nguyên vẹn — đây là bug chính của bản Java.
    let probe = "Tiếng Việt: ế ộ ữ ậ ằ — Ngọc Rồng";
    let (_, got) = exec(&h, &format!("printf '%s' {}", crate_quote(probe))).await?;
    println!(
        "utf8 roundtrip: {}  [{}]",
        if got == probe { "OK" } else { "LỖI" },
        got
    );

    // Output lớn liên tục — mô phỏng `tar -czf` xả dữ liệu (ca làm bản Java đứt WS).
    let t2 = Instant::now();
    let (_, big) = exec(&h, "head -c 8000000 /dev/urandom | base64").await?;
    println!(
        "burst 8MB     : {} byte trong {:?}",
        big.len(),
        t2.elapsed()
    );

    // SFTP + đếm file để biết chi phí thật của thư mục lớn.
    let ch = h.channel_open_session().await?;
    ch.request_subsystem(true, "sftp").await?;
    let sftp = SftpSession::new(ch.into_stream()).await?;
    let t3 = Instant::now();
    let entries = sftp.read_dir("/usr/bin").await?;
    let n = entries.count();
    println!("sftp /usr/bin : {n} entry trong {:?}", t3.elapsed());

    let t4 = Instant::now();
    let (_, cnt) = exec(&h, "find / -xdev 2>/dev/null | wc -l").await?;
    println!(
        "find / toàn bộ: {} entry trong {:?}",
        cnt.trim(),
        t4.elapsed()
    );

    h.disconnect(russh::Disconnect::ByApplication, "", "en").await?;
    Ok(())
}

fn crate_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
