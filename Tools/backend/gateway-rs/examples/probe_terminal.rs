//! Kiểm tra terminal WebSocket trên VPS thật — ba thứ mà bản Java làm sai:
//!
//! 1. Chữ tiếng Việt đi qua PTY về còn nguyên byte.
//! 2. Output lớn liên tục (giống `tar -czf`) KHÔNG làm đứt kết nối.
//! 3. Không token thì không mở được terminal.
//!
//! Chạy: WS=ws://127.0.0.1:8099 TOKEN=... SID=... cargo run --example probe_terminal

use futures::{SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// Mở WS kèm token qua subprotocol — đúng cách browser làm.
async fn connect(
    base: &str,
    sid: &str,
    token: Option<&str>,
) -> anyhow::Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
> {
    let url = format!("{base}/ws/terminal?serverId={sid}&cols=120&rows=32");
    let mut req = url.into_client_request()?;
    if let Some(t) = token {
        req.headers_mut().insert(
            "sec-websocket-protocol",
            format!("jake-token.{t}").parse()?,
        );
    }
    let (ws, _) = tokio_tungstenite::connect_async(req).await?;
    Ok(ws)
}

/// Kết quả một lượt đọc: tổng byte nhận được và phần đuôi để kiểm chuỗi.
struct Received {
    total: usize,
    tail: Vec<u8>,
    found: bool,
}

/// Đọc cho tới khi thấy `needle` hoặc hết thời gian.
///
/// Chỉ quét phần ĐUÔI, không quét lại toàn bộ dữ liệu đã nhận. Bản đầu của hàm
/// này gọi `find()` trên cả buffer sau mỗi message, thành O(n²) — và nó làm
/// phép đo throughput sai hoàn toàn (báo 24KB/s trong khi server không hề chậm).
async fn read_until(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    needle: &[u8],
    timeout: Duration,
) -> Received {
    // Giữ lại đủ để một needle có thể nằm vắt qua ranh giới hai message.
    let keep = (needle.len() * 2).max(4096);
    let mut tail: Vec<u8> = Vec::with_capacity(keep * 2);
    let mut total = 0usize;
    let mut found = false;
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match tokio::time::timeout(left, ws.next()).await {
            Ok(Some(Ok(Message::Binary(b)))) => {
                total += b.len();
                tail.extend_from_slice(&b);
                if !needle.is_empty() && find(&tail, needle).is_some() {
                    found = true;
                    break;
                }
                if tail.len() > keep {
                    let cut = tail.len() - keep;
                    tail.drain(..cut);
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => break,
        }
    }
    Received { total, tail, found }
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let base = std::env::var("WS")?;
    let token = std::env::var("TOKEN")?;
    let sid = std::env::var("SID")?;
    let mut failures = 0;

    // ---------- 1. Không token thì phải bị từ chối ----------
    print!("1. không token -> từ chối  : ");
    match connect(&base, &sid, None).await {
        Err(e) => println!("OK ({})", first_line(&e.to_string())),
        Ok(_) => {
            println!("LỖI — mở được terminal mà không cần token!");
            failures += 1;
        }
    }

    // ---------- 2. Token sai cũng phải bị từ chối ----------
    print!("2. token sai  -> từ chối   : ");
    match connect(&base, &sid, Some("khong-phai-token")).await {
        Err(e) => println!("OK ({})", first_line(&e.to_string())),
        Ok(_) => {
            println!("LỖI — token rác vẫn vào được!");
            failures += 1;
        }
    }

    // ---------- 3. Chữ tiếng Việt qua PTY ----------
    let mut ws = connect(&base, &sid, Some(&token)).await?;
    // Chờ prompt shell xuất hiện.
    let _ = read_until(&mut ws, b"$", Duration::from_secs(8)).await;

    print!("3. tiếng Việt qua PTY      : ");
    // PTY echo lại chính dòng lệnh vừa gõ. Nếu tìm chuỗi đích mà nó cũng nằm
    // nguyên trong câu lệnh thì ta chỉ đang kiểm tra echo, chứ chưa kiểm tra
    // đường VPS -> browser. Nên ghép chuỗi từ hai phần: dòng lệnh chứa
    // "Tiếng Vi" và "ệt: ế ộ ữ ậ ằ đ" rời nhau, chỉ OUTPUT mới có chuỗi liền.
    const VN_A: &str = "Tiếng Vi";
    const VN_B: &str = "ệt: ế ộ ữ ậ ằ đ — Ngọc Rồng";
    let expect = format!("{VN_A}{VN_B}");
    ws.send(Message::Binary(
        format!("printf '%s%s\\n' '{VN_A}' '{VN_B}'\r")
            .into_bytes()
            .into(),
    ))
    .await?;
    let got = read_until(&mut ws, expect.as_bytes(), Duration::from_secs(8)).await;
    if got.found {
        println!("OK — {} byte về nguyên vẹn", expect.len());
    } else {
        println!("LỖI — không thấy chuỗi gốc trong output");
        println!("   đuôi nhận được: {:?}", String::from_utf8_lossy(&got.tail));
        failures += 1;
    }

    // ---------- 4. Ký tự nhiều byte bị chia qua NHIỀU frame ----------
    // Đây chính là ca bản Java làm hỏng: byte của một ký tự nằm ở hai chunk.
    print!("4. ký tự cắt qua 2 frame   : ");
    let (m_a, m_b) = ("KẾT::ộ", "ĩữ::THÚC");
    let expect4 = format!("{m_a}{m_b}");
    let payload = format!("printf '%s%s\\n' '{m_a}' '{m_b}'\r");
    let bytes = payload.as_bytes();
    // Cắt ngay giữa một ký tự nhiều byte: tìm byte continuation (10xxxxxx).
    let split = (bytes.len() / 2..bytes.len())
        .find(|&i| bytes[i] & 0b1100_0000 == 0b1000_0000)
        .unwrap_or(bytes.len() / 2);
    ws.send(Message::Binary(bytes[..split].to_vec().into())).await?;
    tokio::time::sleep(Duration::from_millis(120)).await;
    ws.send(Message::Binary(bytes[split..].to_vec().into())).await?;
    let got = read_until(&mut ws, expect4.as_bytes(), Duration::from_secs(8)).await;
    if got.found {
        println!("OK — ghép đúng dù cắt giữa ký tự nhiều byte (offset {split})");
    } else {
        println!("LỖI — ký tự bị hỏng khi cắt qua 2 frame");
        println!("   đuôi nhận được: {:?}", String::from_utf8_lossy(&got.tail));
        failures += 1;
    }

    // ---------- 5. Burst lớn: mô phỏng tar/zip ----------
    print!("5. burst 12MB không đứt    : ");
    let t = Instant::now();
    // Lại dùng mẹo ghép chuỗi: dòng lệnh echo lại chỉ chứa "__XO" và "NG__"
    // rời nhau, nên khớp "__XONG__" nghĩa là burst đã chạy xong thật.
    ws.send(Message::Binary(
        b"head -c 12000000 /dev/urandom | base64; printf '%s%s\\n' '__XO' 'NG__'\r"
            .to_vec()
            .into(),
    ))
    .await?;
    let got = read_until(&mut ws, b"__XONG__", Duration::from_secs(120)).await;
    let elapsed = t.elapsed();
    let mb = got.total as f64 / 1_048_576.0;
    if got.found {
        println!(
            "OK — {:.1} MB trong {:.1}s ({:.1} MB/s), kết nối còn sống",
            mb,
            elapsed.as_secs_f64(),
            mb / elapsed.as_secs_f64()
        );
    } else {
        println!(
            "LỖI — chưa xong burst (nhận {:.1} MB sau {:.1}s = {:.2} MB/s)",
            mb,
            elapsed.as_secs_f64(),
            mb / elapsed.as_secs_f64()
        );
        failures += 1;
    }

    // ---------- 6. Kết nối vẫn dùng được sau burst ----------
    print!("6. còn gõ được sau burst   : ");
    ws.send(Message::Binary(b"printf '%s%s\\n' '__CON_' 'SONG__'\r".to_vec().into()))
        .await?;
    let got = read_until(&mut ws, b"__CON_SONG__", Duration::from_secs(15)).await;
    if got.found {
        println!("OK");
    } else {
        println!("LỖI — kết nối chết sau burst");
        failures += 1;
    }

    // ---------- 7. Resize qua text frame ----------
    print!("7. resize qua text frame   : ");
    ws.send(Message::Text(
        r#"{"t":"resize","cols":200,"rows":50}"#.into(),
    ))
    .await?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    ws.send(Message::Binary(b"tput cols\r".to_vec().into())).await?;
    let got = read_until(&mut ws, b"200", Duration::from_secs(8)).await;
    if got.found {
        println!("OK — PTY nhận 200 cột");
    } else {
        println!("LỖI — resize không tới PTY");
        failures += 1;
    }

    ws.close(None).await.ok();
    println!();
    if failures == 0 {
        println!("TẤT CẢ 7 KIỂM TRA ĐẠT");
        Ok(())
    } else {
        anyhow::bail!("{failures} kiểm tra thất bại")
    }
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").chars().take(60).collect()
}
