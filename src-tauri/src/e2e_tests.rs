
// ---------- 端到端测试（P4 联调）：WS 认证 + 广播语义 ----------
// 在 Linux 上真实起一个 axum 服务，用 tokio-tungstenite 做客户端，
// 验证 v0.4 §2/§3 的关键行为。Tauri 部分不在此测（需 Windows 真机）。

#[cfg(test)]
mod e2e {
    use crate::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    type WsStream =
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn test_server() -> (u16, Arc<Shared>) {
        test_server_kind(ListenerKind::Loopback).await
    }

    async fn test_server_kind(kind: ListenerKind) -> (u16, Arc<Shared>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, _rx) = broadcast::channel::<(u64, String)>(256);
        let (overlay_tx, _) = broadcast::channel::<(u64, String)>(256);
        let (auth_epoch, _) = watch::channel(0);
        let shared = Arc::new(Shared {
            board: Arc::new(Mutex::new(Board::new())),
            tx,
            overlay_board: Arc::new(Mutex::new(Board::new())),
            overlay_tx,
            pad_count: Arc::new(AtomicUsize::new(0)),
            next_conn: Arc::new(AtomicU64::new(1)),
            auth: Arc::new(Mutex::new(Auth { token: Some("test-token".into()), ..Auth::default() })),
            auth_epoch,
            lan_net: Arc::new(Mutex::new(LanNet { ip: Some("127.0.0.1".into()), port: Some(port) })),
            loopback_port: port,
            host_token: "test-token".to_string(),
            hooks: Arc::new(crate::Hooks::new()),
        });
        let state = AppState {
            kind,
            shared: shared.clone(),
        };
        let app = make_router(state);
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        // 给 serve 一点启动时间
        tokio::time::sleep(Duration::from_millis(50)).await;
        (port, shared)
    }

    async fn ws_connect(port: u16, role: &str, origin: Option<&str>) -> Result<WsStream, String> {
        // 手动构造完整握手请求（tungstenite 不再为自定义 Request 自动补握手头）
        let mut builder = http::Request::builder()
            .method("GET")
            .uri(format!("ws://127.0.0.1:{}/ws?role={}", port, role))
            .header("Host", format!("127.0.0.1:{}", port))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header(
                "Sec-WebSocket-Key",
                tokio_tungstenite::tungstenite::handshake::client::generate_key(),
            );
        if let Some(o) = origin {
            builder = builder.header("Origin", o);
        }
        let req = builder.body(()).unwrap();
        let (ws, _) = tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| e.to_string())?;
        Ok(ws)
    }

    async fn hello(ws: &mut WsStream, token: &str) {
        ws.send(WsMsg::Text(format!(r#"{{"t":"hello","token":"{}"}}"#, token).into()))
            .await
            .unwrap();
    }

    /// 读下一条文本消息（跳过 ping/pong 等），3s 超时则 panic
    async fn next_text(ws: &mut WsStream) -> String {
        loop {
            match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
                Ok(Some(Ok(WsMsg::Text(t)))) => return t.to_string(),
                Ok(Some(Ok(other))) => panic!("unexpected ws message: {:?}", other),
                Ok(Some(Err(e))) => panic!("ws error: {}", e),
                Ok(None) => panic!("ws closed unexpectedly"),
                Err(_) => panic!("timed out waiting for ws message"),
            }
        }
    }

    fn txt(s: &str) -> WsMsg {
        WsMsg::Text(s.to_string().into())
    }

    // v0.5.2 的初连协议固定为 welcome、full-state、board-usage；显式校验，不能吞掉业务消息。
    async fn initial_usage(ws: &mut WsStream, points: usize, strokes: usize) {
        let value: serde_json::Value = serde_json::from_str(&next_text(ws).await).unwrap();
        assert_eq!(value, serde_json::json!({
            "t": "board-usage", "points": points, "maxPoints": board::MAX_TOTAL_POINTS,
            "strokes": strokes, "maxStrokes": board::MAX_STROKES,
        }));
    }

    #[tokio::test]
    async fn hello_auth_broadcast_and_undo() {
        let (port, _shared) = test_server().await;
        let origin = Some("http://tauri.localhost");

        // A、B 两个 viewer 上线
        let mut a = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut a, "test-token").await;
        assert!(next_text(&mut a).await.contains("\"welcome\""));
        assert!(next_text(&mut a).await.contains("full-state"));
        initial_usage(&mut a, 0, 0).await;

        let mut b = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut b, "test-token").await;
        assert!(next_text(&mut b).await.contains("\"welcome\""));
        assert!(next_text(&mut b).await.contains("full-state"));
        initial_usage(&mut b, 0, 0).await;

        // A 画一笔：B 应收到 3 条绘画广播；A 不应收到自己的回声
        a.send(txt(r##"{"t":"stroke-start","id":"s1","color":"#000","size":6,"tool":"pen"}"##))
            .await
            .unwrap();
        a.send(txt(r#"{"t":"stroke-point","id":"s1","x":0.1,"y":0.2,"p":0.5}"#))
            .await
            .unwrap();
        a.send(txt(r#"{"t":"stroke-end","id":"s1"}"#)).await.unwrap();
        for _ in 0..3 {
            let m = next_text(&mut b).await;
            assert!(m.contains("s1"), "B 没收到 s1 的广播: {}", m);
        }
        let no_echo = tokio::time::timeout(Duration::from_millis(300), a.next()).await;
        assert!(no_echo.is_err(), "A 收到了自己的绘画回声");

        // A 发 undo：A、B 都应收到 undo{id=s1}（控制消息发给所有人）
        a.send(txt(r#"{"t":"undo"}"#)).await.unwrap();
        let ma = next_text(&mut a).await;
        let mb = next_text(&mut b).await;
        assert!(ma.contains("\"undo\"") && ma.contains("s1"), "A 没收到 undo: {}", ma);
        assert!(mb.contains("\"undo\"") && mb.contains("s1"), "B 没收到 undo: {}", mb);
    }

    #[tokio::test]
    async fn pad_presence() {
        let (port, _shared) = test_server().await;
        let origin = Some("http://tauri.localhost");

        let mut v = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut v, "test-token").await;
        next_text(&mut v).await; // welcome
        next_text(&mut v).await; // full-state
        initial_usage(&mut v, 0, 0).await;

        // pad 上线 → viewer 收到 pad-status online:1
        let mut p = ws_connect(port, "pad", origin).await.unwrap();
        hello(&mut p, "test-token").await;
        next_text(&mut p).await; // welcome
        next_text(&mut p).await; // full-state
        initial_usage(&mut p, 0, 0).await;
        let m = next_text(&mut v).await;
        assert!(m.contains("pad-status") && m.contains("\"online\":1"), "presence: {}", m);

        // pad 掉线 → online:0
        p.close(None).await.unwrap();
        let m = next_text(&mut v).await;
        assert!(m.contains("pad-status") && m.contains("\"online\":0"), "presence: {}", m);
    }

    #[tokio::test]
    async fn bad_token_rejected() {
        let (port, _shared) = test_server().await;
        let mut c = ws_connect(port, "view", Some("http://tauri.localhost"))
            .await
            .unwrap();
        hello(&mut c, "wrong-token").await;
        let m = next_text(&mut c).await;
        assert!(m.contains("bad-token"), "应收到 auth-failed: {}", m);
        // 随后连接被关闭
        let closed = tokio::time::timeout(Duration::from_secs(3), c.next()).await;
        match closed {
            Ok(None) => {}
            Ok(Some(Ok(WsMsg::Close(_)))) => {}
            other => panic!("连接应被关闭，实际: {:?}", other.is_ok()),
        }
    }

    #[tokio::test]
    async fn missing_origin_rejected() {
        let (port, _shared) = test_server().await;
        // 不带 Origin → 握手 403
        let r = ws_connect(port, "view", None).await;
        assert!(r.is_err(), "缺 Origin 应被拒绝");
    }

    #[tokio::test]
    async fn full_state_on_late_join() {
        let (port, _shared) = test_server().await;
        let origin = Some("http://tauri.localhost");

        let mut a = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut a, "test-token").await;
        next_text(&mut a).await;
        next_text(&mut a).await;
        initial_usage(&mut a, 0, 0).await;
        // 用带确认的整板加载建立同步点，避免靠网络时序猜测前两条绘图消息已应用。
        a.send(txt(r##"{"t":"board-load","strokes":[{"id":"s9","color":"#f00","size":8,"tool":"pen","points":[[0.5,0.5,0.5]]}]}"##)).await.unwrap();
        assert!(next_text(&mut a).await.contains("s9"));

        // 后加入的 C 应在 full-state 里看到 s9
        let mut c = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut c, "test-token").await;
        next_text(&mut c).await; // welcome
        let fs = next_text(&mut c).await;
        assert!(fs.contains("full-state") && fs.contains("s9"), "full-state 缺 s9: {}", fs);
        initial_usage(&mut c, 1, 1).await;
    }

    /// v0.5.1：标注层与共享白板隔离，撤销/清空不能影响另一块板。
    #[tokio::test]
    async fn overlay_board_is_isolated() {
        let (port, shared) = test_server().await;
        let origin = Some("http://tauri.localhost");

        let mut v = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut v, "test-token").await;
        next_text(&mut v).await; // welcome
        next_text(&mut v).await; // full-state
        initial_usage(&mut v, 0, 0).await;

        let mut o = ws_connect(port, "overlay", origin).await.unwrap();
        hello(&mut o, "test-token").await;
        let w = next_text(&mut o).await;
        assert!(w.contains("\"welcome\"") && w.contains("overlay"), "welcome: {}", w);
        next_text(&mut o).await; // full-state
        initial_usage(&mut o, 0, 0).await;

        // overlay 上线不应触发 pad-status（不是 pad）
        let no_presence = tokio::time::timeout(Duration::from_millis(300), v.next()).await;
        assert!(no_presence.is_err(), "overlay 不应影响 pad 在线状态");

        // 先在白板载入一笔，再向标注板绘制。
        v.send(txt(r##"{"t":"board-load","strokes":[{"id":"board-1","color":"#000000","size":6,"tool":"pen","points":[[0.1,0.2,0.5]]}]}"##)).await.unwrap();
        assert!(next_text(&mut v).await.contains("board-1"));
        o.send(txt(r##"{"t":"stroke-start","id":"ov1","color":"#ff3b30","size":6,"tool":"pen"}"##))
            .await
            .unwrap();
        o.send(txt(r#"{"t":"stroke-point","id":"ov1","x":0.3,"y":0.4,"p":0.5}"#))
            .await
            .unwrap();
        let no_cross_board = tokio::time::timeout(Duration::from_millis(300), v.next()).await;
        assert!(no_cross_board.is_err(), "白板不应收到标注层笔画");
        let no_echo = tokio::time::timeout(Duration::from_millis(300), o.next()).await;
        assert!(no_echo.is_err(), "overlay 收到了自己的绘画回声");

        o.send(txt(r#"{"t":"undo"}"#)).await.unwrap();
        assert!(next_text(&mut o).await.contains("ov1"));
        o.send(txt(r#"{"t":"clear"}"#)).await.unwrap();
        assert!(next_text(&mut o).await.contains("clear"));
        assert_eq!(shared.board.lock().await.strokes()[0].id, "board-1");
        assert!(shared.overlay_board.lock().await.strokes().is_empty());
    }

    #[tokio::test]
    async fn board_load_returns_complete_state_to_sender_and_observer() {
        let (port, shared) = test_server().await;
        let origin = Some("http://tauri.localhost");
        let mut a = ws_connect(port, "overlay", origin).await.unwrap();
        hello(&mut a, "test-token").await;
        next_text(&mut a).await;
        next_text(&mut a).await;
        initial_usage(&mut a, 0, 0).await;
        let mut b = ws_connect(port, "overlay", origin).await.unwrap();
        hello(&mut b, "test-token").await;
        next_text(&mut b).await;
        next_text(&mut b).await;
        initial_usage(&mut b, 0, 0).await;

        let strokes: Vec<board::Stroke> = (0..80).map(|i| board::Stroke {
            id: format!("loaded-{}", i), color: "#123456".into(), size: 5.0, tool: "pen".into(),
            points: vec![board::Point(0.2, 0.4, 0.5); 80],
        }).collect();
        a.send(txt(&serde_json::json!({"t":"board-load", "strokes": strokes}).to_string())).await.unwrap();
        for peer in [&mut a, &mut b] {
            let value: serde_json::Value = serde_json::from_str(&next_text(peer).await).unwrap();
            assert_eq!(value["t"], "full-state");
            assert_eq!(value["strokes"].as_array().unwrap().len(), 80);
            assert_eq!(value["strokes"][79]["points"].as_array().unwrap().len(), 80);
        }
        assert_eq!(shared.overlay_board.lock().await.strokes().len(), 80);
        assert!(shared.board.lock().await.strokes().is_empty());
    }

    #[tokio::test]
    async fn lagged_receiver_resyncs_and_keeps_receiving_without_replaying_points() {
        let board = Mutex::new(Board::new());
        let (tx, _) = broadcast::channel(2);
        let (_, mut rx) = snapshot_and_subscribe(&board, &tx).await;
        {
            let mut board = board.lock().await;
            let out = board.handle(ClientMsg::StrokeStart {
                id: "busy".into(), color: "#000".into(), size: 4.0, tool: None,
            });
            for msg in out { tx.send((9, to_json(&msg))).unwrap(); }
            for _ in 0..20 {
                for msg in board.handle(ClientMsg::StrokePoint {
                    id: "busy".into(), x: 0.5, y: 0.5, p: None, ts: None,
                }) { tx.send((9, to_json(&msg))).unwrap(); }
            }
        }
        let lagged = rx.recv().await;
        assert!(matches!(lagged, Err(broadcast::error::RecvError::Lagged(_))));
        let recovered = board_message_batch(&board, &tx, &mut rx, 1, lagged).await.unwrap();
        assert_eq!(recovered.len(), 2);
        let usage: serde_json::Value = serde_json::from_str(&recovered[1]).unwrap();
        assert_eq!(usage["t"], "board-usage");
        assert_eq!(usage["points"], 20);
        let recovered: serde_json::Value = serde_json::from_str(&recovered[0]).unwrap();
        assert_eq!(recovered["t"], "full-state");
        assert_eq!(recovered["strokes"][0]["points"].as_array().unwrap().len(), 20);
        {
            let mut board = board.lock().await;
            for msg in board.handle(ClientMsg::StrokePoint {
                id: "busy".into(), x: 0.8, y: 0.7, p: None, ts: None,
            }) { tx.send((9, to_json(&msg))).unwrap(); }
        }
        let received = rx.recv().await;
        let next = board_message_batch(&board, &tx, &mut rx, 1, received).await.unwrap();
        assert_eq!(next.len(), 1);
        let next: serde_json::Value = serde_json::from_str(&next[0]).unwrap();
        assert_eq!(next["t"], "stroke-point");
        assert!((next["x"].as_f64().unwrap() - 0.8).abs() < 0.0001);
        assert!(tokio::time::timeout(Duration::from_millis(100), rx.recv()).await.is_err());
    }

    #[tokio::test]
    async fn lan_cannot_impersonate_overlay_and_revoked_socket_is_closed() {
        let (port, shared) = test_server_kind(ListenerKind::Lan).await;
        let origin = format!("http://127.0.0.1:{}", port);
        assert!(ws_connect(port, "overlay", Some(&origin)).await.is_err());
        assert!(ws_connect(port, "view", Some(&origin)).await.is_err());
        assert!(ws_connect(port, "pad-local", Some(&origin)).await.is_err());
        let mut pad = ws_connect(port, "pad", Some(&origin)).await.unwrap();
        hello(&mut pad, "test-token").await;
        next_text(&mut pad).await;
        next_text(&mut pad).await;
        initial_usage(&mut pad, 0, 0).await;
        next_text(&mut pad).await; // pad-status
        revoke_lan(&shared).await;
        // 即使客户端无视撤销并继续发送，服务端也不得再接受写入。
        let _ = pad.send(txt(r##"{"t":"stroke-start","id":"after-revoke","color":"#000","size":4}"##)).await;
        let mut closed = false;
        for _ in 0..2 {
            let next = tokio::time::timeout(Duration::from_secs(3), pad.next())
                .await.expect("撤销后的连接未及时关闭");
            match next {
                Some(Ok(WsMsg::Text(text))) => assert!(text.contains("revoked")),
                // 发送正在阻塞或客户端同时写入时，直接断开而不等待关闭帧也合法。
                None | Some(Ok(WsMsg::Close(_))) | Some(Err(_)) => { closed = true; break; }
                other => panic!("撤销后的意外消息：{:?}", other),
            }
        }
        assert!(closed);
        assert!(shared.board.lock().await.strokes().is_empty());
        let mut retry = ws_connect(port, "pad", Some(&origin)).await.unwrap();
        hello(&mut retry, "test-token").await;
        assert!(next_text(&mut retry).await.contains("bad-token"));
    }

    #[tokio::test]
    async fn rejection_memory_is_per_connection_and_resets_on_end_clear_and_load() {
        let (port, shared) = test_server().await;
        let origin = Some("http://tauri.localhost");
        let mut a = ws_connect(port, "view", origin).await.unwrap();
        let mut b = ws_connect(port, "view", origin).await.unwrap();
        for peer in [&mut a, &mut b] {
            hello(peer, "test-token").await;
            assert!(next_text(peer).await.contains("welcome"));
            assert!(next_text(peer).await.contains("full-state"));
            initial_usage(peer, 0, 0).await;
        }
        let invalid_load = r#"{"t":"board-load","strokes":[{"id":"invalid","color":"bad","size":4,"tool":"pen","points":[]}]}"#;
        a.send(txt(r#"{"t":"stroke-start","id":"same","color":"bad","size":4}"#)).await.unwrap();
        assert!(next_text(&mut a).await.contains("stroke-rejected"));
        // 同 id 来自另一条连接时仍遵守原共享白板语义，不被 A 的拒绝集合屏蔽。
        b.send(txt(r##"{"t":"stroke-start","id":"same","color":"#000","size":4}"##)).await.unwrap();
        assert!(next_text(&mut a).await.contains("stroke-start"));
        a.send(txt(r#"{"t":"stroke-point","id":"same","x":0.1,"y":0.2}"#)).await.unwrap();
        // 定向错误作为已处理此前输入的同步点，同时证明无整板错误回滚。
        a.send(txt(invalid_load)).await.unwrap();
        assert!(next_text(&mut a).await.contains("\"error\""));
        assert!(tokio::time::timeout(Duration::from_millis(100), b.next()).await.is_err());
        assert!(shared.board.lock().await.strokes()[0].points.is_empty());

        a.send(txt(r#"{"t":"stroke-end","id":"same"}"#)).await.unwrap();
        assert!(next_text(&mut b).await.contains("stroke-end"));
        a.send(txt(r#"{"t":"stroke-point","id":"same","x":0.3,"y":0.4}"#)).await.unwrap();
        assert!(next_text(&mut b).await.contains("stroke-point"));

        a.send(txt(r#"{"t":"stroke-start","id":"reset","color":"bad","size":4}"#)).await.unwrap();
        assert!(next_text(&mut a).await.contains("stroke-rejected"));
        b.send(txt(invalid_load)).await.unwrap();
        assert!(next_text(&mut b).await.contains("\"error\""));
        a.send(txt(r##"{"t":"stroke-start","id":"reset","color":"#000","size":4}"##)).await.unwrap();
        a.send(txt(invalid_load)).await.unwrap();
        assert!(next_text(&mut a).await.contains("\"error\""));
        assert!(tokio::time::timeout(Duration::from_millis(100), b.next()).await.is_err(), "失败的导入不能清理拒绝记忆");

        // 由另一条连接清屏，也必须清掉 A 的旧拒绝状态。
        b.send(txt(r#"{"t":"clear"}"#)).await.unwrap();
        assert!(next_text(&mut a).await.contains("\"clear\""));
        assert!(next_text(&mut b).await.contains("\"clear\""));
        a.send(txt(r##"{"t":"stroke-start","id":"reset","color":"#000","size":4}"##)).await.unwrap();
        assert!(next_text(&mut b).await.contains("stroke-start"));
        a.send(txt(r#"{"t":"stroke-point","id":"reset","x":2,"y":0.5}"#)).await.unwrap();
        let correction: serde_json::Value = serde_json::from_str(&next_text(&mut a).await).unwrap();
        assert_eq!(correction["t"], "stroke-truncate");
        assert_eq!(correction["len"], 0);
        a.send(txt(r#"{"t":"stroke-point","id":"reset","x":0.2,"y":0.5}"#)).await.unwrap();
        a.send(txt(invalid_load)).await.unwrap();
        assert!(next_text(&mut a).await.contains("\"error\""));
        assert!(tokio::time::timeout(Duration::from_millis(100), b.next()).await.is_err());

        b.send(txt(r##"{"t":"board-load","strokes":[{"id":"reset","color":"#000","size":4,"tool":"pen","points":[[0.5,0.5,0.5]]}]}"##)).await.unwrap();
        assert!(next_text(&mut a).await.contains("full-state"));
        assert!(next_text(&mut b).await.contains("full-state"));
        a.send(txt(r#"{"t":"stroke-point","id":"reset","x":0.6,"y":0.5}"#)).await.unwrap();
        assert!(next_text(&mut b).await.contains("stroke-point"));
        assert_eq!(shared.board.lock().await.strokes()[0].points.len(), 2);
    }

    #[tokio::test]
    async fn excessive_unfinished_rejections_close_only_that_connection() {
        let (port, shared) = test_server().await;
        let origin = Some("http://tauri.localhost");
        let mut observer = ws_connect(port, "view", origin).await.unwrap();
        let mut writer = ws_connect(port, "view", origin).await.unwrap();
        for peer in [&mut observer, &mut writer] {
            hello(peer, "test-token").await;
            next_text(peer).await;
            next_text(peer).await;
            initial_usage(peer, 0, 0).await;
        }
        for i in 0..MAX_REJECTED_STROKES {
            writer.send(txt(&serde_json::json!({
                "t": "stroke-start", "id": format!("bad-{i}"), "color": "bad", "size": 4,
            }).to_string())).await.unwrap();
            assert!(next_text(&mut writer).await.contains("stroke-rejected"));
        }
        // 集合满时旧 id 仍然静默，不能通过淘汰后重发来“限制内存”。
        writer.send(txt(r#"{"t":"stroke-point","id":"bad-0","x":0.1,"y":0.2}"#)).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(100), writer.next()).await.is_err());
        writer.send(txt(r#"{"t":"stroke-start","id":"too-many","color":"bad","size":4}"#)).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(3), writer.next()).await.unwrap();
        assert!(matches!(closed, None | Some(Err(_)) | Some(Ok(WsMsg::Close(_)))));
        assert!(shared.board.lock().await.strokes().is_empty());

        // 断连后的同 id 不留下跨连接记忆，其他连接也没有收到错误广播。
        let mut reconnected = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut reconnected, "test-token").await;
        next_text(&mut reconnected).await;
        next_text(&mut reconnected).await;
        initial_usage(&mut reconnected, 0, 0).await;
        reconnected.send(txt(r##"{"t":"stroke-start","id":"bad-0","color":"#000","size":4}"##)).await.unwrap();
        assert!(next_text(&mut observer).await.contains("stroke-start"));
        // 非法超长 id 不能绕开字节预算，关闭后 observer 仍然可操作白板。
        reconnected.send(txt(&serde_json::json!({
            "t": "stroke-start", "id": "x".repeat(MAX_REJECTED_ID_BYTES + 1), "color": "bad", "size": 4,
        }).to_string())).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(3), reconnected.next()).await.unwrap();
        assert!(matches!(closed, None | Some(Err(_)) | Some(Ok(WsMsg::Close(_)))));
        observer.send(txt(r#"{"t":"board-load","strokes":[]}"#)).await.unwrap();
        assert!(next_text(&mut observer).await.contains("full-state"));
        assert!(shared.board.lock().await.strokes().is_empty());
    }

    #[tokio::test]
    async fn origin_must_match_exactly() {
        let (port, _) = test_server().await;
        for origin in ["http://tauri.localhost.evil", "http://tauri.localhost:9000", "file://tauri.localhost"] {
            assert!(ws_connect(port, "view", Some(origin)).await.is_err());
        }
    }

    #[tokio::test]
    async fn local_mouse_pad_uses_whiteboard_without_counting_as_ipad() {
        let (port, shared) = test_server().await;
        let origin = Some("http://tauri.localhost");
        let mut viewer = ws_connect(port, "view", origin).await.unwrap();
        hello(&mut viewer, "test-token").await;
        next_text(&mut viewer).await;
        next_text(&mut viewer).await;
        initial_usage(&mut viewer, 0, 0).await;
        let mut mouse = ws_connect(port, "pad-local", origin).await.unwrap();
        hello(&mut mouse, "test-token").await;
        next_text(&mut mouse).await;
        next_text(&mut mouse).await;
        initial_usage(&mut mouse, 0, 0).await;
        mouse.send(txt(r##"{"t":"stroke-start","id":"mouse","color":"#000","size":4}"##)).await.unwrap();
        assert!(next_text(&mut viewer).await.contains("mouse"));
        assert_eq!(shared.pad_count.load(Ordering::SeqCst), 0);
        assert!(shared.overlay_board.lock().await.strokes().is_empty());
    }
}
