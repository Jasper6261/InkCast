//! InkCast（墨投）v1.0.2 — Windows / macOS 桌面端。
//!
//! 双监听：
//!   - loopback（127.0.0.1:0，常开）：只给本机 viewer 用，hostToken 经 Tauri command 下发。
//!   - LAN（按需启动）：绑定用户所选网卡 IPv4，iPad 扫码配对后接入。
//!
//! 配对认证：二维码 fragment 携带 pairCode（128bit，5 分钟有效，一次性）
//!   → POST /api/pair 换 token → WS 首条消息 hello{token}（5s 超时则关闭）。
//! Host / Origin 严格校验（防 DNS rebinding / CSWSH）。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod board;
mod license;
mod overlay_lifecycle;
#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod limit_tests;
#[cfg(test)]
mod backend_tests;
#[cfg(test)]
mod v06_tests;

use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Host, Query, State,
    },
    http::{header, StatusCode},
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use board::{Board, ClientMsg, ServerMsg};
use futures_util::{sink::SinkExt, stream::StreamExt};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc, watch, Mutex},
    task::JoinHandle,
};

static PAD_HTML: &str = include_str!("../../pad/pad.html");
static PAD_JS: &str = include_str!("../../pad/pad.js");
static SHARED_JS: &str = include_str!("../../src/shared.js");
static INK_JS: &str = include_str!("../../src/ink.js");
static I18N_JS: &str = include_str!("../../src/i18n.js");
/// v0.8.13：使用说明（与电脑端 src/guide.html 同一份；不引用任何外部资源）
static GUIDE_HTML: &str = include_str!("../../src/guide.html");
static GUIDE_JS: &str = include_str!("../../src/guide.js");

// ---------- 多语言（程序本体部分：托盘菜单、窗口标题、保存的文件名） ----------
// 界面文字都在 src/i18n.js；这里只放程序本体自己显示的少量文字。语言由主窗口通过 set_language 设置。
pub(crate) const LANGS: [&str; 8] = ["zh-CN", "zh-TW", "en", "ja", "ko", "de", "fr", "es"];
static LANG: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());
pub(crate) fn current_lang() -> String {
    let l = LANG.read().map(|g| g.clone()).unwrap_or_default();
    if l.is_empty() { "zh-CN".into() } else { l }
}
pub(crate) fn set_current_lang(lang: &str) -> bool {
    if !LANGS.contains(&lang) { return false; }
    if let Ok(mut g) = LANG.write() { *g = lang.to_string(); }
    true
}
/// 程序本体文字：[简体, 繁體, English, 日本語, 한국어, Deutsch, Français, Español]
pub(crate) fn rs_tr(key: &str) -> &'static str {
    let row: [&'static str; 8] = match key {
        "app" => ["墨投", "墨投", "InkCast", "InkCast", "InkCast", "InkCast", "InkCast", "InkCast"],
        "overlay" => ["墨投 · 标注层", "墨投 · 標註層", "InkCast · Annotation Layer", "InkCast · 注釈レイヤー", "InkCast · 주석 레이어", "InkCast · Anmerkungsebene", "InkCast · Calque d'annotation", "InkCast · Capa de anotación"],
        "open_overlay" => ["打开标注层", "開啟標註層", "Open annotation layer", "注釈レイヤーを開く", "주석 레이어 열기", "Anmerkungsebene öffnen", "Ouvrir le calque d'annotation", "Abrir capa de anotación"],
        "toggle_mode" => ["切换 穿透/绘制", "切換 穿透/繪製", "Toggle click-through / draw", "クリックスルー／描画を切り替え", "클릭 통과/그리기 전환", "Durchklicken / Zeichnen umschalten", "Basculer clic traversant / dessin", "Alternar clic a través / dibujo"],
        "close_overlay" => ["关闭标注层", "關閉標註層", "Close annotation layer", "注釈レイヤーを閉じる", "주석 레이어 닫기", "Anmerkungsebene schließen", "Fermer le calque d'annotation", "Cerrar capa de anotación"],
        "quit" => ["退出", "結束", "Quit", "終了", "종료", "Beenden", "Quitter", "Salir"],
        "file_diag" => ["书写诊断", "書寫診斷", "writing-diagnostics", "書き込み診断", "필기-진단", "schreib-diagnose", "diagnostic-ecriture", "diagnostico-escritura"],
        "file_shot" => ["标注截图", "標註截圖", "annotated-screenshot", "注釈スクリーンショット", "주석-스크린샷", "kommentierter-screenshot", "capture-annotee", "captura-anotada"],
        "file_check" => ["画面自检", "畫面自我檢查", "screen-feed-check", "画面送信チェック", "화면-전송-확인", "bildpruefung", "verification-image", "comprobacion-imagen"],
        _ => return "",
    };
    let lang = current_lang();
    let i = LANGS.iter().position(|l| *l == lang).unwrap_or(0);
    row[i]
}

const PAIR_CODE_TTL: Duration = Duration::from_secs(300);
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_PAIR_FAILURES: u32 = 5;
const MAX_WS_MESSAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_REJECTED_STROKES: usize = 256;
const MAX_REJECTED_ID_BYTES: usize = 32 * 1024;
const DIRECT_QUEUE_CAPACITY: usize = 32;
#[cfg(not(target_os = "macos"))]
const DEFAULT_OVERLAY_SHORTCUT: &str = "Ctrl+Alt+Shift+A";
#[cfg(target_os = "macos")]
const DEFAULT_OVERLAY_SHORTCUT: &str = "Cmd+Alt+Shift+A";

// ---------- 数据位置 ----------
// 免安装模式：程序旁边已有 data 文件夹（或 portable.txt）时，数据继续放在程序旁边（你现在的 D 盘用法不变）。
// 安装版 / 商店版 / Mac：放到系统的用户数据目录（Windows %APPDATA%\com.inkcast.app，Mac ~/Library/Application Support/com.inkcast.app），
// 截图放到“图片”文件夹下的 InkCast。
static DATA_ROOT: OnceLock<(std::path::PathBuf, bool)> = OnceLock::new();
static SHOTS_ROOT: OnceLock<std::path::PathBuf> = OnceLock::new();
fn exe_dir() -> Option<std::path::PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.to_path_buf())
}
pub(crate) fn data_root() -> Option<std::path::PathBuf> {
    if let Some((p, _)) = DATA_ROOT.get() { return Some(p.clone()); }
    exe_dir()
}
fn is_portable() -> bool { DATA_ROOT.get().map(|x| x.1).unwrap_or(true) }
fn portable_dir(exe: &std::path::Path) -> bool {
    exe.join("data").is_dir() || exe.join("portable.txt").exists()
}
fn init_data_root(app: &tauri::AppHandle) {
    let exe = exe_dir();
    let portable = exe.as_deref().map(portable_dir).unwrap_or(false);
    let root = match (&exe, portable) {
        (Some(e), true) => e.clone(),
        _ => app.path().app_data_dir().ok().or(exe.clone()).unwrap_or_else(std::env::temp_dir),
    };
    let _ = std::fs::create_dir_all(&root);
    let shots = if portable { root.join("screenshots") } else {
        app.path().picture_dir().map(|p| p.join("InkCast")).unwrap_or_else(|_| root.join("screenshots"))
    };
    let _ = DATA_ROOT.set((root, portable));
    let _ = SHOTS_ROOT.set(shots);
}

// ---------- 崩溃日志：写到数据目录 logs\（写不进去就写到临时目录），不含笔迹和屏幕内容 ----------
fn install_crash_log() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let text = format!("InkCast {} crash at {:?}\n{}\n\n{}",
            env!("CARGO_PKG_VERSION"),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            info, std::backtrace::Backtrace::force_capture());
        let name = format!("crash-{}.txt", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0));
        let wrote = data_root().map(|r| r.join("logs")).and_then(|d| {
            std::fs::create_dir_all(&d).ok()?; std::fs::write(d.join(&name), &text).ok()
        });
        if wrote.is_none() { let _ = std::fs::write(std::env::temp_dir().join(format!("inkcast-{}", name)), &text); }
        default(info);
    }));
}

// ---------- 只运行一个实例：再次打开时把已运行的窗口调到前面 ----------
static INSTANCE_LOCK: OnceLock<std::fs::File> = OnceLock::new();
/// 单实例锁文件的位置。v0.8.7：不再用 TEMP——不同方式启动的程序 TEMP 可能不同（例如编译脚本把 TEMP 指到 D 盘），
/// 锁文件不在同一处就会同时跑起两个程序。Windows 用 %LOCALAPPDATA%\InkCast，macOS 用 ~/Library/Caches/InkCast，取不到再退回 TEMP
fn instance_dir() -> std::path::PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from)
    } else {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library").join("Caches"))
    };
    match base.filter(|b| b.is_absolute()) {
        Some(b) => {
            let d = b.join("InkCast");
            if std::fs::create_dir_all(&d).is_ok() { d } else { std::env::temp_dir() }
        }
        None => std::env::temp_dir(),
    }
}
fn instance_paths() -> (std::path::PathBuf, std::path::PathBuf) {
    let t = instance_dir();
    (t.join("inkcast-instance.lock"), t.join("inkcast-instance.port"))
}
/// 返回 false 表示已有实例在运行（已通知它显示窗口），本进程应退出
fn acquire_single_instance() -> bool {
    let (lock_path, port_path) = instance_paths();
    let file = match std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(&lock_path) {
        Ok(f) => f,
        Err(_) => return true, // 拿不到锁文件时不阻止启动
    };
    match file.try_lock() {
        Ok(()) => { let _ = INSTANCE_LOCK.set(file); true }
        Err(std::fs::TryLockError::WouldBlock) => {
            if let Some(port) = std::fs::read_to_string(&port_path).ok().and_then(|s| s.trim().parse::<u16>().ok()) {
                use std::io::Write;
                if let Ok(mut c) = std::net::TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(800)) {
                    let _ = c.write_all(b"GET /api/show HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n");
                }
            }
            false
        }
        Err(_) => true,
    }
}
fn publish_instance_port(port: u16) {
    if INSTANCE_LOCK.get().is_some() { let _ = std::fs::write(instance_paths().1, port.to_string()); }
}
const OVERLAY_CLOSE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy, PartialEq)]
enum ListenerKind {
    Loopback,
    Lan,
}

/// v0.6：屏幕画面帧（已缩放、PNG 编码）
pub(crate) struct PreviewFrame {
    pub w: u32,
    pub h: u32,
    pub fw: u32,
    pub fh: u32,
    pub png: Vec<u8>,
    pub hash: u64,
}

type CaptureFn = dyn Fn(u32) -> Result<PreviewFrame, String> + Send + Sync;
type ShotFn = dyn Fn(String) -> Result<String, String> + Send + Sync;

/// v0.6：服务端与桌面端之间的挂钩。测试环境不设置，相应请求会得到明确的“不支持”回复。
pub(crate) struct Hooks {
    pub preview_allowed: AtomicBool,
    /// 录屏/共享时是否让标注层出现在画面里（默认 false：标注层不进入任何屏幕截取）
    pub capture_visible: AtomicBool,
    /// 是否把 iPad 配对信息保存到程序目录（data\lan.json），程序重启后 iPad 无需重新扫码。测试环境关闭。
    pub persist_lan: AtomicBool,
    /// 当前笔头大小（f32 位模式）：iPad、电脑主窗口、标注层三处同步
    pub pen_size: std::sync::atomic::AtomicU32,
    pub annotate_pads: AtomicUsize,
    pub capture: OnceLock<Arc<CaptureFn>>,
    pub save_shot: OnceLock<Arc<ShotFn>>,
    pub on_annotate: OnceLock<Arc<dyn Fn(usize) + Send + Sync>>,
    /// v0.8.9：iPad 切换了“屏幕 | 白板”（参数 "annotate" | "board"），电脑跟着切
    pub on_pad_mode: OnceLock<Arc<dyn Fn(String) + Send + Sync>>,
    pub on_preview_frame: OnceLock<Arc<dyn Fn() + Send + Sync>>,
    /// 再次打开程序时：把主窗口调到前面
    pub on_show: OnceLock<Arc<dyn Fn() + Send + Sync>>,
}

impl Hooks {
    pub(crate) fn new() -> Self {
        Self {
            preview_allowed: AtomicBool::new(true),
            capture_visible: AtomicBool::new(true), // v1.0.2：默认打开，录屏 / 会议共享里能看到标注
            persist_lan: AtomicBool::new(false),
            pen_size: std::sync::atomic::AtomicU32::new(6.0f32.to_bits()),
            annotate_pads: AtomicUsize::new(0),
            capture: OnceLock::new(),
            save_shot: OnceLock::new(),
            on_annotate: OnceLock::new(),
            on_pad_mode: OnceLock::new(),
            on_preview_frame: OnceLock::new(),
            on_show: OnceLock::new(),
        }
    }
}

/// 跨监听共享的状态
#[derive(Clone)]
struct Shared {
    board: Arc<Mutex<Board>>,
    tx: broadcast::Sender<(u64, String)>, // (sender_conn_id, json)；u64::MAX = 发给所有人
    overlay_board: Arc<Mutex<Board>>,
    overlay_tx: broadcast::Sender<(u64, String)>,
    pad_count: Arc<AtomicUsize>,
    next_conn: Arc<AtomicU64>,
    auth: Arc<Mutex<Auth>>,
    auth_epoch: watch::Sender<u64>, // 撤销时唤醒并关闭服务端已有 LAN WebSocket
    lan_net: Arc<Mutex<LanNet>>,
    loopback_port: u16,
    host_token: String,
    hooks: Arc<Hooks>,
}

#[derive(Clone)]
struct AppState {
    kind: ListenerKind,
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Auth {
    pair_code: Option<(String, Instant)>, // (code, expiry)
    token: Option<String>,               // 单人场景：同时只保留一个有效 token
    pair_failures: u32,
}

#[derive(Default)]
struct LanNet {
    ip: Option<String>,
    port: Option<u16>,
}

/// Tauri 托管
struct TauriState {
    shared: Arc<Shared>,
    lan_handle: Mutex<Option<JoinHandle<()>>>,
    last_lan_port: Mutex<Option<u16>>,
    overlay_clickthrough: Mutex<bool>, // 标注层是否处于穿透模式
    overlay_shortcut: Mutex<OverlayShortcut>,
    overlay_lifecycle: Mutex<overlay_lifecycle::OverlayLifecycle>,
    screenshot: Mutex<Option<xcap::image::RgbaImage>>,
}

/// 托盘菜单项：切换语言时更新文字
struct TrayLabels {
    open: tauri::menu::MenuItem<tauri::Wry>,
    toggle: tauri::menu::MenuItem<tauri::Wry>,
    close: tauri::menu::MenuItem<tauri::Wry>,
    quit: tauri::menu::MenuItem<tauri::Wry>,
    tray: tauri::tray::TrayIcon<tauri::Wry>,
}

// ---------- 授权（v0.8.6 预留）：激活码 / 功能解锁 ----------
fn license_file() -> Option<std::path::PathBuf> { Some(data_root()?.join("data").join("license.json")) }

#[tauri::command]
fn get_license_status() -> license::Status {
    let v = license::DevChecksumVerifier;
    let stored = license_file().and_then(|p| license::load(&p, &v));
    license::status(stored.as_ref(), &v)
}

#[tauri::command]
fn activate_license(code: String) -> Result<license::Status, String> {
    let v = license::DevChecksumVerifier;
    let path = license_file().ok_or("找不到程序目录")?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let stored = license::activate(&path, &v, &code, now)?;
    Ok(license::status(Some(&stored), &v))
}

#[tauri::command]
fn deactivate_license() -> Result<license::Status, String> {
    let path = license_file().ok_or("找不到程序目录")?;
    license::deactivate(&path)?;
    Ok(license::status(None, &license::DevChecksumVerifier))
}

/// “关于”窗口：版本、数据位置、系统
#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "dataDir": data_root().map(|p| p.display().to_string()).unwrap_or_default(),
        "shotsDir": SHOTS_ROOT.get().map(|p| p.display().to_string()).unwrap_or_default(),
        "portable": is_portable(),
        "os": std::env::consts::OS,
        "shortcut": DEFAULT_OVERLAY_SHORTCUT,
    })
}

/// 第三方开源组件许可声明（随程序分发）
#[tauri::command]
fn get_notices() -> &'static str { include_str!("../THIRD_PARTY_NOTICES.txt") }

/// iPad 连不上时：放行本程序的入站连接（只限本局域网、只限 TCP）。会弹出 Windows 管理员确认框，由用户本人确认。
/// v1.0.1：只替换“这个程序文件”的旧规则；以前会删掉所有墨投规则，导致另一个位置的墨投（如旧版）被挡住
#[tauri::command]
async fn fix_firewall() -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string().replace('\'', "''");
        let script = format!(
            "$exe='{exe}'; \
             Get-NetFirewallApplicationFilter | Where-Object {{ $_.Program -eq $exe }} | Get-NetFirewallRule | Where-Object {{ ($_.Action -eq 'Block' -and $_.Direction -eq 'Inbound') -or $_.Group -eq 'InkCast' }} | Remove-NetFirewallRule; \
             New-NetFirewallRule -DisplayName 'InkCast (local network, TCP)' -Group 'InkCast' -Direction Inbound -Action Allow -Program $exe -Protocol TCP -RemoteAddress LocalSubnet -Profile Private,Public | Out-Null");
        let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let outer = format!("$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','{}'; exit $p.ExitCode", encoded);
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new("powershell")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", outer.as_str()])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .status()
        }).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        if status.success() { Ok("ok".into()) } else { Err("cancelled".into()) }
    }
    #[cfg(not(windows))]
    { Ok("not-needed".into()) }
}

/// 设置界面语言：主窗口启动时和用户切换时调用。更新托盘菜单、窗口标题，并通知标注层
#[tauri::command]
fn set_language(app: tauri::AppHandle, lang: String) -> Result<String, String> {
    if !set_current_lang(&lang) { return Err(format!("unsupported language: {}", lang)); }
    if let Some(t) = app.try_state::<TrayLabels>() {
        let _ = t.open.set_text(rs_tr("open_overlay"));
        let _ = t.toggle.set_text(rs_tr("toggle_mode"));
        let _ = t.close.set_text(rs_tr("close_overlay"));
        let _ = t.quit.set_text(rs_tr("quit"));
        let _ = t.tray.set_tooltip(Some(rs_tr("app")));
    }
    if let Some(w) = app.get_webview_window("main") { let _ = w.set_title(rs_tr("app")); }
    if let Some(w) = app.get_webview_window("overlay") { let _ = w.set_title(rs_tr("overlay")); }
    let _ = app.emit("language-changed", lang.clone());
    Ok(current_lang())
}

struct OverlayShortcut {
    shortcut: String,
    registered: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OverlayStatus {
    /// v0.8.6：屏幕标注层是否打开（主窗口的“屏幕 | 白板”切换据此显示当前模式）
    open: bool,
    clickthrough: bool,
    shortcut: String,
    shortcut_registered: bool,
    shortcut_error: Option<String>,
}

// ---------- 工具 ----------

fn gen_secret() -> String {
    let mut bytes = [0u8; 16]; // 128 bit
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn qr_svg(data: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build())
}

fn to_json(msg: &ServerMsg) -> String {
    serde_json::to_string(msg).unwrap_or_else(|_| "{\"t\":\"clear\"}".to_string())
}

/// Host / Origin 严格校验。返回 Err → 403。
async fn check_host_origin(
    state: &AppState,
    host: &str,
    headers: &axum::http::HeaderMap,
) -> Result<(), ()> {
    let (exp_host, origin_ok) = match state.kind {
        ListenerKind::Loopback => {
            let exp = format!("127.0.0.1:{}", state.shared.loopback_port);
            // 静态 Tauri 前端无需开发服务器；只接受精确的本机应用 Origin。
            let origin_ok = headers
                .get(header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .map(|o| matches!(o, "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"))
                .unwrap_or(false);
            (exp, origin_ok)
        }
        ListenerKind::Lan => {
            let net = state.shared.lan_net.lock().await;
            match (&net.ip, net.port) {
                (Some(ip), Some(port)) => {
                    let base = format!("{}:{}", ip, port);
                    let origin_ok = headers
                        .get(header::ORIGIN)
                        .and_then(|v| v.to_str().ok())
                        .map(|o| o == format!("http://{}", base))
                        .unwrap_or(false);
                    (base, origin_ok)
                }
                _ => return Err(()),
            }
        }
    };
    if host != exp_host || !origin_ok {
        return Err(());
    }
    Ok(())
}

// ---------- HTTP ----------

const LANDING_HTML: &str = "<html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">\
         <title>InkCast</title></head><body style=\"font-family:sans-serif;text-align:center;padding-top:20vh\">\
         <h1>墨投 · InkCast</h1><p>iPad 请扫描电脑上显示的二维码配对。<br>Scan the QR code shown on the PC to pair your iPad. <a href=\"/pad\">/pad</a></p></body></html>";

async fn landing() -> impl IntoResponse {
    secure_html(LANDING_HTML, PAD_CSP)
}

async fn serve_js(body: &'static str) -> impl IntoResponse {
    ([(header::CONTENT_TYPE, "application/javascript; charset=utf-8"), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")], body)
}

// 局域网页面的安全响应头（开源审核 v0.8.14）：只允许本服务自己的脚本，禁止被别的网站嵌入，不带 Referer。
const PAD_CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
    connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const GUIDE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data:; \
    frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

fn secure_html(body: &'static str, csp: &'static str) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CONTENT_SECURITY_POLICY, csp),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::REFERRER_POLICY, "no-referrer"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        body,
    )
}

/// 定长比较：比较配对码 / 令牌时，耗时与内容无关
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() { return false; }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Deserialize)]
struct PairReq {
    #[serde(rename = "pairCode")]
    pair_code: String,
}

#[derive(Serialize)]
struct PairResp {
    token: String,
}

/// GET /api/show — 仅本机：第二次启动程序时，请已运行的程序把主窗口调到前面
async fn api_show(State(state): State<AppState>) -> StatusCode {
    if !matches!(state.kind, ListenerKind::Loopback) { return StatusCode::NOT_FOUND; }
    if let Some(f) = state.shared.hooks.on_show.get() { f(); }
    StatusCode::NO_CONTENT
}

/// POST /api/pair — 仅 LAN 监听提供
async fn api_pair(
    State(state): State<AppState>,
    Host(host): Host,
    headers: axum::http::HeaderMap,
    Json(body): Json<PairReq>,
) -> impl IntoResponse {
    if state.kind != ListenerKind::Lan {
        return StatusCode::NOT_FOUND.into_response();
    }
    if check_host_origin(&state, &host, &headers).await.is_err() {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut auth = state.shared.auth.lock().await;
    let ok = match &auth.pair_code {
        Some((code, exp)) if Instant::now() < *exp && ct_eq(code, &body.pair_code) => true,
        _ => false,
    };
    if !ok {
        auth.pair_failures += 1;
        if auth.pair_failures >= MAX_PAIR_FAILURES {
            auth.pair_code = None; // 多次失败则作废，需主机刷新
        }
        return StatusCode::FORBIDDEN.into_response();
    }
    let token = gen_secret();
    auth.token = Some(token.clone());
    auth.pair_code = None; // 一次性
    auth.pair_failures = 0;
    drop(auth);
    if state.shared.hooks.persist_lan.load(Ordering::SeqCst) {
        let net = state.shared.lan_net.lock().await;
        if let (Some(ip), Some(port)) = (net.ip.clone(), net.port) {
            save_lan(&SavedLan { ip, port, token: token.clone() });
        }
    }
    Json(PairResp { token }).into_response()
}

// ---------- 重启后自动恢复 iPad 连接 ----------
// 配对成功后把（IP、端口、配对令牌）存到程序目录 data\lan.json；
// 下次启动时如果这个 IP 仍属于本机、端口可用，就自动开启共享并接受同一令牌，iPad 会自动重连。
// “停止共享”“重新配对”会删除该文件。令牌只用于本局域网内的白板写入。
#[derive(Serialize, Deserialize)]
struct SavedLan {
    ip: String,
    port: u16,
    token: String,
}

fn lan_file() -> Option<std::path::PathBuf> {
    Some(data_root()?.join("data").join("lan.json"))
}

fn save_lan(saved: &SavedLan) {
    if let Some(path) = lan_file() {
        if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
        if let Ok(json) = serde_json::to_string(saved) { let _ = std::fs::write(path, json); }
    }
}

fn clear_saved_lan() {
    if let Some(path) = lan_file() { let _ = std::fs::remove_file(path); }
}

fn load_saved_lan() -> Option<SavedLan> {
    let saved: SavedLan = serde_json::from_str(&std::fs::read_to_string(lan_file()?).ok()?).ok()?;
    let token_ok = saved.token.len() >= 16 && saved.token.len() <= 64
        && saved.token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !token_ok || saved.port == 0 || saved.ip.parse::<std::net::Ipv4Addr>().is_err() { return None; }
    Some(saved)
}

async fn restore_lan(app: tauri::AppHandle) {
    let Some(saved) = load_saved_lan() else { return };
    let present = if_addrs::get_if_addrs()
        .map(|list| list.iter().any(|i| i.ip().to_string() == saved.ip))
        .unwrap_or(false);
    if !present { return; } // 换了网络：保留文件，下次回到这个网络还能用
    let Ok(listener) = TcpListener::bind((saved.ip.as_str(), saved.port)).await else { return };
    let s = app.state::<TauriState>();
    *s.last_lan_port.lock().await = Some(saved.port);
    *s.shared.lan_net.lock().await = LanNet { ip: Some(saved.ip.clone()), port: Some(saved.port) };
    s.shared.auth.lock().await.token = Some(saved.token);
    let state = AppState { kind: ListenerKind::Lan, shared: s.shared.clone() };
    let router = make_router(state);
    let handle = tokio::spawn(async move { axum::serve(listener, router).await.ok(); });
    *s.lan_handle.lock().await = Some(handle);
    let _ = app.emit("lan-restored", format!("{}:{}", saved.ip, saved.port));
}

// ---------- WebSocket ----------

#[derive(Deserialize)]
struct WsParams {
    role: Option<String>,
    board: Option<String>,
}

#[derive(Deserialize)]
struct HelloMsg {
    t: String,
    token: Option<String>,
}

async fn check_token(state: &AppState, token: &Option<String>) -> bool {
    match state.kind {
        ListenerKind::Loopback => {
            token.as_deref().map(|t| ct_eq(t, &state.shared.host_token)).unwrap_or(false)
        }
        ListenerKind::Lan => {
            let auth = state.shared.auth.lock().await;
            match (&auth.token, token) {
                (Some(a), Some(b)) => ct_eq(a, b),
                _ => false,
            }
        }
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Host(host): Host,
    headers: axum::http::HeaderMap,
    Query(params): Query<WsParams>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    check_host_origin(&state, &host, &headers)
        .await
        .map_err(|_| StatusCode::FORBIDDEN)?;
    let role = params.role.unwrap_or_else(|| "view".to_string());
    // LAN 只能以 pad 身份接入（不能冒充本机 viewer / overlay）。
    // v0.6：iPad 可以选择写入标注板（board=overlay），用于在电脑屏幕上标注。
    if !matches!(role.as_str(), "view" | "pad" | "pad-local" | "overlay")
        || (state.kind == ListenerKind::Lan && role != "pad")
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let use_overlay = match params.board.as_deref() {
        None | Some("main") => role == "overlay",
        Some("overlay") if role == "pad" || role == "overlay" => true,
        _ => return Err(StatusCode::FORBIDDEN),
    };
    Ok(ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state, role, use_overlay)))
}

/// 快照与订阅在同一把白板锁内建立；所有写入和广播也持有这把锁。
/// 因此快照之前的消息不会重放，快照之后的消息不会漏掉。
async fn snapshot_and_subscribe(
    board: &Mutex<Board>,
    tx: &broadcast::Sender<(u64, String)>,
) -> ([String; 2], broadcast::Receiver<(u64, String)>) {
    let board = board.lock().await;
    let rx = tx.subscribe();
    let full = to_json(&ServerMsg::FullState { strokes: board.strokes().to_vec() });
    ([full, to_json(&board.usage())], rx)
}

/// select 只等待原始 recv；消耗 Lagged 后的快照必须在分支外完成，不能被另一分支取消。
async fn board_message_batch(
    board: &Mutex<Board>,
    tx: &broadcast::Sender<(u64, String)>,
    rx: &mut broadcast::Receiver<(u64, String)>,
    conn_id: u64,
    received: Result<(u64, String), broadcast::error::RecvError>,
) -> Option<Vec<String>> {
    match received {
        Ok((from, text)) if from != conn_id => Some(vec![text]),
        Ok(_) => Some(vec![]),
        Err(broadcast::error::RecvError::Lagged(_)) => {
            let (snapshot, fresh_rx) = snapshot_and_subscribe(board, tx).await;
            *rx = fresh_rx;
            Some(snapshot.into())
        }
        Err(broadcast::error::RecvError::Closed) => None,
    }
}

struct DirectMessage {
    epoch: Option<u64>,
    msgs: Vec<Message>,
}

fn direct_text(text: impl Into<String>) -> DirectMessage {
    DirectMessage { epoch: None, msgs: vec![Message::Text(text.into())] }
}

async fn current_direct_message(board: &Mutex<Board>, message: DirectMessage) -> Vec<Message> {
    // clear / 成功导入后，旧笔画的排队修正不能再作用于新一版白板。
    // 普通 Error、画面帧等不改笔画，仍应送达发起连接。
    if let Some(epoch) = message.epoch {
        if board.lock().await.reset_epoch() != epoch { return vec![]; }
    }
    message.msgs
}

/// v0.6：处理 iPad 的屏幕画面请求（同一连接同时只处理一个，画面没变只回 preview-same）
fn spawn_preview(
    hooks: Arc<Hooks>,
    direct: mpsc::Sender<DirectMessage>,
    busy: Arc<AtomicBool>,
    last_hash: Arc<AtomicU64>,
    width: u32,
) {
    if busy.swap(true, Ordering::SeqCst) { return; }
    tokio::spawn(async move {
        let reply = if !hooks.preview_allowed.load(Ordering::SeqCst) {
            direct_text(r#"{"t":"preview-off"}"#)
        } else if let Some(capture) = hooks.capture.get().cloned() {
            match tokio::task::spawn_blocking(move || capture(width)).await {
                Ok(Ok(frame)) => {
                    if let Some(cb) = hooks.on_preview_frame.get() { cb(); }
                    if last_hash.swap(frame.hash, Ordering::SeqCst) == frame.hash {
                        direct_text(r#"{"t":"preview-same"}"#)
                    } else {
                        // v0.8.12：ink = 这张画面里是否带着标注层（“录屏/共享时显示标注”打开时标注层能被截到）
                        let ink = hooks.capture_visible.load(Ordering::SeqCst);
                        let meta = serde_json::json!({"t":"preview-meta","w":frame.w,"h":frame.h,"fw":frame.fw,"fh":frame.fh,"ink":ink}).to_string();
                        DirectMessage { epoch: None, msgs: vec![Message::Text(meta), Message::Binary(frame.png)] }
                    }
                }
                Ok(Err(e)) => direct_text(serde_json::json!({"t":"preview-error","message":e}).to_string()),
                Err(e) => direct_text(serde_json::json!({"t":"preview-error","message":e.to_string()}).to_string()),
            }
        } else {
            direct_text(r#"{"t":"preview-error","message":"当前环境不支持屏幕画面"}"#)
        };
        let _ = direct.send(reply).await;
        busy.store(false, Ordering::SeqCst);
    });
}

/// v0.6：iPad 请求在电脑上保存“屏幕 + 标注”截图
fn spawn_save_shot(hooks: Arc<Hooks>, direct: mpsc::Sender<DirectMessage>, name: String) {
    tokio::spawn(async move {
        let reply = match hooks.save_shot.get().cloned() {
            Some(save) => match tokio::task::spawn_blocking(move || save(name)).await {
                Ok(Ok(path)) => serde_json::json!({"t":"shot-saved","path":path}),
                Ok(Err(e)) => serde_json::json!({"t":"shot-error","message":e}),
                Err(e) => serde_json::json!({"t":"shot-error","message":e.to_string()}),
            },
            None => serde_json::json!({"t":"shot-error","message":"当前环境不支持截图"}),
        };
        let _ = direct.send(direct_text(reply.to_string())).await;
    });
}

const MAX_DIAG_BYTES: usize = 6 * 1024 * 1024;
const MAX_DIAG_FILES: usize = 20;
const MAX_BRUSHES_BYTES: usize = 256 * 1024;

fn brushes_file() -> Option<std::path::PathBuf> {
    Some(data_root()?.join("data").join("brushes.json"))
}

fn save_brushes(data: &str) -> Result<(), String> {
    let path = brushes_file().ok_or("找不到程序目录")?;
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    std::fs::write(path, data).map_err(|e| e.to_string())
}

fn load_brushes() -> Option<String> {
    let s = std::fs::read_to_string(brushes_file()?).ok()?;
    if s.len() > MAX_BRUSHES_BYTES || serde_json::from_str::<serde_json::Value>(&s).is_err() { return None; }
    Some(s)
}

/// 书写诊断：iPad 发来的原始 Pencil 事件记录，存到程序目录 diagnostics\（只含笔迹坐标、压力、时间，不含屏幕内容）
fn save_diag(name: &str, data: &str) -> Result<String, String> {
    let dir = data_root().ok_or("找不到程序目录")?.join("diagnostics");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建诊断目录：{}", e))?;
    let path = dir.join(format!("{}-{}.json", rs_tr("file_diag"), name));
    std::fs::write(&path, data).map_err(|e| e.to_string())?;
    prune_dir(&dir, "json", MAX_DIAG_FILES);
    Ok(path.display().to_string())
}

/// 只保留目录里最新的 keep 个指定扩展名文件（防止已配对设备反复上传占满磁盘）
pub(crate) fn prune_dir(dir: &std::path::Path, ext: &str, keep: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, std::path::PathBuf)> = rd.flatten()
        .filter(|e| e.path().extension().map(|x| x.eq_ignore_ascii_case(ext)).unwrap_or(false))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= keep { return; }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) { let _ = std::fs::remove_file(p); }
}

fn valid_shot_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_digit() || b == b'-' || b == b'_')
}

/// 只在这条连接内记住未结束的拒绝；断连自动释放，不改变普通笔画的共享语义。
#[derive(Default)]
struct RejectedStrokes {
    ids: HashSet<String>,
    id_bytes: usize,
    epoch: u64,
}

impl RejectedStrokes {
    fn sync_epoch(&mut self, epoch: u64) {
        if self.epoch != epoch {
            self.ids.clear();
            self.id_bytes = 0;
            self.epoch = epoch;
        }
    }

    fn handle(&mut self, board: &mut Board, msg: ClientMsg) -> Result<Vec<ServerMsg>, ()> {
        self.sync_epoch(board.reset_epoch());
        match &msg {
            ClientMsg::StrokeStart { id, .. } | ClientMsg::StrokePoint { id, .. }
                if self.ids.contains(id) => return Ok(vec![]),
            ClientMsg::StrokeEnd { id } => {
                if self.ids.remove(id) { self.id_bytes -= id.len(); }
            }
            _ => {}
        }
        let out = board.handle(msg);
        self.sync_epoch(board.reset_epoch());
        for message in &out {
            if let ServerMsg::StrokeRejected { id, .. } | ServerMsg::StrokeTruncate { id, .. } = message {
                // 不淘汰已有 id：淘汰会让同一笔再次收到拒绝，重新形成消息风暴。
                if self.ids.len() >= MAX_REJECTED_STROKES
                    || id.len() > MAX_REJECTED_ID_BYTES - self.id_bytes
                {
                    return Err(()); // 异常连接一直不发 end；由连接层关闭并释放全部记忆。
                }
                self.id_bytes += id.len();
                self.ids.insert(id.clone());
            }
        }
        Ok(out)
    }
}

async fn handle_socket(socket: WebSocket, state: AppState, role: String, use_overlay: bool) {
    let (mut sender, mut receiver) = socket.split();
    let mut revoked = state.shared.auth_epoch.subscribe();

    // 1. 首条消息必须是 hello{token}，5s 超时关闭
    let hello_text = match tokio::time::timeout(HELLO_TIMEOUT, receiver.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => t.to_string(),
        _ => return,
    };
    let hello: HelloMsg = match serde_json::from_str(&hello_text) {
        Ok(h) => h,
        Err(_) => return,
    };
    if hello.t != "hello" || !check_token(&state, &hello.token).await {
        let _ = sender
            .send(Message::Text(r#"{"t":"auth","ok":false,"reason":"bad-token"}"#.into()))
            .await;
        let _ = sender.send(Message::Close(None)).await;
        return; // 关闭连接
    }
    if sender
        .send(Message::Text(
            format!(r#"{{"t":"welcome","role":"{}"}}"#, role).into(),
        ))
        .await.is_err() { return; }

    let conn_id = state.shared.next_conn.fetch_add(1, Ordering::Relaxed);
    let is_pad = role == "pad";
    let annotate_pad = is_pad && use_overlay;
    let (board, tx) = if use_overlay {
        (state.shared.overlay_board.clone(), state.shared.overlay_tx.clone())
    } else {
        (state.shared.board.clone(), state.shared.tx.clone())
    };

    // 2. 初连快照与后续增量使用同一个同步边界。
    let (snapshot, mut rx) = snapshot_and_subscribe(&board, &tx).await;
    for text in snapshot {
        if sender.send(Message::Text(text.into())).await.is_err() { return; }
    }
    if is_pad {
        let n = state.shared.pad_count.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = state
            .shared
            .tx
            .send((u64::MAX, to_json(&ServerMsg::PadStatus { online: n })));
    }
    if annotate_pad {
        let n = state.shared.hooks.annotate_pads.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(cb) = state.shared.hooks.on_annotate.get() { cb(n); }
    }

    // 3. 有界直发只服务这条连接；绘画广播继续排除发送者。
    let (direct_tx, mut direct_rx) = mpsc::channel::<DirectMessage>(DIRECT_QUEUE_CAPACITY);
    let send_board = board.clone();
    let send_tx = tx.clone();
    let is_lan = state.kind == ListenerKind::Lan;
    let mut send_task = tokio::spawn(async move {
        'send: loop {
            enum Pending {
                Broadcast(Result<(u64, String), broadcast::error::RecvError>),
                Direct(DirectMessage),
            }
            let pending = tokio::select! {
                _ = revoked.changed(), if is_lan => {
                    // 慢客户端也只能占用短暂的正常关闭时间，超时即丢弃 socket。
                    let _ = tokio::time::timeout(Duration::from_millis(250), async {
                        let _ = sender.send(Message::Text(r#"{"t":"auth","ok":false,"reason":"revoked"}"#.into())).await;
                        let _ = sender.send(Message::Close(None)).await;
                    }).await;
                    break;
                }
                message = rx.recv() => Pending::Broadcast(message),
                message = direct_rx.recv() => match message {
                    Some(message) => Pending::Direct(message),
                    None => break,
                },
            };
            let messages: Vec<Message> = match pending {
                Pending::Broadcast(message) => match board_message_batch(
                    &send_board, &send_tx, &mut rx, conn_id, message,
                ).await {
                    Some(messages) => messages.into_iter().map(Message::Text).collect(),
                    None => break,
                },
                Pending::Direct(message) => current_direct_message(&send_board, message).await,
            };
            for msg in messages {
                tokio::select! {
                    biased;
                    _ = revoked.changed(), if is_lan => break 'send,
                    result = sender.send(msg) => {
                        if result.is_err() { break 'send; }
                    }
                }
            }
        }
    });

    // 4. 接收任务
    let recv_state = state.clone();
    let preview_busy = Arc::new(AtomicBool::new(false));
    let preview_hash = Arc::new(AtomicU64::new(0));
    let mut recv_task = tokio::spawn(async move {
        let mut rejected = RejectedStrokes::default();
        while let Some(Ok(msg)) = receiver.next().await {
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Close(_) => break,
                _ => continue,
            };
            // v0.6：标注模式下 iPad 的非笔画请求（屏幕画面、保存截图）
            // 笔头大小同步：任何一端调整，广播给其他所有连接（两块白板的通道都发）
            if text.contains("\"pen-size") {
                if recv_state.kind == ListenerKind::Lan {
                    let auth = recv_state.shared.auth.lock().await;
                    if auth.token.as_ref() != hello.token.as_ref() || auth.token.is_none() { break; }
                }
                let v: serde_json::Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };
                let hooks = &recv_state.shared.hooks;
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("pen-size") => {
                        if let Some(size) = v.get("size").and_then(|s| s.as_f64()).filter(|s| s.is_finite() && *s >= 0.5 && *s <= 100.0) {
                            hooks.pen_size.store((size as f32).to_bits(), Ordering::SeqCst);
                            // v0.8.2：带上是哪支画笔的大小（各端按画笔分别记住）；只接受短的字母数字 / 下划线名称
                            let brush = v.get("brush").and_then(|b| b.as_str())
                                .filter(|b| !b.is_empty() && b.len() <= 32 && b.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'));
                            let json = match brush {
                                Some(b) => serde_json::json!({"t":"pen-size","size":size,"brush":b}),
                                None => serde_json::json!({"t":"pen-size","size":size}),
                            }.to_string();
                            let _ = recv_state.shared.tx.send((conn_id, json.clone()));
                            let _ = recv_state.shared.overlay_tx.send((conn_id, json));
                        }
                    }
                    Some("pen-size-get") => {
                        let size = f32::from_bits(hooks.pen_size.load(Ordering::SeqCst));
                        let _ = direct_tx.send(direct_text(serde_json::json!({"t":"pen-size","size":size}).to_string())).await;
                    }
                    _ => {}
                }
                continue;
            }
            // v0.8.9：iPad 切换“屏幕 | 白板”——通知电脑跟着切（电脑切换时由 broadcast_pc_mode 通知 iPad）
            if is_pad && text.contains("\"pad-mode\"") {
                if recv_state.kind == ListenerKind::Lan {
                    let auth = recv_state.shared.auth.lock().await;
                    if auth.token.as_ref() != hello.token.as_ref() || auth.token.is_none() { break; }
                }
                let mode = serde_json::from_str::<serde_json::Value>(&text).ok()
                    .and_then(|v| v.get("mode").and_then(|m| m.as_str()).map(|m| m.to_string()))
                    .filter(|m| m == "annotate" || m == "board");
                if let (Some(mode), Some(cb)) = (mode, recv_state.shared.hooks.on_pad_mode.get()) { cb(mode); }
                continue;
            }
            // 画笔备份：iPad 上的自定义画笔和调节参数在电脑上存一份（data\\brushes.json），iPad 数据丢失时可恢复
            if is_pad && (text.contains("\"brushes-save\"") || text.contains("\"brushes-get\"")) {
                if recv_state.kind == ListenerKind::Lan {
                    let auth = recv_state.shared.auth.lock().await;
                    if auth.token.as_ref() != hello.token.as_ref() || auth.token.is_none() { break; }
                }
                let v: serde_json::Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };
                let persist = recv_state.shared.hooks.persist_lan.load(Ordering::SeqCst);
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("brushes-save") => {
                        let data = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
                        let ok = !data.is_empty() && data.len() <= MAX_BRUSHES_BYTES
                            && serde_json::from_str::<serde_json::Value>(data).map(|d| d.is_object()).unwrap_or(false);
                        let reply = if !ok { serde_json::json!({"t":"brushes-error","message":"画笔数据无效或过大"}) }
                            else if !persist { serde_json::json!({"t":"brushes-error","message":"当前环境不保存画笔"}) }
                            else { match save_brushes(data) {
                                Ok(()) => serde_json::json!({"t":"brushes-saved"}),
                                Err(e) => serde_json::json!({"t":"brushes-error","message":e}) } };
                        let _ = direct_tx.send(direct_text(reply.to_string())).await;
                    }
                    Some("brushes-get") => {
                        let data = if persist { load_brushes() } else { None };
                        let reply = serde_json::json!({"t":"brushes","data":data});
                        let _ = direct_tx.send(direct_text(reply.to_string())).await;
                    }
                    _ => {}
                }
                continue;
            }
            // 书写诊断：白板模式的 iPad 也可以发
            if (annotate_pad && (text.contains("\"preview-req\"") || text.contains("\"save-shot\"")))
                || (is_pad && text.contains("\"save-diag\"")) {
                if recv_state.kind == ListenerKind::Lan {
                    let auth = recv_state.shared.auth.lock().await;
                    if auth.token.as_ref() != hello.token.as_ref() || auth.token.is_none() { break; }
                }
                let v: serde_json::Value = match serde_json::from_str(&text) { Ok(v) => v, Err(_) => continue };
                match v.get("t").and_then(|t| t.as_str()) {
                    Some("preview-req") => {
                        if v.get("force").and_then(|f| f.as_bool()) == Some(true) { preview_hash.store(0, Ordering::SeqCst); }
                        let width = v.get("w").and_then(|w| w.as_u64()).unwrap_or(1600).clamp(320, 2560) as u32;
                        spawn_preview(recv_state.shared.hooks.clone(), direct_tx.clone(), preview_busy.clone(), preview_hash.clone(), width);
                    }
                    Some("save-diag") => {
                        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        let data = v.get("data").and_then(|d| d.as_str()).unwrap_or("").to_string();
                        let reply = if !valid_shot_name(&name) || data.is_empty() || data.len() > MAX_DIAG_BYTES
                            || serde_json::from_str::<serde_json::Value>(&data).is_err() {
                            serde_json::json!({"t":"diag-error","message":"诊断数据无效或过大"})
                        } else if !recv_state.shared.hooks.persist_lan.load(Ordering::SeqCst) {
                            serde_json::json!({"t":"diag-error","message":"当前环境不保存诊断数据"})
                        } else {
                            match save_diag(&name, &data) {
                                Ok(path) => serde_json::json!({"t":"diag-saved","path":path}),
                                Err(e) => serde_json::json!({"t":"diag-error","message":e}),
                            }
                        };
                        let _ = direct_tx.send(direct_text(reply.to_string())).await;
                    }
                    Some("save-shot") => {
                        let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        if valid_shot_name(&name) {
                            spawn_save_shot(recv_state.shared.hooks.clone(), direct_tx.clone(), name);
                        } else {
                            let _ = direct_tx.send(direct_text(r#"{"t":"shot-error","message":"截图名称无效"}"#)).await;
                        }
                    }
                    _ => {}
                }
                continue;
            }
            let client_msg: ClientMsg = match serde_json::from_str(&text) {
                Ok(m) => m,
                Err(_) => continue,
            };
            // 每次写入再次检查 token；撤销后即使客户端无视 auth 消息也不能继续修改。
            let auth = if recv_state.kind == ListenerKind::Lan {
                let auth = recv_state.shared.auth.lock().await;
                if auth.token.as_ref() != hello.token.as_ref() || auth.token.is_none() { break; }
                Some(auth)
            } else { None };
            let mut board = board.lock().await;
            let outs = match rejected.handle(&mut board, client_msg) {
                Ok(outs) => outs,
                Err(()) => break,
            };
            let epoch = board.reset_epoch();
            let mut direct = Vec::new();
            for out in outs {
                if out.is_direct() {
                    let epoch = if matches!(out, ServerMsg::Error { .. }) { None } else { Some(epoch) };
                    direct.push(DirectMessage { epoch, msgs: vec![Message::Text(to_json(&out))] });
                } else {
                    let from = if out.is_drawing() { conn_id } else { u64::MAX };
                    let _ = tx.send((from, to_json(&out)));
                }
            }
            drop(board);
            drop(auth);
            // 不能持有白板锁或鉴权锁等待慢客户端。
            for message in direct {
                if direct_tx.send(message).await.is_err() { return; }
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    if annotate_pad {
        let n = state.shared.hooks.annotate_pads.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
        if let Some(cb) = state.shared.hooks.on_annotate.get() { cb(n); }
    }
    if is_pad {
        let n = state
            .shared
            .pad_count
            .fetch_sub(1, Ordering::SeqCst)
            .saturating_sub(1);
        let _ = state
            .shared
            .tx
            .send((u64::MAX, to_json(&ServerMsg::PadStatus { online: n })));
    }
}

fn make_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(landing))
        .route("/pad", get(|| async { secure_html(PAD_HTML, PAD_CSP) }))
        .route("/guide", get(|| async { secure_html(GUIDE_HTML, GUIDE_CSP) }))
        .route("/guide.js", get(|| async { serve_js(GUIDE_JS).await }))
        .route("/pad.js", get(|| async { serve_js(PAD_JS).await }))
        .route("/shared.js", get(|| async { serve_js(SHARED_JS).await }))
        .route("/ink.js", get(|| async { serve_js(INK_JS).await }))
        .route("/i18n.js", get(|| async { serve_js(I18N_JS).await }))
        .route("/api/pair", post(api_pair))
        .route("/api/show", get(api_show))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

// ---------- Tauri commands ----------

/// 本机 viewer 用：loopback 端口
#[tauri::command]
fn get_loopback_port(s: tauri::State<TauriState>) -> u16 {
    s.shared.loopback_port
}

/// 本机 viewer 用：hostToken（经 IPC 下发，不经过网络）
#[tauri::command]
fn get_host_token(s: tauri::State<TauriState>) -> String {
    s.shared.host_token.clone()
}

/// P1 兼容：单监听时期的命令，双监听后由 get_loopback_port 替代。
/// 保留以便过渡期 viewer 调用不报错。
#[tauri::command]
fn get_ws_port(s: tauri::State<TauriState>) -> u16 {
    s.shared.loopback_port
}

/// 候选网卡：地址 + 网卡名（Windows 上是“网络连接”里看到的名字，如 WLAN、以太网）+ 是否像虚拟网卡
#[derive(Serialize, Clone, Debug, PartialEq)]
pub(crate) struct NetCandidate {
    ip: String,
    name: String,
    #[serde(rename = "virtual")]
    virt: bool,
}

/// 候选网卡 IPv4（过滤 loopback / link-local），最可能让 iPad 访问到的排第一
fn candidate_nets() -> Vec<NetCandidate> {
    let default_ip = local_ip_address::local_ip().ok().filter(|ip| ip.is_ipv4()).map(|ip| ip.to_string());
    let list: Vec<(String, std::net::Ipv4Addr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|ifa| match ifa.addr {
            if_addrs::IfAddr::V4(v4) if !v4.ip.is_loopback() && !v4.ip.is_link_local() => Some((ifa.name, v4.ip)),
            _ => None,
        })
        .collect();
    let mut out = rank_nets(list, default_ip.as_deref());
    // 兜底：枚举失败时至少给 local-ip-address 的结果
    if out.is_empty() {
        if let Some(ip) = default_ip { out.push(NetCandidate { ip, name: String::new(), virt: false }); }
    }
    out
}

/// 排序（可测试）：真实网卡在前（系统默认上网的那块优先，其次家用 / 公司局域网地址）；
/// 虚拟网卡（虚拟机、WSL、Docker、VPN / 代理软件的 TUN 网卡）放最后。
/// v1.0.1：v2rayN、Clash 等开着 TUN 模式时，系统“默认上网网卡”就是 TUN（如 172.18.0.1），
/// 以前会排第一，二维码里是 iPad 访问不到的地址；现在它被认作虚拟网卡，不再优先
pub(crate) fn rank_nets(list: Vec<(String, std::net::Ipv4Addr)>, default_ip: Option<&str>) -> Vec<NetCandidate> {
    let mut scored: Vec<(u32, NetCandidate)> = list.into_iter().map(|(name, ip)| {
        let virt = looks_virtual(&ip, &name);
        let o = ip.octets();
        let mut score = if default_ip == Some(ip.to_string().as_str()) { 0 }
            else if o[0] == 192 && o[1] == 168 { 10 }
            else if o[0] == 10 { 20 }
            else if o[0] == 172 && (16..=31).contains(&o[1]) { 30 }
            else { 50 };
        if virt { score += 100; }
        (score, NetCandidate { ip: ip.to_string(), name, virt })
    }).collect();
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.ip.cmp(&b.1.ip)));
    let mut out: Vec<NetCandidate> = Vec::new();
    for (_, c) in scored { if !out.iter().any(|x| x.ip == c.ip) { out.push(c); } }
    out
}

pub(crate) fn looks_virtual(ip: &std::net::Ipv4Addr, name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    const VIRTUAL: [&str; 27] = ["vethernet", "vmware", "virtualbox", "vbox", "hyper-v", "wsl", "docker", "utun", "bridge",
        "zerotier", "tailscale", "loopback", "tun", "tap", "wireguard", "vpn", "clash", "mihomo", "singbox", "sing-box",
        "xray", "v2ray", "nekoray", "radmin", "hamachi", "npcap", "openvpn"];
    let o = ip.octets();
    VIRTUAL.iter().any(|v| n.contains(v))
        || o[0] == 100 && (64..=127).contains(&o[1])        // CGNAT：Tailscale 等
        || o[0] == 198 && (o[1] == 18 || o[1] == 19)         // 198.18.0.0/15：代理软件的 fake-ip / TUN
        || o[0] == 172 && (16..=31).contains(&o[1]) && o[3] == 1 // 172.x.x.1：WSL / Docker / TUN 网关地址，家用网络很少见
}

#[tauri::command]
fn get_candidate_ips() -> Vec<String> {
    candidate_nets().into_iter().map(|c| c.ip).collect()
}

/// v1.0.1：连接窗口里显示网卡名，并标出虚拟网卡，方便用户选对
#[tauri::command]
fn get_candidate_nets() -> Vec<NetCandidate> {
    candidate_nets()
}

#[derive(Serialize)]
struct LanInfo {
    ip: String,
    port: u16,
    #[serde(rename = "pairUrl")]
    pair_url: String,
    #[serde(rename = "qrSvg")]
    qr_svg: String,
}

async fn issue_pairing(shared: &Arc<Shared>, ip: &str, port: u16) -> Result<(String, String), String> {
    let code = gen_secret();
    {
        let mut auth = shared.auth.lock().await;
        auth.pair_code = Some((code.clone(), Instant::now() + PAIR_CODE_TTL));
        auth.pair_failures = 0;
    }
    let pair_url = format!("http://{}:{}/pad#p={}", ip, port, code);
    let qr_svg = qr_svg(&pair_url)?;
    Ok((pair_url, qr_svg))
}

async fn stop_lan_inner(s: &tauri::State<'_, TauriState>) {
    if let Some(h) = s.lan_handle.lock().await.take() {
        h.abort();
    }
    *s.shared.lan_net.lock().await = LanNet::default();
    revoke_lan(&s.shared).await;
}

async fn revoke_lan(shared: &Shared) {
    if shared.hooks.persist_lan.load(Ordering::SeqCst) { clear_saved_lan(); }
    let mut auth = shared.auth.lock().await;
    auth.token = None;
    auth.pair_code = None;
    shared.auth_epoch.send_modify(|epoch| *epoch = epoch.wrapping_add(1));
}

/// 启动 LAN 监听并生成配对二维码。端口复用上次成功值，被占则 :0。
#[tauri::command]
async fn start_lan(s: tauri::State<'_, TauriState>, ip: String) -> Result<LanInfo, String> {
    // 开源审核 v0.8.14：只允许绑定本机网卡上的具体 IPv4 地址（不能是 0.0.0.0、回环、广播或组播）
    let parsed = valid_lan_ip(&ip).ok_or("网络地址无效")?;
    let present = if_addrs::get_if_addrs().map(|l| l.iter().any(|i| i.ip() == std::net::IpAddr::V4(parsed))).unwrap_or(false);
    if !present { return Err("这个地址不属于本机网卡".into()); }
    stop_lan_inner(&s).await;

    let try_port = s.last_lan_port.lock().await.unwrap_or(0);
    let listener = match TcpListener::bind((ip.as_str(), try_port)).await {
        Ok(l) => l,
        Err(_) if try_port != 0 => TcpListener::bind((ip.as_str(), 0))
            .await
            .map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    *s.last_lan_port.lock().await = Some(port);
    *s.shared.lan_net.lock().await = LanNet {
        ip: Some(ip.clone()),
        port: Some(port),
    };

    let (pair_url, qr_svg) = issue_pairing(&s.shared, &ip, port).await?;
    let state = AppState {
        kind: ListenerKind::Lan,
        shared: s.shared.clone(),
    };
    let app = make_router(state);
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    *s.lan_handle.lock().await = Some(handle);
    Ok(LanInfo { ip, port, pair_url, qr_svg })
}

/// 停止共享：关闭 LAN 监听并作废 token
#[tauri::command]
async fn stop_lan(s: tauri::State<'_, TauriState>) -> Result<(), String> {
    stop_lan_inner(&s).await;
    Ok(())
}

/// 重新配对：作废旧 token，生成新配对码（需 LAN 已启动）
#[tauri::command]
async fn regenerate_pairing(s: tauri::State<'_, TauriState>) -> Result<LanInfo, String> {
    let (ip, port) = {
        let net = s.shared.lan_net.lock().await;
        match (net.ip.clone(), net.port) {
            (Some(ip), Some(port)) => (ip, port),
            _ => return Err("LAN 监听未启动".to_string()),
        }
    };
    revoke_lan(&s.shared).await;
    let (pair_url, qr_svg) = issue_pairing(&s.shared, &ip, port).await?;
    Ok(LanInfo { ip, port, pair_url, qr_svg })
}

#[derive(Serialize)]
struct LanStatus {
    ip: String,
    port: u16,
    #[serde(rename = "pairingActive")]
    pairing_active: bool,
}

/// 查询 LAN 状态（UI 恢复用；不含配对码）
#[tauri::command]
async fn get_lan_status(
    s: tauri::State<'_, TauriState>,
) -> Result<Option<LanStatus>, String> {
    let net = s.shared.lan_net.lock().await;
    let auth = s.shared.auth.lock().await;
    Ok(match (net.ip.clone(), net.port) {
        (Some(ip), Some(port)) => Some(LanStatus {
            ip,
            port,
            pairing_active: auth.pair_code.is_some(),
        }),
        _ => None,
    })
}

// ---------- 透明标注层（v0.5.1） ----------
// 独立 overlay 窗口及白板：无边框、透明、置顶，使用 viewer 所在显示器的物理边界。
// 双模式：绘制模式（接收鼠标）/ 穿透模式（setIgnoreCursorEvents，鼠标直达底下窗口）。

/// 标注窗口存活期间的全局快捷键：切换标注层 穿透/绘制
fn gs_handler(
    app: &tauri::AppHandle,
    _shortcut: &tauri_plugin_global_shortcut::Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let s = app.state::<TauriState>();
            let next = !*s.overlay_clickthrough.lock().await;
            let _ = apply_overlay_mode(&app, &s, next).await;
        });
    }
}

fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // 启动时不注册任何快捷键，避免占用冲突使整个应用无法启动。
    tauri_plugin_global_shortcut::Builder::new().with_handler(gs_handler).build()
}

/// 屏幕标注层是否已打开（不经生命周期锁，避免在持锁时发布状态造成死锁）
static OVERLAY_OPEN: AtomicBool = AtomicBool::new(false);

async fn overlay_status(s: &TauriState) -> OverlayStatus {
    let shortcut = s.overlay_shortcut.lock().await;
    OverlayStatus {
        open: OVERLAY_OPEN.load(Ordering::SeqCst),
        clickthrough: *s.overlay_clickthrough.lock().await,
        shortcut: shortcut.shortcut.clone(),
        shortcut_registered: shortcut.registered,
        shortcut_error: shortcut.error.clone(),
    }
}

async fn publish_overlay_status(app: &tauri::AppHandle) {
    let s = app.state::<TauriState>();
    let _ = app.emit("overlay-status", overlay_status(&s).await);
}

async fn register_overlay_shortcut(app: &tauri::AppHandle, s: &TauriState) {
    let mut shortcut = s.overlay_shortcut.lock().await;
    if !shortcut.registered {
        match app.global_shortcut().register(shortcut.shortcut.as_str()) {
            Ok(()) => { shortcut.registered = true; shortcut.error = None; }
            Err(e) => {
                shortcut.error = Some(format!("快捷键注册失败，请用托盘切换模式或更换快捷键：{}", e));
            }
        }
    }
}

async fn unregister_overlay_shortcut(app: &tauri::AppHandle, s: &TauriState) {
    let mut shortcut = s.overlay_shortcut.lock().await;
    if shortcut.registered {
        match app.global_shortcut().unregister(shortcut.shortcut.as_str()) {
            Ok(()) => { shortcut.registered = false; shortcut.error = None; }
            Err(e) => { shortcut.error = Some(format!("快捷键注销失败：{}", e)); }
        }
    }
}

#[tauri::command]
async fn get_overlay_status(s: tauri::State<'_, TauriState>) -> Result<OverlayStatus, String> {
    Ok(overlay_status(&s).await)
}

/// 本次应用会话内生效；先校验格式，失败保留原快捷键。
#[tauri::command]
async fn set_overlay_shortcut(
    app: tauri::AppHandle,
    s: tauri::State<'_, TauriState>,
    shortcut: String,
) -> Result<OverlayStatus, String> {
    let lifecycle = s.overlay_lifecycle.lock().await;
    let shortcut = shortcut.trim();
    shortcut.parse::<tauri_plugin_global_shortcut::Shortcut>()
        .map_err(|e| format!("快捷键格式无效：{}", e))?;
    {
        let mut current = s.overlay_shortcut.lock().await;
        if current.registered && current.shortcut != shortcut {
            app.global_shortcut().unregister(current.shortcut.as_str()).map_err(|e| e.to_string())?;
            current.registered = false;
        }
        current.shortcut = shortcut.to_string();
        current.error = None;
    }
    if lifecycle.is_open() && app.get_webview_window("overlay").is_some() {
        register_overlay_shortcut(&app, &s).await;
    }
    let status = overlay_status(&s).await;
    let _ = app.emit("overlay-status", status.clone());
    Ok(status)
}

async fn reset_overlay_state(app: &tauri::AppHandle, s: &TauriState) {
    let was_open = OVERLAY_OPEN.swap(false, Ordering::SeqCst);
    if let Ok(mut r) = OVERLAY_HIT.lock() { *r = None; }
    HIT_GRABBED.store(false, Ordering::SeqCst);
    // 标注层关了（点“白板”、托盘关闭等）：把收起的白板窗口恢复出来
    if was_open {
        if let Some(m) = app.get_webview_window("main") { let _ = m.unminimize(); let _ = m.show(); }
        broadcast_pc_mode(&s.shared, false);
    }
    unregister_overlay_shortcut(app, s).await;
    *s.overlay_clickthrough.lock().await = false;
    *s.screenshot.lock().await = None;
    publish_overlay_status(app).await;
}

/// 调用方已持有生命周期锁；Destroyed 回调必须先同步发信号再等待此锁。
async fn destroy_overlay_window(
    app: &tauri::AppHandle,
    s: &TauriState,
    lifecycle: &mut overlay_lifecycle::OverlayLifecycle,
) -> Result<(), String> {
    lifecycle.closing();
    let requested = match app.get_webview_window("overlay") {
        Some(window) => window.destroy().map_err(|e| format!("请求关闭标注层失败：{}", e)),
        None => Ok(()),
    };
    reset_overlay_state(app, s).await;
    requested?;
    lifecycle.wait_for_close(OVERLAY_CLOSE_TIMEOUT).await?;
    Ok(())
}

/// 打开标注层（已打开则聚焦）。关闭中的旧窗须先收到销毁确认。
#[tauri::command]
async fn open_overlay(app: tauri::AppHandle) -> Result<(), String> {
    open_overlay_with(app, false).await
}

/// auto=true：iPad 进入标注模式时自动打开——新开的窗口直接设为穿透（鼠标照常操作文件）；
/// 已经打开的窗口不改变当前模式，也不抢焦点。
async fn open_overlay_with(app: tauri::AppHandle, auto: bool) -> Result<(), String> {
    let s = app.state::<TauriState>();
    let mut lifecycle = s.overlay_lifecycle.lock().await;
    if lifecycle.has_window() && app.get_webview_window("overlay").is_none() {
        // manager 已移除标签但窗口事件尚未完成时，仍等待本代销毁信号。
        lifecycle.closing();
    }
    if lifecycle.wait_for_close(OVERLAY_CLOSE_TIMEOUT).await? {
        reset_overlay_state(&app, &s).await;
    }
    if lifecycle.is_open() {
        let w = app.get_webview_window("overlay").ok_or("标注窗口正在关闭，请稍后重试")?;
        if auto { return Ok(()); }
        apply_overlay_mode_inner(&app, &s, false).await?;
        if let Some(m) = app.get_webview_window("main") { let _ = m.minimize(); }
        w.set_focus().map_err(|e| e.to_string())?;
        register_overlay_shortcut(&app, &s).await;
        publish_overlay_status(&app).await;
        return Ok(());
    }
    if app.get_webview_window("overlay").is_some() {
        return Err("旧标注窗口尚未完成关闭，请稍后重试".into());
    }
    let monitor = app.get_webview_window("main").ok_or("主窗口不存在")?
        .current_monitor().map_err(|e| e.to_string())?.ok_or("找不到主窗口所在显示器")?;
    let position = *monitor.position();
    let size = *monitor.size();
    let (generation, signal) = lifecycle.begin_window()?;
    let built = WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title(rs_tr("overlay"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .visible(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .build();
    let win = match built {
        Ok(window) => window,
        Err(error) => {
            lifecycle.cancel_unbuilt(generation);
            return Err(error.to_string());
        }
    };
    let destroy_app = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            signal.closing();
        }
        if matches!(event, tauri::WindowEvent::Destroyed) {
            // 此时 Tauri manager 已移除本代标签；发信号不依赖生命周期锁。
            signal.destroyed();
            let app = destroy_app.clone();
            tauri::async_runtime::spawn(async move {
                let s = app.state::<TauriState>();
                let mut lifecycle = s.overlay_lifecycle.lock().await;
                // 旧窗口的异步销毁事件不能注销刚重开的窗口快捷键。
                if lifecycle.finish_destroyed(generation) {
                    reset_overlay_state(&app, &s).await;
                }
            });
        }
    });
    // 先注册销毁监听，再执行可能失败的设置；物理坐标保留负坐标和混合 DPI 支持。
    // 标注层不进入屏幕截取（发给 iPad 的画面里不会出现重影）；保存截图时临时取消。
    let _ = win.set_content_protected(!s.shared.hooks.capture_visible.load(Ordering::SeqCst));
    let configured = win.set_position(position)
        .and_then(|_| win.set_size(size))
        .and_then(|_| win.set_ignore_cursor_events(auto))
        .and_then(|_| win.show());
    if let Err(error) = configured {
        return match destroy_overlay_window(&app, &s, &mut lifecycle).await {
            Ok(()) => Err(format!("标注窗口设置失败：{}", error)),
            Err(cleanup) => Err(format!("标注窗口设置失败：{}；{}", error, cleanup)),
        };
    }
    *s.overlay_clickthrough.lock().await = auto;
    OVERLAY_OPEN.store(true, Ordering::SeqCst);
    HIT_GRABBED.store(false, Ordering::SeqCst);
    // v0.8.8：屏幕标注时白板窗口收到任务栏，屏幕上只留标注工具，不和白板的按键混在一起；关闭标注后恢复
    if let Some(m) = app.get_webview_window("main") { let _ = m.minimize(); }
    broadcast_pc_mode(&s.shared, true);
    if auto { let _ = app.emit_to("overlay", "overlay-mode", true); }
    register_overlay_shortcut(&app, &s).await;
    publish_overlay_status(&app).await;
    Ok(())
}

#[tauri::command]
async fn close_overlay(app: tauri::AppHandle) -> Result<(), String> {
    let s = app.state::<TauriState>();
    let mut lifecycle = s.overlay_lifecycle.lock().await;
    destroy_overlay_window(&app, &s, &mut lifecycle).await
}

/// v0.8.6：标注层上点“白板”——关闭屏幕标注并把主窗口（白板）调到前面，与 iPad 上切换“屏幕 | 白板”一致
#[tauri::command]
async fn switch_to_whiteboard(app: tauri::AppHandle) -> Result<(), String> {
    {
        let s = app.state::<TauriState>();
        let mut lifecycle = s.overlay_lifecycle.lock().await;
        destroy_overlay_window(&app, &s, &mut lifecycle).await?;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
    }
    Ok(())
}

/// v0.8.9：电脑切换了“屏幕 | 白板”（打开 / 关闭屏幕标注），通知所有 iPad 跟着切
pub(crate) fn broadcast_pc_mode(shared: &Shared, annotate: bool) {
    let json = serde_json::json!({"t":"pc-mode","mode": if annotate { "annotate" } else { "board" }}).to_string();
    let _ = shared.tx.send((u64::MAX, json.clone()));
    let _ = shared.overlay_tx.send((u64::MAX, json));
}

// ---------- v0.8.8：穿透模式下的小工具栏 ----------
// 穿透时整个标注窗口不接收鼠标；小工具栏（屏幕 | 白板、继续标注）要能点，就在鼠标移到它上面时临时取消穿透，
// 移开后恢复。前端用 set_overlay_hit_rect 报告小工具栏位置（CSS 像素，相对标注窗口），None = 不显示。
static OVERLAY_HIT: std::sync::Mutex<Option<[f64; 4]>> = std::sync::Mutex::new(None);
/// 当前是否因为鼠标在小工具栏上而临时取消了穿透
static HIT_GRABBED: AtomicBool = AtomicBool::new(false);
static HIT_POLLER: std::sync::Once = std::sync::Once::new();

#[tauri::command]
fn set_overlay_hit_rect(app: tauri::AppHandle, rect: Option<[f64; 4]>) -> Result<(), String> {
    let rect = rect.filter(|r| r.iter().all(|v| v.is_finite()) && r[2] > 0.0 && r[3] > 0.0 && r[2] < 20000.0 && r[3] < 20000.0);
    *OVERLAY_HIT.lock().map_err(|e| e.to_string())? = rect;
    HIT_POLLER.call_once(|| {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { hit_poller(app).await; });
    });
    Ok(())
}

/// 点 (px, py)（相对窗口的 CSS 像素）是否在小工具栏范围内（四周留 6 像素余量）
pub(crate) fn in_hit_rect(rect: &[f64; 4], px: f64, py: f64) -> bool {
    let m = 6.0;
    px >= rect[0] - m && px <= rect[0] + rect[2] + m && py >= rect[1] - m && py <= rect[1] + rect[3] + m
}

async fn hit_poller(app: tauri::AppHandle) {
    loop {
        let open = OVERLAY_OPEN.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(if open { 40 } else { 300 })).await;
        if !open { HIT_GRABBED.store(false, Ordering::SeqCst); continue; }
        let s = app.state::<TauriState>();
        let clickthrough = *s.overlay_clickthrough.lock().await;
        let rect = OVERLAY_HIT.lock().ok().and_then(|r| *r);
        let Some(w) = app.get_webview_window("overlay") else { continue };
        let want_grab = match (clickthrough, rect) {
            (true, Some(rect)) => {
                let (Ok(c), Ok(p), Ok(k)) = (app.cursor_position(), w.outer_position(), w.scale_factor()) else { continue };
                in_hit_rect(&rect, (c.x - p.x as f64) / k, (c.y - p.y as f64) / k)
            }
            _ => false,
        };
        if !clickthrough { HIT_GRABBED.store(false, Ordering::SeqCst); continue; }
        if want_grab != HIT_GRABBED.load(Ordering::SeqCst) {
            // 再确认一次仍是穿透模式，避免和切换模式的命令交错
            let lifecycle = s.overlay_lifecycle.lock().await;
            if !lifecycle.is_open() || !*s.overlay_clickthrough.lock().await { continue; }
            if w.set_ignore_cursor_events(!want_grab).is_ok() { HIT_GRABBED.store(want_grab, Ordering::SeqCst); }
        }
    }
}

/// 设置穿透模式并通知 overlay 窗口更新 UI；返回新的穿透状态
async fn apply_overlay_mode(
    app: &tauri::AppHandle,
    s: &tauri::State<'_, TauriState>,
    clickthrough: bool,
) -> Result<bool, String> {
    let lifecycle = s.overlay_lifecycle.lock().await;
    if !lifecycle.is_open() {
        return Err("标注层未打开或正在关闭，请稍后重试".into());
    }
    apply_overlay_mode_inner(app, s, clickthrough).await
}

/// 调用方已持有生命周期锁且确认本代可用。
async fn apply_overlay_mode_inner(
    app: &tauri::AppHandle,
    s: &tauri::State<'_, TauriState>,
    clickthrough: bool,
) -> Result<bool, String> {
    let w = app.get_webview_window("overlay").ok_or("标注层未打开，请先从主窗口或托盘打开")?;
    w.set_ignore_cursor_events(clickthrough).map_err(|e| e.to_string())?;
    HIT_GRABBED.store(false, Ordering::SeqCst);
    let _ = app.emit_to("overlay", "overlay-mode", clickthrough);
    *s.overlay_clickthrough.lock().await = clickthrough;
    Ok(clickthrough)
}

#[tauri::command]
async fn set_overlay_clickthrough(
    app: tauri::AppHandle,
    s: tauri::State<'_, TauriState>,
    clickthrough: bool,
) -> Result<bool, String> {
    apply_overlay_mode(&app, &s, clickthrough).await
}

#[tauri::command]
async fn toggle_overlay_clickthrough(
    app: tauri::AppHandle,
    s: tauri::State<'_, TauriState>,
) -> Result<bool, String> {
    let next = !*s.overlay_clickthrough.lock().await;
    apply_overlay_mode(&app, &s, next).await
}

/// 先截取 overlay 所在显示器并缓存到内存；前端随后再打开保存对话框。
/// DWM 已把标注合成进桌面画面，所以截到的就是"底下内容 + 标注"的合成图。
/// 调用方需先隐藏工具条（前端负责），避免工具条入镜。
#[tauri::command]
async fn capture_screenshot_png(app: tauri::AppHandle, s: tauri::State<'_, TauriState>) -> Result<(), String> {
    let lifecycle = s.overlay_lifecycle.lock().await;
    *s.screenshot.lock().await = None;
    if !lifecycle.is_open() {
        return Err("标注层未打开或正在关闭，请稍后重试".into());
    }
    let overlay = app
        .get_webview_window("overlay")
        .ok_or("标注层未打开")?;
    let mon = overlay
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("找不到标注层所在显示器")?;
    let pos = *mon.position();
    let size = *mon.size();
    // v0.8.7：截图时标注层始终不进画面（GDI 截屏本来也截不到透明标注窗口），标注笔迹由标注层自己渲染后合成，
    // 避免“截图里没有标注”或在能截到的系统上出现两层重影。录屏可见模式下临时排除一下再恢复。
    let visible = s.shared.hooks.capture_visible.load(Ordering::SeqCst);
    if visible {
        let _ = overlay.set_content_protected(true);
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let captured = tokio::task::spawn_blocking(move || capture_monitor(pos.x, pos.y, size.width, size.height))
        .await.map_err(|e| e.to_string());
    if visible && s.shared.hooks.capture_visible.load(Ordering::SeqCst) {
        let _ = overlay.set_content_protected(false);
    }
    let img = captured??;
    if !lifecycle.is_open() {
        return Err("标注层已关闭，未保留截图，请重新打开后再试".into());
    }
    *s.screenshot.lock().await = Some(img);
    Ok(())
}

/// 局域网共享可用的地址：具体的单播 IPv4（不能是 0.0.0.0、回环、广播、组播）；是否属于本机网卡另外检查
pub(crate) fn valid_lan_ip(ip: &str) -> Option<std::net::Ipv4Addr> {
    let a: std::net::Ipv4Addr = ip.trim().parse().ok()?;
    if a.is_unspecified() || a.is_loopback() || a.is_broadcast() || a.is_multicast() { return None; }
    Some(a)
}

/// 开源审核 v0.8.14：截图只能写成 .png 文件（绝对路径）；扩展名不是 png 时在后面补上 .png，
/// 这样即使界面被篡改，也不能借这个命令覆盖别的类型的文件
pub(crate) fn png_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::PathBuf::from(path);
    if path.is_empty() || !p.is_absolute() { return Err("保存位置无效".into()); }
    let is_png = p.extension().map(|e| e.eq_ignore_ascii_case("png")).unwrap_or(false);
    Ok(if is_png { p } else { std::path::PathBuf::from(format!("{}.png", path)) })
}

#[tauri::command]
async fn save_captured_screenshot(s: tauri::State<'_, TauriState>, path: String, ink: Option<String>) -> Result<(), String> {
    let mut screenshot = s.screenshot.lock().await;
    let image = screenshot.as_mut().ok_or("没有待保存的截图，请重新截图")?;
    // v0.8.7：把标注层渲染的墨迹（透明 PNG，base64）叠到屏幕截图上
    if let Some(ink) = ink.filter(|i| !i.is_empty()) {
        composite_ink_b64(image, &ink)?;
    }
    // 明确 PNG 格式，避免用户输入其他扩展名导致隐式格式转换。
    let path = png_path(&path)?;
    image.save_with_format(&path, xcap::image::ImageFormat::Png).map_err(|e| e.to_string())?;
    *screenshot = None;
    Ok(())
}

/// 标注墨迹层上限（base64 文本长度）。2560×1600 的透明 PNG 通常只有几百 KB
const MAX_INK_B64: usize = 48 * 1024 * 1024;

/// 把透明的墨迹层 PNG（base64）按 alpha 叠加到截图上；尺寸不同则先缩放到截图大小
pub(crate) fn composite_ink_b64(base: &mut xcap::image::RgbaImage, ink_b64: &str) -> Result<(), String> {
    use base64::engine::general_purpose::STANDARD;
    if ink_b64.len() > MAX_INK_B64 { return Err("标注图层过大".into()); }
    let bytes = STANDARD.decode(ink_b64.trim()).map_err(|_| "标注图层数据无效".to_string())?;
    let ink = xcap::image::load_from_memory_with_format(&bytes, xcap::image::ImageFormat::Png)
        .map_err(|e| format!("标注图层无法读取：{}", e))?.to_rgba8();
    let (w, h) = base.dimensions();
    let ink = if ink.dimensions() == (w, h) { ink }
        else { xcap::image::imageops::resize(&ink, w, h, xcap::image::imageops::FilterType::Triangle) };
    xcap::image::imageops::overlay(base, &ink, 0, 0);
    Ok(())
}

// iPad 发起的截图：向标注层要一份当前墨迹（标注层收到 ink-layer-request 后用 provide_ink_layer 交回）
static INK_SEQ: AtomicU64 = AtomicU64::new(0);
static INK_WAIT: std::sync::Mutex<Option<(u64, std::sync::mpsc::SyncSender<String>)>> = std::sync::Mutex::new(None);

fn request_ink_layer(app: &tauri::AppHandle, timeout: Duration) -> Option<String> {
    app.get_webview_window("overlay")?;
    let id = INK_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    *INK_WAIT.lock().ok()? = Some((id, tx));
    let _ = app.emit_to("overlay", "ink-layer-request", id);
    let got = rx.recv_timeout(timeout).ok();
    if let Ok(mut w) = INK_WAIT.lock() { if w.as_ref().map(|x| x.0) == Some(id) { *w = None; } }
    got
}

#[tauri::command]
fn provide_ink_layer(id: u64, png: String) -> Result<(), String> {
    if png.len() > MAX_INK_B64 { return Err("标注图层过大".into()); }
    let w = INK_WAIT.lock().map_err(|e| e.to_string())?;
    if let Some((rid, tx)) = w.as_ref() { if *rid == id { let _ = tx.try_send(png); } }
    Ok(())
}

#[tauri::command]
async fn discard_captured_screenshot(s: tauri::State<'_, TauriState>) -> Result<(), String> {
    *s.screenshot.lock().await = None;
    Ok(())
}

// ---------- v0.6：屏幕画面 / 截图 ----------

fn capture_monitor(x: i32, y: i32, w: u32, h: u32) -> Result<xcap::image::RgbaImage, String> {
    let target = xcap::Monitor::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|m| matches!((m.x(), m.y(), m.width(), m.height()),
            (Ok(mx), Ok(my), Ok(mw), Ok(mh)) if mx == x && my == y && mw == w && mh == h))
        .ok_or("未找到对应显示器的截屏源")?;
    target.capture_image().map_err(|e| e.to_string())
}

/// 标注所用显示器：标注层所在显示器，未打开时用主窗口所在显示器
fn annotate_monitor(app: &tauri::AppHandle) -> Result<(i32, i32, u32, u32), String> {
    let win = app.get_webview_window("overlay").or_else(|| app.get_webview_window("main")).ok_or("找不到窗口")?;
    let m = win.current_monitor().map_err(|e| e.to_string())?.ok_or("找不到显示器")?;
    Ok((m.position().x, m.position().y, m.size().width, m.size().height))
}

fn encode_preview(img: &xcap::image::RgbaImage, max_w: u32) -> Result<PreviewFrame, String> {
    use xcap::image::{codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder}, imageops, DynamicImage, ExtendedColorType, ImageEncoder};
    let (w, h) = img.dimensions();
    let fw = max_w.min(w).max(1);
    let fh = ((h as u64 * fw as u64) / w.max(1) as u64).max(1) as u32;
    let small = if fw == w { img.clone() } else { imageops::resize(img, fw, fh, imageops::FilterType::Triangle) };
    let rgb = DynamicImage::ImageRgba8(small).into_rgb8();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(&rgb.as_raw().iter().step_by(7).copied().collect::<Vec<u8>>(), &mut hasher);
    let hash = std::hash::Hasher::finish(&hasher) | 1; // 0 表示“还没发过”
    let mut png = Vec::new();
    PngEncoder::new_with_quality(&mut png, CompressionType::Fast, PngFilter::Sub)
        .write_image(rgb.as_raw(), fw, fh, ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(PreviewFrame { w, h, fw, fh, png, hash })
}

fn shots_dir() -> Result<std::path::PathBuf, String> {
    let dir = match SHOTS_ROOT.get() { Some(d) => d.clone(), None => data_root().ok_or("找不到程序目录")?.join("screenshots") };
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建截图目录：{}", e))?;
    Ok(dir)
}

fn install_hooks(app: &tauri::AppHandle, hooks: &Arc<Hooks>) {
    let shower = app.clone();
    let _ = hooks.on_show.set(Arc::new(move || {
        if let Some(w) = shower.get_webview_window("main") {
            let _ = w.unminimize(); let _ = w.show(); let _ = w.set_focus();
        }
    }));
    let a = app.clone();
    let _ = hooks.capture.set(Arc::new(move |max_w| {
        let (x, y, w, h) = annotate_monitor(&a)?;
        let img = capture_monitor(x, y, w, h)?;
        encode_preview(&img, max_w)
    }));
    let a = app.clone();
    let hk = hooks.clone();
    let _ = hooks.save_shot.set(Arc::new(move |name| {
        let (x, y, w, h) = annotate_monitor(&a)?;
        let overlay = a.get_webview_window("overlay");
        // v0.8.7：截屏时标注层不进画面，墨迹由标注层渲染后合成（与电脑端截图按钮一致）
        let visible = hk.capture_visible.load(Ordering::SeqCst);
        if visible {
            if let Some(o) = &overlay { let _ = o.set_content_protected(true); }
            std::thread::sleep(Duration::from_millis(200));
        }
        let img = capture_monitor(x, y, w, h);
        if visible && hk.capture_visible.load(Ordering::SeqCst) {
            if let Some(o) = &overlay { let _ = o.set_content_protected(false); }
        }
        let mut img = img?;
        if let Some(ink) = request_ink_layer(&a, Duration::from_millis(2500)) {
            if !ink.is_empty() { composite_ink_b64(&mut img, &ink)?; }
        }
        let path = shots_dir()?.join(format!("{}-{}.png", rs_tr("file_shot"), name));
        img.save_with_format(&path, xcap::image::ImageFormat::Png).map_err(|e| e.to_string())?;
        let shown = path.display().to_string();
        let _ = a.emit("shot-saved", shown.clone());
        Ok(shown)
    }));
    let a = app.clone();
    let _ = hooks.on_annotate.set(Arc::new(move |n| {
        let _ = a.emit("annotate-pads", n);
        if n > 0 {
            let app = a.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = open_overlay_with(app.clone(), true).await { let _ = app.emit("overlay-error", e); }
            });
        }
    }));
    let a = app.clone();
    let _ = hooks.on_pad_mode.set(Arc::new(move |mode| {
        let app = a.clone();
        tauri::async_runtime::spawn(async move {
            if mode == "board" {
                // iPad 切回白板：关闭屏幕标注，白板窗口回来（与电脑上点“白板”一样）
                let _ = switch_to_whiteboard(app).await;
            } else if let Err(e) = open_overlay_with(app.clone(), true).await {
                let _ = app.emit("overlay-error", e);
            }
        });
    }));
    let a = app.clone();
    let _ = hooks.on_preview_frame.set(Arc::new(move || { let _ = a.emit("preview-frame", ()); }));
}

#[tauri::command]
fn get_preview_allowed(s: tauri::State<TauriState>) -> bool {
    s.shared.hooks.preview_allowed.load(Ordering::SeqCst)
}

#[tauri::command]
fn set_preview_allowed(s: tauri::State<TauriState>, allowed: bool) -> bool {
    s.shared.hooks.preview_allowed.store(allowed, Ordering::SeqCst);
    allowed
}

/// 自检：按发给 iPad 的方式截一帧（标注层不入画面），保存到程序目录 screenshots，返回说明
#[tauri::command]
async fn preview_selftest(s: tauri::State<'_, TauriState>) -> Result<String, String> {
    let capture = s.shared.hooks.capture.get().cloned().ok_or("截屏能力未就绪")?;
    let started = Instant::now();
    let frame = tokio::task::spawn_blocking(move || capture(1600)).await.map_err(|e| e.to_string())??;
    let ms = started.elapsed().as_millis();
    let path = shots_dir()?.join(format!("{}.png", rs_tr("file_check")));
    std::fs::write(&path, &frame.png).map_err(|e| e.to_string())?;
    Ok(format!("画面正常：屏幕 {}×{} → 发送 {}×{}，PNG {:.2} MB，用时 {} ms；已保存 {}",
        frame.w, frame.h, frame.fw, frame.fh, frame.png.len() as f64 / 1048576.0, ms, path.display()))
}

#[tauri::command]
fn get_capture_visible(s: tauri::State<TauriState>) -> bool {
    s.shared.hooks.capture_visible.load(Ordering::SeqCst)
}

/// 录屏/共享时显示标注：true = 标注层会被 OBS、Xbox Game Bar、会议软件共享等截取到；
/// false（默认）= 标注层对所有屏幕截取隐身（发给 iPad 的画面也不含标注，不会重影）。
#[tauri::command]
fn set_capture_visible(app: tauri::AppHandle, s: tauri::State<TauriState>, visible: bool) -> bool {
    s.shared.hooks.capture_visible.store(visible, Ordering::SeqCst);
    if let Some(o) = app.get_webview_window("overlay") {
        let _ = o.set_content_protected(!visible);
    }
    visible
}

#[tauri::command]
fn get_annotate_pads(s: tauri::State<TauriState>) -> usize {
    s.shared.hooks.annotate_pads.load(Ordering::SeqCst)
}

// ---------- main ----------

fn main() {
    install_crash_log();
    if !acquire_single_instance() { return; }
    // loopback 监听在 main 里直接绑定，避免"先找端口再绑定"的竞态
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback");
    std_listener.set_nonblocking(true).expect("set nonblocking loopback");
    let loopback_port = std_listener.local_addr().expect("addr").port();
    publish_instance_port(loopback_port);
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
        auth: Arc::new(Mutex::new(Auth::default())),
        auth_epoch,
        lan_net: Arc::new(Mutex::new(LanNet::default())),
        loopback_port,
        host_token: gen_secret(),
        hooks: Arc::new(Hooks::new()),
    });
    let hooks = shared.hooks.clone();

    // loopback 常开
    let lb_state = AppState {
        kind: ListenerKind::Loopback,
        shared: shared.clone(),
    };
    let lb_app = make_router(lb_state);

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(global_shortcut_plugin())
        .manage(TauriState {
            shared,
            lan_handle: Mutex::new(None),
            last_lan_port: Mutex::new(None),
            overlay_clickthrough: Mutex::new(false),
            overlay_shortcut: Mutex::new(OverlayShortcut {
                shortcut: DEFAULT_OVERLAY_SHORTCUT.into(), registered: false, error: None,
            }),
            overlay_lifecycle: Mutex::new(overlay_lifecycle::OverlayLifecycle::default()),
            screenshot: Mutex::new(None),
        })
        .setup(move |app| {
            init_data_root(app.handle());
            install_hooks(app.handle(), &hooks);
            hooks.persist_lan.store(true, Ordering::SeqCst);
            tauri::async_runtime::spawn(restore_lan(app.handle().clone()));
            // 穿透模式下整个窗口不接收鼠标，托盘始终提供打开、切换和关闭入口。
            let open_item =
                tauri::menu::MenuItemBuilder::with_id("open_overlay", rs_tr("open_overlay"))
                    .build(app)
                    .map_err(|e| e.to_string())?;
            let toggle_item =
                tauri::menu::MenuItemBuilder::with_id("toggle_mode", rs_tr("toggle_mode"))
                    .build(app)
                    .map_err(|e| e.to_string())?;
            let close_item =
                tauri::menu::MenuItemBuilder::with_id("close_overlay", rs_tr("close_overlay"))
                    .build(app)
                    .map_err(|e| e.to_string())?;
            let quit_item = tauri::menu::MenuItemBuilder::with_id("quit", rs_tr("quit"))
                .build(app)
                .map_err(|e| e.to_string())?;
            let menu = tauri::menu::Menu::with_items(app, &[&open_item, &toggle_item, &close_item, &quit_item])
                .map_err(|e| e.to_string())?;
            let mut tray_builder = tauri::tray::TrayIconBuilder::new()
                .menu(&menu)
                .tooltip(rs_tr("app"));
            // Mac 菜单栏用单色模板图标（随系统深浅色自动变色）；Windows 用彩色应用图标
            #[cfg(target_os = "macos")]
            {
                if let Ok(img) = xcap::image::load_from_memory(include_bytes!("../icons/tray-template@2x.png")) {
                    let rgba = img.to_rgba8();
                    let (w, h) = rgba.dimensions();
                    tray_builder = tray_builder.icon(tauri::image::Image::new_owned(rgba.into_raw(), w, h)).icon_as_template(true);
                } else if let Some(icon) = app.default_window_icon() {
                    tray_builder = tray_builder.icon(icon.clone());
                }
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let tray = tray_builder.build(app).map_err(|e| e.to_string())?;
            app.manage(TrayLabels { open: open_item.clone(), toggle: toggle_item.clone(), close: close_item.clone(), quit: quit_item.clone(), tray });

            tauri::async_runtime::spawn(async move {
                let listener =
                    TcpListener::from_std(std_listener).expect("from_std loopback");
                axum::serve(listener, lb_app).await.expect("loopback serve");
            });
            Ok(())
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "open_overlay" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = open_overlay(app.clone()).await {
                        let _ = app.emit("overlay-error", error);
                    }
                });
            }
            "close_overlay" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { let _ = close_overlay(app).await; });
            }
            "toggle_mode" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let s = app.state::<TauriState>();
                    let next = !*s.overlay_clickthrough.lock().await;
                    let _ = apply_overlay_mode(&app, &s, next).await;
                });
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            set_language,
            get_app_info,
            get_license_status,
            activate_license,
            deactivate_license,
            get_notices,
            fix_firewall,
            get_loopback_port,
            get_host_token,
            get_ws_port,
            get_candidate_ips,
            get_candidate_nets,
            start_lan,
            stop_lan,
            regenerate_pairing,
            get_lan_status,
            open_overlay,
            close_overlay,
            switch_to_whiteboard,
            set_overlay_clickthrough,
            toggle_overlay_clickthrough,
            get_overlay_status,
            set_overlay_shortcut,
            capture_screenshot_png,
            save_captured_screenshot,
            discard_captured_screenshot,
            provide_ink_layer,
            set_overlay_hit_rect,
            get_preview_allowed,
            set_preview_allowed,
            get_annotate_pads,
            get_capture_visible,
            set_capture_visible,
            preview_selftest,
        ])
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
