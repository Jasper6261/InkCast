// 屏幕标注使用独立白板；服务端完整状态是存档导入和重连时的唯一事实来源。
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { save } = window.__TAURI__.dialog;

const WB = window.Whiteboard;
const Ink = window.Ink;
const I18N = window.I18N, T = I18N.t;
const UNIT = 1600; // 笔宽单位 = 屏幕宽度 / 1600（与 iPad 一致）
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const liveCanvas = document.getElementById("live");
const lctx = liveCanvas.getContext("2d");
const openIds = new Set(); // 正在书写、尚未收到 stroke-end 的笔画（含 iPad 写的）
const toolbar = document.getElementById("ui");
// 书写工具：与白板（主窗口）、iPad 同一套控件（src/pctools.js），设置两个窗口共用；
// v0.8.6：标注层把所有功能集中在屏幕上方一条工具栏：屏幕 | 白板、画笔 / 荧光笔 / 橡皮 / 颜色、大小、撤销 / 清除、截图、鼠标穿透
const ICON_SHOT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.5A1.5 1.5 0 015.5 7h2.2l1.5-2h5.6l1.5 2h2.2A1.5 1.5 0 0120 8.5v9a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z"/><circle cx="12" cy="13" r="3.5"/></svg>';
const ICON_THROUGH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5l11 8.2-4.6.9 2.7 5.6-2.3 1.1-2.7-5.6L6.5 17z"/></svg>';
const pcui = window.PcTools.mount(toolbar, {
  layout: "dock",
  start: '<div class="seg" id="mode-seg" role="tablist"><button type="button" id="seg-screen" class="on" data-i18n="seg.screen">屏幕</button>' +
         '<button type="button" id="seg-board" data-i18n="seg.board" data-i18n-title="ov.toBoardTitle">白板</button></div>',
  end: '<button type="button" id="btn-shot" class="ib" data-i18n-title="ov.shotTitle" data-i18n-aria="ov.shot">' + ICON_SHOT + "</button>" +
       '<button type="button" id="btn-mode" class="ib" data-i18n-aria="ov.btnThrough">' + ICON_THROUGH + "</button>",
  sendSize: (v, brush) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "pen-size", size: v, brush })); },
  undo: () => sendControl(WB.undoMsg()),
  // 重做：本窗口的笔画服务器不回发给自己，先放进本地列表再发送
  sendStroke: (s) => {
    if (busy) return; endStroke();
    try {
      send(WB.strokeStart(s.id, s.color, s.size, s.tool));
      strokes.push({ id: s.id, color: s.color, size: s.size, tool: s.tool, points: s.points.map((q) => q.slice()) });
      s.points.forEach((q) => send(WB.strokePoint(s.id, q[0], q[1], q[2])));
      send(WB.strokeEnd(s.id));
      redraw();
    } catch (e) { alert(e.message); }
  },
  clear: () => sendControl(WB.clearMsg()),
  boardLoad: (list) => sendControl(WB.boardLoadMsg(list)),
  strokes: () => strokes,
  clearedKey: "pad.clearedAnnotate"
});
const hint = document.getElementById("hint");
const status = document.getElementById("overlay-status");
const usageEl = document.getElementById("board-usage");
const noticeEl = document.getElementById("board-notice");
const fileButtons = ["btn-shot"].map((id) => document.getElementById(id));

let strokes = [], ws = null, port = 7749, hostToken = null;
let cur = null, clickthrough = false, ready = false, busy = false;
let serverError = "";
let shortcut = "Ctrl+Alt+Shift+A", shortcutRegistered = false;
let W = 0, H = 0;
function dpr() { return window.devicePixelRatio || 1; }
function fit() {
  W = Math.round(window.innerWidth * dpr());
  H = Math.round(window.innerHeight * dpr());
  for (const c of [canvas, liveCanvas]) {
    c.width = W; c.height = H;
    c.style.width = window.innerWidth + "px";
    c.style.height = window.innerHeight + "px";
  }
  redraw();
}
window.addEventListener("resize", fit);

function xf(w, h) { return { sx: w, sy: h, ox: 0, oy: 0, s: w / UNIT }; }
// 已完成的笔画画在 board 上；正在书写的笔画每帧在 live 层重画（带笔锋的轮廓需要整笔重算）
function redraw() {
  ctx.clearRect(0, 0, W, H);
  for (const s of strokes) if (!openIds.has(s.id) || s.tool === "eraser") Ink.drawStroke(ctx, s, xf(W, H), !openIds.has(s.id));
  erased.clear();
  for (const s of strokes) if (s.tool === "eraser" && openIds.has(s.id)) erased.set(s.id, s.points.length);
  renderLive();
}
// v0.8.9：橡皮擦增量擦除。以前橡皮每多一个点就把整屏（2560×1600）所有笔画重画一遍，笔画一多就明显延迟；
// 现在只把新增的几段直接从画布上擦掉（与 iPad 相同）
const erased = new Map(); // 正在擦的橡皮笔画 id → 已经擦到第几个点
function eraseMore(s) {
  if (!s || s.tool !== "eraser") return;
  erased.set(s.id, Ink.eraseSegment(ctx, s, xf(W, H), erased.get(s.id) || 0));
}
function renderLive() {
  lctx.clearRect(0, 0, W, H);
  for (const s of strokes) {
    if (!openIds.has(s.id) || s.tool === "eraser") continue;
    // 自己正在写的这一笔：加上笔感层还没定稿的最后几个点，笔迹紧跟鼠标 / 笔尖
    let view = s;
    if (cur && cur.stroke === s) {
      const r = canvas.getBoundingClientRect(), tail = cur.input.tail();
      if (tail.length) view = { id: s.id + "-live", color: s.color, size: s.size, tool: s.tool,
        points: s.points.concat(tail.map((q) => [(q[0] - r.left) / r.width, (q[1] - r.top) / r.height, q[2]])) };
    }
    Ink.drawStroke(lctx, view, xf(W, H), false);
  }
}
let liveRaf = false;
function scheduleLive(full) {
  if (full) needFull = true;
  if (liveRaf) return;
  liveRaf = true;
  requestAnimationFrame(() => { liveRaf = false; if (needFull) { needFull = false; redraw(); } else renderLive(); });
}
let needFull = false;
function finishStroke(id) {
  if (!openIds.delete(id)) return;
  const s = strokes.find((x) => x.id === id);
  if (s && s.tool !== "eraser") Ink.drawStroke(ctx, s, xf(W, H), true);
  if (s && s.tool === "eraser") { eraseMore(s); erased.delete(id); }
  scheduleLive(false);
}

let lastUsageMsg = null;
function showOverlayUsage(msg) {
  lastUsageMsg = msg;
  const notice = WB.usageNotice(msg);
  usageEl.textContent = notice.text; usageEl.dataset.level = notice.level;
  usageEl.hidden = !notice.text;
}
// 状态文字：传词条键时切换语言会自动更新；传普通文字（如服务端原文）则原样显示
// 正常连接时不显示状态（界面保持简洁），只在连接中、出错时显示
function setStatus(text, key, params) {
  if (key) I18N.bind(status, key, params); else I18N.unbind(status, text);
  status.hidden = key === "ov.independent";
}
function send(msg) {
  if (!ready || !ws || ws.readyState !== WebSocket.OPEN) throw new Error(T("ov.notConnected"));
  ws.send(JSON.stringify(msg));
}
function connect() {
  const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws?role=overlay");
  ws = socket;
  ready = false;
  socket.onopen = () => socket.send(JSON.stringify(WB.helloMsg(hostToken)));
  socket.onmessage = (ev) => {
    if (socket !== ws) return;
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === "pen-size") { pcui.onRemoteSize(msg); return; }
    if (msg.t === "board-usage") {
      showOverlayUsage(msg);
      return;
    }
    if (msg.t === "stroke-rejected" || msg.t === "stroke-truncate") {
      if (cur && cur.id === msg.id) {
        cur = null; // 不再补发 pending 尾点。
        if (ready) send(WB.strokeEnd(msg.id));
      }
      openIds.delete(msg.id);
      if (WB.applyMessage(strokes, msg).changed) redraw();
      noticeEl.textContent = T("stroke.stopped", { r: msg.reason ? I18N.msg(msg.reason) : T("stroke.limitSave") });
      return;
    }
    if (msg.t === "auth" && !msg.ok) {
      setStatus(null, "ov.authFail");
      return;
    }
    if (msg.t === "error") {
      cur = null;
      const error = new Error(msg.message ? I18N.msg(msg.message) : T("ov.rejected"));
      serverError = error.message;
      setStatus(error.message);
      return;
    }
    if (msg.t === "full-state") {
      cur = null;
      ready = true;
      openIds.clear();
    }
    pcui.noteMessage(msg);
    if (msg.t === "stroke-start") openIds.add(msg.id);
    if (msg.t === "stroke-end") { finishStroke(msg.id); return; }
    if (msg.t === "clear") openIds.clear();
    if (msg.t === "clear" || (msg.t === "undo" && cur && msg.id === cur.id)) cur = null;
    const result = WB.applyMessage(strokes, msg);
    if (result.changed) {
      if (result.incremental && result.stroke) { if (result.stroke.tool === "eraser") eraseMore(result.stroke); else scheduleLive(false); }
      else if (msg.t !== "stroke-start") redraw();
    }
    if (msg.t === "full-state") {
      if (serverError) setStatus(serverError);
      else setStatus(null, "ov.independent");
    }
  };
  socket.onclose = () => {
    if (socket !== ws) return;
    ready = false; cur = null;
    setStatus(null, "ov.reconnecting");
    setTimeout(connect, 1500);
  };
}

// 本地即时绘制；断线时暂停，避免产生未保存到服务端的幽灵笔画。
function evPos(e) {
  const r = canvas.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}
canvas.addEventListener("pointerdown", (e) => {
  if (!ready || busy || clickthrough || e.button !== 0 || cur) return;
  serverError = "";
  noticeEl.textContent = "";
  const id = WB.newId();
  // v0.8.2：和 iPad 一样的画笔，走同一个笔感层（鼠标用速度模拟粗细，数位板用真实压力）
  pcui.beginStroke(id);
  const ps = Ink.pcStroke(pcui.tool());
  const stroke = { id, color: ps.color, size: ps.size, tool: ps.tool, points: [] };
  cur = { id, stroke, pointerId: e.pointerId, sampler: WB.pointSampler(), input: ps.input, eraser: ps.tool === "eraser", lastP: null };
  strokes.push(stroke);
  openIds.add(id);
  canvas.setPointerCapture(e.pointerId);
  send(WB.strokeStart(id, stroke.color, stroke.size, stroke.tool));
  addPoint(pt(e, 0, 0));
});
canvas.addEventListener("pointermove", (e) => {
  if (!cur || cur.pointerId !== e.pointerId || !ready) return;
  coalesced(e).forEach((c) => addPoint(c));
});
// 笔感层定稿的点（CSS 像素）→ 屏幕比例坐标，抽稀后发送
function feedPoints(list, forceLast) {
  const r = canvas.getBoundingClientRect();
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    const point = [Math.min(1, Math.max(0, (q[0] - r.left) / r.width)), Math.min(1, Math.max(0, (q[1] - r.top) / r.height)),
                   Math.round(q[2] * 1000) / 1000];
    const pt = WB.samplePoint(cur.sampler, point, q[0], q[1], forceLast && i === list.length - 1);
    if (pt) emitPoint(pt);
  }
}
function emitPoint(point) {
  cur.stroke.points.push(point);
  if (cur.stroke.tool === "eraser") eraseMore(cur.stroke); else scheduleLive(false);
  send(WB.strokePoint(cur.id, ...point));
}
// 合并采样（getCoalescedEvents）：部分 Windows WebView2 / 显示缩放组合下，合并采样的坐标与本事件整体错开一段固定距离，
// 笔迹会和鼠标“漂”开。这里以本事件的坐标为准，把合并采样整体平移对齐（坐标本来就对时平移量为 0）
function coalesced(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (list.length < 2) return [pt(e, 0, 0)];
  const last = list[list.length - 1], dx = e.clientX - last.clientX, dy = e.clientY - last.clientY;
  return list.map((c) => pt(c, dx, dy));
}
function pt(e, dx, dy) { return { x: e.clientX + dx, y: e.clientY + dy, t: e.timeStamp || performance.now(), pointerType: e.pointerType, pressure: e.pressure, type: e.type }; }
function addPoint(e) {
  if (!cur) return;
  let pr = null;
  if (e.pointerType === "pen" && !cur.eraser) {
    if (e.pressure > 0) cur.lastP = e.pressure;
    pr = e.pressure > 0 ? e.pressure : (cur.lastP || 0.3);
  }
  feedPoints(cur.input.add(e.x, e.y, pr, e.t), false);
  if (!cur.eraser) scheduleLive(false);
}
function endStroke(e) {
  if (!cur) return;
  if (e && e.pointerId !== cur.pointerId) return;
  if (e && e.type === "pointerup") addPoint(pt(e, 0, 0), true);
  if (!cur) return;
  if (ready && (!e || e.type !== "pointercancel")) {
    feedPoints(cur.input.finish(), true);
    const point = WB.flushPoint(cur.sampler);
    if (point) emitPoint(point);
  }
  if (ready) send(WB.strokeEnd(cur.id));
  const id = cur.id;
  cur = null;
  finishStroke(id);
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);

let lastHintMode = null, hintTimer = null;
function updateBadge() {
  // 鼠标穿透按钮：点一下切到穿透（工具栏隐藏，鼠标操作底下的文件）；用快捷键或托盘切回
  document.getElementById("btn-mode").classList.toggle("active", clickthrough);
  document.getElementById("btn-mode").title = shortcutRegistered ? T("ov.modeTitle", { k: shortcut }) : T("ov.modeTitleNoKey");
  canvas.style.cursor = clickthrough ? "default" : "crosshair";
  // 穿透模式：完整工具栏收起，屏幕上方只留一条小工具栏（屏幕 | 白板、继续标注）。
  // 窗口整体仍然穿透，程序检测到鼠标移到小工具栏上时才让它可以点（见 set_overlay_hit_rect），其他地方照常操作下面的窗口
  toolbar.style.display = clickthrough ? "none" : "";
  hint.style.display = clickthrough ? "none" : "";
  const mini = document.getElementById("mini");
  mini.hidden = !clickthrough;
  mini.title = shortcutRegistered ? T("ov.miniTitle", { k: shortcut }) : T("ov.miniTitleNoKey");
  reportMiniRect();
  hint.textContent = clickthrough
    ? (shortcutRegistered ? T("ov.hintThroughKey", { k: shortcut }) : T("ov.hintThroughTray"))
    : (shortcutRegistered ? T("ov.hintDrawKey", { k: shortcut }) : T("ov.hintDrawNoKey"));
  // 提示只在切到绘制模式时显示几秒，之后淡出，不挡画面
  if (clickthrough !== lastHintMode) {
    lastHintMode = clickthrough;
    hint.classList.remove("hidden"); clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add("hidden"), 6000);
  }
}
let lastOverlayStatus = null;
function applyOverlayStatus(value) {
  lastOverlayStatus = value;
  clickthrough = !!value.clickthrough;
  shortcut = value.shortcut || shortcut;
  shortcutRegistered = !!value.shortcutRegistered;
  updateBadge();
}
async function setClickthrough(on) {
  if (on === clickthrough) return;
  endStroke(); pcui.closePops();
  try { clickthrough = !!(await invoke("set_overlay_clickthrough", { clickthrough: on })); updateBadge(); }
  catch (e) { alert(T("ov.toggleFail", { e: I18N.msg(e) })); }
}
document.getElementById("btn-mode").addEventListener("click", () => setClickthrough(!clickthrough));
// 小工具栏：继续标注 / 屏幕 = 回到绘制模式；白板 = 关闭屏幕标注、回到主窗口
document.getElementById("mini-draw").addEventListener("click", () => setClickthrough(false));
document.getElementById("mini-screen").addEventListener("click", () => setClickthrough(false));
document.getElementById("mini-board").addEventListener("click", async () => {
  try { await invoke("switch_to_whiteboard"); } catch (e) { alert(T("ov.closeFail", { e: I18N.msg(e) })); }
});
// 把小工具栏的位置告诉程序（CSS 像素，相对标注窗口）；不显示时传 null
let lastMiniRect = "";
function reportMiniRect() {
  const mini = document.getElementById("mini");
  let rect = null;
  if (!mini.hidden) { const r = mini.getBoundingClientRect(); if (r.width > 0) rect = [r.left, r.top, r.width, r.height].map((v) => Math.round(v)); }
  const key = JSON.stringify(rect);
  if (key === lastMiniRect) return;
  lastMiniRect = key;
  invoke("set_overlay_hit_rect", { rect }).catch(() => { lastMiniRect = ""; });
}
window.addEventListener("resize", reportMiniRect);
// “白板”：关闭屏幕标注，回到主窗口白板（与 iPad 上切换“屏幕 | 白板”一样）
document.getElementById("seg-board").addEventListener("click", async () => {
  endStroke();
  try { await invoke("switch_to_whiteboard"); } catch (e) { alert(T("ov.closeFail", { e: I18N.msg(e) })); }
});


// 书写工具：与白板（主窗口）、iPad 同一套（src/pctools.js），设置两个窗口共用
function sendControl(message) {
  if (busy) return;
  endStroke();
  try { send(message); } catch (e) { alert(e.message); }
}

async function fileAction(action) {
  if (busy) return;
  busy = true; endStroke();
  fileButtons.forEach((button) => { button.disabled = true; });
  try { await action(); }
  catch (e) { alert(T("ov.opFail", { e: I18N.msg(e) })); }
  finally {
    toolbar.style.visibility = ""; hint.style.visibility = "";
    busy = false;
    fileButtons.forEach((button) => { button.disabled = false; });
  }
}

// 标注墨迹层：把屏幕上的标注（已完成 + 正在写的）合成一张透明 PNG，交给程序叠到屏幕截图上（base64）
// v0.8.7：截屏时标注窗口不进画面（系统截屏本来也截不到透明标注窗口），所以截图里的标注由这里提供
async function inkLayerB64() {
  if (!W || !H) return "";
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.drawImage(canvas, 0, 0); g.drawImage(liveCanvas, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) return "";
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
window.__inkLayerB64 = inkLayerB64; // 测试用
window.__ovStrokes = () => strokes.length; // 测试用
function stamp() {
  const d = new Date(), z = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}

// 先把干净的桌面截图缓存到内存，再询问路径；取消、写入失败都清理缓存。
document.getElementById("btn-shot").addEventListener("click", () => fileAction(async () => {
  try {
    toolbar.style.visibility = "hidden";
    hint.style.visibility = "hidden";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await invoke("capture_screenshot_png");
    const ink = await inkLayerB64();
    toolbar.style.visibility = ""; hint.style.visibility = "";
    const path = await save({ filters: [{ name: T("file.png"), extensions: ["png"] }], defaultPath: T("ov.fileShotName", { t: stamp() }) });
    if (path) await invoke("save_captured_screenshot", { path, ink });
  } finally { await invoke("discard_captured_screenshot"); }
}));

// 语言：跟随主窗口的选择（主窗口切换时由程序本体通知，或通过共享的本地存储）
function relabel() {
  I18N.apply();
  updateBadge();
  lastMiniRect = ""; reportMiniRect(); // 语言切换后宽度会变
  if (lastOverlayStatus) applyOverlayStatus(lastOverlayStatus);
  if (lastUsageMsg) showOverlayUsage(lastUsageMsg);
}
I18N.onChange(relabel);
window.addEventListener("storage", (e) => { if (e.key === "wb_lang" && e.newValue && e.newValue !== I18N.lang()) I18N.set(e.newValue); });
I18N.apply();
(async function init() {
  try { await listen("language-changed", (event) => { if (event.payload && event.payload !== I18N.lang()) I18N.set(event.payload); }); } catch (e) {}
  port = await invoke("get_loopback_port");
  hostToken = await invoke("get_host_token");
  // iPad 发起的截图：程序向这里要当前的标注墨迹
  await listen("ink-layer-request", async (event) => {
    let png = "";
    try { png = await inkLayerB64(); } catch (e) {}
    try { await invoke("provide_ink_layer", { id: event.payload, png }); } catch (e) {}
  });
  await listen("overlay-mode", (event) => { endStroke(); clickthrough = !!event.payload; updateBadge(); });
  let statusUpdates = 0;
  await listen("overlay-status", (event) => { statusUpdates++; applyOverlayStatus(event.payload); });
  const revision = statusUpdates;
  const initialStatus = await invoke("get_overlay_status");
  if (revision === statusUpdates) applyOverlayStatus(initialStatus);
  fit(); connect();
})().catch((e) => { setStatus(T("ov.initFail", { e: I18N.msg(e) })); });

