// 白板共享层：协议消息、笔画状态机、SVG 序列化。
// 被电脑端 viewer 和 iPad 画板页共同引用（viewer 直接引用本文件；
// Rust 服务把本文件原样提供给 /shared.js，pad.html 引用它）。
// 本文件不依赖 DOM，可在 Node 下直接 require 做单元测试。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Whiteboard = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 虚拟画布：pad 与 viewer 都 letterbox 到这个坐标系，保证比例一致
  var VW = 1600, VH = 1000;
  var POINT_DISTANCE_CSS = 0.75, POINT_PRESSURE_DELTA = 0.1;

  // 只与最后已发送点比较；pending 保存最新被抽掉的尾点，正常结束时补发。
  function pointSampler() { return { lastSent: null, pending: null, latest: null }; }
  function samplePoint(sampler, point, cssX, cssY, force) {
    var candidate = { point: point, x: cssX, y: cssY }, last = sampler.lastSent;
    sampler.latest = point;
    if (last && point.every(function (value, i) { return value === last.point[i]; })) {
      sampler.pending = null;
      return null;
    }
    if (!force && last && Math.hypot(cssX - last.x, cssY - last.y) < POINT_DISTANCE_CSS &&
        // PointerEvent.pressure 是 float32，容纳 0.6 -> 0.7 的表示误差。
        Math.abs(point[2] - last.point[2]) + 1e-7 < POINT_PRESSURE_DELTA) {
      sampler.pending = candidate;
      return null;
    }
    sampler.lastSent = candidate;
    sampler.pending = null;
    return point;
  }
  function flushPoint(sampler) {
    if (!sampler.pending) return null;
    sampler.lastSent = sampler.pending;
    sampler.pending = null;
    return sampler.lastSent.point;
  }
  function pointerPressure(event, fallback, sampler, ending) {
    if (event.pointerType !== "pen") return fallback;
    if (event.pressure > 0) return event.pressure;
    // pointerup 通常 pressure=0，这是离开屏幕的状态，不是新笔压采样。
    return ending && sampler.latest ? sampler.latest[2] : fallback;
  }
  // 多语言：页面加载了 i18n.js 时用当前语言，否则用简体中文原文
  function L(key, zh, p) {
    var I = typeof window !== "undefined" ? window.I18N : null;
    if (I && I._dict[key]) return I.t(key, p);
    return p ? zh.replace(/\{(\w+)\}/g, function (m, k) { return p[k]; }) : zh;
  }
  function usageNotice(msg) {
    var ratio = Math.max(msg.maxPoints > 0 ? msg.points / msg.maxPoints : 0,
      msg.maxStrokes > 0 ? msg.strokes / msg.maxStrokes : 0);
    if (ratio >= 1) return { level: "full", text: L("usage.full", "白板已满，请先存档再清屏，或撤销后继续") };
    if (ratio >= 0.95) return { level: "critical", text: L("usage.critical", "白板容量已达 95%，请尽快存档后清屏") };
    if (ratio >= 0.8) return { level: "warning", text: L("usage.warning", "白板接近容量上限（80%），建议存档后清屏") };
    return { level: "normal", text: "" };
  }

  // ---- 消息构造（pad / viewer -> server） ----
  function strokeStart(id, color, size, tool) {
    return { t: "stroke-start", id: id, color: color, size: size, tool: tool || "pen" };
  }
  function strokePoint(id, x, y, p) {
    // ts: 发送时间戳（ms），viewer 用它统计端到端延迟 p50/p95；
    // 注意 iPad 与电脑时钟可能有偏差，只看趋势与尖刺，不做实验室级测量
    return { t: "stroke-point", id: id, x: x, y: y, p: p == null ? 0.5 : p, ts: Date.now() };
  }
  function strokeEnd(id) { return { t: "stroke-end", id: id }; }
  function undoMsg() { return { t: "undo" }; }
  function clearMsg() { return { t: "clear" }; }
  function boardLoadMsg(strokes) { return { t: "board-load", strokes: strokes }; }
  // v0.4 配对认证：WS 首条消息（5s 内未收到服务端关闭连接）
  function helloMsg(token) { return { t: "hello", token: token || null }; }

  // ---- 状态机：把一条 server 广播消息应用到 strokes 数组 ----
  // strokes: [{id,color,size,tool,points:[[x,y,p],...]}]
  // 返回 {changed:true/false, removedId} 供调用方决定是否重绘
  function applyMessage(strokes, msg) {
    if (!msg || !msg.t) return { changed: false };
    switch (msg.t) {
      case "stroke-start": {
        if (strokes.some(function (s) { return s.id === msg.id; })) return { changed: false };
        strokes.push({ id: msg.id, color: msg.color, size: msg.size,
                       tool: msg.tool || "pen", points: [] });
        return { changed: true };
      }
      case "stroke-point": {
        var s = null;
        for (var i = 0; i < strokes.length; i++) if (strokes[i].id === msg.id) { s = strokes[i]; break; }
        if (!s) return { changed: false };
        s.points.push([msg.x, msg.y, msg.p == null ? 0.5 : msg.p]);
        return { changed: true, stroke: s, incremental: true };
      }
      case "stroke-end":
        return { changed: false, ended: msg.id };
      case "stroke-rejected": {
        var rejected = strokes.findIndex(function (s) { return s.id === msg.id; });
        if (rejected < 0) return { changed: false };
        strokes.splice(rejected, 1);
        return { changed: true, removedId: msg.id };
      }
      case "stroke-truncate": {
        if (!Number.isSafeInteger(msg.len) || msg.len < 0) return { changed: false };
        var truncated = strokes.find(function (s) { return s.id === msg.id; });
        if (!truncated || truncated.points.length <= msg.len) return { changed: false };
        truncated.points.length = msg.len;
        return { changed: true };
      }
      case "undo": {
        // server 广播带 id；本地直接调用时无 id 则弹最后一笔
        var id = msg.id;
        var idx = -1;
        if (id) {
          for (var j = 0; j < strokes.length; j++) if (strokes[j].id === id) { idx = j; break; }
        } else if (!Object.prototype.hasOwnProperty.call(msg, "id") && strokes.length) idx = strokes.length - 1;
        if (idx < 0) return { changed: false };
        var removed = strokes.splice(idx, 1)[0];
        return { changed: true, removedId: removed.id };
      }
      case "clear":
        if (!strokes.length) return { changed: false };
        strokes.length = 0;
        return { changed: true };
      case "full-state":
        strokes.length = 0;
        (msg.strokes || []).forEach(function (st) {
          strokes.push({ id: st.id, color: st.color, size: st.size,
                         tool: st.tool || "pen",
                         points: (st.points || []).map(function (pt) { return [pt[0], pt[1], pt[2]]; }) });
        });
        return { changed: true };
      default:
        return { changed: false };
    }
  }

  function newId() {
    return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  // 与 Rust Board::validate_strokes / WebSocket 消息上限一致；任何一项失败都不替换当前板。
  // 常用色（iPad、电脑主窗口、标注层一致）；另有色盘可选任意颜色
  // [颜色, 中文名, 词条键]
  var PALETTE = [["#e5484d", "红", "red"], ["#f76b15", "橙", "orange"], ["#f5b700", "黄", "yellow"], ["#1f9d55", "绿", "green"], ["#2f6fed", "蓝", "blue"],
                 ["#8e4ec6", "紫", "purple"], ["#1a1a1a", "黑", "black"], ["#8b8d98", "灰", "gray"], ["#ffffff", "白", "white"]];
  // 笔头大小范围（世界单位 = 画布宽 / 1600），三端一致
  var PEN_SIZE_MIN = 1, PEN_SIZE_MAX = 48;
  var ARCHIVE_LIMITS = { bytes: 10 * 1024 * 1024, strokes: 2000, pointsPerStroke: 20000, points: 200000 };
  var TOOL_IDS = ["pen", "syrup", "gel", "looney", "marker", "eraser"];
  function validateArchive(data) {
    if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.strokes))
      throw new Error(L("arc.version", "存档格式或版本不支持（支持 v1 / v2）"));
    if (data.version === 2 && data.board !== "overlay") throw new Error(L("arc.notOverlay", "此文件不是屏幕标注存档"));
    if (data.strokes.length > ARCHIVE_LIMITS.strokes) throw new Error(L("arc.tooManyStrokes", "存档超过 2000 笔限制"));
    var ids = new Set(), total = 0;
    var result = data.strokes.map(function (s, index) {
      var label = L("arc.strokeN", "第 {n} 笔：", { n: index + 1 });
      if (!s || typeof s.id !== "string" || !s.id.length || new TextEncoder().encode(s.id).length > 128 || ids.has(s.id))
        throw new Error(label + L("arc.badId", "笔画编号缺失、重复或过长"));
      ids.add(s.id);
      if (typeof s.color !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.color))
        throw new Error(label + L("arc.badColor", "颜色必须是 #RGB 或 #RRGGBB"));
      if (!Number.isFinite(s.size) || s.size <= 0 || s.size > 100) throw new Error(label + L("arc.badSize", "笔宽超出范围"));
      if (TOOL_IDS.indexOf(s.tool) < 0 && !(typeof s.tool === "string" && s.tool.length <= 96 && /^v2\/[A-Za-z0-9.\/-]*$/.test(s.tool))) throw new Error(label + L("arc.badTool", "工具类型无效"));
      if (!Array.isArray(s.points) || s.points.length > ARCHIVE_LIMITS.pointsPerStroke)
        throw new Error(label + L("arc.badPoints", "点数组无效或超过 20000 点"));
      total += s.points.length;
      if (total > ARCHIVE_LIMITS.points) throw new Error(L("arc.tooManyPoints", "存档超过 200000 点限制"));
      var points = s.points.map(function (p) {
        if (!Array.isArray(p) || p.length !== 3 || p.some(function (n) { return !Number.isFinite(n) || n < 0 || n > 1; }))
          throw new Error(label + L("arc.badCoord", "坐标和压力必须是 0 到 1 的有限数值"));
        return p.slice();
      });
      return { id: s.id, color: s.color, size: s.size, tool: s.tool, points: points };
    });
    if (data.version === 2 && (!data.canvas || !Number.isFinite(data.canvas.width) || !Number.isFinite(data.canvas.height) ||
        data.canvas.width <= 0 || data.canvas.height <= 0 || data.canvas.width > 100000 || data.canvas.height > 100000))
      throw new Error(L("arc.badCanvas", "存档画布尺寸无效"));
    if (new TextEncoder().encode(JSON.stringify(boardLoadMsg(result))).length > ARCHIVE_LIMITS.bytes)
      throw new Error(L("arc.tooBig", "存档消息超过 10 MiB 限制"));
    return result;
  }

  // ---- SVG 导出 ----
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }
  function serializeSvg(strokes, w, h) {
    w = w || VW; h = h || VH;
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
               '" viewBox="0 0 ' + VW + ' ' + VH + '">',
               '<rect width="' + VW + '" height="' + VH + '" fill="#ffffff"/>'];
    strokes.forEach(function (s) {
      if (!s.points.length) return;
      var d = s.points.map(function (pt, i) {
        return (i === 0 ? "M" : "L") + (pt[0] * VW).toFixed(1) + " " + (pt[1] * VH).toFixed(1);
      }).join(" ");
      // 橡皮擦在导出时按白色笔画处理（白底等价）
      var color = s.tool === "eraser" ? "#ffffff" : s.color;
      var width = s.tool === "eraser" ? s.size * 2 : s.size;
      var op = s.tool === "marker" ? ' stroke-opacity="0.35"' : "";
      out.push('<path d="' + d + '" fill="none" stroke="' + esc(color) + '" stroke-width="' +
               width.toFixed(1) + '"' + op + ' stroke-linecap="round" stroke-linejoin="round"/>');
    });
    out.push("</svg>");
    return out.join("\n");
  }

  return {
    VW: VW, VH: VH,
    POINT_DISTANCE_CSS: POINT_DISTANCE_CSS, POINT_PRESSURE_DELTA: POINT_PRESSURE_DELTA,
    pointSampler: pointSampler, samplePoint: samplePoint, flushPoint: flushPoint,
    pointerPressure: pointerPressure, usageNotice: usageNotice,
    strokeStart: strokeStart, strokePoint: strokePoint, strokeEnd: strokeEnd,
    undoMsg: undoMsg, clearMsg: clearMsg, helloMsg: helloMsg, boardLoadMsg: boardLoadMsg,
    applyMessage: applyMessage, newId: newId, serializeSvg: serializeSvg,
    ARCHIVE_LIMITS: ARCHIVE_LIMITS, validateArchive: validateArchive,
    PALETTE: PALETTE, PEN_SIZE_MIN: PEN_SIZE_MIN, PEN_SIZE_MAX: PEN_SIZE_MAX
  };
});
