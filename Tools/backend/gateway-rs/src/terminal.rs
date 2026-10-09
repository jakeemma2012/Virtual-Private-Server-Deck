//! WebSocket terminal.
//!
//! Ba lỗi của bản Java được sửa tận gốc ở đây, không phải vá:
//!
//! **1. Chữ tiếng Việt bị lỗi.** Bản Java đọc 8KB từ SSH rồi
//! `new String(buf, 0, len, "UTF-8")`. Một ký tự như `ế` dài 3 byte, nếu rơi
//! đúng biên buffer thì nửa đầu bị decode thành `?` và nửa sau thành `?` nữa —
//! mất ký tự. Ở đây **không decode gì cả**: byte thô từ PTY đi thẳng vào
//! WebSocket binary frame, và `xterm.js` tự ghép bằng bộ decode UTF-8 có trạng
//! thái của nó. Không có chỗ nào để cắt sai.
//!
//! **2. Zip/tar làm đứt kết nối.** Bản Java bọc session trong
//! `ConcurrentWebSocketSessionDecorator(5s, 512KB)`: khi `tar -czf` xả nhanh
//! hơn tốc độ gửi, vượt ngưỡng là Spring **đóng session**. Ở đây vòng đọc
//! `await` trên `send()`; client chậm thì vòng lặp chậm, russh thôi mở rộng
//! cửa sổ SSH, và `tar` trên VPS tự bị chặn lại. Đó là hành vi của một terminal
//! thật — y như bấm Ctrl+S — thay vì phình đệm rồi vỡ.
//!
//! **3. Keepalive kiểu tự chế.** Bản Java dùng text `__PING__`/`__PONG__`, nên
//! chuỗi đó mà xuất hiện trong dữ liệu là nhiễu. Ở đây dùng WebSocket Ping
//! frame đúng chuẩn (browser tự trả Pong), và **text frame chỉ dành cho lệnh
//! điều khiển dạng JSON** — binary frame mới là dữ liệu terminal. Hai kênh
//! tách hẳn, không cần escape, không thể lẫn.


use crate::db::{self, VpsServer};
use crate::error::AppError;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use futures::{SinkExt, StreamExt};
use russh::ChannelMsg;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;

const PING_EVERY: Duration = Duration::from_secs(20);
/// Một lần gửi không xong trong khoảng này = client đã chết, không phải chậm.
/// Ở tốc độ đã đo (6,4 MB/s) thì 32KB cần vài ms; 60s tương đương 0,5 KB/s.
/// Ngưỡng rộng như vậy để backpressure thật (client chậm) không bị cắt oan.
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
/// Không nhận được frame nào (kể cả Pong tự động của browser) trong khoảng này
/// thì đóng. Ping 20s nên đây là 3 lần Pong bị mất.
const RX_SILENCE_LIMIT: Duration = Duration::from_secs(75);
/// Kích thước PTY mặc định khi client chưa kịp báo. Cho sát với khung trình
/// duyệt phổ biến để lần vẽ đầu không bị wrap sai rồi nhảy — một phần của
/// cảm giác "terminal nháy" lúc mới mở.
const DEFAULT_COLS: u32 = 120;
const DEFAULT_ROWS: u32 = 32;

#[derive(Deserialize)]
pub struct TerminalQuery {
    #[serde(alias = "serverId")]
    pub server_id: String,
    #[serde(default)]
    pub cols: Option<u32>,
    #[serde(default)]
    pub rows: Option<u32>,
    /// Chỉ dùng khi không gửi được qua subprotocol.
    #[serde(default)]
    pub token: Option<String>,
}

/// Lệnh điều khiển, luôn đi bằng **text frame** dạng JSON.
#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Control {
    Resize { cols: u32, rows: u32 },
}

pub async fn handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<crate::AppState>>,
    Query(q): Query<TerminalQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    // Xác thực TRƯỚC khi upgrade: không có token hợp lệ thì không ai mở được
    // shell. Đây là lỗ hổng lớn nhất của bản Java (`/ws/**` = permitAll).
    // Dùng chung `auth::extract_token_ws` để đường WS không lệch đường REST.
    let q_token_src: Option<String> = None;
    let token = crate::auth::extract_token_ws(&headers, q_token_src.as_deref())
        .or_else(|| q.token.clone());
    let Some(token) = token else {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            "thiếu token cho WebSocket",
        )
            .into_response();
    };
    if state.jwt.verify(&token).is_none() {
        return (axum::http::StatusCode::UNAUTHORIZED, "token không hợp lệ").into_response();
    }

    let server = match db::get_server(&state.pool, &q.server_id, &state.secrets).await {
        Ok(s) => s,
        Err(e) => return e.into_response(),
    };

    // Nếu client báo subprotocol thì phải trả lại đúng một giá trị, nếu không
    // browser sẽ đóng kết nối ngay.
    let proto = selected_protocol(&headers);
    let cols = q.cols.unwrap_or(DEFAULT_COLS).clamp(20, 500);
    let rows = q.rows.unwrap_or(DEFAULT_ROWS).clamp(5, 200);

    let upgrade = ws
        // Đệm vừa phải: đủ để không chặt khúc burst nhỏ, nhưng không lớn tới
        // mức che mất backpressure.
        .max_message_size(1 << 20)
        .write_buffer_size(64 * 1024);

    let upgrade = match proto {
        Some(p) => upgrade.protocols([p]),
        None => upgrade,
    };

    upgrade.on_upgrade(move |socket| async move {
        if let Err(e) = pump(socket, state, server, cols, rows).await {
            tracing::info!("phiên terminal kết thúc: {e}");
        }
    })
}

fn selected_protocol(headers: &axum::http::HeaderMap) -> Option<String> {
    let raw = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    // Trả lại chính chuỗi token mà client đề nghị, đúng theo giao thức.
    raw.split(',')
        .map(str::trim)
        .find(|p| p.starts_with("jake-token."))
        .map(str::to_string)
}

async fn pump(
    socket: WebSocket,
    state: Arc<crate::AppState>,
    server: VpsServer,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    let name = server.name.clone();
    let session = state.ssh.connect_pty(&server).await?;
    let channel = session.channel_open_session().await?;

    // Terminal modes rỗng = dùng mặc định của server. 256 màu để prompt có màu
    // như terminal thật.
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;

    tracing::info!("terminal mở cho '{name}' ({cols}x{rows})");

    let (mut ws_tx, mut ws_rx) = socket.split();

    // `split()` cho nửa đọc (cần &mut) và nửa ghi (chỉ cần &self, nên dùng được
    // ở nhiều nhánh select! cùng lúc — kể cả window_change).
    let (mut read_half, write_half) = channel.split();
    let mut reader = read_half.make_reader();

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut buf = vec![0u8; 32 * 1024];

    // Laptop gập nắp hay rút mạng thường KHÔNG gửi FIN/RST. Không có hai mốc
    // thời gian dưới đây, `pump` chờ tới khi TCP hết retransmit (15 phút trở
    // lên), và suốt thời gian đó session SSH cùng một shell root trên VPS vẫn
    // được giữ.
    let mut last_rx = tokio::time::Instant::now();

    loop {
        tokio::select! {
            // --- VPS -> browser ---
            n = tokio::io::AsyncReadExt::read(&mut reader, &mut buf) => {
                let n = match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                // Byte thô, không decode. `await` ở đây chính là backpressure:
                // client chậm -> vòng lặp chậm -> cửa sổ SSH không mở rộng ->
                // tiến trình trên VPS tự bị chặn. Không bao giờ đóng session.
                let sent = tokio::time::timeout(
                    SEND_TIMEOUT,
                    ws_tx.send(Message::Binary(buf[..n].to_vec().into())),
                )
                .await;
                match sent {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break,
                    Err(_) => {
                        tracing::info!("đóng terminal '{name}': client không nhận dữ liệu");
                        break;
                    }
                }
            }

            // --- browser -> VPS ---
            msg = ws_rx.next() => {
                // Bất kỳ frame nào cũng tính là còn sống, kể cả Pong.
                last_rx = tokio::time::Instant::now();
                match msg {
                    // Binary = ký tự người dùng gõ, kể cả ký tự điều khiển
                    // (Ctrl+C = 0x03) và chữ có dấu nhiều byte.
                    Some(Ok(Message::Binary(data))) => {
                        if write_half.data_bytes(data).await.is_err() {
                            break;
                        }
                    }
                    // Text = lệnh điều khiển JSON. Không parse được thì coi là
                    // dữ liệu gõ, để client cũ vẫn dùng được.
                    Some(Ok(Message::Text(t))) => {
                        match serde_json::from_str::<Control>(&t) {
                            Ok(Control::Resize { cols, rows }) => {
                                let (c, r) = (cols.clamp(20, 500), rows.clamp(5, 200));
                                // pixel width/height = 0: server tự suy ra.
                                if write_half.window_change(c, r, 0, 0).await.is_err() {
                                    break;
                                }
                            }
                            Err(_) => {
                                if write_half
                                    .data_bytes(t.as_bytes().to_vec())
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        tracing::debug!("lỗi đọc WebSocket: {e}");
                        break;
                    }
                    // Pong của browser trả lời Ping của ta — không cần làm gì.
                    Some(Ok(_)) => {}
                }
            }

            // --- keepalive + phát hiện client chết ---
            _ = ping.tick() => {
                if last_rx.elapsed() > RX_SILENCE_LIMIT {
                    tracing::info!("đóng terminal '{name}': client im lặng quá lâu");
                    break;
                }
                match tokio::time::timeout(
                    SEND_TIMEOUT,
                    ws_tx.send(Message::Ping(Vec::new().into())),
                ).await {
                    Ok(Ok(())) => {}
                    _ => break,
                }
            }
        }
    }

    tracing::info!("terminal đóng cho '{name}'");
    Ok(())
}

/// Giữ lại để tham chiếu: đây là vòng đọc dựa trên `ChannelMsg`, dùng khi cần
/// phân biệt stdout/stderr. Terminal không cần vì PTY đã trộn hai luồng.
#[allow(dead_code)]
async fn drain_channel_msgs(mut ch: russh::Channel<russh::client::Msg>) {
    while let Some(msg) = ch.wait().await {
        if matches!(msg, ChannelMsg::Eof | ChannelMsg::Close) {
            break;
        }
    }
}
