// 电脑端 viewer：实时渲染 + 鼠标书写 + 工具栏 + 保存。
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { save, confirm: confirmDialog } = window.__TAURI__.dialog;
const { writeFile } = window.__TAURI__.fs;

const WB = window.Whiteboard;
const I18N = window.I18N, T = I18N.t;
const VW = WB.VW, VH = WB.VH;

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const wrap = document.getElementById("canvas-wrap");

// ---------- 状态 ----------
let strokes = [];            // 事实来源：只从 wsView 广播更新
let wsView = null, wsPad = null;
let port = 7749;
let hostToken = null;
const overlayStatusHandlers = []; // 标注层状态的订阅者（见下方“屏幕 | 白板”切换）
let mouseStroke = null;      // 正在写的鼠标笔画 {id}
let padReady = false;
let lastPadOnline = 0;        // 上次收到的在线 iPad 数（判断“刚连上”）
let padEverOnline = false, padOffTimer = 0; // v1.0.1：本次运行里 iPad 是否连上过；短暂断开不立即显示“未连接”
const PAD_OFF_DELAY = 2500;
const usageEl = document.getElementById("board-usage");
const noticeEl = document.getElementById("board-notice");
let lastUsage = null;
function showUsage(msg) {
  lastUsage = msg;
  const notice = WB.usageNotice(msg);
  usageEl.textContent = notice.text; usageEl.dataset.level = notice.level;
  usageEl.hidden = !notice.text;
}

// 虚拟坐标 -> 屏幕坐标
let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
function fit() {
  const r = wrap.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const scale = Math.min(r.width / VW, r.height / VH);
  view = {
    scale: scale * dpr,
    ox: (r.width * dpr - VW * scale * dpr) / 2,
    oy: (r.height * dpr - VH * scale * dpr) / 2,
    w: r.width * dpr, h: r.height * dpr
  };
  redraw();
}
window.addEventListener("resize", fit);

function v2s(x, y) { return [view.ox + x * VW * view.scale, view.oy + y * VH * view.scale]; }
function s2v(px, py) {
  const dpr = window.devicePixelRatio || 1;
  return [((px * dpr - view.ox) / view.scale) / VW, ((py * dpr - view.oy) / view.scale) / VH];
}

// ---------- 渲染 ----------
const Ink = window.Ink;
const openIds = new Set(); // 正在书写的笔画：不做收笔锋
function boardXf() { return { sx: VW * view.scale, sy: VH * view.scale, ox: view.ox, oy: view.oy, s: view.scale }; }
function redraw() {
  ctx.clearRect(0, 0, view.w, view.h);
  // 纸面
  const [px, py] = v2s(0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(px, py, VW * view.scale, VH * view.scale);
  const t = boardXf();
  for (const s of strokes) Ink.drawStroke(ctx, liveView(s), t, !openIds.has(s.id), { eraserPaint: "#ffffff" });
  I18N.bind(document.getElementById("stroke-count"), "pc.strokes", { n: strokes.length });
}
let redrawPending = false;
function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => { redrawPending = false; redraw(); });
}

// ---------- 延迟统计（v0.4 §10：端到端延迟管控） ----------
// 采样：iPad 发送点的时间戳 → viewer 收到的时间差；滑动窗口 300 个点
// v1.0.2：差值里含两台设备的时钟差（以前直接显示，iPad 时钟慢 1 秒就显示“延迟 1300ms”）。
// 时钟差是常数，取窗口内最小差值当作基准扣掉，显示的是相对最快一次的延迟（局域网里最快一次通常只有几毫秒）
const latSamples = [];
// 本机鼠标写的笔画带的是电脑自己的时间戳，混进来会把“时钟差基准”算错——只统计 iPad 的笔画
const localStrokeIds = new Set();
function markLocalStroke(id) {
  localStrokeIds.add(id);
  if (localStrokeIds.size > 200) localStrokeIds.delete(localStrokeIds.values().next().value);
}
function recordLatency(msg) {
  if (!msg.ts || localStrokeIds.has(msg.id)) return;
  const d = Date.now() - msg.ts;
  if (!(Math.abs(d) < 120000)) return; // 时钟差超过 2 分钟时不统计
  latSamples.push(d);
  if (latSamples.length > 300) latSamples.shift();
}
function latencyStats() {
  if (latSamples.length < 5) return null;
  const s = latSamples.slice().sort((a, b) => a - b), base = s[0];
  return { p50: Math.round(percentile(s, 0.5) - base), p95: Math.round(percentile(s, 0.95) - base) };
}
function percentile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}
setInterval(() => {
  const el = document.getElementById("latency");
  const st = latencyStats();
  if (!st) { I18N.bind(el, "pc.latencyNone"); return; }
  const p50 = st.p50, p95 = st.p95;
  I18N.bind(el, "pc.latency", { a: p50, b: p95 });
  el.style.color = p95 > 200 ? "#e5484d" : p95 > 100 ? "#f76b15" : "";
}, 1000);

// ---------- WebSocket ----------
function wsUrl(role) { return "ws://127.0.0.1:" + port + "/ws?role=" + role; }
function sendHello(ws) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(WB.helloMsg(hostToken)));
}

function connectView() {
  wsView = new WebSocket(wsUrl("view"));
  wsView.onopen = () => sendHello(wsView);
  wsView.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === "board-usage") { showUsage(msg); return; }
    if (msg.t === "pen-size") { pcui.onRemoteSize(msg); return; }
    if (msg.t === "pad-status") {
      const el = document.getElementById("pad-status");
      // v1.0.1：iPad 切换“屏幕 | 白板”时会断开再重连（约几百毫秒）。以前这一下会让“连接你的 iPad”引导卡片闪一下。
      // 现在：本次运行里 iPad 连上过以后不再弹引导；“iPad 未连接”也要持续 2.5 秒才显示
      clearTimeout(padOffTimer);
      const setPill = (on) => { I18N.bind(el, on ? "pc.padOn" : "pc.padOff"); el.classList.toggle("on", on); };
      if (msg.online > 0) { padEverOnline = true; setPill(true); }
      else if (padEverOnline) padOffTimer = setTimeout(() => setPill(false), PAD_OFF_DELAY);
      else setPill(false);
      showOnboard(msg.online === 0 && !padEverOnline);
      // v0.8.11：扫码连上以后，二维码窗口自动关闭，并提示已连接
      const qr = document.getElementById("qr-modal");
      if (msg.online > (lastPadOnline || 0) && !qr.classList.contains("hidden")) {
        qr.classList.add("hidden");
        noticeEl.textContent = T("pc.padJustConnected");
        setTimeout(() => { if (noticeEl.textContent === T("pc.padJustConnected")) noticeEl.textContent = ""; }, 4000);
      }
      lastPadOnline = msg.online;
      return;
    }
    if (msg.t === "stroke-point") recordLatency(msg);
    pcui.noteMessage(msg);
    if (msg.t === "clear" || msg.t === "full-state" || (msg.t === "undo" && mouseStroke && msg.id === mouseStroke.id)) mouseStroke = null;
    if (msg.t === "stroke-start") openIds.add(msg.id);
    if (msg.t === "stroke-end") { if (openIds.delete(msg.id)) scheduleRedraw(); return; }
    if (msg.t === "full-state" || msg.t === "clear") openIds.clear();
    const r = WB.applyMessage(strokes, msg);
    if (!r.changed) return;
    if (r.incremental && r.stroke) scheduleRedraw();
    else redraw();
  };
  wsView.onclose = () => { mouseStroke = null; setTimeout(connectView, 1500); };
}

function connectPad() {
  // 鼠标书写通道；只处理认证和错误，绘制事实从 wsView 接收。
  wsPad = new WebSocket(wsUrl("pad-local"));
  padReady = false;
  wsPad.onopen = () => sendHello(wsPad);
  wsPad.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.t === "welcome") padReady = true;
    if (msg.t === "pen-size") { pcui.onRemoteSize(msg); return; }
    if (msg.t === "stroke-rejected" || msg.t === "stroke-truncate") {
      if (mouseStroke && mouseStroke.id === msg.id) {
        // 丢弃未发送尾点；只结束对应的笔，迟到的旧 id 不影响新笔。
        mouseStroke = null;
        sendPad(WB.strokeEnd(msg.id));
      }
      if (WB.applyMessage(strokes, msg).changed) redraw();
      noticeEl.textContent = T("stroke.stopped", { r: msg.reason ? I18N.msg(msg.reason) : T("stroke.limitSave") });
      return;
    }
    if (msg.t === "error") {
      mouseStroke = null;
      I18N.unbind(document.getElementById("server-url"), T("pc.boardOpFail", { m: I18N.msg(msg.message) }));
    }
  };
  wsPad.onclose = () => { padReady = false; mouseStroke = null; setTimeout(connectPad, 1500); };
}
function sendPad(msg) {
  if (padReady && wsPad && wsPad.readyState === WebSocket.OPEN) wsPad.send(JSON.stringify(msg));
}

// ---------- 鼠标书写（走 pad-local 通道，只从广播渲染） ----------
// v0.8.2：和 iPad 一样的画笔（英文斜体 / 中国毛笔 / 荧光笔），走同一个笔感层；
// 鼠标没有压力，用书写速度模拟粗细；数位板用真实压力
canvas.addEventListener("pointerdown", (e) => {
  if (!padReady || mouseStroke || e.button !== 0 || e.pointerType === "touch" || document.body.classList.contains("annotating")) return;
  const [x, y] = s2v(e.offsetX, e.offsetY);
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  const id = WB.newId();
  markLocalStroke(id);
  const tool = pcui.tool(), ps = Ink.pcStroke(tool);
  mouseStroke = { id, pointerId: e.pointerId, sampler: WB.pointSampler(), input: ps.input, eraser: tool.kind === "eraser",
                  rect: canvas.getBoundingClientRect(), lastP: null };
  noticeEl.textContent = "";
  if (!onboardDismissed) dismissOnboard();
  pcui.beginStroke(id);
  canvas.setPointerCapture(e.pointerId);
  sendPad(WB.strokeStart(id, ps.color, ps.size, ps.tool));
  addMousePoint(pt(e, 0, 0));
});
canvas.addEventListener("pointermove", (e) => {
  if (!mouseStroke || mouseStroke.pointerId !== e.pointerId) return;
  coalesced(e).forEach((c) => addMousePoint(c));
  scheduleRedraw(); // 刷新本地临时尾巴
});
// 笔感层定稿的点（CSS 像素）→ 画布坐标，抽稀后发送
function emitMousePoints(list, forceLast) {
  const ms = mouseStroke;
  for (let i = 0; i < list.length; i++) {
    const q = list[i], [x, y] = s2v(q[0] - ms.rect.left, q[1] - ms.rect.top);
    const pt = WB.samplePoint(ms.sampler, [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), Math.round(q[2] * 1000) / 1000],
                              q[0], q[1], forceLast && i === list.length - 1);
    if (pt) sendPad(WB.strokePoint(ms.id, ...pt));
  }
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
// 正在写的这一笔：加上笔感层还没定稿的最后一两个点，只在本窗口显示，笔迹紧跟鼠标
function liveView(s) {
  if (!mouseStroke || mouseStroke.id !== s.id || mouseStroke.eraser) return s;
  const tail = mouseStroke.input.tail();
  if (!tail.length) return s;
  const ms = mouseStroke;
  return { id: s.id + "-live", color: s.color, size: s.size, tool: s.tool,
    points: s.points.concat(tail.map((q) => { const [x, y] = s2v(q[0] - ms.rect.left, q[1] - ms.rect.top); return [x, y, q[2]]; })) };
}
function addMousePoint(e, ending) {
  if (!mouseStroke) return;
  let pr = null;
  if (e.pointerType === "pen" && !mouseStroke.eraser) {
    if (e.pressure > 0) mouseStroke.lastP = e.pressure;
    pr = e.pressure > 0 ? e.pressure : (mouseStroke.lastP || 0.3);
  }
  emitMousePoints(mouseStroke.input.add(e.x, e.y, pr, e.t), false);
}
function endMouseStroke(e) {
  if (!mouseStroke) return;
  if (e && e.pointerId !== mouseStroke.pointerId) return;
  if (e && e.type === "pointerup") addMousePoint(pt(e, 0, 0), true);
  if (!mouseStroke) return;
  if (!e || e.type !== "pointercancel") {
    emitMousePoints(mouseStroke.input.finish(), true);
    const point = WB.flushPoint(mouseStroke.sampler);
    if (point) sendPad(WB.strokePoint(mouseStroke.id, ...point));
  }
  sendPad(WB.strokeEnd(mouseStroke.id));
  mouseStroke = null;
}
canvas.addEventListener("pointerup", endMouseStroke);
canvas.addEventListener("pointercancel", endMouseStroke);

// ---------- 书写工具：与 iPad、屏幕标注层同一套（src/pctools.js） ----------
const $ = (id) => document.getElementById(id);
const pcui = window.PcTools.mount(document.getElementById("canvas-wrap"), {
  sendSize: (v, brush) => sendPad({ t: "pen-size", size: v, brush }),
  undo: () => sendPad(WB.undoMsg()),
  sendStroke: (s) => { sendPad(WB.strokeStart(s.id, s.color, s.size, s.tool)); s.points.forEach((q) => sendPad(WB.strokePoint(s.id, q[0], q[1], q[2]))); sendPad(WB.strokeEnd(s.id)); },
  clear: () => sendPad(WB.clearMsg()),
  boardLoad: (list) => sendPad(WB.boardLoadMsg(list)),
  strokes: () => strokes,
  clearedKey: "pad.clearedBoard",
  active: () => !document.body.classList.contains("annotating") // 屏幕标注时 Ctrl+Z 不动白板
});

// ---------- 设置：屏幕标注的穿透 / 绘制快捷键（v0.8.5 从标注层工具条移到这里） ----------
(function () {
  function show(v) {
    if (!v) return;
    if (document.activeElement !== $("shortcut")) $("shortcut").value = v.shortcut || "";
    $("shortcut-status").textContent = v.shortcutError ? T("ov.keyFail", { e: I18N.msg(v.shortcutError) }) : T("ov.keyOk");
  }
  let last = null;
  $("btn-shortcut").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (button.disabled) return;
    button.disabled = true;
    try {
      last = await invoke("set_overlay_shortcut", { shortcut: $("shortcut").value.trim() }); show(last);
      try { localStorage.setItem("wb_ov_shortcut", last.shortcut); } catch (e) {} // v0.8.7：记住，下次启动沿用
    }
    catch (e) { $("shortcut-status").textContent = T("ov.keySetFail", { e: I18N.msg(e) }); }
    finally { button.disabled = false; }
  });
  // 启动时恢复上次设置的快捷键（格式不对就保持默认）
  (async () => {
    let saved = null;
    try { saved = localStorage.getItem("wb_ov_shortcut"); } catch (e) {}
    if (!saved) return;
    try { last = await invoke("set_overlay_shortcut", { shortcut: saved }); show(last); } catch (e) {}
  })();
  I18N.onChange(() => show(last));
  overlayStatusHandlers.push((st) => { last = st; show(last); });
})();

// ---------- 导出：保存 PNG / SVG ----------
(function () {
  const btn = $("btn-export"), pop = $("export-pop");
  function set(open) { pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); btn.classList.toggle("active", open); }
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(pop.hidden); });
  pop.addEventListener("click", (e) => { if (e.target.closest("button")) setTimeout(() => set(false), 0); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
})();

// ---------- 保存 ----------
async function renderExport(scaleF) {
  const c = document.createElement("canvas");
  c.width = VW * scaleF; c.height = VH * scaleF;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  const t = { sx: VW * scaleF, sy: VH * scaleF, ox: 0, oy: 0, s: scaleF };
  for (const s of strokes) Ink.drawStroke(g, s, t, true, { eraserPaint: "#ffffff" });
  return c;
}
// v0.8.7：默认文件名带日期时间（不会覆盖上一次的），保存后在画布上方提示保存位置
function stamp() {
  const d = new Date(), z = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
}
function savedNotice(path) {
  noticeEl.textContent = T("pc.saved", { p: path });
  clearTimeout(savedNotice.timer);
  savedNotice.timer = setTimeout(() => { if (noticeEl.textContent === T("pc.saved", { p: path })) noticeEl.textContent = ""; }, 6000);
}
document.getElementById("btn-png").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const path = await save({ filters: [{ name: T("file.png"), extensions: ["png"] }], defaultPath: T("pc.fileBoard", { t: stamp() }) + ".png" });
  if (!path) return;
  const c = await renderExport(2);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error(T("err.png"));
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
  savedNotice(path);
}));
document.getElementById("btn-svg").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const path = await save({ filters: [{ name: T("file.svg"), extensions: ["svg"] }], defaultPath: T("pc.fileBoard", { t: stamp() }) + ".svg" });
  if (!path) return;
  const svg = WB.serializeSvg(strokes);
  await writeFile(path, new TextEncoder().encode(svg));
  savedNotice(path);
}));

async function withButton(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try { await action(); }
  catch (e) { alert(T("pc.saveFail", { e: I18N.msg(e) })); }
  finally { button.disabled = false; }
}

// ---------- 配对面板（v0.4 §3） ----------
const modal = document.getElementById("qr-modal");
const pairBody = document.getElementById("pair-body");
let lastPair = null; // {ip, port, pairUrl, qrSvg}
document.getElementById("btn-qr").addEventListener("click", async () => {
  modal.classList.remove("hidden");
  await renderPairPanel();
});
document.getElementById("btn-qr-close").addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.add("hidden"); });

function escHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// 连接：直接用最合适的网络地址开始共享并显示二维码；需要时可以“换一个网络地址”
let appInfo = { os: "windows" };
async function renderPairPanel(chooseIp) {
  pairBody.innerHTML = "<p>" + escHtml(T("pair.loading")) + "</p>";
  let st = null;
  try { st = await invoke("get_lan_status"); }
  catch (e) { pairBody.innerHTML = "<p>" + escHtml(T("pair.statusFail", { e: I18N.msg(e) })) + "</p>"; return; }
  if (!st) {
    const nets = await loadNets();
    if (!nets.length) { pairBody.innerHTML = "<p>" + escHtml(T("pair.noIp")) + "</p>"; return; }
    if (!chooseIp) { startLan(nets[0].ip); return; }
    // v1.0.1：列出网卡名，并标出虚拟网卡 / VPN，方便选对（一般选 WLAN / 以太网）
    pairBody.innerHTML = "<p class='hint'>" + escHtml(T("pair.pickIp")) + "</p>" +
      nets.map((n) => `<button class="ip-btn${n.virtual ? " virtual" : ""}" data-ip="${escHtml(n.ip)}"><b>${escHtml(n.ip)}</b>` +
        `<span class="ip-name">${escHtml(n.name || "")}${n.virtual ? (n.name ? " · " : "") + escHtml(T("pair.virtualNet")) : ""}</span></button>`).join("");
    pairBody.querySelectorAll(".ip-btn").forEach((b) =>
      b.addEventListener("click", () => startLan(b.dataset.ip)));
  } else {
    if (!lastNets.length) await loadNets();
    showSharing(st.ip, st.port, st.pairingActive);
  }
}

// 候选网卡 [{ip, name, virtual}]，最合适的排第一；老版本后端只有 get_candidate_ips 时退回只有地址
let lastNets = [];
async function loadNets() {
  let nets = [];
  try { nets = await invoke("get_candidate_nets"); } catch (e) {}
  if (!Array.isArray(nets) || !nets.length) {
    try { nets = (await invoke("get_candidate_ips")).map((ip) => ({ ip, name: "", virtual: false })); } catch (e) { nets = []; }
  }
  lastNets = nets;
  return nets;
}

function showSharing(ip, port, pairingActive) {
  const net = lastNets.find((n) => n.ip === ip);
  let html = `<p>${escHtml(T("pair.sharing"))}<b>http://${escHtml(ip)}:${escHtml(port)}</b>` +
    (net && net.name ? ` <span class="ip-name">(${escHtml(net.name)})</span>` : "") + `</p>`;
  if (net && net.virtual) html += `<p class="warn" id="virtual-warn">${escHtml(T("pair.virtualWarn"))}</p>`;
  if (lastPair && lastPair.ip === ip && lastPair.port === port) {
    html += `<div id="qr-img">${lastPair.qrSvg}</div><div id="qr-url">${escHtml(lastPair.pairUrl)}</div>
             <p class="hint">${escHtml(T("pair.scanHint"))}</p>`;
  } else if (!pairingActive) {
    html += `<p class="hint">${escHtml(T("pair.codeUsed"))}</p>`;
  }
  html += `<div class="row"><button id="btn-repair">${escHtml(T("pair.repair"))}</button><button id="btn-stop">${escHtml(T("pair.stop"))}</button></div>
           <p class="hint">${escHtml(T("pair.sameWifi"))} · <a href="#" id="btn-change-ip">${escHtml(T("pair.changeIp"))}</a></p>
           <details class="trouble"><summary>${escHtml(T("pair.trouble"))}</summary><ul>
             <li>${escHtml(T("pair.trouble1"))}</li><li>${escHtml(T("pair.trouble3"))}</li><li>${escHtml(T("pair.trouble2"))}</li></ul>
             ${appInfo.os === "windows" ? `<button id="btn-firewall">${escHtml(T("pair.fixFirewall"))}</button><p class="hint" id="fw-result">${escHtml(T("pair.fixFirewallHint"))}</p>` : ""}
           </details>`;
  pairBody.innerHTML = html;
  document.getElementById("btn-change-ip").addEventListener("click", async (e) => {
    e.preventDefault();
    await invoke("stop_lan"); lastPair = null;
    renderPairPanel(true);
  });
  const fw = document.getElementById("btn-firewall");
  if (fw) fw.addEventListener("click", async () => {
    fw.disabled = true;
    const out = document.getElementById("fw-result");
    try { await invoke("fix_firewall"); out.textContent = T("pair.fixFirewallDone"); }
    catch (e) { out.textContent = T("pair.fixFirewallFail"); }
    finally { fw.disabled = false; }
  });
  document.getElementById("btn-repair").addEventListener("click", async () => {
    try {
      if (!await confirmDialog(T("pair.repairConfirm"), { title: T("pair.repair"), kind: "warning" })) return;
      lastPair = await invoke("regenerate_pairing");
      showSharing(lastPair.ip, lastPair.port, true);
    } catch (e) { alert(T("common.failed", { e: I18N.msg(e) })); }
  });
  document.getElementById("btn-stop").addEventListener("click", async () => {
    await invoke("stop_lan");
    lastPair = null;
    const el = document.getElementById("pad-status");
    I18N.bind(el, "pc.padOff"); el.classList.remove("on");
    I18N.bind(document.getElementById("server-url"), "pair.stopped");
    renderPairPanel();
  });
}

async function startLan(ip) {
  pairBody.innerHTML = "<p>" + escHtml(T("pair.starting")) + "</p>";
  try {
    lastPair = await invoke("start_lan", { ip });
    showSharing(lastPair.ip, lastPair.port, true);
    I18N.bind(document.getElementById("server-url"), "pair.localService", { url: "http://" + lastPair.ip + ":" + lastPair.port });
  } catch (e) {
    pairBody.innerHTML = "<p>" + escHtml(T("pc.startFail", { e: I18N.msg(e) })) + "</p>";
  }
}

// ---------- 启动 ----------
async function init() {
  await listen("overlay-error", (event) => { alert(T("pc.overlayOpenFail", { e: I18N.msg(event.payload) })); });
  // 程序重启后自动恢复上次的共享（iPad 无需重新扫码）
  await listen("lan-restored", (event) => {
    I18N.bind(document.getElementById("server-url"), "pc.lanRestored", { url: "http://" + event.payload });
  });
  port = await invoke("get_loopback_port");
  hostToken = await invoke("get_host_token");
  fit();
  connectView();
  connectPad();
  const urlEl = document.getElementById("server-url");
  if (urlEl.getAttribute("data-i18n") === "pc.starting") I18N.bind(urlEl, "pc.annotateHint");
  // v0.6：屏幕画面共享开关与指示
  // v0.8.7：记住“向 iPad 发送屏幕画面”开关（关掉后重启仍是关的）
  const allow = document.getElementById("preview-allowed");
  let savedAllow = null;
  try { savedAllow = localStorage.getItem("wb_preview_allowed"); } catch (e) {}
  allow.checked = savedAllow === "0" ? await invoke("set_preview_allowed", { allowed: false }) : await invoke("get_preview_allowed");
  allow.addEventListener("change", async () => {
    allow.checked = await invoke("set_preview_allowed", { allowed: allow.checked });
    try { localStorage.setItem("wb_preview_allowed", allow.checked ? "1" : "0"); } catch (e) {}
  });
  // 录屏/共享时显示标注（记住上次选择）
  const capVis = document.getElementById("capture-visible");
  let savedCap = null;
  try { savedCap = localStorage.getItem("wb_capture_visible"); } catch (e) {}
  // v1.0.2 起默认打开；用户关过（"0"）或开过（"1"）就按上次的选择
  capVis.checked = savedCap === "0" || savedCap === "1" ? await invoke("set_capture_visible", { visible: savedCap === "1" }) : await invoke("get_capture_visible");
  capVis.addEventListener("change", async () => {
    capVis.checked = await invoke("set_capture_visible", { visible: capVis.checked });
    try { localStorage.setItem("wb_capture_visible", capVis.checked ? "1" : "0"); } catch (e) {}
  });
  const liveEl = document.getElementById("preview-live");
  let liveTimer = null;
  await listen("preview-frame", () => {
    liveEl.hidden = false; clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveEl.hidden = true; }, 3000);
  });
  const annotateEl = document.getElementById("annotate-status");
  const showAnnotate = (n) => { annotateEl.hidden = !(n > 0); };
  showAnnotate(await invoke("get_annotate_pads"));
  await listen("annotate-pads", (event) => showAnnotate(event.payload));
  await listen("shot-saved", (event) => { noticeEl.textContent = T("pc.shotSaved", { p: event.payload }); });
  document.getElementById("btn-preview-test").addEventListener("click", async () => {
    noticeEl.textContent = T("pc.shotTaking");
    try { noticeEl.textContent = I18N.msg(await invoke("preview_selftest")); }
    catch (e) { noticeEl.textContent = T("pc.previewCheckFail", { e: I18N.msg(e) }); }
  });
}

// “屏幕 | 白板”切换（与 iPad 一致）：屏幕 = 打开屏幕标注层（和 iPad 屏幕标注模式同步），白板 = 本窗口
// v0.8.8：屏幕标注进行中，白板的工具全部收起（屏幕标注的工具在屏幕上方），只显示说明卡片，避免两套按键混用
function showMode(open) {
  document.getElementById("btn-overlay").classList.toggle("on", !!open);
  document.getElementById("seg-board").classList.toggle("on", !open);
  document.body.classList.toggle("annotating", !!open);
  document.getElementById("annot-card").hidden = !open;
  if (open) { pcui.closePops(); document.getElementById("export-pop").hidden = true; }
}
document.getElementById("annot-draw").addEventListener("click", async () => {
  try { await invoke("open_overlay"); } catch (e) { alert(T("pc.overlayOpenFail", { e: I18N.msg(e) })); }
});
document.getElementById("annot-back").addEventListener("click", () => document.getElementById("seg-board").click());
document.getElementById("btn-overlay").addEventListener("click", async () => {
  try { await invoke("open_overlay"); showMode(true); }
  catch (e) { alert(T("pc.overlayOpenFail", { e: I18N.msg(e) })); }
});
document.getElementById("seg-board").addEventListener("click", async () => {
  if (!document.getElementById("btn-overlay").classList.contains("on")) return;
  try { await invoke("close_overlay"); showMode(false); } catch (e) { alert(T("ov.closeFail", { e: I18N.msg(e) })); }
});
// 标注层状态（是否打开、快捷键）：主窗口只订阅一次，分发给“屏幕 | 白板”切换和设置里的快捷键
overlayStatusHandlers.unshift((st) => showMode(st && st.open));
(async () => {
  try { await listen("overlay-status", (ev) => overlayStatusHandlers.forEach((fn) => fn(ev.payload))); } catch (e) {}
  try { const st = await invoke("get_overlay_status"); overlayStatusHandlers.forEach((fn) => fn(st)); } catch (e) {}
})();
// ---------- 连接引导：还没有 iPad 连接时显示在画布中间 ----------
// v0.8.7：可以先不连 iPad、直接用鼠标写：点右上角 × 或开始在白板上写字，引导就收起（本次运行内不再弹出）
let onboardWanted = true, onboardDismissed = false;
function showOnboard(on) {
  onboardWanted = on;
  const el = document.getElementById("onboard");
  if (el) el.hidden = !on || onboardDismissed;
}
function dismissOnboard() { onboardDismissed = true; showOnboard(onboardWanted); }
document.getElementById("onb-close").addEventListener("click", dismissOnboard);
document.getElementById("onb-connect").addEventListener("click", () => document.getElementById("btn-qr").click());
invoke("get_app_info").then((info) => {
  appInfo = info || appInfo;
  document.getElementById("onb-mac").hidden = appInfo.os !== "macos";
}).catch(() => {});
showOnboard(true);

// ---------- 设置面板：屏幕画面、录屏可见、语言 ----------
(function () {
  const btn = document.getElementById("btn-settings"), pop = document.getElementById("settings-pop");
  function set(open) { pop.hidden = !open; btn.setAttribute("aria-expanded", String(open)); btn.classList.toggle("active", open); }
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(pop.hidden); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
  // “测试画面”的结果显示在画布上方：点了就收起设置面板，免得挡住结果
  document.getElementById("btn-preview-test").addEventListener("click", () => set(false));
})();

// ---------- v0.8.13：使用说明（内嵌页面，离线可用） ----------
const guideModal = document.getElementById("guide-modal");
// 说明页按当前语言显示（guide.html?lang=xx）；切换语言后下次打开重新载入
const guideSrc = () => "guide.html?lang=" + encodeURIComponent(I18N.lang());
function openGuide() {
  const f = document.getElementById("guide-frame");
  if (f.getAttribute("src") !== guideSrc()) f.setAttribute("src", guideSrc());
  guideModal.classList.remove("hidden");
  document.getElementById("guide-close").focus();
}
function closeGuide() { guideModal.classList.add("hidden"); }
document.getElementById("btn-guide").addEventListener("click", openGuide);
document.getElementById("onb-guide").addEventListener("click", openGuide);
document.getElementById("guide-close").addEventListener("click", closeGuide);
guideModal.addEventListener("click", (e) => { if (e.target === guideModal) closeGuide(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !guideModal.classList.contains("hidden")) closeGuide(); });

// ---------- 关于：版本、隐私说明、数据位置、开源组件许可 ----------
const aboutModal = document.getElementById("about-modal");
document.getElementById("btn-about").addEventListener("click", async () => {
  aboutModal.classList.remove("hidden");
  try {
    const info = await invoke("get_app_info");
    document.getElementById("about-version").textContent = T("about.version", { v: info.version });
    document.getElementById("about-data").textContent = T(info.portable ? "about.dataPortable" : "about.data", { p: info.dataDir });
  } catch (e) { document.getElementById("about-version").textContent = ""; }
  const pre = document.getElementById("about-notices");
  if (!pre.textContent) { try { pre.textContent = await invoke("get_notices"); } catch (e) {} }
});
// ---------- 授权（v0.8.6 预留接口）：激活码 / 功能解锁 ----------
// window.InkLicense.isUnlocked("export") 之类：以后按授权限制功能时，各处用它判断（当前全部解锁）
let licenseStatus = null;
window.InkLicense = {
  status: () => licenseStatus,
  isUnlocked: (feature) => !licenseStatus || !licenseStatus.enforced || (licenseStatus.features || []).indexOf(feature) >= 0
};
function showLicense(st, msgKey, params) {
  licenseStatus = st || licenseStatus;
  const s = licenseStatus, active = s && s.state === "active";
  const pill = document.getElementById("lic-state");
  if (active) I18N.bind(pill, "lic.active", { plan: (s.plan || "").toUpperCase() });
  else I18N.bind(pill, s && s.enforced ? "lic.free" : "lic.freeDev");
  pill.classList.toggle("on", !!active);
  document.getElementById("lic-form").hidden = !!active;
  document.getElementById("lic-active").hidden = !active;
  document.getElementById("lic-code-hint").textContent = active ? (s.codeHint || "") : "";
  const msg = document.getElementById("lic-msg");
  if (msgKey) I18N.bind(msg, msgKey, params); else I18N.unbind(msg, "");
}
async function refreshLicense() { try { showLicense(await invoke("get_license_status")); } catch (e) {} }
document.getElementById("lic-activate").addEventListener("click", (event) => withButton(event.currentTarget, async () => {
  const code = document.getElementById("lic-code").value;
  if (!code.trim()) { showLicense(null, "lic.empty"); return; }
  try { showLicense(await invoke("activate_license", { code }), "lic.ok"); document.getElementById("lic-code").value = ""; }
  catch (e) { showLicense(null, "lic.fail", { e: I18N.msg(e) }); }
}));
document.getElementById("lic-code").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("lic-activate").click(); });
// v0.8.7：取消激活要点两次（第一次按钮变成“再点一次确认”，4 秒内再点才执行），防止误点
let deactArmed = null;
function disarmDeactivate() {
  clearTimeout(deactArmed); deactArmed = null;
  const b = document.getElementById("lic-deactivate");
  b.classList.remove("armed"); I18N.bind(b, "lic.deactivate");
}
document.getElementById("lic-deactivate").addEventListener("click", (event) => {
  const b = event.currentTarget;
  if (!deactArmed) {
    b.classList.add("armed"); I18N.bind(b, "lic.deactivateConfirm");
    deactArmed = setTimeout(disarmDeactivate, 4000);
    return;
  }
  disarmDeactivate();
  withButton(b, async () => {
    try { showLicense(await invoke("deactivate_license"), "lic.removed"); } catch (e) { showLicense(null, "lic.fail", { e: I18N.msg(e) }); }
  });
});
document.getElementById("btn-about").addEventListener("click", refreshLicense);
refreshLicense();
document.getElementById("about-close").addEventListener("click", () => aboutModal.classList.add("hidden"));
aboutModal.addEventListener("click", (e) => { if (e.target === aboutModal) aboutModal.classList.add("hidden"); });

// ---------- 语言 ----------
// 首次按系统语言；手动选择后记住。切换时通知程序本体（托盘菜单、窗口标题、保存的文件名跟着变）
(function () {
  const sel = document.getElementById("lang-select");
  I18N.langs().forEach((l) => { const o = document.createElement("option"); o.value = l.code; o.textContent = l.name; sel.appendChild(o); });
  sel.value = I18N.lang();
  sel.addEventListener("change", () => I18N.set(sel.value));
  I18N.onChange((code) => {
    sel.value = code;
    if (lastUsage) showUsage(lastUsage);
    invoke("set_language", { lang: code }).catch(() => {});
  });
  I18N.apply();
  invoke("set_language", { lang: I18N.lang() }).catch(() => {});
})();
init().catch((e) => { I18N.unbind(document.getElementById("server-url"), T("pc.startFail", { e: I18N.msg(e) })); });
