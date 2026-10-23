// ---------- v0.5.2 回归测试：白板上限与错误定向回复 ----------
// 用法：放到 src-tauri/src/limit_tests.rs，并在 main.rs 的 `mod e2e_tests;` 旁加
//   #[cfg(test)]
//   mod limit_tests;
// 在 v0.5.1 上这 3 项应当失败（证明问题存在）；v0.5.2 修复后应全部通过。
// 允许服务端额外发送 t=="board-usage" 的用量消息，测试会忽略它。

#[cfg(test)]
mod limit {
    use crate::board::{Point, Stroke, MAX_POINTS_PER_STROKE, MAX_TOTAL_POINTS};
    use crate::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    type WsStream =
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn server() -> (u16, Arc<Shared>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, _) = broadcast::channel::<(u64, String)>(256);
        let (overlay_tx, _) = broadcast::channel::<(u64, String)>(256);
        let (auth_epoch, _) = watch::channel(0);
        let shared = Arc::new(Shared {
            board: Arc::new(Mutex::new(Board::new())),
            tx,
            overlay_board: Arc::new(Mutex::new(Board::new())),
            overlay_tx,
            pad_count: Arc::new(AtomicUsize::new(0)),
            next_conn: Arc::new(AtomicU64::new(1)),
            auth: Arc::new(Mutex::new(Auth::default())),
            auth_epoch,
            lan_net: Arc::new(Mutex::new(LanNet::default())),
            loopback_port: port,
            host_token: "t".into(),
            hooks: Arc::new(crate::Hooks::new()),
        });
        let app = make_router(AppState { kind: ListenerKind::Loopback, shared: shared.clone() });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (port, shared)
    }

    /// 连接并完成 hello；吃掉 welcome 与初始 full-state。
    async fn connect(port: u16, role: &str) -> WsStream {
        let req = http::Request::builder()
            .method("GET")
            .uri(format!("ws://127.0.0.1:{}/ws?role={}", port, role))
            .header("Host", format!("127.0.0.1:{}", port))
            .header("Origin", "http://tauri.localhost")
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
            .body(())
            .unwrap();
        let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
            .max_message_size(Some(64 << 20))
            .max_frame_size(Some(64 << 20));
        let (mut ws, _) = tokio_tungstenite::connect_async_with_config(req, Some(config), false)
            .await
            .unwrap();
        ws.send(WsMsg::Text(r#"{"t":"hello","token":"t"}"#.into())).await.unwrap();
        let mut seen_full = false;
        while !seen_full {
            let t = next_relevant(&mut ws, Duration::from_secs(10)).await.expect("handshake");
            seen_full = t.contains("\"full-state\"");
        }
        ws
    }

    /// 读下一条非 board-usage 的文本消息；超时返回 None。
    async fn next_relevant(ws: &mut WsStream, wait: Duration) -> Option<String> {
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, ws.next()).await {
                Ok(Some(Ok(WsMsg::Text(t)))) => {
                    if t.contains("\"board-usage\"") { continue; }
                    return Some(t.to_string());
                }
                Ok(Some(Ok(_))) => continue,
                _ => return None,
            }
        }
    }

    /// 收集 `wait` 时间内的全部相关消息。
    async fn drain(ws: &mut WsStream, wait: Duration) -> Vec<String> {
        let mut out = vec![];
        let deadline = tokio::time::Instant::now() + wait;
        while let Some(t) = next_relevant(ws, deadline.saturating_duration_since(tokio::time::Instant::now())).await {
            out.push(t);
        }
        out
    }

    fn txt(s: String) -> WsMsg { WsMsg::Text(s.into()) }

    fn full_board() -> Vec<Stroke> {
        (0..MAX_TOTAL_POINTS / MAX_POINTS_PER_STROKE)
            .map(|i| Stroke {
                id: format!("f{}", i),
                color: "#123456".into(),
                size: 6.0,
                tool: "pen".into(),
                points: vec![Point(0.123456, 0.654321, 0.5); MAX_POINTS_PER_STROKE],
            })
            .collect()
    }

    /// 白板已满（20 万点）时再画一笔 20 个点：
    /// 其他连接不应收到任何 error / full-state；发送者只收到一条很小的 stroke-rejected；
    /// 白板不新增空笔画。
    #[tokio::test]
    async fn full_board_rejects_new_stroke_without_broadcast() {
        let (port, shared) = server().await;
        shared.board.lock().await.handle(board::ClientMsg::BoardLoad { strokes: full_board() });
        let mut viewer = connect(port, "view").await;
        let mut mouse = connect(port, "pad-local").await;

        mouse.send(txt(r##"{"t":"stroke-start","id":"late","color":"#ff0000","size":6}"##.into())).await.unwrap();
        for i in 0..20 {
            mouse.send(txt(format!(r#"{{"t":"stroke-point","id":"late","x":0.{},"y":0.5,"p":0.5}}"#, 10 + i))).await.unwrap();
        }
        mouse.send(txt(r#"{"t":"stroke-end","id":"late"}"#.into())).await.unwrap();

        let to_viewer = drain(&mut viewer, Duration::from_secs(3)).await;
        assert!(
            to_viewer.iter().all(|m| !m.contains("\"full-state\"") && !m.contains("\"error\"")),
            "旁观连接收到了错误或整板重发：{} 条，共 {} 字节",
            to_viewer.len(),
            to_viewer.iter().map(|m| m.len()).sum::<usize>()
        );

        let to_sender = drain(&mut mouse, Duration::from_secs(1)).await;
        let rejects: Vec<_> = to_sender.iter().filter(|m| m.contains("\"stroke-rejected\"")).collect();
        assert_eq!(rejects.len(), 1, "发送者应恰好收到 1 条 stroke-rejected，实际：{:?}",
            to_sender.iter().map(|m| format!("{:.60}", m)).collect::<Vec<_>>());
        assert!(rejects[0].contains("\"late\""));
        let sender_bytes: usize = to_sender.iter().map(|m| m.len()).sum();
        assert!(sender_bytes < 4096, "发送者收到 {} 字节，应为小消息", sender_bytes);

        assert_eq!(shared.board.lock().await.strokes().len(), 10, "被拒笔画不应留在白板里");
    }

    /// 单笔超过 20000 点：服务端保留前 20000 点，只给发送者回一条 stroke-truncate{len:20000}，
    /// 之后同一笔的点静默丢弃；旁观者只看到被接受的点。
    #[tokio::test]
    async fn per_stroke_limit_truncates_for_sender_only() {
        let (port, shared) = server().await;
        let mut viewer = connect(port, "view").await;
        let mut mouse = connect(port, "pad-local").await;

        mouse.send(txt(r##"{"t":"stroke-start","id":"long","color":"#ff0000","size":6}"##.into())).await.unwrap();
        for _ in 0..(MAX_POINTS_PER_STROKE + 5) {
            mouse.send(txt(r#"{"t":"stroke-point","id":"long","x":0.5,"y":0.5,"p":0.5}"#.into())).await.unwrap();
        }
        mouse.send(txt(r#"{"t":"stroke-end","id":"long"}"#.into())).await.unwrap();

        let to_viewer = drain(&mut viewer, Duration::from_secs(5)).await;
        // v0.5.3 调整：旁观者处理不过来时，服务端按设计用整板快照补齐（Lagged 重新同步，只发给落后的那条连接）。
        // Windows 实测会触发这一路径，所以按旁观者最终重建出的状态判断，而不是逐条计数。
        let mut seen = 0usize;
        for m in &to_viewer {
            let v: serde_json::Value = serde_json::from_str(m).unwrap();
            match v["t"].as_str() {
                Some("stroke-point") if v["id"] == "long" => seen += 1,
                Some("full-state") => {
                    seen = v["strokes"].as_array().unwrap().iter()
                        .find(|s| s["id"] == "long")
                        .map(|s| s["points"].as_array().unwrap().len()).unwrap_or(0);
                }
                _ => {}
            }
        }
        assert_eq!(seen, MAX_POINTS_PER_STROKE, "旁观者最终应恰好看到被接受的 20000 个点");
        assert!(to_viewer.iter().all(|m| !m.contains("\"error\"") && !m.contains("\"stroke-truncate\"")),
            "错误与截断只能发给发送者");

        let to_sender = drain(&mut mouse, Duration::from_secs(1)).await;
        let truncs: Vec<_> = to_sender.iter().filter(|m| m.contains("\"stroke-truncate\"")).collect();
        assert_eq!(truncs.len(), 1, "发送者应恰好收到 1 条 stroke-truncate");
        let v: serde_json::Value = serde_json::from_str(truncs[0]).unwrap();
        assert_eq!(v["id"], "long");
        assert_eq!(v["len"].as_u64().unwrap() as usize, MAX_POINTS_PER_STROKE);

        let board = shared.board.lock().await;
        assert_eq!(board.strokes().len(), 1);
        assert_eq!(board.strokes()[0].points.len(), MAX_POINTS_PER_STROKE);
    }

    /// 非法存档导入：错误只回给导入者，同板的其他标注层连接收不到任何消息，白板不变。
    #[tokio::test]
    async fn invalid_board_load_error_goes_to_sender_only() {
        let (port, shared) = server().await;
        let mut a = connect(port, "overlay").await;
        let mut b = connect(port, "overlay").await;
        a.send(txt(r#"{"t":"board-load","strokes":[{"id":"x","color":"red","size":6,"tool":"pen","points":[]}]}"#.into()))
            .await
            .unwrap();
        let to_a = drain(&mut a, Duration::from_secs(1)).await;
        assert!(to_a.iter().any(|m| m.contains("\"error\"")), "导入者应收到错误");
        let to_b = drain(&mut b, Duration::from_secs(1)).await;
        assert!(to_b.is_empty(), "其他连接不应收到导入错误：{:?}", to_b);
        assert!(shared.overlay_board.lock().await.strokes().is_empty());
    }
}
