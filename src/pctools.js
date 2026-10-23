// 墨投 · 电脑端书写工具（v0.8.5）：主窗口白板和屏幕标注层共用同一套界面和逻辑，与 iPad 一致
// 右上：画笔（再点一次选英文斜体 / 中国毛笔）、荧光笔、橡皮、颜色；左侧：笔头大小（拖动或直接输入）、撤销、重做、一键清除（可撤销）
// 工具设置存在本机（Ink.pcTool），两个窗口读写同一份：在哪个窗口选，另一个窗口跟着变
(function (root) {
  "use strict";
  var Ink = root.Ink, WB = root.Whiteboard, I18N = root.I18N, T = I18N.t;
  var SVG = function (d) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>"; };
  var ICON = {
    pen: SVG('<path d="M14.5 4.5l5 5-7 7-5-5z"/><path d="M7.5 11.5c-3 0-4 2.5-4 4.5 0 2-1 3-1 3s5 .5 7-1.5c1.2-1.2 1.5-2.5 1.5-3.5"/>'),
    marker: SVG('<path d="M14 4l6 6-7.5 7.5H8.5V13.5z"/><path d="M8.5 17.5L6 20H3l2.5-2.5"/><path d="M11 7l6 6"/>'),
    eraser: SVG('<path d="M8 20h12"/><path d="M4.6 15.4l9.8-9.8a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L11 19H8.2z"/><path d="M9 11l5 5"/>'),
    undo: SVG('<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 010 10h-2"/>'),
    redo: SVG('<path d="M15 7l4 4-4 4"/><path d="M19 11h-9a5 5 0 000 10h2"/>'),
    trash: SVG('<path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 12.5h9l1-12.5"/><path d="M10 11v5M14 11v5"/>')
  };
  var TOOLS =
      '<button type="button" id="t-pen" class="ib active" data-i18n-title="pad.penTitle">' + ICON.pen + '<span id="brush-name" class="sr"></span></button>' +
      '<button type="button" id="t-marker" class="ib" data-i18n-title="pad.markerTitle" data-i18n-aria="pad.marker">' + ICON.marker + "</button>" +
      '<button type="button" id="t-eraser" class="ib" data-i18n-title="tool.eraser" data-i18n-aria="tool.eraser">' + ICON.eraser + "</button>" +
      '<button type="button" id="custom-color" data-i18n-title="color.picker" data-i18n-aria="color.pickerShort"></button>';
  var SIZE =
      '<div id="sizebar" data-i18n-title="pad.sizeTitle"><div id="size-track"><div id="size-fill"></div><div id="size-thumb"></div></div></div>' +
      '<input id="size-val" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-i18n-title="pad.sizeInput" data-i18n-aria="pad.sizeInput">';
  var EDIT =
      '<button type="button" id="btn-undo" class="ib" data-i18n-title="tool.undoTitle" data-i18n-aria="tool.undo">' + ICON.undo + "</button>" +
      '<button type="button" id="btn-redo" class="ib" disabled data-i18n-title="pad.redoTitle" data-i18n-aria="pad.redo">' + ICON.redo + "</button>" +
      '<button type="button" id="btn-clear" class="ib danger" data-i18n-title="pad.quickClearTitle" data-i18n-aria="pad.clearAll">' + ICON.trash + "</button>";
  var POPS =
    '<div id="pc-brushes" class="tool-pop" hidden role="menu" data-i18n-aria="pad.brushMenu"></div>' +
    '<div id="pc-picker" class="tool-pop" hidden data-i18n-aria="color.pickerShort">' +
      '<div class="pk-swatches" id="colors"></div>' +
      '<label class="pk-custom"><span data-i18n="color.custom"></span><input type="color" id="color-input" value="#e5484d"></label>' +
    "</div>" +
    '<div id="undo-toast" hidden role="status"><span id="undo-toast-text"></span><button type="button" id="undo-toast-btn" class="primary" data-i18n="pad.undoClear"></button></div>';
  // 两种排列，控件和用法完全相同：
  //  "corners"（主窗口白板，与 iPad 一样）：右上 画笔 / 荧光笔 / 橡皮 / 颜色，左侧 大小竖条 / 撤销 / 清除
  //  "dock"（屏幕标注层）：全部集中在屏幕上方的一条工具栏里，鼠标不用在屏幕四角来回跑；opts.start / opts.end 放该窗口自己的按钮
  var CORNERS =
    '<div id="pc-toolbar" class="cluster">' + TOOLS + "</div>" + POPS +
    '<div id="pc-sidebar" class="cluster">' + SIZE + EDIT.replace('<button type="button" id="btn-clear"', '<div class="sb-sep"></div><button type="button" id="btn-clear"') + "</div>";
  function dockMarkup(start, end) {
    return '<div id="pc-dock" class="cluster dock">' + (start ? start + '<div class="div"></div>' : "") + TOOLS + '<div class="div"></div>' +
      '<div class="dock-size">' + SIZE + '</div><div class="div"></div>' + EDIT + (end ? '<div class="div"></div>' + end : "") + "</div>" + POPS;
  }

  // opts：sendSize(v, brush)、undo()、clear()、boardLoad(strokes)、strokes() 当前笔画、clearedKey 清除后提示的词条
  function mount(host, opts) {
    var dock = opts.layout === "dock";
    host.insertAdjacentHTML("beforeend", dock ? dockMarkup(opts.start, opts.end) : CORNERS);
    host.classList.add(dock ? "pct-dock" : "pct-corners");
    var $ = function (id) { return host.querySelector("#" + id); };
    // 工具栏模式下，弹出面板出现在点的按钮正下方
    function placePop(pop, btn) {
      if (!dock) return;
      var b = btn.getBoundingClientRect(), d = $("pc-dock").getBoundingClientRect(), w = pop.offsetWidth || 300;
      pop.style.top = Math.round(d.bottom + 8) + "px";
      pop.style.left = Math.round(Math.max(8, Math.min(root.innerWidth - w - 8, b.left + b.width / 2 - w / 2))) + "px";
    }
    var tool = Ink.pcTool();
    var brushPop = $("pc-brushes"), pickerPop = $("pc-picker");
    function closePops(except) {
      if (except !== "brushes") brushPop.hidden = true;
      if (except !== "picker") pickerPop.hidden = true;
    }
    function save() { Ink.savePcTool(tool); }
    function curColor() { return tool.kind === "marker" ? tool.markerColor : tool.color; }
    function update() {
      $("t-pen").classList.toggle("active", tool.kind === "write");
      $("t-marker").classList.toggle("active", tool.kind === "marker");
      $("t-eraser").classList.toggle("active", tool.kind === "eraser");
      $("brush-name").textContent = T("brush." + tool.brush);
      brushPop.querySelectorAll("button[data-brush]").forEach(function (b) { b.classList.toggle("active", b.dataset.brush === tool.brush); });
      var c = curColor();
      $("custom-color").style.setProperty("--c", c);
      $("colors").querySelectorAll(".swatch").forEach(function (b) { b.classList.toggle("active", tool.kind !== "eraser" && b.dataset.color === c); });
      $("color-input").value = c;
      updateSizeBar();
    }
    // 画笔菜单：每支画笔画一笔示例（同一个渲染引擎）
    function renderBrushMenu() {
      brushPop.innerHTML = "";
      Ink.PC_BRUSHES.forEach(function (id) {
        var b = document.createElement("button");
        b.type = "button"; b.dataset.brush = id; b.setAttribute("role", "menuitemradio");
        b.innerHTML = "<b></b><small></small><canvas></canvas>";
        b.querySelector("b").textContent = T("brush." + id);
        b.querySelector("small").textContent = T("brush." + id + ".use");
        b.addEventListener("click", function () { tool.brush = id; tool.kind = "write"; save(); brushPop.hidden = true; update(); });
        brushPop.appendChild(b);
      });
    }
    function drawBrushSamples() {
      brushPop.querySelectorAll("button[data-brush]").forEach(function (b) {
        var c = b.querySelector("canvas"), r = root.devicePixelRatio || 1, w = c.clientWidth || 150, h = c.clientHeight || 40;
        c.width = Math.round(w * r); c.height = Math.round(h * r);
        var g = c.getContext("2d"), br = Ink.BRUSHES[b.dataset.brush], inp = Ink.Input(br.dyn), out = [];
        for (var i = 0; i <= 90; i++) {
          var t = i / 90, x = 0.06 + 0.88 * t, y = 0.5 + 0.3 * Math.sin(t * Math.PI * 2.2);
          out = out.concat(inp.add(x * w, y * h, Math.max(0.01, 0.08 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.15))), i * 6));
        }
        out = out.concat(inp.finish());
        g.clearRect(0, 0, c.width, c.height);
        Ink.drawStroke(g, { id: "sample-" + b.dataset.brush, color: "#1a1a1a", size: br.sizes[1], tool: Ink.encodeTool(br.render),
          points: out.map(function (q) { return [q[0] / w, q[1] / h, q[2]]; }) }, { sx: c.width, sy: c.height, ox: 0, oy: 0, s: r * 1.1 }, true);
      });
    }
    $("t-pen").addEventListener("click", function () {
      if (tool.kind === "write") { var open = brushPop.hidden; closePops("brushes"); brushPop.hidden = !open; if (open) { placePop(brushPop, $("t-pen")); drawBrushSamples(); } return; }
      tool.kind = "write"; save(); closePops(); update();
    });
    $("t-marker").addEventListener("click", function () { tool.kind = "marker"; save(); closePops(); update(); });
    $("t-eraser").addEventListener("click", function () { tool.kind = "eraser"; save(); closePops(); update(); });
    // 颜色：9 个常用色 + 自定义；荧光笔的颜色单独记
    WB.PALETTE.forEach(function (p) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "swatch"; b.dataset.color = p[0]; b.style.background = p[0];
      b.title = p[2] ? T("color." + p[2]) : p[1];
      if (p[2]) b.setAttribute("data-i18n-title", "color." + p[2]);
      $("colors").appendChild(b);
    });
    function setColor(c) {
      if (tool.kind === "marker") tool.markerColor = c;
      else { tool.color = c; if (tool.kind === "eraser") tool.kind = "write"; }
      save(); update();
    }
    $("colors").addEventListener("click", function (e) { var b = e.target.closest(".swatch[data-color]"); if (b) { setColor(b.dataset.color); pickerPop.hidden = true; } });
    $("color-input").addEventListener("input", function (e) { setColor(e.target.value.toLowerCase()); });
    $("custom-color").addEventListener("click", function () { var open = pickerPop.hidden; closePops("picker"); pickerPop.hidden = !open; if (open) placePop(pickerPop, $("custom-color")); });
    document.addEventListener("pointerdown", function (e) {
      if (!e.target.closest || !e.target.closest("#pc-brushes, #pc-picker, #pc-toolbar, #pc-dock")) closePops();
    }, true);

    // 笔头大小：按工具分别记住；竖条拖动（对数刻度）或点数字直接输入；书写画笔的大小与 iPad 同步
    var sizeTrack = $("size-track"), sizeThumb = $("size-thumb"), sizeFill = $("size-fill"), sizeVal = $("size-val"), sizeTimer = null;
    function sizeKey() { return Ink.pcSizeKey(tool); }
    function fmtSize(v) { var r = Math.round(v * 10) / 10; return r < 10 ? r.toFixed(1) : String(r); }
    function updateSizeBar() {
      var r = Ink.pcSizeRange(sizeKey()), v = Ink.pcSize(sizeKey()), t = Math.log(v / r[0]) / Math.log(r[1] / r[0]);
      if (dock) { sizeThumb.style.left = (t * 100) + "%"; sizeFill.style.width = (t * 100) + "%"; } // 横向：向右变粗
      else { sizeThumb.style.top = ((1 - t) * 100) + "%"; sizeFill.style.height = (t * 100) + "%"; }
      if (document.activeElement !== sizeVal) sizeVal.value = fmtSize(v);
    }
    function setSize(v) {
      var key = sizeKey();
      v = Ink.setPcSize(key, v); updateSizeBar();
      if (Ink.PC_BRUSHES.indexOf(key) >= 0 && opts.sendSize) {
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(function () { opts.sendSize(v, key); }, 60);
      }
    }
    (function () {
      var dragging = null, bar = $("sizebar");
      function apply(e) {
        var b = sizeTrack.getBoundingClientRect(), r = Ink.pcSizeRange(sizeKey());
        var t = dock ? Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) : 1 - Math.max(0, Math.min(1, (e.clientY - b.top) / b.height));
        setSize(r[0] * Math.pow(r[1] / r[0], t));
      }
      bar.addEventListener("pointerdown", function (e) { e.preventDefault(); dragging = e.pointerId; try { bar.setPointerCapture(e.pointerId); } catch (err) {} apply(e); });
      bar.addEventListener("pointermove", function (e) { if (dragging === e.pointerId) apply(e); });
      function end(e) { if (dragging === e.pointerId) dragging = null; }
      bar.addEventListener("pointerup", end); bar.addEventListener("pointercancel", end);
    })();
    function commitSizeInput() {
      var v = parseFloat(String(sizeVal.value).replace(",", "."));
      if (isFinite(v) && v > 0) setSize(v); else updateSizeBar();
    }
    sizeVal.addEventListener("change", commitSizeInput);
    sizeVal.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); commitSizeInput(); sizeVal.blur(); } });
    sizeVal.addEventListener("focus", function () { try { sizeVal.select(); } catch (e) {} });
    // iPad（或另一个窗口）调了某支画笔的大小：只更新那一支
    function onRemoteSize(msg) {
      if (!msg.brush || Ink.PC_BRUSHES.indexOf(msg.brush) < 0 || !(+msg.size > 0)) return; // 没带画笔名的旧消息、iPad 自定义画笔：不影响电脑端
      Ink.setPcSize(msg.brush, +msg.size);
      if (sizeKey() === msg.brush) updateSizeBar();
    }
    // 另一个窗口改了工具设置：跟着更新
    function refresh() { tool = Ink.pcTool(); update(); }
    root.addEventListener("storage", function (e) { if (e.key && e.key.indexOf("wb_pc_") === 0) refresh(); });
    root.addEventListener("focus", refresh);

    // 撤销 / 一键清除（与 iPad 一样：点一下就清，不弹确认；误点了点“撤销”整板恢复）
    var clearUndo = null, toastTimer = null;
    function dropClearUndo() { clearUndo = null; clearTimeout(toastTimer); $("undo-toast").hidden = true; }
    function quickClear() {
      closePops();
      var snap = opts.strokes().filter(function (s) { return s.points && s.points.length; })
        .map(function (s) { return { id: s.id, color: s.color, size: s.size, tool: s.tool, points: s.points.map(function (q) { return q.slice(); }) }; });
      opts.clear();
      if (!snap.length) return;
      clearUndo = { strokes: snap };
      $("undo-toast-text").textContent = T(opts.clearedKey || "pad.clearedBoard"); $("undo-toast").hidden = false;
      clearTimeout(toastTimer); toastTimer = setTimeout(function () { $("undo-toast").hidden = true; }, 8000);
    }
    function restoreClear() {
      var u = clearUndo; dropClearUndo();
      if (!u || opts.strokes().length) return;
      opts.boardLoad(u.strokes);
    }
    function undo() { if (clearUndo && !opts.strokes().length) restoreClear(); else opts.undo(); }
    $("btn-undo").addEventListener("click", undo);

    // 重做（v0.8.7，与 iPad 一致）：只重做本窗口写的、刚被撤销的笔画（最多 50 笔）；写了新笔画或清除后不能再重做
    var own = {}, redoStack = [];
    function updateRedo() { $("btn-redo").disabled = !redoStack.length; }
    function noteMessage(msg) {
      if (!msg) return;
      if (msg.t === "clear") { redoStack = []; updateRedo(); return; }
      if (msg.t === "undo" && msg.id && own[msg.id]) {
        var s = opts.strokes().filter(function (x) { return x.id === msg.id; })[0];
        if (s && s.points && s.points.length) {
          redoStack.push({ color: s.color, size: s.size, tool: s.tool, points: s.points.map(function (q) { return q.slice(); }) });
          if (redoStack.length > 50) redoStack.shift();
          updateRedo();
        }
      }
    }
    function redo() {
      var r = redoStack.pop(); updateRedo();
      if (!r || !opts.sendStroke) return;
      var id = WB.newId(); own[id] = true;
      opts.sendStroke({ id: id, color: r.color, size: r.size, tool: r.tool, points: r.points });
    }
    $("btn-redo").addEventListener("click", redo);
    // 键盘：Ctrl+Z 撤销，Ctrl+Y / Ctrl+Shift+Z 重做（输入框里不拦截）
    root.addEventListener("keydown", function (e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (opts.active && !opts.active()) return;
      var t = e.target, tag = t && t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
      var k = (e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    });
    $("btn-clear").addEventListener("click", quickClear);
    $("undo-toast-btn").addEventListener("click", restoreClear);

    I18N.apply(host);
    renderBrushMenu();
    update();
    I18N.onChange(function () { renderBrushMenu(); update(); });
    return {
      tool: function () { return tool; },
      // 开始写一笔时调用：收起弹出面板；清除后写了新内容就不再提供“撤销清除”
      beginStroke: function (id) {
        closePops(); if (clearUndo) dropClearUndo();
        if (id) own[id] = true;
        if (redoStack.length) { redoStack = []; updateRedo(); }
      },
      // 宿主窗口收到服务器消息时（应用到笔画列表之前）调用：记下被撤销的本窗口笔画，供重做
      noteMessage: noteMessage,
      onRemoteSize: onRemoteSize, refresh: refresh, closePops: closePops
    };
  }
  root.PcTools = { mount: mount };
})(window);
