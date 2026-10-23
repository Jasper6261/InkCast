// iPad 端（v0.6）：把 iPad 当作电脑屏幕的手写板。
//  - 屏幕标注模式（默认）：背景显示电脑屏幕画面，写在哪里，电脑屏幕最上层就出现在哪里。
//  - 白板模式：白纸书写，电脑主窗口显示。
//  - 只向电脑发送：iPad 不显示电脑端写的内容（电脑端书写不回传）。
//  - 双指缩放/平移；双指轻点 = 撤销；检测到 Apple Pencil 后手指只移动画面。
// 坐标：所有笔画用“世界坐标”0..1 存储；笔宽单位 = 世界宽度 / 1600（两端一致）。
(function () {
  "use strict";
  var WB = window.Whiteboard, Ink = window.Ink;
  var I18N = window.I18N, T = I18N.t;
  var UNIT = 1600;
  var $ = function (id) { return document.getElementById(id); };
  var bg = $("bg"), ink = $("ink"), live = $("live");
  var bgx = bg.getContext("2d"), inkx = ink.getContext("2d"), livex = live.getContext("2d");
  var connEl = $("conn"), noticeEl = $("notice"), usageEl = $("usage");

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var mode = store("wb_mode") === "board" ? "board" : "annotate";
  var token = store("wb_token") || null;

  // ---------- 工具 ----------
  // 书写画笔：英文斜体 / 中国毛笔（笔感在 iPad 上计算，可调节；参数见 BRUSHES.md）
  // v0.8.2 精简：签字笔、硬笔书法不再出现在菜单里；以它们为底的自定义画笔仍然可用
  // Procreate 复刻笔刷已从菜单移除；旧笔画仍按原样显示（ink.js 保留其渲染）
  var V2 = Ink.BRUSHES;
  var OFFICIAL = ["italic", "soft"];
  var OFFICIAL_IDS = { italic: 1, soft: 1 };
  var DEFAULT_BRUSH = OFFICIAL[0];
  var BASE_IDS = { gel05: 1, callig: 1, italic: 1, soft: 1 }; // 自定义画笔可以基于的画笔（含已下架的两支）
  // 自定义画笔（画笔工作室里“另存为新画笔”）：保存在 iPad 本地，并自动备份到电脑（data\\brushes.json）
  // 可调参数（画笔工作室）：[分组, 组内键, 名称词条, 最小, 最大, 步长, 说明词条, 栏目词条]
  var PARAMS = [
    ["dyn", "stab", "p.stab", 0, 1, 0.05, "p.stab.hint", "studio.secFeel"],
    ["dyn", "speed", "p.speed", 0, 0.7, 0.05, "p.speed.hint", "studio.secFeel"],
    ["dyn", "pFull", "p.pFull", 0.06, 0.8, 0.01, "p.pFull.hint", "studio.secPressure"],
    ["dyn", "gamma", "p.gamma", 0.4, 2.5, 0.05, "p.gamma.hint", "studio.secPressure"],
    ["dyn", "minW", "p.minW", 0, 1, 0.02, "p.minW.hint", "studio.secPressure"],
    ["render", "ratio", "p.ratio", 0.15, 1, 0.05, "p.ratio.hint", "studio.secNib"],
    ["render", "angle", "p.angle", -90, 90, 5, "p.angle.hint", "studio.secNib"],
    ["render", "ts", "p.ts", 0, 3, 0.1, "p.ts.hint", "studio.secTaper"],
    ["render", "f0", "p.f0", 0, 1, 0.02, "p.f0.hint", "studio.secTaper"],
    ["render", "te", "p.te", 0, 8, 0.1, "p.te.hint", "studio.secTaper"],
    ["render", "f1", "p.f1", 0, 1, 0.02, "p.f1.hint", "studio.secTaper"]
  ];
  function paramSpec(group, key) { for (var i = 0; i < PARAMS.length; i++) if (PARAMS[i][0] === group && PARAMS[i][1] === key) return PARAMS[i]; return null; }
  // 数值清洗：只接受有限数字，并限制在可调范围内（导入或备份里的异常值不会进入笔画）
  function cleanNum(group, key, v, fallback) {
    if (typeof v !== "number" || !isFinite(v)) return fallback;
    var sp = paramSpec(group, key);
    return sp ? Math.max(sp[3], Math.min(sp[4], v)) : v;
  }
  function loadCustoms() {
    try { var a = JSON.parse(store("wb_custom_brushes") || "[]"); return Array.isArray(a) ? a.filter(validCustom) : []; } catch (e) { return []; }
  }
  function validCustom(c) {
    return !!(c && typeof c.id === "string" && /^u_[a-z0-9]{4,20}$/.test(c.id) && typeof c.label === "string" &&
           c.label.trim().length > 0 && c.label.length <= 24 && c.dyn && typeof c.dyn === "object" &&
           c.render && typeof c.render === "object" && typeof c.base === "string" && BASE_IDS[c.base] === 1);
  }
  var customs = loadCustoms();
  function saveCustoms() { store("wb_custom_brushes", JSON.stringify(customs)); scheduleBackup(); }
  function customOf(id) { for (var i = 0; i < customs.length; i++) if (customs[i].id === id) return customs[i]; return null; }
  function allBrushIds() { return OFFICIAL.concat(customs.map(function (c) { return c.id; })); }
  var OTHER_SIZES = { marker: [10, 16, 26], eraser: [5, 10, 20] };
  function loadTune(id) { try { return JSON.parse(store("wb_tune_" + id) || "null"); } catch (e) { return null; } }
  // 当前生效的 v2 参数 = 预设 + 本机调节
  function brushParams(id) {
    var c = customOf(id);
    if (c) {
      var cd = {}, cr = {}, kk, base = V2[c.base];
      for (kk in base.dyn) cd[kk] = cleanNum("dyn", kk, c.dyn[kk], base.dyn[kk]);
      for (kk in base.render) cr[kk] = cleanNum("render", kk, c.render[kk], base.render[kk]);
      return { dyn: cd, render: cr, sizes: base.sizes };
    }
    var b = V2[id]; if (!b) return null;
    var t = loadTune(id) || {}, dyn = {}, render = {}, k;
    for (k in b.dyn) dyn[k] = cleanNum("dyn", k, t.dyn && t.dyn[k], b.dyn[k]);
    var cal = pressureCal(); if (cal && !(t.dyn && typeof t.dyn.pFull === "number")) dyn.pFull = cal; // 全局笔压校准
    for (k in b.render) render[k] = cleanNum("render", k, t.render && t.render[k], b.render[k]);
    return { dyn: dyn, render: render, sizes: b.sizes };
  }
  // 开发模式（v0.8.6）：书写诊断（发送到电脑 / 保存到 iPad）只在开发调试时用，正式版默认隐藏。
  // 打开方式：页面地址后加 ?dev=1（记住，?dev=0 关闭）
  (function () {
    var m = location.search.match(/[?&]dev=([01])/);
    if (m) { if (m[1] === "1") store("wb_dev", "1"); else { try { localStorage.removeItem("wb_dev"); } catch (e) {} } }
  })();
  function devMode() { return store("wb_dev") === "1"; }
  // 笔压校准：用这台 iPad 上最近书写的压力 95% 分位作为“写满”压力（所有自研笔刷共用，单支笔可再单独调）。
  // 生效方式：笔画粗细 = 最细比例 + (1 − 最细比例) × (压力 ÷ 写满压力)^压感曲线；写满压力变小，同样力度写出的线更粗，反之更细。
  // 样本来自本机最近 40 笔的原始 Pencil 压力（只存在 iPad 本地，不需要打开诊断功能）
  function pressureCal() { var v = parseFloat(store("wb_pcal")); return isFinite(v) && v > 0.03 && v <= 1 ? v : null; }
  function calibratePressure() {
    var ps = [];
    press.strokes.forEach(function (s) { s.forEach(function (p) { if (p > 0) ps.push(p); }); });
    if (ps.length < 200) { notice(T("cal.notEnough"), 5000); return; }
    ps.sort(function (a, b) { return a - b; });
    var p95 = Math.max(0.06, Math.min(1, ps[Math.floor(ps.length * 0.95)]));
    // 校准前“写满压力”：已有校准值，否则当前画笔的出厂值（0.22）
    var old = pressureCal() || (V2[tool.brush] ? V2[tool.brush].dyn.pFull : 0.22);
    store("wb_pcal", p95.toFixed(3));
    OFFICIAL.forEach(function (id) { var t = loadTune(id); if (t && t.dyn && "pFull" in t.dyn) { delete t.dyn.pFull; store("wb_tune_" + id, JSON.stringify(t)); } });
    customs.forEach(function (c) { c.dyn.pFull = p95; }); saveCustoms();
    notice(T("cal.done", { old: old.toFixed(2), med: ps[Math.floor(ps.length / 2)].toFixed(2), p95: p95.toFixed(2), n: ps.length }), 8000);
    buildTune();
  }
  function brushLabel(id) { var c = customOf(id); return c ? c.label : V2[id] ? T("brush." + id) : (Ink.TOOLS[id] || Ink.TOOLS.pen).label; }
  function brushSizes(id) { var c = customOf(id); return (c ? V2[c.base] : V2[id] || V2[DEFAULT_BRUSH]).sizes; }
  function brushInfo(id) {
    var c = customOf(id);
    if (c) return { use: T("brush.customUse", { base: T("brush." + c.base) }), note: c.note || T("brush.customNote") };
    return { use: T("brush." + id + ".use"), note: T("brush." + id + ".note") };
  }
  // 官方默认值：官方画笔的出厂值（写满压力优先用笔压校准值）；自定义画笔回到它所基于的官方画笔
  function officialValue(id, group, key) {
    var c = customOf(id), b = V2[c ? c.base : id];
    if (group === "dyn" && key === "pFull" && pressureCal()) return pressureCal();
    return b[group][key];
  }
  function resetParam(id, group, key) {
    var c = customOf(id);
    if (c) { c[group][key] = officialValue(id, group, key); saveCustoms(); return; }
    var t = loadTune(id); if (!t || !t[group]) return;
    delete t[group][key];
    store("wb_tune_" + id, JSON.stringify(t)); scheduleBackup();
  }
  function resetOfficial(id) { try { localStorage.removeItem("wb_tune_" + id); } catch (e) {} scheduleBackup(); }
  function isTuned(id) {
    var t = loadTune(id); if (!t) return false;
    return Object.keys(t.dyn || {}).length + Object.keys(t.render || {}).length > 0;
  }
  // 另存为新画笔：复制当前生效的全部参数
  function saveAsNew(fromId, label) {
    var bp = brushParams(fromId), c = customOf(fromId);
    var nb = { id: "u_" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36), label: label,
               base: c ? c.base : fromId, dyn: {}, render: {} };
    for (var k in bp.dyn) nb.dyn[k] = bp.dyn[k];
    for (k in bp.render) nb.render[k] = bp.render[k];
    customs.push(nb); saveCustoms();
    return nb.id;
  }
  function renameCustom(id, label) { var c = customOf(id); if (c) { c.label = label; saveCustoms(); } }
  function deleteCustom(id) {
    var c = customOf(id); if (!c) return;
    customs = customs.filter(function (x) { return x.id !== id; }); saveCustoms();
    if (tool.brush === id) { tool.brush = OFFICIAL.indexOf(c.base) >= 0 ? c.base : DEFAULT_BRUSH; store("wb_brush", tool.brush); } // 删除后回到它所基于的官方画笔
  }
  function cleanLabel(v) { return String(v || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24); }
  // 修改一项参数：官方画笔存为“本机调节”（可一键恢复官方默认）；自定义画笔直接改它自己
  function setParam(id, group, key, val) {
    var c = customOf(id);
    if (c) { c[group][key] = val; saveCustoms(); return; }
    var t = loadTune(id) || { dyn: {}, render: {} };
    t[group] = t[group] || {}; t[group][key] = val;
    store("wb_tune_" + id, JSON.stringify(t)); scheduleBackup();
  }
  // ---------- 画笔备份到电脑 ----------
  var backupTimer = null;
  function backupData() {
    var tunes = {};
    OFFICIAL.forEach(function (id) { var t = loadTune(id); if (t) tunes[id] = t; });
    return { version: 1, customs: customs, tunes: tunes, pcal: pressureCal() };
  }
  // 未成功备份的改动记一个标记（断线时改的也不会丢）：重新连接后先把本机的推给电脑，而不是用电脑的旧备份覆盖
  function scheduleBackup() {
    store("wb_brush_dirty", "1");
    clearTimeout(backupTimer);
    backupTimer = setTimeout(pushBackup, 800);
  }
  function pushBackup() { clearTimeout(backupTimer); send({ t: "brushes-save", data: JSON.stringify(backupData()) }); }
  function syncBackupOnConnect() {
    if (store("wb_brush_dirty") === "1") pushBackup(); else send({ t: "brushes-get" });
  }
  // 连接后取回电脑上的备份：本机没有的自定义画笔补回来；本机没有调节记录时恢复调节
  function restoreBackup(text) {
    var d; try { d = JSON.parse(text); } catch (e) { return; }
    if (!d || typeof d !== "object") return;
    var added = 0;
    (Array.isArray(d.customs) ? d.customs : []).forEach(function (c) { if (validCustom(c) && !customOf(c.id)) { c.label = cleanLabel(c.label); customs.push(c); added++; } });
    if (added) store("wb_custom_brushes", JSON.stringify(customs));
    var restoredTunes = 0;
    if (d.tunes && typeof d.tunes === "object") OFFICIAL.forEach(function (id) {
      if (!loadTune(id) && d.tunes[id] && typeof d.tunes[id] === "object") { store("wb_tune_" + id, JSON.stringify(d.tunes[id])); restoredTunes++; }
    });
    if (!pressureCal() && d.pcal > 0.03 && d.pcal <= 1) store("wb_pcal", String(d.pcal));
    if (added || restoredTunes) { renderBrushMenu(); updateButtons(); notice(T("studio.restoredFromPc", { n: added }) + (restoredTunes ? T("studio.restoredTunes") : ""), 4000); }
  }
  // ---------- 一键清除（v0.8.2）：一点就清，不弹确认框；误点了可以马上“撤销” ----------
  // 清除前把整板笔画存一份；撤销时用 board-load 整板发回电脑。画了新的一笔、换了模式或白板被别处整板替换后不再能撤销
  var clearUndo = null, toastTimer = null;
  function quickClear() {
    closePops();
    if (!connected) { notice(T(lastConnKey, { mode: modeLabel() }), 2500); return; }
    if (active) endStroke(null, true);
    var snap = strokes.filter(function (s) { return s.points && s.points.length; })
      .map(function (s) { return { id: s.id, color: s.color, size: s.size, tool: s.tool, points: s.points.map(function (q) { return q.slice(); }) }; });
    send(WB.clearMsg());
    clearUndo = snap.length ? { strokes: snap, mode: mode } : null;
    if (clearUndo) showUndoToast(T(mode === "annotate" ? "pad.clearedAnnotate" : "pad.clearedBoard"));
  }
  function showUndoToast(text) {
    $("undo-toast-text").textContent = text; $("undo-toast").hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { $("undo-toast").hidden = true; }, 8000);
  }
  function clearUndoDrop() { clearUndo = null; clearTimeout(toastTimer); $("undo-toast").hidden = true; }
  function restoreClear() {
    var u = clearUndo; clearUndoDrop();
    if (!u || u.mode !== mode) return;
    restoringClear = true;
    send(WB.boardLoadMsg(u.strokes));
    notice(T("pad.clearRestored"), 2500);
  }
  var restoringClear = false;
  // 撤销：刚清除过且之后什么都没画，就撤销清除；否则撤销上一笔
  function undoAction() {
    if (clearUndo && !strokes.length) { restoreClear(); return; }
    send(WB.undoMsg());
  }
  var redoStack = []; // 撤销掉的本机笔画（最多 50 笔），重做时重新发送
  function redo() {
    var r = redoStack.pop(); if (!r) return;
    var id = WB.newId ? WB.newId() : "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var s = { id: id, color: r.color, size: r.size, tool: r.tool, points: [] };
    strokes.push(s); mine[id] = true;
    send(WB.strokeStart(id, s.color, s.size, s.tool));
    r.points.forEach(function (q) { s.points.push(q.slice()); send(WB.strokePoint(id, q[0], q[1], q[2])); });
    send(WB.strokeEnd(id));
    renderInk(); renderLive(); updateButtons();
  }
  // v0.8.2：英文斜体默认 6、中国毛笔默认 9——升级时清掉这两支笔以前记住的大小，一次性回到新默认值
  // （rev 3：v0.8.2 首版连接时会被电脑端的粗细覆盖，再清一次）
  if (store("wb_sz_rev") !== "3") {
    try { localStorage.removeItem("wb_sz_italic"); localStorage.removeItem("wb_sz_soft"); } catch (e) {}
    store("wb_sz_rev", "3");
  }
  var savedBrush = store("wb_brush");
  var tool = { kind: "write", brush: allBrushIds().indexOf(savedBrush) >= 0 ? savedBrush : DEFAULT_BRUSH,
               color: "#e5484d", sizeIdx: 1, markerColor: "#f5b700" };
  function strokeTool() {
    if (tool.kind !== "write") return tool.kind;
    var bp = brushParams(tool.brush);
    return bp ? Ink.encodeTool(bp.render) : tool.brush;
  }
  var penOnly = store("wb_penonly") === "1";
  var previewOn = store("wb_preview") !== "0";

  // ---------- 状态 ----------
  var strokes = [];            // 本机写的 + 服务端快照
  var mine = {};               // 本机写的笔画 id
  var active = null;           // {stroke, pointerId, sampler}
  var ws = null, connected = false, authFailed = false, retryMs = 500;
  var aspect = mode === "annotate" ? (parseFloat(store("wb_aspect")) || 1.6) : 1.6;
  var screenImg = null;        // ImageBitmap
  var pendingMeta = null, previewTimer = null, previewWaiting = false;
  var dpr = 1, vw = 0, vh = 0, base = { x: 0, y: 0, w: 0, h: 0 }, cam = { z: 1, tx: 0, ty: 0 };

  // ---------- 布局与相机 ----------
  // 版面：顶部两组浮动工具（左：菜单 / 模式 / 画面 / 截图；右：画笔 / 荧光 / 橡皮 / 颜色），左侧大小滑条和撤销重做。
  // 画布让出顶部工具组的高度，底部只留边距（不再有底部工具条）
  var PAD_TOP = 66, PAD_BOTTOM = 8;
  function padTop() {
    var bl = document.getElementById("bar-left");
    if (bl) document.documentElement.style.setProperty("--left-w", Math.ceil(bl.getBoundingClientRect().width) + "px");
    return PAD_TOP;
  }
  function fit(resetCam) {
    dpr = window.devicePixelRatio || 1; vw = window.innerWidth; vh = window.innerHeight;
    setAppHeight();
    [bg, ink, live].forEach(function (c) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); });
    var top = padTop(), w = vw - 16, h = vh - top - PAD_BOTTOM;
    if (w / h > aspect) w = h * aspect; else h = w / aspect;
    base = { x: (vw - w) / 2, y: top + (vh - top - PAD_BOTTOM - h) / 2, w: w, h: h };
    if (resetCam || !cam.init) cam = { z: 1, tx: base.x, ty: base.y, init: true };
    redrawAll();
  }
  window.addEventListener("resize", function () { fit(false); });
  // 面板高度按“实际看得见的高度”算：iPad 浏览器的地址栏、工具栏会占掉一部分，100vh 比可见区域高，
  // 面板底部就会藏在浏览器栏后面滚不到。这里用可见视口的高度（地址栏收起/展开时也跟着更新）
  function setAppHeight() {
    var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-h", Math.round(Math.min(h, window.innerHeight)) + "px");
  }
  if (window.visualViewport) window.visualViewport.addEventListener("resize", setAppHeight);
  function worldW() { return base.w * cam.z; }
  function worldH() { return base.h * cam.z; }
  function xf() { return { sx: worldW() * dpr, sy: worldH() * dpr, ox: cam.tx * dpr, oy: cam.ty * dpr, s: worldW() * dpr / UNIT }; }
  function toWorld(cx, cy) { return [(cx - cam.tx) / worldW(), (cy - cam.ty) / worldH()]; }

  // ---------- 渲染 ----------
  var rafPending = false;
  function schedule() { if (!rafPending) { rafPending = true; requestAnimationFrame(function (ts) {
    rafPending = false;
    var t0 = performance.now(); renderLive();
    if (diag.cur) diag.cur.frames.push([+(ts - diag.cur.t0).toFixed(1), +(performance.now() - t0).toFixed(2)]);
  }); } }

  // ---------- 书写诊断：记录最近若干笔的原始 Pencil 事件，发到电脑保存，用于分析手感问题 ----------
  var diag = { strokes: [], cur: null, waiting: null, saveTimer: null };
  // v0.8.11：只在开发模式（?dev=1）记录。以前正式版也在记：每一笔抬笔时把最近 40 笔的全部原始事件（可达数 MB）
  // 序列化写进本地存储，iPad 上每次抬笔都要卡一下——橡皮来回擦（一下一下抬笔）时最明显；还会占满本地存储
  // 最近的诊断笔画也存一份在 iPad 本地，刷新页面后仍可发送（开发模式）
  var savedDiag = [];
  try { savedDiag = JSON.parse(localStorage.getItem("wb_diag") || "[]"); if (!Array.isArray(savedDiag)) savedDiag = []; } catch (e) { savedDiag = []; }
  if (devMode()) diag.strokes = savedDiag; else { try { localStorage.removeItem("wb_diag"); } catch (e) {} }
  // “按我的笔压校准”用的笔压样本：正式版也记，但只记笔压数字（每笔最多 400 个、最近 40 笔），停笔 2 秒后才存
  var press = { strokes: [], cur: null, timer: null };
  try { var savedPress = JSON.parse(localStorage.getItem("wb_press") || "[]"); if (Array.isArray(savedPress)) press.strokes = savedPress.slice(-40); } catch (e) {}
  // 旧版本存过诊断数据：先把其中的笔压取出来，校准不用从头写
  if (!press.strokes.length) savedDiag.slice(-40).forEach(function (s) {
    var ps = (s && s.ev || []).filter(function (e) { return e[4] === 1 && e[3] > 0; }).map(function (e) { return e[3]; }).slice(0, 400);
    if (ps.length) press.strokes.push(ps);
  });
  savedDiag = null;
  function diagStart(e) {
    press.cur = [];
    if (!devMode()) return;
    diag.cur = { t0: e.timeStamp || performance.now(), wall: Date.now(), brush: tool.kind === "write" ? tool.brush : tool.kind,
                 tool: active.stroke.tool, size: active.stroke.size, zoom: +cam.z.toFixed(3), worldW: +worldW().toFixed(1),
                 dpr: dpr, moves: 0, coalesced: 0, ev: [], frames: [] };
  }
  function diagEvent(ev) {
    if (press.cur && ev.pointerType === "pen" && ev.pressure > 0 && press.cur.length < 400) press.cur.push(+ev.pressure.toFixed(4));
    if (!diag.cur || diag.cur.ev.length > 6000) return;
    diag.cur.ev.push([+((ev.timeStamp || performance.now()) - diag.cur.t0).toFixed(2), +ev.clientX.toFixed(2), +ev.clientY.toFixed(2),
                      +(ev.pressure || 0).toFixed(4), ev.pointerType === "pen" ? 1 : 0, ev.tiltX || 0, ev.tiltY || 0]);
  }
  function diagEnd() {
    if (press.cur && press.cur.length) {
      press.strokes.push(press.cur); if (press.strokes.length > 40) press.strokes.shift();
      clearTimeout(press.timer);
      press.timer = setTimeout(function () { try { localStorage.setItem("wb_press", JSON.stringify(press.strokes)); } catch (e) {} }, 2000);
    }
    press.cur = null;
    if (!diag.cur || !active) return;
    diag.cur.sent = active.stroke.points.map(function (p) { return [+p[0].toFixed(5), +p[1].toFixed(5), p[2]]; });
    diag.strokes.push(diag.cur); if (diag.strokes.length > 40) diag.strokes.shift();
    diag.cur = null;
    // 写本地存储放到停笔 2 秒后，不在抬笔的那一刻做
    clearTimeout(diag.saveTimer);
    diag.saveTimer = setTimeout(function () {
      try { localStorage.setItem("wb_diag", JSON.stringify(diag.strokes)); }
      catch (e) { try { localStorage.setItem("wb_diag", JSON.stringify(diag.strokes.slice(-10))); } catch (e2) {} }
    }, 2000);
  }
  function sendDiag() {
    if (!diag.strokes.length) { notice(T("diag.noStrokes"), 4000); return; }
    var d = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
    var report = {
      version: 1, ua: navigator.userAgent, dpr: window.devicePixelRatio, view: [innerWidth, innerHeight],
      coalescedApi: typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype,
      predictedApi: typeof PointerEvent !== "undefined" && "getPredictedEvents" in PointerEvent.prototype,
      mode: mode, aspect: aspect, brushParams: brushParams(tool.brush), strokes: diag.strokes
    };
    var name = d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds());
    var data = JSON.stringify(report);
    lastDiag = { name: name, data: data };
    if (!ws || ws.readyState !== WebSocket.OPEN || !connected) {
      notice(T("diag.offline"), 8000); return;
    }
    send({ t: "save-diag", name: name, data: data });
    notice(T("diag.sending", { n: diag.strokes.length, kb: Math.round(data.length / 1024) }), 10000);
    clearTimeout(diag.waiting);
    diag.waiting = setTimeout(function () { notice(T("diag.noReply"), 10000); }, 8000);
  }
  var lastDiag = null;
  // 备用：在 iPad 上存成文件（Safari 会弹出下载，存到“文件”App，可隔空投送到电脑）
  function saveDiagLocal() {
    if (!lastDiag) { sendDiagPrepare(); }
    if (!lastDiag) return;
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lastDiag.data], { type: "application/json" }));
    a.download = T("diag.fileName") + "-" + lastDiag.name + ".json";
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  function sendDiagPrepare() {
    if (!diag.strokes.length) { notice(T("diag.noStrokes"), 4000); return; }
    var d = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
    lastDiag = { name: d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()),
                 data: JSON.stringify({ version: 1, ua: navigator.userAgent, dpr: window.devicePixelRatio, view: [innerWidth, innerHeight],
                   coalescedApi: typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype,
                   predictedApi: typeof PointerEvent !== "undefined" && "getPredictedEvents" in PointerEvent.prototype,
                   mode: mode, aspect: aspect, brushParams: brushParams(tool.brush), strokes: diag.strokes }) };
  }
  function renderBg() {
    bgx.setTransform(1, 0, 0, 1, 0, 0);
    bgx.fillStyle = "#1d1d20"; bgx.fillRect(0, 0, bg.width, bg.height);
    var x = cam.tx * dpr, y = cam.ty * dpr, w = worldW() * dpr, h = worldH() * dpr;
    if (mode === "board") { bgx.fillStyle = "#ffffff"; bgx.fillRect(x, y, w, h); return; }
    if (previewOn && screenImg) { bgx.imageSmoothingQuality = "high"; bgx.drawImage(screenImg, x, y, w, h); }
    else { bgx.fillStyle = "#f4f4f6"; bgx.fillRect(x, y, w, h); }
    bgx.strokeStyle = "rgba(62,142,247,.6)"; bgx.lineWidth = 1; bgx.strokeRect(x + .5, y + .5, w - 1, h - 1);
  }
  // 电脑端正在写的笔画（还没收笔，不画收笔锋）；每帧最多重画一次书写层
  var remoteOpen = {}, remoteErased = {}, inkPending = false;
  function scheduleInk() {
    if (inkPending) return; inkPending = true;
    requestAnimationFrame(function () { inkPending = false; renderInk(); });
  }
  function renderInk() {
    inkx.setTransform(1, 0, 0, 1, 0, 0); inkx.clearRect(0, 0, ink.width, ink.height);
    var t = xf();
    for (var i = 0; i < strokes.length; i++) if (!active || strokes[i] !== active.stroke) Ink.drawStroke(inkx, strokes[i], t, !remoteOpen[strokes[i].id]);
    // 正在擦：整层重画后把这一笔已经擦过的部分重新擦一遍
    if (active && active.stroke.tool === "eraser") { active.erased = 0; eraseStep(); }
    // 电脑上正在擦的橡皮：整层重画时已经按目前的点画过，之后从这里接着增量擦
    for (var k in remoteOpen) { var rs = strokes.filter(function (x) { return x.id === k; })[0]; if (rs && rs.tool === "eraser") remoteErased[k] = rs.points.length; }
  }
  // 橡皮擦增量擦除（v0.8.2）：以前每一帧都把所有笔画整层重画一遍再擦，笔画一多 iPad 就跟不上，橡皮“卡顿”；
  // 现在只把新增的几段直接从书写层上擦掉，每帧的工作量和笔画多少无关
  function eraseStep() { active.erased = Ink.eraseSegment(inkx, active.stroke, xf(), active.erased); }
  // 橡皮范围圈：画在书写层之上，看得到擦的范围
  function drawEraserRing() {
    var pts = active.stroke.points; if (!pts.length) return;
    var t = xf(), p = pts[pts.length - 1], r = Math.max(0.5, (active.stroke.size || 4) * t.s), x = p[0] * t.sx + t.ox, y = p[1] * t.sy + t.oy;
    livex.save(); livex.lineWidth = 1.5 * dpr;
    livex.beginPath(); livex.arc(x, y, r, 0, Math.PI * 2); livex.strokeStyle = "rgba(255,255,255,.9)"; livex.stroke();
    livex.beginPath(); livex.arc(x, y, r + 1.5 * dpr, 0, Math.PI * 2); livex.strokeStyle = "rgba(0,0,0,.45)"; livex.stroke();
    livex.restore();
  }
  function renderLive() {
    livex.setTransform(1, 0, 0, 1, 0, 0); livex.clearRect(0, 0, live.width, live.height);
    if (!active) return;
    if (active.stroke.tool === "eraser") { eraseStep(); drawEraserRing(); return; }
    // 书写中：已发送的点 + 本地临时尾巴（还没定稿的最后几个采样），笔迹始终贴着笔尖
    var tail = active.input.tail().map(worldPoint);
    var view = tail.length ? { id: active.stroke.id + "-live", color: active.stroke.color, size: active.stroke.size, tool: active.stroke.tool,
                               points: active.stroke.points.concat(tail) } : active.stroke;
    Ink.drawStroke(livex, view, xf(), false);
    drawPrediction(view.points);
  }
  // 预测点：浏览器根据笔的运动预测接下来 1–2 帧的位置，只画在书写层上（不发送、不保存），
  // 让笔迹“追上”笔尖，弥补网页 60Hz 绘制的延迟（Procreate 也用同样的做法）
  function drawPrediction(pts) {
    var pr = active && active.pred;
    if (!pr || !pr.length || !pts.length || active.stroke.tool === "eraser") return;
    var last = pts[pts.length - 1], t = xf();
    var lw = Math.max(0.7 * dpr, (last[2] || 0.5) * active.stroke.size * t.s * (Ink.specOf(active.stroke.tool) ? 1 : 0.8));
    livex.save();
    livex.strokeStyle = active.stroke.color; livex.lineWidth = lw; livex.lineCap = livex.lineJoin = "round";
    livex.globalAlpha = (Ink.toolOf(active.stroke).alpha || 1);
    livex.beginPath(); livex.moveTo(last[0] * t.sx + t.ox, last[1] * t.sy + t.oy);
    pr.forEach(function (q) { livex.lineTo(q[0] * dpr, q[1] * dpr); });
    livex.stroke(); livex.restore();
  }
  function redrawAll() { renderBg(); renderInk(); renderLive(); }

  var lastConnKey = "conn.connecting";
  function setConn(on, key) {
    connected = on; lastConnKey = key;
    if (key === "conn.connected") I18N.bind(connEl, key, { mode: modeLabel() }); else I18N.bind(connEl, key);
    connEl.classList.toggle("on", on);
  }
  var noticeTimer = null;
  function notice(text, ms) {
    noticeEl.textContent = text || "";
    clearTimeout(noticeTimer);
    if (text && ms) noticeTimer = setTimeout(function () { noticeEl.textContent = ""; }, ms);
  }
  var lastUsageMsg = null;
  function showUsage(msg) {
    lastUsageMsg = msg;
    var n = WB.usageNotice(msg); usageEl.textContent = n.text; usageEl.dataset.level = n.level; usageEl.hidden = !n.text;
  }
  function modeLabel() { return T(mode === "annotate" ? "pad.modeAnnotate" : "pad.modeBoard"); }

  // ---------- 网络 ----------
  function send(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
  function connect() {
    setConn(false, "conn.connecting");
    var url = "ws://" + location.host + "/ws?role=pad" + (mode === "annotate" ? "&board=overlay" : "");
    var sock = new WebSocket(url);
    sock.binaryType = "blob";
    ws = sock;
    sock.onopen = function () { retryMs = 500; pairIfNeeded(function () { send({ t: "hello", token: token }); }); };
    sock.onmessage = function (ev) { if (sock === ws) onMessage(ev.data); };
    sock.onclose = function () {
      if (sock !== ws) return;
      ws = null; active = null; previewWaiting = false; clearTimeout(previewTimer);
      setConn(false, authFailed ? "conn.pairExpired" : "conn.reconnecting");
      if (authFailed) return;
      setTimeout(connect, retryMs);
      retryMs = Math.min(10000, retryMs * 2) * (0.8 + Math.random() * 0.4);
    };
    sock.onerror = function () { try { sock.close(); } catch (e) {} };
  }

  function onMessage(data) {
    if (typeof data !== "string") { onFrame(data); return; }
    var msg; try { msg = JSON.parse(data); } catch (e) { return; }
    switch (msg.t) {
      case "auth":
        if (!msg.ok) { authFailed = true; setConn(false, "conn.authFail"); try { ws.close(); } catch (e) {} }
        return;
      case "welcome": setConn(false, "conn.syncing"); return;
      case "full-state":
        if (restoringClear) restoringClear = false; else clearUndoDrop(); // 白板被整板替换（打开存档、重新连接）后不能再撤销清除
        active = null; mine = {}; remoteOpen = {}; remoteErased = {}; redoStack = []; $("btn-redo").disabled = true;
        WB.applyMessage(strokes, msg);
        strokes.forEach(function (s) { mine[s.id] = true; });
        setConn(true, "conn.connected");
        announceSize(); // 连接后把 iPad 当前画笔的大小告诉电脑（不再从电脑取一个不分画笔的大小）
        syncBackupOnConnect();
        redrawAll();
        if (mode === "annotate") requestPreview(true, 0);
        return;
      case "board-usage": {
        showUsage(msg); return;
      }
      case "stroke-rejected": case "stroke-truncate":
        if (active && active.stroke.id === msg.id) { send(WB.strokeEnd(msg.id)); active = null; }
        WB.applyMessage(strokes, msg); renderInk(); renderLive();
        notice(T("stroke.stopped", { r: msg.reason ? I18N.msg(msg.reason) : T("stroke.limit") }), 5000);
        return;
      case "error": notice(T("pad.opRejected", { m: I18N.msg(msg.message || "") }), 5000); return;
      case "undo": case "clear":
        if (active && (msg.t === "clear" || msg.id === active.stroke.id)) active = null;
        if (msg.t === "clear") { redoStack = []; $("btn-redo").disabled = true; }
        else if (msg.id && mine[msg.id]) {
          var undone = strokes.filter(function (x) { return x.id === msg.id; })[0];
          if (undone && undone.points.length) { redoStack.push({ color: undone.color, size: undone.size, tool: undone.tool, points: undone.points.slice() }); if (redoStack.length > 50) redoStack.shift(); updateButtons(); }
        }
        if (WB.applyMessage(strokes, msg).changed) { renderInk(); renderLive(); refreshSoon(); }
        return;
      case "preview-meta":
        pendingMeta = msg;
        frameInk = !!msg.ink;
        if (frameInk && !inkNoticeShown) { inkNoticeShown = true; notice(T("pad.inkInFrame"), 9000); }
        if (!frameInk) inkNoticeShown = false;
        return;
      case "preview-same": previewWaiting = false; requestPreview(false, 700); return;
      case "preview-off":
        previewWaiting = false; notice(T("pad.previewOff"), 4000); requestPreview(false, 3000); return;
      case "preview-error":
        previewWaiting = false; notice(T("pad.previewError", { m: I18N.msg(msg.message || "") }), 4000); requestPreview(false, 3000); return;
      case "shot-saved": notice(T("pad.shotSaved", { p: msg.path }), 6000); return;
      case "shot-error": notice(T("pad.shotError", { m: I18N.msg(msg.message || "") }), 6000); return;
      case "pen-size": onRemoteSize(+msg.size, msg.brush); return;
      case "brushes": if (typeof msg.data === "string") restoreBackup(msg.data); return;
      case "brushes-saved": try { localStorage.removeItem("wb_brush_dirty"); } catch (e) {} return;
      case "brushes-error": return; // 电脑端不保存（例如开发环境），本机数据不受影响
      case "diag-saved": clearTimeout(diag.waiting); notice(T("diag.saved", { p: msg.path }), 10000); return;
      case "diag-error": clearTimeout(diag.waiting); notice(T("diag.error", { m: I18N.msg(msg.message || "") }), 10000); return;
      // v0.8.9：电脑切换了“屏幕 | 白板”，iPad 跟着切
      case "pc-mode":
        if ((msg.mode === "annotate" || msg.mode === "board") && msg.mode !== mode) {
          if (active) endStroke(null, true);
          switchMode(true);
          notice(T(mode === "annotate" ? "pad.pcSwitchedScreen" : "pad.pcSwitchedBoard"), 2500);
        }
        return;
      // v0.8.4：电脑端（主窗口鼠标 / 屏幕标注层）写的笔画也显示在 iPad 上
      case "stroke-start": case "stroke-point": case "stroke-end": {
        if (msg.t === "stroke-start") remoteOpen[msg.id] = true;
        else if (msg.t === "stroke-end") {
          if (remoteOpen[msg.id]) {
            delete remoteOpen[msg.id];
            var es = strokes.filter(function (x) { return x.id === msg.id; })[0];
            if (es && es.tool === "eraser" && !inkPending) { Ink.eraseSegment(inkx, es, xf(), remoteErased[msg.id] || 0); }
            else scheduleInk();
            if (es && es.tool === "eraser") refreshSoon();
            delete remoteErased[msg.id];
          }
          return;
        }
        var r = WB.applyMessage(strokes, msg);
        if (r.changed) {
          // v0.8.9：电脑上用橡皮擦——只擦新增的几段，不整层重画（整层重画在笔画多时会明显延迟）
          if (msg.t === "stroke-start" && msg.tool === "eraser") { remoteErased[msg.id] = 0; }
          else if (msg.t === "stroke-point" && r.stroke && r.stroke.tool === "eraser" && remoteOpen[msg.id] && !inkPending) {
            remoteErased[msg.id] = Ink.eraseSegment(inkx, r.stroke, xf(), remoteErased[msg.id] || 0);
          } else scheduleInk();
        }
        return;
      }
      default: return;
    }
  }

  // ---------- 屏幕画面 ----------
  function requestPreview(force, delay) {
    clearTimeout(previewTimer);
    if (mode !== "annotate" || !previewOn) return;
    previewTimer = setTimeout(function () {
      if (!connected || previewWaiting) return;
      if (busyWriting()) { requestPreview(force, 300); return; } // 书写 / 擦除中（含刚抬笔的一会儿）不刷新画面
      previewWaiting = true;
      var w = Math.min(2560, Math.ceil(worldW() * dpr * Math.min(cam.z, 2) / cam.z));
      send({ t: "preview-req", w: Math.max(640, w), force: !!force });
    }, delay || 0);
  }
  // v0.8.10：电脑画面在变化时，每张新画面（1–2 MB）解码、重画背景都要占用 iPad 一段时间；
  // 如果正好在擦除 / 书写，笔迹就会一顿一顿（橡皮来回擦时最明显）。现在书写中和抬笔后 1.2 秒内不请求新画面，
  // 已经在路上的画面也等抬笔后再换上
  var PREVIEW_QUIET_MS = 1200;
  // v0.8.12：电脑开着“录屏/共享时显示标注”时，发来的屏幕画面里本身就带着标注（ink: true）。
  // 在 iPad 上擦掉 / 撤销后，本机笔迹层已经清掉，但背景画面里的那份还在，要等下一张画面才消失——
  // 看起来就是“落笔不会马上擦除”。这种情况下抬笔就换画面，擦除 / 撤销 / 清除后立即要一张新画面
  var frameInk = false, inkNoticeShown = false;
  function refreshSoon() { if (frameInk) requestPreview(false, 120); }
  function busyWriting() { return !!active || penDown || (!frameInk && performance.now() - penUpAt < PREVIEW_QUIET_MS); }
  function onFrame(blob) {
    var meta = pendingMeta; pendingMeta = null;
    applyFrame(blob, meta);
  }
  function applyFrame(blob, meta) {
    if (busyWriting()) { setTimeout(function () { applyFrame(blob, meta); }, 250); return; }
    previewWaiting = false;
    createImageBitmap(blob).then(function (img) {
      if (screenImg && screenImg.close) screenImg.close();
      screenImg = img;
      if (meta && meta.w && meta.h) {
        var a = meta.w / meta.h;
        if (Math.abs(a - aspect) > 0.005) { aspect = a; store("wb_aspect", String(a)); fit(true); }
      }
      renderBg();
      requestPreview(false, 600);
    }).catch(function () { requestPreview(false, 1500); });
  }

  // ---------- 配对 ----------
  function pairIfNeeded(done) {
    var m = location.hash.match(/#p=([A-Za-z0-9_-]+)/);
    var code = m && m[1];
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    if (!code) { done(); return; }
    setConn(false, "conn.pairing");
    fetch("/api/pair", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pairCode: code }) })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (j) { token = j.token; store("wb_token", token); done(); })
      .catch(function () { setConn(false, "conn.pairFail"); });
  }

  // ---------- 书写 ----------
  // 笔头大小：每支笔各自记住（世界单位 = 画布宽 / 1600），左侧滑条无级调节，对数刻度
  // 范围与电脑端主窗口、标注层的“粗细”滑条一致（1–48）；书写笔的大小与电脑端双向同步
  var SIZE_RANGE = { write: [1, 48], marker: [4, 96], eraser: [3, 96] };
  function sizeKey() { return tool.kind === "write" ? tool.brush : tool.kind; }
  function sizeRange() { return SIZE_RANGE[tool.kind === "write" ? "write" : tool.kind]; }
  function currentSize() {
    var v = parseFloat(store("wb_sz_" + sizeKey())), r = sizeRange();
    if (!(v >= r[0] && v <= r[1])) v = (tool.kind === "write" ? brushSizes(tool.brush) : OTHER_SIZES[tool.kind])[1];
    return v;
  }
  var sizeSendTimer = null;
  function setSize(v, fromRemote) {
    var r = sizeRange(); v = Math.max(r[0], Math.min(r[1], v)); store("wb_sz_" + sizeKey(), v.toFixed(2)); updateSizeBar();
    if (!fromRemote) announceSize();
  }
  function announceSize() {
    if (tool.kind !== "write") return;
    clearTimeout(sizeSendTimer);
    sizeSendTimer = setTimeout(function () { send({ t: "pen-size", size: Math.round(currentSize() * 100) / 100, brush: tool.brush }); }, 60);
  }
  // 电脑端调整了某支画笔的粗细：只改那一支（v0.8.2 起消息带画笔名）。
  // 不带画笔名的旧消息一律忽略——以前连接时会把电脑上的粗细套到 iPad 当前画笔上，默认大小因此“改不过来”
  function onRemoteSize(v, brush) {
    if (!(v > 0) || !brush || allBrushIds().indexOf(brush) < 0) return;
    var r = SIZE_RANGE.write; v = Math.max(r[0], Math.min(r[1], v));
    store("wb_sz_" + brush, v.toFixed(2));
    if (tool.kind === "write" && tool.brush === brush) updateSizeBar();
  }
  var sizeTrack = $("size-track"), sizeThumb = $("size-thumb"), sizeFill = $("size-fill"), sizeVal = $("size-val"), sizePrev = $("size-preview");
  // 数值输入（v0.8.4）：点数字可以直接输入大小，回车或点别处生效；超出范围自动限制
  function fmtSize(v) { var r = Math.round(v * 10) / 10; return r < 10 ? r.toFixed(1) : String(r); }
  function commitSizeInput() {
    var v = parseFloat(String(sizeVal.value).replace(",", "."));
    if (isFinite(v) && v > 0) setSize(v); else updateSizeBar();
  }
  sizeVal.addEventListener("change", commitSizeInput);
  sizeVal.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitSizeInput(); sizeVal.blur(); } });
  sizeVal.addEventListener("focus", function () { try { sizeVal.select(); } catch (e) {} });
  function updateSizeBar() {
    var r = sizeRange(), v = currentSize(), t = Math.log(v / r[0]) / Math.log(r[1] / r[0]);
    sizeThumb.style.top = ((1 - t) * 100) + "%"; sizeFill.style.height = (t * 100) + "%";
    if (document.activeElement !== sizeVal) sizeVal.value = fmtSize(v);
    var px = Math.max(1, v * worldW() / UNIT * (tool.kind === "eraser" ? 2 : 1));
    var dot = sizePrev.firstChild; dot.style.width = dot.style.height = Math.min(110, px) + "px";
    dot.style.background = tool.kind === "eraser" ? "#bbb" : (tool.kind === "marker" ? tool.markerColor : tool.color);
  }
  (function () {
    var dragging = null;
    function apply(e) {
      var b = sizeTrack.getBoundingClientRect(), t = 1 - Math.max(0, Math.min(1, (e.clientY - b.top) / b.height)), r = sizeRange();
      setSize(r[0] * Math.pow(r[1] / r[0], t));
    }
    $("sizebar").addEventListener("pointerdown", function (e) {
      e.preventDefault(); dragging = e.pointerId; try { $("sizebar").setPointerCapture(e.pointerId); } catch (err) {}
      sizePrev.hidden = false; apply(e);
    });
    $("sizebar").addEventListener("pointermove", function (e) { if (dragging === e.pointerId) apply(e); });
    function end(e) { if (dragging === e.pointerId) { dragging = null; sizePrev.hidden = true; } }
    $("sizebar").addEventListener("pointerup", end);
    $("sizebar").addEventListener("pointercancel", end);
  })();
  function startStroke(e, pts) {
    var id = WB.newId();
    var color = tool.kind === "marker" ? tool.markerColor : tool.color;
    var s = { id: id, color: color, size: currentSize(), tool: strokeTool(), points: [] };
    if (redoStack.length) { redoStack = []; updateButtons(); } // 写了新笔画后不能再重做
    strokes.push(s); mine[id] = true;
    clearUndoDrop();
    active = { stroke: s, pointerId: e.pointerId, sampler: WB.pointSampler(), lastP: null, erased: 0,
               input: tool.kind === "write" && brushParams(tool.brush) ? Ink.Input(brushParams(tool.brush).dyn)
                      : tool.kind === "eraser" ? Ink.Input({ stab: 0 }, { rawPressure: true, R: 0 }) // 橡皮：不平滑、不延迟
                      : Ink.Input({ stab: 0.3 }, { rawPressure: true }) }; // 荧光笔：只做去重和平滑，压力原样
    send(WB.strokeStart(id, s.color, s.size, s.tool));
    diagStart(e);
    (pts || [e]).forEach(function (ev) { addEventPoint(ev, false); });
    schedule();
  }
  function pushPoint(pt) { active.stroke.points.push(pt); send(WB.strokePoint(active.stroke.id, pt[0], pt[1], pt[2])); }
  // 笔感层输出的屏幕点 → 画布坐标；经过抽稀后发送
  function worldPoint(q) {
    var w = toWorld(q[0], q[1]);
    return [Math.min(1, Math.max(0, w[0])), Math.min(1, Math.max(0, w[1])), Math.round(q[2] * 1000) / 1000];
  }
  function emitPoints(list, forceLast) {
    for (var i = 0; i < list.length; i++) {
      var q = list[i], pt = WB.samplePoint(active.sampler, worldPoint(q), q[0], q[1], forceLast && i === list.length - 1);
      if (pt) pushPoint(pt);
    }
  }
  function addEventPoint(ev, ending) {
    if (!active) return;
    diagEvent(ev);
    // 先过笔感层（去重 + 居中平滑 + 压感曲线 + 速度），把宽度系数烘焙进第三个值；定稿的点才发送
    var raw = null;
    if (ev.pointerType === "pen" && active.stroke.tool !== "eraser") { // 橡皮宽度不随压力变化，不传压力也减少要发送的点
      if (ev.pressure > 0) { active.lastP = ev.pressure; pressureReadout(ev.pressure); }
      raw = ev.pressure > 0 ? ev.pressure : (active.lastP || 0.15);
    }
    emitPoints(active.input.add(ev.clientX, ev.clientY, raw, ev.timeStamp || performance.now()), false);
  }
  function endStroke(e, cancelled) {
    if (!active) return;
    if (e && !cancelled) addEventPoint(e, true);
    if (!active) return;
    // 抬笔：剩下的点按收窄的窗口定稿，最后一点正好落在笔尖
    if (!cancelled) emitPoints(active.input.finish(), true);
    var tail = WB.flushPoint(active.sampler);
    if (tail) pushPoint(tail);

    send(WB.strokeEnd(active.stroke.id));
    diagEnd();
    if (active.stroke.tool === "eraser") eraseStep();
    var s = active.stroke; active = null;
    // 橡皮：增量擦除已经完成，这里只按最终形状补擦一遍（只画这一笔，不再整层重画）
    Ink.drawStroke(inkx, s, xf(), true);
    renderLive();
    requestPreview(false, 300);
    if (s.tool === "eraser") refreshSoon();
  }

  // 触控手势：双指缩放/平移、双指轻点撤销；手指书写会先等一小会儿，判断是不是要双指
  var touches = {}, gesture = null, pendingTouch = null;
  // 防误触（掌托）：Pencil 在纸上、或刚抬笔 0.5 秒内，所有手指/手掌触点一律忽略——
  // 否则手掌搭在屏幕上会被当成双指缩放/平移，书写中画布被移动，笔迹看起来“乱飘”
  var penDown = false, penUpAt = -1e9, PALM_GRACE_MS = 500, ignoredTouches = {};
  function palmGuard() { return penDown || performance.now() - penUpAt < PALM_GRACE_MS; }
  // 手掌接触面大（CSS 像素）。v0.8.5：原来按 44 判断，但 iPad 上普通手指的接触面就有 40–60，
  // 手指被当成手掌忽略，双指手势因此全部失效；手掌通常在 100 以上
  var PALM_PX = 100;
  function isPalm(e) { return (e.width || 0) > PALM_PX || (e.height || 0) > PALM_PX; }
  function touchCount() { return Object.keys(touches).length; }
  function beginGesture() {
    var ids = Object.keys(touches);
    if (ids.length < 2) return;
    var a = touches[ids[0]], b = touches[ids[1]];
    var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    gesture = { ids: [ids[0], ids[1]], d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: cam.z, wx: (cx - cam.tx) / worldW(), wy: (cy - cam.ty) / worldH(),
                t0: performance.now(), moved: 0, cx0: cx, cy0: cy };
  }
  function updateGesture() {
    var a = touches[gesture.ids[0]], b = touches[gesture.ids[1]];
    if (!a || !b) return;
    var cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.hypot(a.x - b.x, a.y - b.y);
    gesture.moved = Math.max(gesture.moved, Math.abs(d - gesture.d0), Math.hypot(cx - gesture.cx0, cy - gesture.cy0));
    cam.z = Math.min(8, Math.max(1, gesture.z0 * d / gesture.d0));
    cam.tx = cx - gesture.wx * worldW(); cam.ty = cy - gesture.wy * worldH();
    scheduleFull();
  }
  var fullPending = false;
  function scheduleFull() { if (!fullPending) { fullPending = true; requestAnimationFrame(function () { fullPending = false; redrawAll(); }); } }
  function panBy(dx, dy) { cam.tx += dx; cam.ty += dy; scheduleFull(); }

  live.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    if (e.pointerType === "pen") {
      if (!penOnly) { penOnly = true; store("wb_penonly", "1"); updateButtons(); }
      penDown = true;
      // 笔落下时冻结画布：结束任何手势，已有触点都视为手掌
      if (gesture || touchCount()) { Object.keys(touches).forEach(function (k) { ignoredTouches[k] = true; }); touches = {}; gesture = null; }
      if (pendingTouch) { clearTimeout(pendingTouch.timer); pendingTouch = null; }
      if (!connected || active) return;
      try { live.setPointerCapture(e.pointerId); } catch (err) {}
      startStroke(e);
      return;
    }
    if (e.pointerType === "mouse") return;
    if (palmGuard() || isPalm(e)) { ignoredTouches[e.pointerId] = true; return; }
    touches[e.pointerId] = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY };
    if (touchCount() >= 2) {
      if (gesture) return; // 第三根手指：不改变正在进行的双指手势
      if (pendingTouch) { clearTimeout(pendingTouch.timer); pendingTouch = null; }
      if (active && active.pointerId !== undefined && touches[active.pointerId]) {
        // 手指刚开始的一笔被第二根手指打断：作废这一笔
        var id = active.stroke.id; send(WB.strokeEnd(id)); active = null; send({ t: "undo" }); renderLive();
      }
      beginGesture(); return;
    }
    if (penOnly || !connected) return; // 只认笔：单指只用于平移
    var evs = [e];
    pendingTouch = { id: e.pointerId, evs: evs, timer: setTimeout(function () {
      if (pendingTouch && pendingTouch.id === e.pointerId && touchCount() === 1) { var p = pendingTouch; pendingTouch = null; startStroke(e, p.evs); }
    }, 70) };
  });
  live.addEventListener("pointermove", function (e) {
    if (e.pointerType === "pen") {
      if (!active || active.pointerId !== e.pointerId) return;
      var evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      if (!evs.length) evs = [e];
      if (diag.cur) { diag.cur.moves++; diag.cur.coalesced += evs.length; }
      for (var i = 0; i < evs.length; i++) addEventPoint(evs[i], false);
      if (active) {
        var pe = typeof e.getPredictedEvents === "function" ? e.getPredictedEvents() : [];
        active.pred = pe.slice(0, 3).map(function (q) { return [q.clientX, q.clientY]; });
      }
      schedule(); return;
    }
    var t = touches[e.pointerId];
    if (!t) return;
    if (palmGuard()) return; // 书写中不移动画布
    t.x = e.clientX; t.y = e.clientY;
    if (gesture) { updateGesture(); return; }
    if (pendingTouch && pendingTouch.id === e.pointerId) {
      pendingTouch.evs.push(e);
      var f = pendingTouch.evs[0];
      if (Math.hypot(e.clientX - f.clientX, e.clientY - f.clientY) > 8) { var p = pendingTouch; clearTimeout(p.timer); pendingTouch = null; startStroke(e, p.evs); }
      return;
    }
    if (active && active.pointerId === e.pointerId) {
      var ce = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
      if (!ce.length) ce = [e];
      for (var j = 0; j < ce.length; j++) addEventPoint(ce[j], false);
      schedule(); return;
    }
    // 放大后单指也可以拖动画面；没放大时单指不动画布（手掌最容易误触）
    if (cam.z > 1.01 && !active) panBy(e.clientX - t.lx, e.clientY - t.ly);
    t.lx = e.clientX; t.ly = e.clientY;
  });
  function pointerUp(e) {
    if (e.pointerType === "pen") { penDown = false; penUpAt = performance.now(); }
    if (ignoredTouches[e.pointerId]) { delete ignoredTouches[e.pointerId]; return; }
    if (e.pointerType === "pen" || (active && active.pointerId === e.pointerId)) {
      if (active && active.pointerId === e.pointerId) endStroke(e, e.type === "pointercancel");
    }
    if (pendingTouch && pendingTouch.id === e.pointerId) {
      // 很快抬起的单指轻点：当作一个点
      var p = pendingTouch; clearTimeout(p.timer); pendingTouch = null;
      if (!penOnly && connected && e.type === "pointerup") { startStroke(e, p.evs); endStroke(e, false); }
    }
    if (touches[e.pointerId]) {
      delete touches[e.pointerId];
      if (gesture && gesture.ids.indexOf(String(e.pointerId)) >= 0) {
        // 双指手势结束：剩下的手指不再触发拖动（多指轻点的撤销 / 重做由下面的触摸事件判定）
        gesture = null;
        Object.keys(touches).forEach(function (k) { ignoredTouches[k] = true; }); touches = {};
        requestPreview(true, 200);
      }
    }
  }
  live.addEventListener("pointerup", pointerUp);
  live.addEventListener("pointercancel", pointerUp);

  // 多指轻点：双指轻点 = 撤销，三指轻点 = 重做（与 Procreate 一致）。
  // v0.8.6：改用系统触摸事件判定——iPad Safari 的触摸事件直接给出同时按下的手指数，
  // 比逐个手指的指针事件更可靠（指针事件在多指时可能被系统改为取消或合并）
  var tap = null, TAP_MS = 350, TAP_MOVE = 20, PALM_R = PALM_PX / 2;
  function fingers(list) { return Array.prototype.filter.call(list || [], function (t) { return t.touchType !== "stylus"; }); }
  live.addEventListener("touchstart", function (e) {
    var f = fingers(e.touches); if (!f.length) return;
    if (!tap) tap = { t0: performance.now(), max: 0, start: {}, moved: 0, bad: false };
    if (penDown || palmGuard()) tap.bad = true;               // 正在用笔写字：手指是手掌
    fingers(e.changedTouches).forEach(function (t) {
      tap.start[t.identifier] = [t.clientX, t.clientY];
      if ((t.radiusX || 0) > PALM_R || (t.radiusY || 0) > PALM_R) tap.bad = true;
    });
    tap.max = Math.max(tap.max, f.length);
  }, { passive: true });
  live.addEventListener("touchmove", function (e) {
    if (!tap) return;
    fingers(e.changedTouches).forEach(function (t) {
      var s0 = tap.start[t.identifier]; if (s0) tap.moved = Math.max(tap.moved, Math.hypot(t.clientX - s0[0], t.clientY - s0[1]));
    });
  }, { passive: true });
  function tapEnd(e) {
    if (!tap || fingers(e.touches).length) return;     // 等所有手指都抬起
    var g = tap; tap = null;
    if (g.bad || g.max < 2 || g.moved > TAP_MOVE || performance.now() - g.t0 > TAP_MS) return;
    if (g.max >= 3) { if (redoStack.length) { redo(); notice(T("pad.redone"), 800); } }
    else { undoAction(); notice(T("pad.undone"), 800); }
  }
  live.addEventListener("touchend", tapEnd, { passive: true });
  live.addEventListener("touchcancel", tapEnd, { passive: true });
  // Pencil 在按钮或面板上抬起时 pointerup 不会到画布：在整页上复位“笔在纸上”，否则手指手势会一直被当成手掌忽略
  function penLifted(e) { if (e.pointerType === "pen" && penDown && !(active && active.pointerId === e.pointerId)) { penDown = false; penUpAt = performance.now(); } }
  document.addEventListener("pointerup", penLifted, true);
  document.addEventListener("pointercancel", penLifted, true);
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); });
  // 整页禁止滚动/缩放（避免书写时页面被拖动），但画笔工作室和画笔菜单这两个面板要能上下滚动：
  // 手指和 Pencil 在面板里拖动时放行；在试写区或用 Pencil 拖滑条时仍然禁止，免得面板跟着动
  var SCROLL_PANELS = "#tune, #brushes";
  document.addEventListener("touchmove", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (t && t.closest(SCROLL_PANELS) && !t.closest(".testpad")) {
      var stylus = e.touches && e.touches[0] && e.touches[0].touchType === "stylus";
      if (!(stylus && t.closest("input[type=range]"))) return;
    }
    e.preventDefault();
  }, { passive: false });
  // Pencil 拖动面板滚动：直接按笔的位移设置滚动位置（系统也滚动时两者目标一致，不会叠加）
  (function () {
    var drag = null;
    document.addEventListener("pointerdown", function (e) {
      drag = null;
      if (e.pointerType !== "pen" || !e.target || !e.target.closest) return;
      var sc = e.target.closest(SCROLL_PANELS);
      if (!sc || e.target.closest("input[type=range], .testpad, input[type=text], textarea")) return;
      drag = { sc: sc, id: e.pointerId, y: e.clientY, top: sc.scrollTop, moved: false };
    }, true);
    document.addEventListener("pointermove", function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) < 8) return;
      drag.moved = true; drag.sc.scrollTop = drag.top - dy;
    }, true);
    function end(e) { if (drag && e.pointerId === drag.id) drag = null; }
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
  })();

  // ---------- 工具条 ----------
  function updateButtons() {
    $("t-pen").classList.toggle("active", tool.kind === "write");
    $("t-marker").classList.toggle("active", tool.kind === "marker");
    $("t-eraser").classList.toggle("active", tool.kind === "eraser");
    $("brush-name").textContent = brushLabel(tool.brush);
    brushMenu.querySelectorAll("button").forEach(function (b) { b.classList.toggle("active", b.dataset.brush === tool.brush); });
    var shown = tool.kind === "marker" ? tool.markerColor : tool.color;
    var preset = false;
    document.querySelectorAll(".swatch[data-color]").forEach(function (b) {
      var on = tool.kind !== "eraser" && b.dataset.color === shown; if (on) preset = true; b.classList.toggle("active", on);
    });
    var cs = $("custom-color");
    cs.classList.toggle("active", tool.kind !== "eraser" && !preset);
    cs.classList.toggle("has-color", !preset); cs.style.setProperty("--c", shown);
    updateSizeBar();
    $("btn-penonly").classList.toggle("active", penOnly);
    $("btn-preview").classList.toggle("active", previewOn);
    // 只有屏幕标注模式才用得到的按钮：白板模式下直接不显示（不再显示成灰色按钮）
    $("btn-preview").hidden = $("btn-shot").hidden = $("div-screen").hidden = mode !== "annotate";
    document.querySelectorAll("#mode-seg button").forEach(function (b) { b.classList.toggle("on", b.dataset.mode === mode); });
    $("btn-redo").disabled = !redoStack.length;
  }
  // 画笔菜单：每种画笔画一笔示例（用同一个渲染引擎，所见即所得）
  var brushMenu = $("brushes");
  // 示例笔迹：模拟一笔“先轻后重再轻”的手写（240Hz 采样），v2 笔刷走同一个笔感层
  function sampleStroke(id, color, cw, ch) {
    var raw = [], n = 90;
    for (var i = 0; i <= n; i++) {
      var t = i / n, x = 0.06 + 0.88 * t, y = 0.5 + 0.3 * Math.sin(t * Math.PI * 2.2);
      raw.push([x, y, 0.08 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15)), i * 6]);
    }
    var pts;
    if (brushParams(id)) {
      var inp = Ink.Input(brushParams(id).dyn), out = [];
      raw.forEach(function (r) { out = out.concat(inp.add(r[0] * cw, r[1] * ch, Math.max(0.01, r[2]), r[3])); });
      pts = out.concat(inp.finish()).map(function (q) { return [q[0] / cw, q[1] / ch, q[2]]; });
      return { id: "sample-" + id, color: color, size: brushSizes(id)[1], tool: Ink.encodeTool(brushParams(id).render), points: pts };
    }
    pts = raw.map(function (r) { return [r[0], r[1], r[2]]; });
    return { id: "sample-" + id, color: color, size: brushSizes(id)[1], tool: id, points: pts };
  }
  function drawSamples() {
    brushMenu.querySelectorAll("canvas").forEach(function (c) {
      var r = window.devicePixelRatio || 1, w = c.clientWidth || 170, h = c.clientHeight || 44;
      c.width = Math.round(w * r); c.height = Math.round(h * r);
      var g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
      // 示例按“iPad 上该笔中号的实际像素宽”缩放，便于对比粗细
      var unitPx = worldW() / UNIT * r;
      Ink.drawStroke(g, sampleStroke(c.dataset.brush, "#1a1a1a", w, h), { sx: c.width, sy: c.height, ox: 0, oy: 0, s: unitPx }, true);
    });
  }
  function renderBrushMenu(initial) {
    brushMenu.innerHTML = "";
    var ids = allBrushIds();
    ids.forEach(function (id, i) {
      if (i === OFFICIAL.length) {
        var hd = document.createElement("div"); hd.className = "menu-sec"; hd.textContent = T("brush.mine");
        brushMenu.appendChild(hd);
      }
      var info = brushInfo(id);
      var btn = document.createElement("button");
      btn.type = "button"; btn.dataset.brush = id; btn.setAttribute("role", "menuitemradio");
      btn.innerHTML = "<b></b><span><span class=\"use\"></span><small></small></span><canvas></canvas>";
      btn.querySelector("b").textContent = brushLabel(id) + (OFFICIAL_IDS[id] && isTuned(id) ? " *" : "");
      btn.querySelector(".use").textContent = info.use;
      btn.querySelector("small").textContent = info.note;
      btn.querySelector("canvas").dataset.brush = id;
      btn.classList.toggle("custom", !OFFICIAL_IDS[id]);
      btn.addEventListener("click", function () {
        tool.brush = id; tool.kind = "write"; store("wb_brush", id);
        brushMenu.hidden = true; updateButtons(); announceSize();
        if (!tunePanel.hidden) buildTune();
      });
      brushMenu.appendChild(btn);
    });
    var foot = document.createElement("div");
    foot.className = "menu-foot";
    foot.innerHTML = "<button id=\"btn-tune\" type=\"button\"></button>";
    foot.querySelector("button").textContent = T("brush.studioOpen");
    foot.querySelector("button").addEventListener("click", function () {
      brushMenu.hidden = true; tunePanel.hidden = false; buildTune();
    });
    brushMenu.appendChild(foot);
    if (!initial) updateButtons();
    if (!brushMenu.hidden) drawSamples();
  }

  // ---------- 画笔工作室（类似 Procreate）：调参数、试写板实时预览、另存为新画笔、恢复官方默认 ----------
  // 官方画笔的修改保存为“本机调节”，可随时一键恢复官方默认；自定义画笔保存在 iPad，并自动备份到电脑。
  var tunePanel = $("tune"), pressureEl = null, pressureTimer = null;
  var TUNE = PARAMS;
  function pressureReadout(p) {
    if (!pressureEl || tunePanel.hidden) return;
    pressureEl.textContent = T("studio.pressure", { p: p.toFixed(2) });
    clearTimeout(pressureTimer);
    pressureTimer = setTimeout(function () { pressureEl.textContent = T("studio.pressureIdle"); }, 1500);
  }
  function fmt(v, step) { return (+v).toFixed(step < 1 ? 2 : 0); }
  // 试写板：保存原始输入（坐标、压力、时间），参数一变就按新参数重算重画，像 Procreate 的“绘图板”
  var testPad = { strokes: [], cur: null, canvas: null };
  function drawTestPad() {
    var c = testPad.canvas; if (!c || tunePanel.hidden) return;
    var r = window.devicePixelRatio || 1, w = c.clientWidth || 360, h = c.clientHeight || 160;
    if (c.width !== Math.round(w * r) || c.height !== Math.round(h * r)) { c.width = Math.round(w * r); c.height = Math.round(h * r); }
    var g = c.getContext("2d"); g.clearRect(0, 0, c.width, c.height);
    var bp = brushParams(tool.brush); if (!bp) return;
    var tf = { sx: c.width, sy: c.height, ox: 0, oy: 0, s: worldW() / UNIT * r };
    var list = testPad.strokes.concat(testPad.cur ? [testPad.cur] : []);
    var hint = c.parentNode && c.parentNode.querySelector(".tp-hint");
    if (hint) hint.hidden = list.length > 0;
    list.forEach(function (raw, i) {
      var inp = Ink.Input(bp.dyn), out = [];
      raw.forEach(function (q) { out = out.concat(inp.add(q[0], q[1], q[2], q[3])); });
      out = out.concat(inp.finish());
      if (!out.length) return;
      Ink.drawStroke(g, { id: "tp" + i, color: tool.color, size: currentSize(), tool: Ink.encodeTool(bp.render),
                          points: out.map(function (q) { return [q[0] / w, q[1] / h, q[2]]; }) }, tf, true);
    });
  }
  function bindTestPad(c) {
    testPad.canvas = c;
    var pid = null;
    function pt(e) {
      var rc = c.getBoundingClientRect();
      return [e.clientX - rc.left, e.clientY - rc.top, e.pointerType === "pen" ? Math.max(0.01, e.pressure || 0) : null, e.timeStamp];
    }
    c.addEventListener("pointerdown", function (e) {
      if (penOnly && e.pointerType === "touch") return;
      e.preventDefault(); e.stopPropagation(); pid = e.pointerId;
      try { c.setPointerCapture(pid); } catch (err) {}
      testPad.cur = [pt(e)];
      if (e.pointerType === "pen") pressureReadout(e.pressure || 0);
      drawTestPad();
    });
    c.addEventListener("pointermove", function (e) {
      if (pid !== e.pointerId || !testPad.cur) return;
      e.preventDefault();
      var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      (evs.length ? evs : [e]).forEach(function (ev) { testPad.cur.push(pt(ev)); });
      if (e.pointerType === "pen") pressureReadout(e.pressure || 0);
      drawTestPad();
    });
    function up(e) {
      if (pid !== e.pointerId) return;
      pid = null;
      if (testPad.cur && testPad.cur.length) testPad.strokes.push(testPad.cur);
      if (testPad.strokes.length > 12) testPad.strokes.shift();
      testPad.cur = null; drawTestPad();
    }
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
  }
  // 需要二次确认的按钮：第一次点变成“再点一次确认”，3 秒内再点才执行
  function armed(btn, label, run) {
    var t = null, orig = btn.textContent;
    btn.addEventListener("click", function () {
      if (btn.classList.contains("armed")) { clearTimeout(t); btn.classList.remove("armed"); btn.textContent = orig; run(); return; }
      btn.classList.add("armed"); btn.textContent = label;
      t = setTimeout(function () { btn.classList.remove("armed"); btn.textContent = orig; }, 3000);
    });
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function buildTune() {
    var id = tool.brush, prm = brushParams(id), official = !!OFFICIAL_IDS[id];
    tunePanel.innerHTML = "";
    var head = el("div", "tune-head");
    head.innerHTML = "<b></b><i class=\"tag\"></i><button type=\"button\" data-act=\"close\"></button>";
    head.querySelector("[data-act=close]").textContent = T("common.done");
    head.querySelector("b").textContent = T("studio.title", { name: brushLabel(id) });
    var tag = head.querySelector(".tag");
    tag.textContent = official ? T(isTuned(id) ? "studio.officialTuned" : "studio.official") : T("brush.customUse", { base: T("brush." + customOf(id).base) });
    tag.classList.toggle("mod", official && isTuned(id));
    tunePanel.appendChild(head);
    var pr = el("div", "pr", T("studio.pressureIdle")); tunePanel.appendChild(pr); pressureEl = pr;
    head.querySelector("[data-act=close]").addEventListener("click", function () { tunePanel.hidden = true; renderBrushMenu(); });
    if (!prm) {
      tunePanel.appendChild(el("p", "tune-note", T("studio.notTunable")));
      appendTools(id, null);
      return;
    }
    // 试写板
    var tp = el("div", "testpad");
    tp.innerHTML = "<canvas></canvas><span class=\"tp-hint\"></span><button type=\"button\" data-act=\"tp-clear\"></button>";
    tp.querySelector(".tp-hint").textContent = T("studio.padHint");
    tp.querySelector("[data-act=tp-clear]").textContent = T("studio.clearPad");
    tunePanel.appendChild(tp);
    bindTestPad(tp.querySelector("canvas"));
    tp.querySelector("[data-act=tp-clear]").addEventListener("click", function () { testPad.strokes = []; testPad.cur = null; drawTestPad(); });
    // 参数，按栏目分组
    var sec = null;
    TUNE.forEach(function (row) {
      if (row[7] !== sec) { sec = row[7]; tunePanel.appendChild(el("div", "tune-sec", T(sec))); }
      var lab = el("div", "tune-row");
      lab.dataset.key = row[1];
      lab.innerHTML = "<span class=\"nm\"></span><input type=\"range\"><output></output><button type=\"button\" class=\"rs\">↺</button><small></small>";
      lab.querySelector(".rs").title = T("studio.resetOne");
      lab.querySelector(".nm").textContent = T(row[2]);
      var input = lab.querySelector("input"), out = lab.querySelector("output"), rs = lab.querySelector(".rs");
      input.min = row[3]; input.max = row[4]; input.step = row[5];
      function show() {
        var v = brushParams(id)[row[0]][row[1]], dv = officialValue(id, row[0], row[1]);
        input.value = v; out.textContent = fmt(v, row[5]);
        var changed = Math.abs(v - dv) > row[5] / 2;
        rs.hidden = !changed; lab.classList.toggle("changed", changed);
        lab.querySelector("small").textContent = T(row[6]) + T("studio.officialVal", { v: fmt(dv, row[5]) });
      }
      show();
      input.addEventListener("input", function () {
        setParam(id, row[0], row[1], +input.value);
        out.textContent = fmt(input.value, row[5]);
        var changed = Math.abs(+input.value - officialValue(id, row[0], row[1])) > row[5] / 2;
        rs.hidden = !changed; lab.classList.toggle("changed", changed);
        refreshTag(); drawTestPad();
      });
      rs.addEventListener("click", function () { resetParam(id, row[0], row[1]); show(); refreshTag(); drawTestPad(); });
      tunePanel.appendChild(lab);
    });
    function refreshTag() {
      if (!official) return;
      var m = isTuned(id); tag.textContent = T(m ? "studio.officialTuned" : "studio.official"); tag.classList.toggle("mod", m);
      var rb = tunePanel.querySelector("[data-act=reset]"); if (rb) rb.disabled = !m;
    }
    appendTools(id, prm);
    refreshTag();
    requestAnimationFrame(drawTestPad);
  }
  // 画笔管理（另存 / 重命名 / 删除 / 恢复官方默认）+ 导入导出 + 校准与诊断
  function appendTools(id, prm) {
    var official = !!OFFICIAL_IDS[id];
    if (prm) {
      tunePanel.appendChild(el("div", "tune-sec", T("studio.secBrush")));
      var acts = el("div", "tune-foot");
      acts.innerHTML = "<button type=\"button\" data-act=\"saveas\"></button>" +
        (official ? "<button type=\"button\" data-act=\"reset\"></button>"
                  : "<button type=\"button\" data-act=\"rename\"></button><button type=\"button\" data-act=\"delete\" class=\"danger\"></button>");
      [["saveas", "studio.saveAs"], ["reset", "studio.reset"], ["rename", "studio.rename"], ["delete", "studio.delete"]].forEach(function (x) {
        var b = acts.querySelector("[data-act=" + x[0] + "]"); if (b) b.textContent = T(x[1]);
      });
      tunePanel.appendChild(acts);
      var nameRow = el("div", "tune-name");
      nameRow.hidden = true;
      nameRow.innerHTML = "<input type=\"text\" maxlength=\"24\" enterkeyhint=\"done\"><button type=\"button\" data-act=\"name-ok\"></button><button type=\"button\" data-act=\"name-cancel\"></button>";
      nameRow.querySelector("[data-act=name-ok]").textContent = T("common.save");
      nameRow.querySelector("[data-act=name-cancel]").textContent = T("common.cancel");
      tunePanel.appendChild(nameRow);
      var nameInput = nameRow.querySelector("input"), nameMode = null;
      function askName(modeName, initial) {
        nameMode = modeName; nameRow.hidden = false; nameInput.value = initial;
        nameRow.querySelector("[data-act=name-ok]").textContent = T(modeName === "saveas" ? "studio.saveNew" : "studio.saveName");
        try { nameInput.focus(); nameInput.select(); } catch (e) {}
      }
      function commitName() {
        var v = cleanLabel(nameInput.value);
        if (!v) { notice(T("studio.needName"), 2500); return; }
        nameRow.hidden = true;
        if (nameMode === "saveas") {
          var nid = saveAsNew(id, v);
          tool.brush = nid; tool.kind = "write"; store("wb_brush", nid);
          notice(T("studio.savedNew", { name: v }), 4000);
        } else { renameCustom(id, v); notice(T("studio.renamed", { name: v }), 2500); }
        renderBrushMenu(); buildTune();
      }
      nameRow.querySelector("[data-act=name-ok]").addEventListener("click", commitName);
      nameRow.querySelector("[data-act=name-cancel]").addEventListener("click", function () { nameRow.hidden = true; });
      nameInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitName(); } });
      acts.querySelector("[data-act=saveas]").addEventListener("click", function () { askName("saveas", cleanLabel(T("brush.copy", { name: brushLabel(id) }))); });
      if (official) {
        armed(acts.querySelector("[data-act=reset]"), T("studio.resetArmed"), function () {
          resetOfficial(id); notice(T("studio.restored", { name: brushLabel(id) }), 3000); renderBrushMenu(); buildTune();
        });
      } else {
        acts.querySelector("[data-act=rename]").addEventListener("click", function () { askName("rename", brushLabel(id)); });
        armed(acts.querySelector("[data-act=delete]"), T("studio.deleteArmed"), function () {
          var name = brushLabel(id); deleteCustom(id);
          notice(T("studio.deleted", { name: name }), 3000); renderBrushMenu(); buildTune();
        });
      }
    }
    tunePanel.appendChild(el("div", "tune-sec", T("studio.secBackup")));
    var io = el("div", "tune-foot");
    io.innerHTML = "<button type=\"button\" data-act=\"export\"></button><button type=\"button\" data-act=\"import\"></button>" +
      "<button type=\"button\" class=\"cal\"></button><textarea hidden></textarea><button type=\"button\" data-act=\"import-ok\" hidden></button>" +
      "<span class=\"tune-tip\"></span>";
    io.querySelector("[data-act=export]").textContent = T("studio.export");
    io.querySelector("[data-act=import]").textContent = T("studio.import");
    io.querySelector(".cal").textContent = T("cal.button");
    io.querySelector("[data-act=import-ok]").textContent = T("studio.importOk");
    io.querySelector(".tune-tip").textContent = T("studio.backupTip");
    tunePanel.appendChild(io);
    var ta = io.querySelector("textarea"), impOk = io.querySelector("[data-act=import-ok]");
    io.querySelector("[data-act=export]").addEventListener("click", function () {
      ta.hidden = false; ta.readOnly = true; impOk.hidden = true;
      ta.value = JSON.stringify(backupData()); ta.select();
      notice(T("studio.exported"), 3000);
    });
    io.querySelector("[data-act=import]").addEventListener("click", function () {
      ta.hidden = false; ta.readOnly = false; ta.value = ""; impOk.hidden = false;
      ta.placeholder = T("studio.importPlaceholder");
      try { ta.focus(); } catch (e) {}
    });
    impOk.addEventListener("click", function () {
      var r = importBrushes(ta.value);
      if (r < 0) { notice(T("studio.importBad"), 4000); return; }
      notice(T("studio.imported", { n: r }), 3000); renderBrushMenu(); buildTune();
    });
    io.querySelector(".cal").addEventListener("click", calibratePressure);
    var diagRow = el("div", "tune-foot");
    diagRow.innerHTML = "<button type=\"button\" class=\"diag\"></button><button type=\"button\" class=\"diag-local\"></button><span class=\"diag-n\"></span>";
    diagRow.querySelector(".diag").textContent = T("diag.send");
    diagRow.querySelector(".diag-local").textContent = T("diag.local");
    diagRow.querySelector(".diag").addEventListener("click", sendDiag);
    diagRow.querySelector(".diag-local").addEventListener("click", saveDiagLocal);
    diagRow.querySelector(".diag-n").textContent = T("diag.count", { n: diag.strokes.length });
    if (devMode()) tunePanel.appendChild(diagRow); // 开发模式才显示
  }
  // 导入：接受“导出全部画笔”的文本；同 id 的自定义画笔被覆盖，官方画笔的调节被替换。返回导入项数，格式错误返回 -1
  function importBrushes(text) {
    var d; try { d = JSON.parse(text); } catch (e) { return -1; }
    if (Array.isArray(d)) d = { customs: d };
    if (!d || typeof d !== "object") return -1;
    var n = 0;
    (Array.isArray(d.customs) ? d.customs : []).forEach(function (c) {
      if (!validCustom(c)) return;
      c = { id: c.id, label: cleanLabel(c.label), base: c.base, dyn: c.dyn, render: c.render };
      var old = customOf(c.id);
      if (old) customs[customs.indexOf(old)] = c; else customs.push(c);
      n++;
    });
    if (d.tunes && typeof d.tunes === "object") OFFICIAL.forEach(function (oid) {
      var t = d.tunes[oid];
      if (t && typeof t === "object") { store("wb_tune_" + oid, JSON.stringify({ dyn: t.dyn || {}, render: t.render || {} })); n++; }
    });
    if (typeof d.pcal === "number" && d.pcal > 0.03 && d.pcal <= 1) store("wb_pcal", String(d.pcal));
    saveCustoms();
    return n;
  }
  renderBrushMenu(true);
  // 弹出面板一次只开一个；在画布上落笔时自动收起（画笔工作室保持打开，边写边调）
  function closePops(except) {
    ["brushes", "appmenu", "langmenu", "help"].forEach(function (id) { if (id !== except) $(id).hidden = true; });
    if (except !== "picker") closePicker();
  }
  $("t-pen").addEventListener("click", function () {
    if (tool.kind === "write") { var open = brushMenu.hidden; closePops("brushes"); brushMenu.hidden = !open; if (open) drawSamples(); }
    else { tool.kind = "write"; closePops(); }
    updateButtons();
  });
  live.addEventListener("pointerdown", function () { closePops(); }, true);
  ["marker", "eraser"].forEach(function (k) {
    $("t-" + k).addEventListener("click", function () { tool.kind = k; closePops(); updateButtons(); });
  });
  // 颜色：9 个常用色 + 色盘（系统取色器，可选任意颜色）；选择会被记住
  function applyColor(c) {
    if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
    c = c.toLowerCase();
    if (tool.kind === "marker") { tool.markerColor = c; store("wb_marker_color", c); }
    else { tool.color = c; store("wb_color", c); if (tool.kind === "eraser") tool.kind = "write"; }
    updateButtons();
  }
  document.querySelectorAll(".swatch[data-color]").forEach(function (b) {
    b.addEventListener("click", function () { applyColor(b.dataset.color); });
  });
  // ---------- 自建色盘（HSV：饱和度/明度方块 + 色相条 + 最近使用），Pencil 与手指都可操作 ----------
  var picker = $("picker"), pkSV = $("pk-sv"), pkHue = $("pk-hue"), hsv = [0, 1, 1];
  function hexToHsv(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, h = 0;
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, mx ? d / mx : 0, mx];
  }
  function hsvToHex(h, s2, v) {
    var f = function (n) { var k = (n + h / 60) % 6; return v - v * s2 * Math.max(0, Math.min(k, 4 - k, 1)); };
    return "#" + [f(5), f(3), f(1)].map(function (x) { return ("0" + Math.round(x * 255).toString(16)).slice(-2); }).join("");
  }
  function drawPicker() {
    var g = pkSV.getContext("2d"), W = pkSV.width, H = pkSV.height;
    g.fillStyle = hsvToHex(hsv[0], 1, 1); g.fillRect(0, 0, W, H);
    var gw = g.createLinearGradient(0, 0, W, 0); gw.addColorStop(0, "#fff"); gw.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gw; g.fillRect(0, 0, W, H);
    var gb = g.createLinearGradient(0, 0, 0, H); gb.addColorStop(0, "rgba(0,0,0,0)"); gb.addColorStop(1, "#000"); g.fillStyle = gb; g.fillRect(0, 0, W, H);
    var x = hsv[1] * W, y = (1 - hsv[2]) * H, k = W / 280;
    g.lineWidth = 3 * k; g.strokeStyle = "#fff"; g.beginPath(); g.arc(x, y, 9 * k, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 1 * k; g.strokeStyle = "#000"; g.beginPath(); g.arc(x, y, 11 * k, 0, Math.PI * 2); g.stroke();
    var h2 = pkHue.getContext("2d"), HW = pkHue.width, HH = pkHue.height, gh = h2.createLinearGradient(0, 0, HW, 0);
    for (var i = 0; i <= 6; i++) gh.addColorStop(i / 6, hsvToHex(i * 60 % 360, 1, 1));
    h2.clearRect(0, 0, HW, HH); h2.fillStyle = gh; h2.fillRect(0, 0, HW, HH);
    var hx = hsv[0] / 360 * HW, hk = HW / 280; h2.lineWidth = 4 * hk; h2.strokeStyle = "#fff"; h2.strokeRect(hx - 5 * hk, 2 * hk, 10 * hk, HH - 4 * hk);
    var hex = hsvToHex(hsv[0], hsv[1], hsv[2]);
    $("pk-preview").style.background = hex; $("pk-hex").textContent = hex;
  }
  function pickerApply() { var hex = hsvToHex(hsv[0], hsv[1], hsv[2]); store("wb_custom_color", hex); applyColor(hex); drawPicker(); }
  function dragOn(canvas, onPos) {
    var id = null;
    function at(e) { var r = canvas.getBoundingClientRect(); onPos(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))); }
    canvas.addEventListener("pointerdown", function (e) { e.preventDefault(); id = e.pointerId; try { canvas.setPointerCapture(id); } catch (err) {} at(e); });
    canvas.addEventListener("pointermove", function (e) { if (id === e.pointerId) at(e); });
    canvas.addEventListener("pointerup", function (e) { if (id === e.pointerId) id = null; });
    canvas.addEventListener("pointercancel", function (e) { if (id === e.pointerId) id = null; });
  }
  dragOn(pkSV, function (x, y) { hsv[1] = x; hsv[2] = 1 - y; pickerApply(); });
  dragOn(pkHue, function (x) { hsv[0] = Math.min(359.9, x * 360); pickerApply(); });
  function recents() { try { var r = JSON.parse(store("wb_recent_colors") || "[]"); return Array.isArray(r) ? r.filter(function (c) { return /^#[0-9a-f]{6}$/.test(c); }) : []; } catch (e) { return []; } }
  function renderRecent() {
    var box = $("pk-recent"); box.innerHTML = "";
    recents().forEach(function (c) {
      var b = document.createElement("button"); b.type = "button"; b.style.background = c; b.title = c;
      b.addEventListener("click", function () { hsv = hexToHsv(c); pickerApply(); });
      box.appendChild(b);
    });
  }
  function closePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    var c = hsvToHex(hsv[0], hsv[1], hsv[2]), r = recents().filter(function (x) { return x !== c; });
    r.unshift(c); store("wb_recent_colors", JSON.stringify(r.slice(0, 8)));
  }
  $("custom-color").addEventListener("click", function () {
    if (!picker.hidden) { closePicker(); return; }
    closePops("picker");
    hsv = hexToHsv(tool.kind === "marker" ? tool.markerColor : tool.color);
    renderRecent(); picker.hidden = false; drawPicker();
  });
  $("pk-done").addEventListener("click", closePicker);
  live.addEventListener("pointerdown", closePicker, true);
  (function () {
    var c = store("wb_color"), m = store("wb_marker_color");
    if (c && /^#[0-9a-f]{6}$/.test(c)) tool.color = c;
    if (m && /^#[0-9a-f]{6}$/.test(m)) tool.markerColor = m;
  })();

  $("btn-undo").addEventListener("click", undoAction);
  $("btn-redo").addEventListener("click", redo);
  $("btn-clear").addEventListener("click", quickClear);
  $("btn-quickclear").addEventListener("click", quickClear);
  $("undo-toast-btn").addEventListener("click", restoreClear);
  $("btn-penonly").addEventListener("click", function () { penOnly = !penOnly; store("wb_penonly", penOnly ? "1" : "0"); updateButtons(); });
  $("btn-fit").addEventListener("click", function () { closePops(); fit(true); requestPreview(true, 0); });
  $("btn-menu").addEventListener("click", function () { var open = $("appmenu").hidden; closePops("appmenu"); $("appmenu").hidden = !open; });
  $("btn-help").addEventListener("click", function () { closePops("help"); $("help").hidden = false; });
  // v0.8.13：使用说明（由电脑上的墨投提供 /guide，离线可用）
  $("btn-guide").addEventListener("click", function () {
    closePops();
    // 说明页按当前语言显示；切换语言后重新载入
    var f = $("guide-frame"), src = "/guide?lang=" + encodeURIComponent(I18N.lang());
    if (f.getAttribute("src") !== src) f.setAttribute("src", src);
    $("guide").hidden = false;
  });
  $("guide-close").addEventListener("click", function () { $("guide").hidden = true; });
  $("help-ok").addEventListener("click", function () { $("help").hidden = true; store("wb_help_seen", "1"); });
  $("btn-preview").addEventListener("click", function () {
    previewOn = !previewOn; store("wb_preview", previewOn ? "1" : "0"); updateButtons(); renderBg();
    if (previewOn) requestPreview(true, 0); else clearTimeout(previewTimer);
  });
  $("btn-shot").addEventListener("click", function () {
    var d = new Date(), z = function (n) { return (n < 10 ? "0" : "") + n; };
    send({ t: "save-shot", name: d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()) + z(d.getSeconds()) });
    notice(T("pad.savingShot"), 3000);
  });
  document.querySelectorAll("#mode-seg button").forEach(function (b) {
    b.addEventListener("click", function () { if (b.dataset.mode !== mode) switchMode(false); });
  });
  // fromPc：电脑那边切换了（pc-mode），这里跟着切，不再通知电脑；自己切换时先告诉电脑（pad-mode），电脑跟着切
  function switchMode(fromPc) {
    var next = mode === "annotate" ? "board" : "annotate";
    if (!fromPc && ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ t: "pad-mode", mode: next })); } catch (e) {} }
    mode = next; store("wb_mode", mode); redoStack = []; clearUndoDrop();
    aspect = mode === "annotate" ? (parseFloat(store("wb_aspect")) || 1.6) : 1.6;
    strokes = []; mine = {}; active = null; screenImg = null; clearTimeout(previewTimer); previewWaiting = false;
    updateButtons(); fit(true);
    if (ws) { var old = ws; ws = null; try { old.close(); } catch (e) {} }
    connect();
  }

  // ---------- Apple Pencil 点按钮 ----------
  // 实测：iPad 浏览器里用 Pencil 点按钮、拖滑条不触发（只有手指可以）。这里统一处理 Pencil 的点击和拖动：
  // 在同一控件上按下再抬起（移动 < 12px）就当作一次点击；滑条按 Pencil 位置设置数值。
  // 为避免与浏览器偶尔自带的点击重复触发，合成点击后 500ms 内同一控件的原生点击会被忽略。
  (function () {
    var CTRL = "button, label.swatch, input[type=range], input[type=color], input[type=text], textarea";
    var down = null, synth = false, lastSynth = { el: null, t: 0 };
    function ctrlOf(e) { var el = e.target && e.target.closest ? e.target.closest(CTRL) : null; return el && !el.disabled ? el : null; }
    function setRange(el, e) {
      var r = el.getBoundingClientRect(), t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      var min = +el.min || 0, max = el.max === "" ? 100 : +el.max, step = +el.step || 1;
      el.value = Math.round((min + t * (max - min)) / step) * step;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    document.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "pen") return;
      var el = ctrlOf(e); down = el ? { el: el, x: e.clientX, y: e.clientY } : null;
      if (el && el.type === "range") { e.preventDefault(); setRange(el, e); }
    }, true);
    document.addEventListener("pointermove", function (e) {
      if (e.pointerType === "pen" && down && down.el.type === "range" && e.buttons) setRange(down.el, e);
    }, true);
    document.addEventListener("pointerup", function (e) {
      if (e.pointerType !== "pen" || !down) return;
      var d = down; down = null;
      if (d.el.type === "range") { d.el.dispatchEvent(new Event("change", { bubbles: true })); return; }
      if (ctrlOf(e) !== d.el || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12) return;
      if (d.el.matches("input[type=text], textarea")) { try { d.el.focus(); } catch (err) {} return; } // 文本框：Pencil 点一下即可输入（也可用随手写）
      lastSynth = { el: d.el, t: performance.now() };
      synth = true; try { d.el.click(); } finally { synth = false; }
    }, true);
    document.addEventListener("click", function (e) {
      if (synth || !lastSynth.el || performance.now() - lastSynth.t > 500) return;
      if (e.target === lastSynth.el || lastSynth.el.contains(e.target)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  })();

  // ---------- 语言 ----------
  // 第一次按 iPad 的语言设置；在右上角“🌐”里切换，选择会被记住
  var LANG_SHORT = { "zh-CN": "简", "zh-TW": "繁", en: "EN", ja: "日", ko: "한", de: "DE", fr: "FR", es: "ES" };
  var langMenu = $("langmenu");
  function showLangButton() {
    var cur = I18N.langs().filter(function (l) { return l.code === I18N.lang(); })[0];
    $("lang-val").textContent = cur ? cur.name : I18N.lang();
  }
  function renderLangMenu() {
    langMenu.innerHTML = "";
    I18N.langs().forEach(function (l) {
      var b = document.createElement("button");
      b.type = "button"; b.dataset.lang = l.code; b.textContent = l.name; b.lang = l.code;
      b.classList.toggle("active", l.code === I18N.lang());
      b.addEventListener("click", function () { langMenu.hidden = true; $("appmenu").hidden = true; I18N.set(l.code); });
      langMenu.appendChild(b);
    });
  }
  $("btn-lang").addEventListener("click", function () {
    if (!langMenu.hidden) { langMenu.hidden = true; return; }
    renderLangMenu(); langMenu.hidden = false;
  });
  I18N.onChange(function () {
    showLangButton();
    updateButtons();
    fit(false);
    setConn(connected, lastConnKey);
    if (lastUsageMsg) showUsage(lastUsageMsg);
    renderBrushMenu();
    if (!tunePanel.hidden) buildTune();
  });
  I18N.apply();
  showLangButton();
  if (store("wb_help_seen") !== "1") $("help").hidden = false;

  updateButtons();
  fit(true);
  connect();
})();
