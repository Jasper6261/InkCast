// ---------- v0.6 测试：iPad 写入屏幕标注层、屏幕画面、截图请求 ----------
// 另含一个默认忽略的“开发服务器”（dev_server），供浏览器端到端模拟 iPad 使用。

#[cfg(test)]
mod v06 {
    use crate::*;
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMsg;

    type WsStream =
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

    async fn lan_server(port_hint: u16) -> (u16, Arc<Shared>) {
        let listener = TcpListener::bind(("127.0.0.1", port_hint)).await.unwrap();
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
            auth: Arc::new(Mutex::new(Auth { token: Some("tok".into()), ..Auth::default() })),
            auth_epoch,
            lan_net: Arc::new(Mutex::new(LanNet { ip: Some("127.0.0.1".into()), port: Some(port) })),
            loopback_port: port,
            host_token: "host".into(),
            hooks: Arc::new(Hooks::new()),
        });
        let app = make_router(AppState { kind: ListenerKind::Lan, shared: shared.clone() });
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        tokio::time::sleep(Duration::from_millis(50)).await;
        (port, shared)
    }

    async fn connect(port: u16, query: &str) -> Result<WsStream, String> {
        let req = http::Request::builder()
            .method("GET")
            .uri(format!("ws://127.0.0.1:{}/ws?{}", port, query))
            .header("Host", format!("127.0.0.1:{}", port))
            .header("Origin", format!("http://127.0.0.1:{}", port))
            .header("Connection", "Upgrade")
            .header("Upgrade", "websocket")
            .header("Sec-WebSocket-Version", "13")
            .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
            .body(())
            .unwrap();
        let (mut ws, _) = tokio_tungstenite::connect_async(req).await.map_err(|e| e.to_string())?;
        ws.send(WsMsg::Text(r#"{"t":"hello","token":"tok"}"#.into())).await.unwrap();
        // welcome + full-state + board-usage
        for _ in 0..3 { next(&mut ws).await.expect("handshake"); }
        Ok(ws)
    }

    async fn next(ws: &mut WsStream) -> Option<WsMsg> {
        match tokio::time::timeout(Duration::from_secs(15), ws.next()).await { // 调试构建下编码 2560×1600 截图较慢
            Ok(Some(Ok(m))) => Some(m),
            _ => None,
        }
    }
    async fn next_text(ws: &mut WsStream) -> serde_json::Value {
        loop {
            match next(ws).await.expect("message") {
                WsMsg::Text(t) => {
                    let v: serde_json::Value = serde_json::from_str(&t).unwrap();
                    if v["t"] == "pad-status" || v["t"] == "board-usage" { continue; }
                    return v;
                }
                other => panic!("期望文本消息，收到 {:?}", other),
            }
        }
    }
    fn txt(s: &str) -> WsMsg { WsMsg::Text(s.to_string().into()) }

    fn fake_frame(counter: Arc<AtomicU64>) -> Arc<CaptureFn> {
        Arc::new(move |w| {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            // 前两次同一画面，之后画面变化
            let shade = if n < 2 { 10u8 } else { 200u8 };
            let img = xcap::image::RgbaImage::from_pixel(2560, 1600, xcap::image::Rgba([shade, 120, 60, 255]));
            encode_preview(&img, w)
        })
    }

    /// LAN 的 iPad 可以写入标注板（不进共享白板）；仍然不能以 overlay/view 身份接入；未知 board 被拒。
    #[tokio::test]
    async fn lan_pad_writes_to_overlay_board() {
        let (port, shared) = lan_server(0).await;
        assert!(connect(port, "role=overlay").await.is_err());
        assert!(connect(port, "role=view&board=overlay").await.is_err());
        assert!(connect(port, "role=pad&board=desktop").await.is_err());
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        pad.send(txt(r##"{"t":"stroke-start","id":"a1","color":"#e5484d","size":4,"tool":"marker"}"##)).await.unwrap();
        pad.send(txt(r#"{"t":"stroke-point","id":"a1","x":0.2,"y":0.3,"p":0.7}"#)).await.unwrap();
        pad.send(txt(r#"{"t":"stroke-end","id":"a1"}"#)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        let ov = shared.overlay_board.lock().await;
        assert_eq!(ov.strokes().len(), 1);
        assert_eq!(ov.strokes()[0].tool, "marker");
        assert!(shared.board.lock().await.strokes().is_empty(), "不能写进共享白板");
    }

    /// v0.6.1 画笔：钢笔/糖露/凝胶墨水笔/Looney/荧光/橡皮都能写入；未知画笔被拒
    #[tokio::test]
    async fn brush_presets_accepted() {
        let (port, shared) = lan_server(0).await;
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        let tools = ["pen", "syrup", "gel", "looney", "marker", "eraser", "v2/n0.55/a-25/s0.8/e3.2/f0.35/g0.04/o1", "fountain", "v2/<script>", "v2/n1/../../x y"];
        for (i, t) in tools.iter().enumerate() {
            pad.send(txt(&format!(r##"{{"t":"stroke-start","id":"b{}","color":"#1a1a1a","size":4,"tool":"{}"}}"##, i, t))).await.unwrap();
            pad.send(txt(&format!(r#"{{"t":"stroke-point","id":"b{}","x":0.2,"y":0.3,"p":0.7}}"#, i))).await.unwrap();
            pad.send(txt(&format!(r#"{{"t":"stroke-end","id":"b{}"}}"#, i))).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        let ov = shared.overlay_board.lock().await;
        let got: Vec<&str> = ov.strokes().iter().map(|s| s.tool.as_str()).collect();
        assert_eq!(got, &tools[..7], "未知画笔与非法字符的 v2 参数串不应被接受");
    }

    /// v1.0.2：录屏可见开关默认打开（录屏、会议共享里能看到标注；以前默认关闭，用户录屏时标注丢失）
    #[test]
    fn capture_visible_defaults_on() {
        assert!(Hooks::new().capture_visible.load(Ordering::SeqCst));
    }

    /// v0.8.12：屏幕画面的 preview-meta 带 ink 标记——“录屏/共享时显示标注”打开时画面里含标注层
    #[tokio::test]
    async fn preview_meta_reports_ink_in_frame() {
        for visible in [false, true] {
            let hooks = Arc::new(Hooks::new());
            hooks.capture_visible.store(visible, Ordering::SeqCst);
            let _ = hooks.capture.set(Arc::new(|_w| Ok(PreviewFrame { w: 1600, h: 1000, fw: 160, fh: 100, png: vec![1, 2, 3], hash: 42 })));
            let (tx, mut rx) = tokio::sync::mpsc::channel(4);
            spawn_preview(hooks, tx, Arc::new(AtomicBool::new(false)), Arc::new(AtomicU64::new(0)), 1600);
            let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
            let meta = match &msg.msgs[0] { Message::Text(t) => serde_json::from_str::<serde_json::Value>(t).unwrap(), _ => panic!("首条应为 preview-meta") };
            assert_eq!(meta["t"], "preview-meta");
            assert_eq!(meta["ink"], visible, "ink 标记应与录屏可见开关一致");
            assert!(matches!(&msg.msgs[1], Message::Binary(b) if b.len() == 3));
        }
    }

    /// iPad 进入/离开标注模式时通知桌面端（用于自动打开标注层）
    #[tokio::test]
    async fn annotate_hook_counts_pads() {
        let (port, shared) = lan_server(0).await;
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let s2 = seen.clone();
        let _ = shared.hooks.on_annotate.set(Arc::new(move |n| s2.lock().unwrap().push(n)));
        let board_pad = connect(port, "role=pad").await.unwrap();
        let pad = connect(port, "role=pad&board=overlay").await.unwrap();
        drop(pad);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(*seen.lock().unwrap(), vec![1, 0], "白板模式的 iPad 不触发标注层");
        drop(board_pad);
    }

    /// 屏幕画面：先发 meta 再发 PNG；画面没变回 preview-same；关闭共享回 preview-off；白板模式不响应
    #[tokio::test]
    async fn preview_protocol() {
        let (port, shared) = lan_server(0).await;
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "preview-error", "没有截屏能力时要明确回复");

        let counter = Arc::new(AtomicU64::new(0));
        let _ = shared.hooks.capture.set(fake_frame(counter.clone()));
        pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        let meta = next_text(&mut pad).await;
        assert_eq!(meta["t"], "preview-meta");
        assert_eq!((meta["w"].as_u64(), meta["h"].as_u64(), meta["fw"].as_u64(), meta["fh"].as_u64()), (Some(2560), Some(1600), Some(1600), Some(1000)));
        match next(&mut pad).await.expect("frame") {
            WsMsg::Binary(b) => assert_eq!(&b[..8], b"\x89PNG\r\n\x1a\n"),
            other => panic!("期望 PNG 二进制帧，收到 {:?}", other),
        }
        pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "preview-same");
        pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "preview-meta", "画面变化后重新发送");
        assert!(matches!(next(&mut pad).await, Some(WsMsg::Binary(_))));

        shared.hooks.preview_allowed.store(false, Ordering::SeqCst);
        pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "preview-off");

        // 白板模式的 iPad 发同样请求：不处理（按普通消息解析失败忽略）
        shared.hooks.preview_allowed.store(true, Ordering::SeqCst);
        let mut board_pad = connect(port, "role=pad").await.unwrap();
        board_pad.send(txt(r#"{"t":"preview-req","w":1600}"#)).await.unwrap();
        while let Ok(Some(Ok(m))) = tokio::time::timeout(Duration::from_millis(500), board_pad.next()).await {
            let t = m.to_text().unwrap_or("").to_string();
            assert!(t.contains("pad-status"), "白板模式不应回复画面请求：{}", t);
        }
    }

    /// 截图请求：名称只允许数字、-、_；没有桌面能力时明确报错
    #[tokio::test]
    async fn save_shot_validation() {
        let (port, shared) = lan_server(0).await;
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        pad.send(txt(r#"{"t":"save-shot","name":"../../evil"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "shot-error");
        pad.send(txt(r#"{"t":"save-shot","name":"20261016-191500"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "shot-error");
        let _ = shared.hooks.save_shot.set(Arc::new(|name| Ok(format!("X:/shots/标注截图-{}.png", name))));
        pad.send(txt(r#"{"t":"save-shot","name":"20261016-191500"}"#)).await.unwrap();
        let v = next_text(&mut pad).await;
        assert_eq!(v["t"], "shot-saved");
        assert!(v["path"].as_str().unwrap().ends_with("20261016-191500.png"));
    }

    /// 笔头大小同步：iPad（标注板）调整后，白板模式的 iPad 也收到；新连接可查询；非法值忽略
    #[tokio::test]
    async fn pen_size_sync() {
        let (port, _shared) = lan_server(0).await;
        let mut a = connect(port, "role=pad&board=overlay").await.unwrap();
        let mut b = connect(port, "role=pad").await.unwrap();
        a.send(txt(r#"{"t":"pen-size","size":12.5}"#)).await.unwrap();
        let got = next_text(&mut b).await;
        assert_eq!((got["t"].as_str(), got["size"].as_f64()), (Some("pen-size"), Some(12.5)));
        assert!(got.get("brush").is_none());
        // v0.8.2：画笔名原样转发；不合法的名称被丢掉
        a.send(txt(r#"{"t":"pen-size","size":9,"brush":"soft"}"#)).await.unwrap();
        let got = next_text(&mut b).await;
        assert_eq!((got["size"].as_f64(), got["brush"].as_str()), (Some(9.0), Some("soft")));
        a.send(txt(r#"{"t":"pen-size","size":7,"brush":"<x>"}"#)).await.unwrap();
        let got = next_text(&mut b).await;
        assert!(got.get("brush").is_none() && got["size"].as_f64() == Some(7.0));
        a.send(txt(r#"{"t":"pen-size","size":12.5}"#)).await.unwrap();
        let _ = next_text(&mut b).await;
        a.send(txt(r#"{"t":"pen-size","size":5000}"#)).await.unwrap();
        a.send(txt(r#"{"t":"pen-size-get"}"#)).await.unwrap();
        let cur = next_text(&mut a).await;
        assert_eq!(cur["size"].as_f64(), Some(12.5), "超出范围的值被忽略，查询返回当前值");
    }

    /// 画笔备份：无效数据被拒；测试环境不落盘，查询返回空
    #[tokio::test]
    async fn brushes_backup_protocol() {
        let (port, _shared) = lan_server(0).await;
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        pad.send(txt(r#"{"t":"brushes-save","data":"[1,2]"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "brushes-error", "只接受 JSON 对象");
        pad.send(txt(r#"{"t":"brushes-save","data":"{\"customs\":[]}"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "brushes-error", "测试环境不写文件");
        pad.send(txt(r#"{"t":"brushes-get"}"#)).await.unwrap();
        let v = next_text(&mut pad).await;
        assert_eq!(v["t"], "brushes"); assert!(v["data"].is_null());
    }

    /// 书写诊断：名称、大小、JSON 校验；测试环境不落盘
    /// 多语言：程序本体文字随语言切换；iPad 能取到 /i18n.js
    #[tokio::test]
    async fn i18n_language_and_script() {
        assert!(!set_current_lang("xx"));
        assert!(set_current_lang("en"));
        assert_eq!(rs_tr("quit"), "Quit");
        assert_eq!(rs_tr("file_shot"), "annotated-screenshot");
        assert!(set_current_lang("ja"));
        assert_eq!(rs_tr("app"), "InkCast");
        assert!(set_current_lang("zh-CN"));
        assert_eq!(rs_tr("overlay"), "墨投 · 标注层");
        for l in LANGS.iter() { assert!(set_current_lang(l)); for k in ["app", "overlay", "open_overlay", "toggle_mode", "close_overlay", "quit", "file_diag", "file_shot", "file_check"] { assert!(!rs_tr(k).is_empty(), "{} {}", l, k); } }
        assert!(set_current_lang("zh-CN"));
        let (port, _shared) = lan_server(0).await;
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        s.write_all(b"GET /i18n.js HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        let text = String::from_utf8_lossy(&buf);
        assert!(text.starts_with("HTTP/1.1 200"), "{}", &text[..text.len().min(200)]);
        assert!(text.contains("root.I18N = api") && text.contains("\"pad.title\""));
        // v0.8.13：iPad 菜单里的“使用说明”由局域网服务提供，页面不引用任何外部资源（离线可用、不向第三方发请求）
        let mut g = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        g.write_all(b"GET /guide HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut gb = Vec::new();
        g.read_to_end(&mut gb).await.unwrap();
        let gt = String::from_utf8_lossy(&gb);
        assert!(gt.starts_with("HTTP/1.1 200") && gt.contains("text/html") && gt.contains("<title>墨投使用说明</title>"));
        // 只允许内联 SVG 的命名空间（xmlns），不能有任何外链资源
        for bad in ["src=\"http", "href=\"http", "url(http", "url(\"http", "url('http", "@import", "<link"] { assert!(!gt.contains(bad), "使用说明不能引用外部资源: {}", bad); }
        // v0.8.14 开源审核：说明页没有内联脚本，带 CSP / nosniff / no-referrer
        let gl = gt.to_ascii_lowercase();
        assert!(gl.contains("content-security-policy: default-src 'none'; script-src 'self'") && gl.contains("x-content-type-options: nosniff") && gl.contains("referrer-policy: no-referrer"));
        assert!(gt.contains("<script src=\"guide.js\"></script>") && !gt.contains("<script>"), "说明页不能有内联脚本");
        // 8 种语言的说明文字都在 guide.js 里（按 ?lang= 切换）
        let get = |path: &'static str| async move {
            let mut c = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            c.write_all(format!("GET {} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n", path).as_bytes()).await.unwrap();
            let mut b = Vec::new(); c.read_to_end(&mut b).await.unwrap();
            String::from_utf8_lossy(&b).to_string()
        };
        let js = get("/guide.js").await;
        assert!(js.starts_with("HTTP/1.1 200") && js.to_ascii_lowercase().contains("x-content-type-options: nosniff"));
        for t in ["InkCast user guide", "墨投使用說明", "InkCast の使い方", "InkCast 사용 설명서", "InkCast-Anleitung", "Mode d'emploi d'InkCast", "Guía de uso de InkCast"] { assert!(js.contains(t), "{}", t); }
        // iPad 页面同样带 CSP，并禁止被其他网站嵌入
        let pad = get("/pad").await.to_ascii_lowercase();
        assert!(pad.starts_with("http/1.1 200") && pad.contains("content-security-policy: default-src 'self'; script-src 'self'") && pad.contains("frame-ancestors 'none'"));
    }

    /// v0.8.14 开源审核：配对码 / 令牌用定长比较；诊断文件数量有上限
    #[test]
    fn audit_helpers() {
        assert!(ct_eq("abcDEF123", "abcDEF123"));
        assert!(!ct_eq("abcDEF123", "abcDEF124") && !ct_eq("abc", "abcd") && !ct_eq("", "a"));
        let dir = std::env::temp_dir().join(format!("inkcast-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..25 {
            std::fs::write(dir.join(format!("d{:02}.json", i)), "{}").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        std::fs::write(dir.join("keep.txt"), "x").unwrap();
        prune_dir(&dir, "json", 20);
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names.iter().filter(|n| n.ends_with(".json")).count(), 20);
        assert!(names.contains(&"keep.txt".to_string()) && names.contains(&"d24.json".to_string()) && !names.contains(&"d00.json".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
        // 截图保存路径：只写 .png，相对路径拒绝
        let abs = std::env::temp_dir().join("shot.PNG");
        assert_eq!(png_path(abs.to_str().unwrap()).unwrap(), abs);
        let bat = std::env::temp_dir().join("evil.bat");
        assert!(png_path(bat.to_str().unwrap()).unwrap().to_string_lossy().ends_with("evil.bat.png"));
        assert!(png_path("relative.png").is_err() && png_path("").is_err());
        // 局域网共享只能绑定具体的本机地址
        assert!(valid_lan_ip("192.168.1.20").is_some());
        for bad in ["0.0.0.0", "127.0.0.1", "255.255.255.255", "224.0.0.1", "::1", "abc", "192.168.1.300"] { assert!(valid_lan_ip(bad).is_none(), "{}", bad); }
    }

    /// 产品化：网络地址排序、免安装模式判断、单实例“显示窗口”接口只对本机开放
    #[tokio::test]
    async fn productization_helpers() {
        let ip = |s: &str| -> std::net::Ipv4Addr { s.parse().unwrap() };
        let order = |list: Vec<(&str, &str)>, def: Option<&str>| -> Vec<String> {
            rank_nets(list.into_iter().map(|(n, a)| (n.to_string(), ip(a))).collect(), def).into_iter().map(|c| c.ip).collect()
        };
        // 普通情况：系统默认上网网卡排第一；虚拟机、Tailscale 排后面
        assert_eq!(order(vec![("VirtualBox Host-Only", "192.168.56.1"), ("WLAN", "192.168.1.20"), ("Tailscale", "100.80.1.2")], Some("192.168.1.20")),
                   vec!["192.168.1.20", "192.168.56.1", "100.80.1.2"]);
        // v1.0.1 实际案例：v2rayN 开着 TUN，系统默认上网网卡是 172.18.0.1——Wi-Fi 仍然排第一
        let r = rank_nets(vec![("singbox_tun".into(), ip("172.18.0.1")), ("WLAN".into(), ip("192.168.99.22"))], Some("172.18.0.1"));
        assert_eq!(r[0].ip, "192.168.99.22");
        assert!(!r[0].virt && r[1].virt);
        // 网卡名看不出来时，按地址判断：172.x.x.1（WSL / Docker / TUN 网关）、198.18/15（代理 fake-ip）
        assert_eq!(order(vec![("Unknown", "172.18.0.1"), ("以太网", "10.0.0.8")], Some("172.18.0.1")), vec!["10.0.0.8", "172.18.0.1"]);
        assert_eq!(order(vec![("Meta", "198.18.0.1"), ("Wi-Fi", "192.168.0.5")], Some("198.18.0.1")), vec!["192.168.0.5", "198.18.0.1"]);
        for (n, a) in [("vEthernet (WSL)", "172.25.160.1"), ("Clash", "198.19.0.1"), ("WireGuard Tunnel", "10.8.0.2"), ("OpenVPN TAP-Windows6", "10.9.0.6")] {
            assert!(looks_virtual(&ip(a), n), "{} {}", n, a);
        }
        for (n, a) in [("WLAN", "192.168.1.20"), ("以太网", "172.20.10.3"), ("Wi-Fi", "10.0.0.8"), ("Ethernet 2", "192.168.0.1")] {
            assert!(!looks_virtual(&ip(a), n), "{} {}", n, a);
        }
        // v1.0.1：iPad 第一次打开（没有记录）默认是白板
        assert!(crate::PAD_JS.contains(r#"var mode = store("wb_mode") === "annotate" ? "annotate" : "board";"#));
        let dir = std::env::temp_dir().join(format!("inkcast-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!portable_dir(&dir));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        assert!(portable_dir(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        let (port, shared) = lan_server(0).await;
        let shown = Arc::new(AtomicUsize::new(0));
        let s2 = shown.clone();
        let _ = shared.hooks.on_show.set(Arc::new(move || { s2.fetch_add(1, Ordering::SeqCst); }));
        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        c.write_all(b"GET /api/show HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
        let mut buf = Vec::new(); c.read_to_end(&mut buf).await.unwrap();
        assert!(String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 404"), "LAN listener must not expose /api/show");
        assert_eq!(shown.load(Ordering::SeqCst), 0);
        assert!(get_notices().contains("third-party") && get_notices().len() > 10_000);
    }

    #[tokio::test]
    async fn save_diag_validation() {
        let (port, _shared) = lan_server(0).await;
        let mut pad = connect(port, "role=pad&board=overlay").await.unwrap();
        pad.send(txt(r#"{"t":"save-diag","name":"../x","data":"{}"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "diag-error");
        pad.send(txt(r#"{"t":"save-diag","name":"20261017-091500","data":"not json"}"#)).await.unwrap();
        assert_eq!(next_text(&mut pad).await["t"], "diag-error");
        pad.send(txt(r#"{"t":"save-diag","name":"20261017-091500","data":"{\"strokes\":[]}"}"#)).await.unwrap();
        let v = next_text(&mut pad).await;
        assert_eq!(v["t"], "diag-error", "测试环境（未开启持久化）不写文件");
        assert!(v["message"].as_str().unwrap().contains("不保存"));
    }

    /// v0.8.7：截图合成标注墨迹——透明处保留屏幕，墨迹处覆盖；尺寸不同自动缩放；坏数据报错不崩溃
    #[test]
    fn composite_ink_layer() {
        use base64::engine::general_purpose::STANDARD;
        use base64::Engine as _;
        use xcap::image::{Rgba, RgbaImage, ImageFormat};
        let mut base = RgbaImage::from_pixel(200, 100, Rgba([10, 20, 30, 255]));
        // 墨迹层是一半尺寸（100×50）：左上角 10×10 红色不透明，其余全透明
        let mut ink = RgbaImage::from_pixel(100, 50, Rgba([0, 0, 0, 0]));
        for y in 0..10 { for x in 0..10 { ink.put_pixel(x, y, Rgba([255, 0, 0, 255])); } }
        let mut png = std::io::Cursor::new(Vec::new());
        ink.write_to(&mut png, ImageFormat::Png).unwrap();
        crate::composite_ink_b64(&mut base, &STANDARD.encode(png.into_inner())).unwrap();
        assert_eq!(base.get_pixel(5, 5).0, [255, 0, 0, 255], "墨迹覆盖到截图上（按比例放大）");
        assert_eq!(base.get_pixel(150, 80).0, [10, 20, 30, 255], "透明处保留屏幕内容");
        assert!(crate::composite_ink_b64(&mut base, "not-base64!!").is_err());
        assert!(crate::composite_ink_b64(&mut base, &STANDARD.encode(b"not a png")).is_err());
    }

    /// v0.8.8：穿透模式小工具栏的命中范围（四周 6 像素余量）
    #[test]
    fn overlay_hit_rect() {
        let r = [100.0, 12.0, 300.0, 50.0];
        assert!(crate::in_hit_rect(&r, 100.0, 12.0));
        assert!(crate::in_hit_rect(&r, 250.0, 40.0));
        assert!(crate::in_hit_rect(&r, 95.0, 8.0), "边缘余量");
        assert!(!crate::in_hit_rect(&r, 90.0, 40.0));
        assert!(!crate::in_hit_rect(&r, 250.0, 70.0));
        assert!(!crate::in_hit_rect(&r, 407.0, 40.0));
    }

    /// v0.8.9：“屏幕 | 白板”双向同步——iPad 的 pad-mode 交给程序；程序的 pc-mode 发到两块板上的所有 iPad
    #[tokio::test]
    async fn mode_sync_protocol() {
        let (port, shared) = lan_server(0).await;
        let got = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let g = got.clone();
        let _ = shared.hooks.on_pad_mode.set(Arc::new(move |m| g.lock().unwrap().push(m)));
        let mut a = connect(port, "role=pad&board=overlay").await.unwrap();
        let mut b = connect(port, "role=pad").await.unwrap();
        a.send(txt(r#"{"t":"pad-mode","mode":"board"}"#)).await.unwrap();
        a.send(txt(r#"{"t":"pad-mode","mode":"<bad>"}"#)).await.unwrap();
        b.send(txt(r#"{"t":"pad-mode","mode":"annotate"}"#)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(*got.lock().unwrap(), vec!["board".to_string(), "annotate".to_string()], "无效模式被忽略");
        crate::broadcast_pc_mode(&shared, true);
        let va = next_text(&mut a).await;
        let vb = next_text(&mut b).await;
        assert_eq!((va["t"].as_str(), va["mode"].as_str()), (Some("pc-mode"), Some("annotate")));
        assert_eq!((vb["t"].as_str(), vb["mode"].as_str()), (Some("pc-mode"), Some("annotate")));
        crate::broadcast_pc_mode(&shared, false);
        assert_eq!(next_text(&mut b).await["mode"].as_str(), Some("board"));
    }

    /// 开发服务器：WB_DEV_PORT 端口、配对码 WB_DEV_PAIR，带合成屏幕画面。仅手动运行：
    ///   WB_DEV_PORT=18888 WB_DEV_PAIR=devpair cargo test dev_server -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn dev_server() {
        let port: u16 = std::env::var("WB_DEV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(18888);
        let (port, shared) = lan_server(port).await;
        shared.auth.lock().await.pair_code = Some((std::env::var("WB_DEV_PAIR").unwrap_or("devpair".into()), Instant::now() + Duration::from_secs(3600)));
        // WB_DEV_ANIM=1：每帧画面都略有变化（模拟电脑屏幕一直在变，用于测 iPad 收画面时的书写流畅度）
        let anim = std::env::var("WB_DEV_ANIM").is_ok();
        let frame_no = Arc::new(AtomicU64::new(0));
        let _ = shared.hooks.capture.set(Arc::new(move |w| {
            // 合成一张“文档截图”：白底 + 灰色文字行 + 蓝色标题条
            let mut img = xcap::image::RgbaImage::from_pixel(2560, 1600, xcap::image::Rgba([255, 255, 255, 255]));
            if anim {
                let n = frame_no.fetch_add(1, Ordering::SeqCst) as u32;
                for y in 1450..1550u32 { for x in 0..2560u32 { if (x / 40 + n) % 2 == 0 { img.put_pixel(x, y, xcap::image::Rgba([(n * 37 % 255) as u8, 90, 160, 255])); } } }
            }
            for y in 0..1600u32 { for x in 0..2560u32 {
                let title = y > 120 && y < 200 && x > 200 && x < 1400;
                let line = (y / 60) % 2 == 0 && y > 300 && y < 1400 && x > 200 && x < 200 + 1800 - (y % 7) * 60;
                if title { img.put_pixel(x, y, xcap::image::Rgba([47, 111, 237, 255])); }
                else if line && (y % 60) < 22 { img.put_pixel(x, y, xcap::image::Rgba([170, 170, 178, 255])); }
            } }
            encode_preview(&img, w)
        }));
        println!("DEV_SERVER_READY {}", port);
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let ov = shared.overlay_board.lock().await;
            let json = serde_json::to_string(ov.strokes()).unwrap();
            let _ = std::fs::write(std::env::var("WB_DEV_DUMP").unwrap_or("/tmp/wb_overlay.json".into()), json);
        }
    }
}
