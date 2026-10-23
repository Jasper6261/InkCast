// 笔迹引擎（v0.6）：把一笔的采样点渲染成“有压感、有笔锋、平滑”的填充轮廓。
// iPad 与电脑端共用本文件，保证两边看到的笔迹完全一致。
//
// 算法（自写实现，思路与 Procreate / perfect-freehand 一类“变宽笔刷”相同）：
//   1. 采样点映射到像素坐标并去重；
//   2. 防抖（streamline）：指数平滑，消除手抖与网络抖动；
//   3. Catmull-Rom 样条重采样（约每 1px 一个点），曲线圆润不出折角；
//   4. 宽度：Pencil 用真实压力（带压感曲线，可反向）；可叠加速度；手指/鼠标用速度模拟；宽度再做平滑；
//      不透明度可随速度变化（凝胶墨水笔），按档位分层填充，层内不叠色；
//   5. 笔锋：起笔按长度渐粗；收笔（抬笔后）渐细；
//   6. 轮廓：每个采样点一个笔尖（圆，或固定角度的扁椭圆笔尖 = 书法“宽笔尖”效果）
//      + 相邻两个笔尖的外公切四边形，全部放进一个 Path2D 一次填充。
//      一次填充的并集不会叠加透明度，所以荧光笔也不会出现深浅不一的接缝。
// 不依赖 DOM（几何部分可在 Node 中测试）；Path2D 仅在绘制时使用。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Ink = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 画笔预设。前三项以外的参数取自用户提供的 Procreate .brush 解包数值（见 BRUSHES.md）
  //  k0：防抖（≈ Procreate StreamLine）
  //  thin / gamma：零压力时的最细比例 / 压感曲线指数（1 = 线性）；inv：反向压感量（压得越重越细）
  //  vel：速度→尺寸（负数 = 越快越细，正数 = 越快越粗）；speedBy："size" 按笔宽计速，"unit" 按画布计速
  //  sim：没有真实压力（手指/鼠标）时用速度模拟粗细
  //  aMin / aVel：速度→不透明度（最小不透明度 / 速度增益）
  //  nib：{ratio, angle}——扁笔尖（短轴/长轴，固定角度，弧度）；不写为圆笔尖
  //  ts / te：起笔、收笔笔锋长度（×笔宽）；f0 / f1：笔锋最细处比例
  var TOOLS = {
    pen:    { label: "钢笔", note: "默认 · 压感适中，带笔锋", k0: 0.45, thin: 0.22, gamma: 0.8, vel: -0.15, speedBy: "size", sim: true,
              ts: 1.6, te: 2.2, f0: 0.22, f1: 0.12, alpha: 1 },
    syrup:  { label: "糖露", note: "Procreate Syrup · 叶形扁笔尖，横细竖粗", k0: 0.371, thin: 0, gamma: 1, vel: 0, sim: true,
              nib: { ratio: 0.42, angle: -0.3 }, ts: 0.8, te: 2.6, f0: 0.35, f1: 0.15, alpha: 1 },
    gel:    { label: "凝胶墨水笔", note: "Procreate Gel Pen · 反向压感，越快越粗越实", k0: 0.06, thin: 1, gamma: 1, inv: 0.75,
              vel: 1.0, speedBy: "unit", aMin: 0.125, aVel: 0.621, ts: 0, te: 0, alpha: 1 },
    looney: { label: "Looney", note: "花体字 · 横向扁笔尖，收笔长尖尾", k0: 0.202, thin: 0, gamma: 1, vel: 0, sim: true,
              nib: { ratio: 0.482, angle: 0 }, ts: 0, te: 7, f0: 1, f1: 0, alpha: 1 },
    marker: { label: "荧光", note: "半透明划重点", k0: 0.35, alpha: 0.35 },
    eraser: { label: "橡皮", k0: 0, alpha: 1 } // v0.8.2：橡皮不做防抖平滑，擦到哪就是哪（也让 iPad 增量擦除与最终形状一致）
  };
  var MAX_SAMPLES = 8000;
  var UNIT_SPEED = 10; // “按画布计速”：每个采样点移动 10 个世界单位（画布宽 / 1600）视为快

  function toolOf(stroke) { return TOOLS[stroke.tool] || specOf(stroke.tool) || TOOLS.pen; }

  // ================= v2 自研笔刷 =================
  // 两层分工：
  //   笔感层（只在 iPad 上运行，Input）：有真实时间戳、压力、合并事件——做防抖、压感曲线、速度变化，
  //     把“最终宽度系数”烘焙进每个点的第三个值 p（0..1）后再发送；
  //   渲染层（两端相同，samplesOf/drawStroke）：只按点和工具串里的“渲染参数”画——笔尖形状、起收笔锋、透明度。
  // 所以电脑端不需要知道笔感参数，iPad 上自定义的笔刷在电脑上也完全一样。
  // 工具串格式：v2/n<扁度>/a<角度°>/s<起锋>/e<收锋>/f<起锋最细>/g<收锋最细>/o<不透明度>，例：v2/n1/a0/s0.6/e1.2/f0.6/g0.35/o1
  var SPEC_KEYS = { n: "ratio", a: "angle", s: "ts", e: "te", f: "f0", g: "f1", o: "alpha" };
  var specCache = {};
  function specOf(tool) {
    if (typeof tool !== "string" || tool.slice(0, 3) !== "v2/") return null;
    if (specCache[tool]) return specCache[tool];
    var r = { ratio: 1, angle: 0, ts: 0, te: 0, f0: 1, f1: 1, alpha: 1 };
    tool.slice(3).split("/").forEach(function (part) {
      var k = SPEC_KEYS[part[0]], v = parseFloat(part.slice(1));
      if (k && isFinite(v)) r[k] = v;
    });
    var spec = {
      label: "自定义", baked: true, thin: 0, k0: 0,
      nib: r.ratio < 0.99 ? { ratio: Math.max(0.1, Math.min(1, r.ratio)), angle: r.angle * Math.PI / 180 } : null,
      ts: Math.max(0, Math.min(8, r.ts)), te: Math.max(0, Math.min(10, r.te)),
      f0: Math.max(0, Math.min(1, r.f0)), f1: Math.max(0, Math.min(1, r.f1)),
      alpha: Math.max(0.05, Math.min(1, r.alpha))
    };
    specCache[tool] = spec;
    return spec;
  }
  function num(v) { return String(Math.round(v * 1000) / 1000); }
  function encodeTool(r) {
    return "v2/n" + num(r.ratio) + "/a" + num(r.angle) + "/s" + num(r.ts) + "/e" + num(r.te) +
           "/f" + num(r.f0) + "/g" + num(r.f1) + "/o" + num(r.alpha);
  }

  // 预设：笔感参数 dyn + 渲染参数 render
  //  dyn.stab：稳定度 0..1（One Euro 滤波，慢写时抹平手抖，快写时几乎不拖线）
  //  dyn.pFull：多大的笔压算“写满”。实测（2026-10-18 诊断，7147 个采样）：网页拿到的 Pencil 压力中位数 0.11、
  //    95% 分位 0.22、最大 0.32——远低于直觉的 0.5。所以默认 0.22，并提供“按我的笔压校准”
  //  dyn.gamma：压感曲线（>1 轻压更细、需要用力才粗；<1 轻压就粗）
  //  dyn.minW：零压力时的最细比例；dyn.speed：写快变细的程度（0..1）；dyn.pSmooth：压力平滑时间（毫秒）
  //  render：见上面的工具串；sizes：细/中/粗（世界单位，画布宽 / 1600）
  // v0.8.2 起菜单里只有“英文斜体”和“中国毛笔”两支；签字笔、硬笔书法的定义保留，
  // 用来继续支持以它们为底的自定义画笔（菜单里不再显示）
  var BRUSHES = {
    gel05:   { label: "签字笔", use: "日常笔记、批注、画图", note: "圆笔尖，轻写细、重写粗，快写略细，干净利落",
               dyn: { stab: 0.35, pFull: 0.22, gamma: 1.15, minW: 0.28, speed: 0.3, pSmooth: 12 },
               render: { ratio: 1, angle: 0, ts: 0.5, te: 1.4, f0: 0.5, f1: 0.25, alpha: 1 }, sizes: [2.5, 3.5, 5] },
    callig:  { label: "硬笔书法", use: "中文、有笔锋", note: "扁笔尖横细竖粗，轻提细、重按粗，收笔出锋",
               dyn: { stab: 0.3, pFull: 0.22, gamma: 1.25, minW: 0.12, speed: 0.2, pSmooth: 10 },
               render: { ratio: 0.55, angle: -25, ts: 0.8, te: 3.2, f0: 0.35, f1: 0.04, alpha: 1 }, sizes: [4, 6, 9] },
    italic:  { label: "英文斜体", use: "英文手写、标题", note: "45° 宽笔尖，下笔粗、连笔细，几乎不靠压力",
               dyn: { stab: 0.35, pFull: 0.22, gamma: 0.9, minW: 0.45, speed: 0.1, pSmooth: 14 },
               render: { ratio: 0.28, angle: -45, ts: 0.4, te: 0.8, f0: 0.6, f1: 0.4, alpha: 1 }, sizes: [4, 6, 9] },
    soft:    { label: "中国毛笔", use: "大字、签名、强调", note: "软圆笔头，粗细对比最大，起笔尖、收笔拖出长锋",
               dyn: { stab: 0.45, pFull: 0.22, gamma: 1.6, minW: 0.04, speed: 0.35, pSmooth: 14 },
               render: { ratio: 0.8, angle: -35, ts: 1.4, te: 5, f0: 0.15, f1: 0.02, alpha: 1 }, sizes: [6, 9, 16] }
  };


  // ---------- 笔感层 v3：去重 + 居中二项式平滑 + 压感曲线 + 速度 ----------
  // 实测（2026-10-18 诊断）：iPad 浏览器给的 Pencil 坐标是整数 CSS 像素（2424 个采样里 0 个小数），
  // 且约 42% 的事件是完全重复的。整数坐标在小字上形成“台阶”，这就是笔画边缘的锯齿；
  // 重复事件让速度忽快忽慢，宽度跟着抖。
  // 处理：① 去掉重复事件；② 对位置和压力做“居中”二项式平滑（用前后各 R 个采样加权平均），
  //   台阶被平均掉而不产生单向拖尾；③ 只有拿到后面 R 个采样的点才“定稿”发送，
  //   最后 R 个点作为临时尾巴只在 iPad 本地显示，所以本地笔迹始终贴着笔尖；
  // ④ 抬笔时窗口对称收窄，最后一点正好落在笔尖。
  // dyn：笔感参数；opts.rawPressure：w 直接用平滑后的压力（Procreate 复刻笔刷）
  // 返回 {add(x,y,pressure|null,tMs) -> [[x,y,w],...] 新定稿的点, tail() -> 临时尾巴, finish() -> 剩余点}
  function binom(n) { var r = [1]; for (var i = 0; i < n; i++) { var nx = [1]; for (var j = 1; j <= i; j++) nx.push(r[j - 1] + r[j]); nx.push(1); r = nx; } return r; }
  function Input(dyn, opts) {
    opts = opts || {};
    // opts.R === 0：不平滑、不延迟，每个点立即定稿（橡皮擦用）
    var R = opts.R === 0 ? 0 : Math.max(1, Math.min(5, Math.round(1 + 4 * Math.max(0, Math.min(1, dyn.stab)))));
    var K = binom(2 * R);
    var raw = [], done = 0;
    function point(i) {
      var n = raw.length, m = Math.min(R, i, n - 1 - i), sx = 0, sy = 0, sp = 0, sw = 0, hasP = raw[i][2] !== null;
      for (var k = -m; k <= m; k++) {
        var wk = K[R + k], q = raw[i + k];
        sx += wk * q[0]; sy += wk * q[1]; if (hasP && q[2] !== null) sp += wk * q[2]; sw += wk;
      }
      var x = sx / sw, y = sy / sw, pr = hasP ? sp / sw : null;
      // 速度（CSS 像素/毫秒）：用前后各 2 个采样之间的距离和真实时间
      var a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2), dtm = raw[b][3] - raw[a][3];
      var v = dtm > 0.5 ? Math.hypot(raw[b][0] - raw[a][0], raw[b][1] - raw[a][1]) / dtm : 0;
      var w;
      if (opts.rawPressure) w = pr === null ? 0.5 : pr;
      else if (pr === null && opts.mouseSim) {
        // 电脑鼠标（v0.8.2）：没有压力，用速度模拟“笔压”——慢写重、快写轻，再走这支笔自己的压感曲线，
        // 所以中国毛笔用鼠标也能写出粗细变化，英文斜体变化较小
        var qm = 0.22 + 0.78 * Math.max(0, 1 - v / 1.6);
        w = dyn.minW + (1 - dyn.minW) * Math.pow(qm, dyn.gamma);
      }
      else if (pr === null) w = 1 - 0.45 * Math.min(1, v / 2.5);           // 手指 / 鼠标：用速度模拟
      else {
        var q2 = Math.pow(Math.min(1, pr / Math.max(0.03, dyn.pFull)), dyn.gamma);
        w = (dyn.minW + (1 - dyn.minW) * q2) * (1 - dyn.speed * Math.min(1, v / 2.5));
      }
      return [x, y, Math.max(0.02, Math.min(1, w))];
    }
    return {
      R: R,
      add: function (x, y, pr, t) {
        var last = raw[raw.length - 1];
        if (!isFinite(t)) t = last ? last[3] + 4 : 0;
        if (last && last[0] === x && last[1] === y && last[2] === pr) return [];   // 重复事件
        if (last && t < last[3]) t = last[3];
        raw.push([x, y, pr, t]);
        var out = [];
        while (done + R < raw.length) out.push(point(done++));
        return out;
      },
      tail: function () { var out = []; for (var i = done; i < raw.length; i++) out.push(point(i)); return out; },
      finish: function () { var out = []; while (done < raw.length) out.push(point(done++)); return out; }
    };
  }
  function thinning(tool) { return tool.thin !== undefined; }

  // 压力是否真实：Pencil 的压力会变化；鼠标/手指是常数
  function hasRealPressure(points) {
    if (!points.length) return false;
    var p0 = points[0][2];
    for (var i = 1; i < points.length; i++) if (Math.abs(points[i][2] - p0) > 1e-3) return true;
    return false;
  }

  function easeOut(t) { t = Math.max(0, Math.min(1, t)); return t * (2 - t); }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // 返回 {samples:[[x,y,r,a],...]} —— 像素坐标、半径（扁笔尖为长半轴）、不透明度
  function samplesOf(stroke, xf, final) {
    var pts = stroke.points || [];
    // 橡皮宽度沿用旧版约定：size × 2
    var sizePx = Math.max(0.5, (stroke.size || 4) * (xf.s || 1) * (stroke.tool === "eraser" ? 2 : 1));
    var tool = toolOf(stroke);
    if (!pts.length) return { samples: [], sizePx: sizePx };

    // 1. 映射 + 去重
    var raw = [];
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0] * xf.sx + (xf.ox || 0), y = pts[i][1] * xf.sy + (xf.oy || 0);
      var p = pts[i][2] == null ? 0.5 : pts[i][2];
      var last = raw[raw.length - 1];
      if (last && Math.abs(last[0] - x) < 0.3 && Math.abs(last[1] - y) < 0.3) { last[2] = Math.max(last[2], p); continue; }
      raw.push([x, y, p]);
    }
    var real = tool.baked ? true : hasRealPressure(pts);

    // 2. 防抖：自适应指数平滑——小幅抖动（几像素内）抹平，大幅移动跟随原始轨迹，避免稀疏点时“切弯”变形；
    //    最后一个原始点总是保留，笔迹跟到笔尖
    var k0 = tool.k0, jitterPx = Math.max(3, sizePx * 0.8);
    var sm = [raw[0].slice()];
    for (i = 1; i < raw.length; i++) {
      var q = sm[sm.length - 1];
      var dd = Math.hypot(raw[i][0] - q[0], raw[i][1] - q[1]);
      var k = k0 * Math.max(0, 1 - dd / jitterPx);
      sm.push([q[0] + (raw[i][0] - q[0]) * (1 - k), q[1] + (raw[i][1] - q[1]) * (1 - k), raw[i][2]]);
    }
    if (raw.length > 1) sm.push(raw[raw.length - 1].slice());

    // 4a. 每个平滑点的宽度系数 w 与不透明度 a
    //     速度只取决于相邻点的位移（点本身带着），两端算出来一样
    var w = new Array(sm.length), al = new Array(sm.length), unitPx = Math.max(1e-6, xf.s || 1);
    for (i = 0; i < sm.length; i++) {
      var d = i ? Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1]) : 0;
      var speed = tool.speedBy === "unit" ? clamp01(d / unitPx / UNIT_SPEED) : clamp01(d / (sizePx * 2.2));
      var wi;
      if (tool.baked) wi = clamp01(sm[i][2]);
      else if (!thinning(tool)) wi = 1;
      else if (!real && tool.sim) wi = 1 - 0.55 * speed * (1 - Math.min(tool.thin, 0.45));
      else {
        var pr = real ? clamp01(sm[i][2]) : 0.5;
        wi = tool.thin + (1 - tool.thin) * Math.pow(pr, tool.gamma);
        if (tool.inv) wi *= 1 - tool.inv * pr;
        if (tool.vel > 0) wi *= 0.45 + tool.vel * speed;      // 越快越粗
        else if (tool.vel < 0) wi *= 1 + tool.vel * speed;    // 越快越细
        wi = Math.max(0.03, Math.min(1.2, wi));
      }
      var ai = tool.aMin !== undefined ? Math.max(tool.aMin, Math.min(1, 0.45 + tool.aVel * speed)) : 1;
      w[i] = i && !tool.baked ? w[i - 1] + (wi - w[i - 1]) * 0.35 : wi; // 宽度平滑（v2 已在 iPad 上平滑过）
      al[i] = i ? al[i - 1] + (ai - al[i - 1]) * 0.25 : ai;
    }

    // 3. Catmull-Rom 重采样（约 1px），宽度、不透明度线性插值
    //    v0.8.15：很长的笔画（尤其来回涂抹的橡皮）放大后按 1px 会超过 MAX_SAMPLES；以前直接截断，
    //    后半段没画出来——放大后橡皮擦过的地方又露出笔迹。现在按总长加大间距，整笔都画到
    var polyLen = 0;
    for (i = 1; i < sm.length; i++) polyLen += Math.hypot(sm[i][0] - sm[i - 1][0], sm[i][1] - sm[i - 1][1]);
    var step = Math.max(1, polyLen / MAX_SAMPLES);
    var out = [];
    if (sm.length === 1) out.push([sm[0][0], sm[0][1], w[0], al[0]]);
    for (i = 0; i < sm.length - 1; i++) {
      var p0 = sm[Math.max(0, i - 1)], p1 = sm[i], p2 = sm[i + 1], p3 = sm[Math.min(sm.length - 1, i + 2)];
      var seg = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      var n = Math.max(1, Math.min(96, Math.ceil(seg / step)));
      for (var j = 0; j < n; j++) {
        var t = j / n, t2 = t * t, t3 = t2 * t;
        var cx = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
        var cy = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
        out.push([cx, cy, w[i] + (w[i + 1] - w[i]) * t, al[i] + (al[i + 1] - al[i]) * t]);
      }
    }
    if (sm.length > 1) { var e = sm[sm.length - 1]; out.push([e[0], e[1], w[w.length - 1], al[al.length - 1]]); }

    // 5. 笔锋：累计长度
    var len = [0];
    for (i = 1; i < out.length; i++) len.push(len[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
    var total = len[len.length - 1];
    var ts = thinning(tool) && tool.ts ? Math.min(sizePx * tool.ts * (real ? 1 : 1.5), total * 0.3) : 0;
    var te = thinning(tool) && tool.te && (final || !real) ? Math.min(sizePx * tool.te * (real ? 1 : 1.5), total * (tool.te > 4 ? 0.5 : 0.35)) : 0;
    var half = sizePx / 2;
    for (i = 0; i < out.length; i++) {
      var f = 1;
      if (ts > 0) f *= tool.f0 + (1 - tool.f0) * easeOut(len[i] / ts);
      if (te > 0) f *= tool.f1 + (1 - tool.f1) * easeOut((total - len[i]) / te);
      out[i][2] = Math.max(0.35, half * out[i][2] * f);
    }
    return { samples: out, sizePx: sizePx, length: total };
  }

  function quadArea(q) {
    var area = 0;
    for (var i = 0; i < 4; i++) { var u = q[i], v = q[(i + 1) % 4]; area += u[0] * v[1] - v[0] * u[1]; }
    return area;
  }
  // 两圆外公切梯形（保证正向绕序，和 arc 一致，并集填充不会互相抵消）
  function hull(a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d < 1e-6 || d <= Math.abs(a[2] - b[2])) return null;
    var th = Math.atan2(dy, dx), ph = Math.acos((a[2] - b[2]) / d);
    var q = [
      [a[0] + a[2] * Math.cos(th + ph), a[1] + a[2] * Math.sin(th + ph)],
      [b[0] + b[2] * Math.cos(th + ph), b[1] + b[2] * Math.sin(th + ph)],
      [b[0] + b[2] * Math.cos(th - ph), b[1] + b[2] * Math.sin(th - ph)],
      [a[0] + a[2] * Math.cos(th - ph), a[1] + a[2] * Math.sin(th - ph)]
    ];
    return quadArea(q) >= 0 ? q : q.reverse();
  }
  // 扁笔尖：椭圆在法线方向的支撑点（相对圆心）
  function nibSupport(r, nib, nx, ny) {
    var ca = Math.cos(nib.angle), sa = Math.sin(nib.angle), A = r, B = Math.max(0.3, r * nib.ratio);
    var lx = nx * ca + ny * sa, ly = -nx * sa + ny * ca;
    var m = Math.sqrt(A * A * lx * lx + B * B * ly * ly) || 1;
    var sx = A * A * lx / m, sy = B * B * ly / m;
    return [sx * ca - sy * sa, sx * sa + sy * ca];
  }
  // 两个扁笔尖之间的连接四边形（Minkowski 扫掠）
  function nibHull(a, b, nib) {
    var dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
    if (d < 1e-6) return null;
    var nx = -dy / d, ny = dx / d, sa = nibSupport(a[2], nib, nx, ny), sb = nibSupport(b[2], nib, nx, ny);
    var q = [[a[0] + sa[0], a[1] + sa[1]], [b[0] + sb[0], b[1] + sb[1]], [b[0] - sb[0], b[1] - sb[1]], [a[0] - sa[0], a[1] - sa[1]]];
    return quadArea(q) >= 0 ? q : q.reverse();
  }

  // 几何：{circles, quads, nib}（Node 测试用）。minA：只取不透明度 ≥ minA 的部分（分层用）
  function outline(stroke, xf, final, minA, cached) {
    var tool = toolOf(stroke), s = cached || samplesOf(stroke, xf, final).samples, quads = [], circles = [];
    var keep = function (c) { return minA === undefined || c[3] >= minA - 1e-9; };
    for (var i = 0; i < s.length; i++) {
      if (!keep(s[i])) continue;
      circles.push(s[i]);
      if (i && keep(s[i - 1])) { var h = tool.nib ? nibHull(s[i - 1], s[i], tool.nib) : hull(s[i - 1], s[i]); if (h) quads.push(h); }
    }
    return { circles: circles, quads: quads, nib: tool.nib || null };
  }

  function geomPath(g) {
    var path = new Path2D(), i;
    for (i = 0; i < g.circles.length; i++) {
      var c = g.circles[i];
      if (g.nib) {
        var A = c[2], B = Math.max(0.3, c[2] * g.nib.ratio), an = g.nib.angle;
        path.moveTo(c[0] + A * Math.cos(an), c[1] + A * Math.sin(an));
        path.ellipse(c[0], c[1], A, B, an, 0, Math.PI * 2, false);
      } else {
        path.moveTo(c[0] + c[2], c[1]);
        path.arc(c[0], c[1], c[2], 0, Math.PI * 2, false);
      }
    }
    for (i = 0; i < g.quads.length; i++) {
      var q = g.quads[i];
      path.moveTo(q[0][0], q[0][1]); path.lineTo(q[1][0], q[1][1]);
      path.lineTo(q[2][0], q[2][1]); path.lineTo(q[3][0], q[3][1]); path.closePath();
    }
    return path;
  }

  // 返回分层路径 [{a, path}]：不透明度恒定的画笔只有一层；凝胶墨水笔按 1/8 档分层，
  // 层层嵌套（高档是低档的子集），逐层叠加后每处正好是它所在档位的不透明度，层内不叠色
  function strokeLayers(stroke, xf, final) {
    var key = [xf.sx, xf.sy, xf.ox || 0, xf.oy || 0, xf.s || 1, final ? 1 : 0, (stroke.points || []).length, stroke.size, stroke.tool].join(",");
    if (stroke._ink && stroke._ink.key === key) return stroke._ink.layers;
    var tool = toolOf(stroke), layers;
    if (tool.aMin === undefined) layers = [{ a: 1, path: geomPath(outline(stroke, xf, final)) }];
    else {
      var s = samplesOf(stroke, xf, final).samples, lv = {}, levels = [];
      s.forEach(function (c) { c[3] = Math.ceil(c[3] * 8 - 1e-6) / 8; lv[c[3]] = true; });
      Object.keys(lv).map(Number).sort(function (x, y) { return x - y; }).forEach(function (L) { levels.push(L); });
      layers = [];
      var prev = 0;
      levels.forEach(function (L) {
        layers.push({ a: prev >= 1 ? 0 : Math.min(1, 1 - (1 - L) / (1 - prev)), path: geomPath(outline(stroke, xf, final, L, s)) });
        prev = L;
      });
    }
    try { Object.defineProperty(stroke, "_ink", { value: { key: key, layers: layers }, writable: true, configurable: true, enumerable: false }); } catch (e) {}
    return layers;
  }

  // 填充 + 同色细描边：许多子路径并集填充时，浏览器的抗锯齿会在相邻小块之间留下发丝状白缝，
  // 沿同一路径描一圈约 1px 的边可以把缝补上（外轮廓只外扩约 0.5px，肉眼无差别）。
  function paint(ctx, path) {
    ctx.fill(path, "nonzero");
    ctx.lineWidth = 1; ctx.lineJoin = "round"; ctx.stroke(path);
  }
  var scratch = null;
  function scratchFor(w, h) {
    if (!scratch) scratch = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : document.createElement("canvas");
    if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h; }
    return scratch;
  }

  // 画一笔。final=false 表示正在书写（不做收笔锋）
  // opts.eraserPaint：在白纸上用纸色覆盖代替“挖透明洞”
  function drawStroke(ctx, stroke, xf, final, opts) {
    if (!stroke.points || !stroke.points.length) return;
    var tool = toolOf(stroke), layers = strokeLayers(stroke, xf, final);
    ctx.save();
    if (stroke.tool === "eraser" && opts && opts.eraserPaint) {
      ctx.fillStyle = ctx.strokeStyle = opts.eraserPaint; paint(ctx, layers[0].path);
    } else if (stroke.tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = ctx.strokeStyle = "#000"; paint(ctx, layers[0].path);
    } else if ((tool.alpha < 1 || layers.length > 1 || layers[0].a < 1) && ctx.canvas) {
      // 半透明：先在临时画布上逐层画，再整体按透明度贴上，避免同一笔内颜色叠深
      var c = scratchFor(ctx.canvas.width, ctx.canvas.height), g = c.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height);
      g.setTransform(ctx.getTransform());
      g.fillStyle = g.strokeStyle = stroke.color || "#000";
      layers.forEach(function (L) { if (L.a > 0) { g.globalAlpha = L.a; paint(g, L.path); } });
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = tool.alpha; ctx.drawImage(c, 0, 0);
    } else {
      ctx.fillStyle = ctx.strokeStyle = stroke.color || "#000"; paint(ctx, layers[0].path);
    }
    ctx.restore();
  }

  // 橡皮擦增量擦除：只把这一笔新增的几段直接从画布上擦掉（不整层重画），每帧工作量和笔画多少无关。
  // from = 上次擦到的点数；返回新的点数。iPad、电脑标注层共用（v0.8.2 起 iPad 用，v0.8.9 标注层也用）
  function eraseSegment(ctx, stroke, xf, from) {
    var pts = stroke.points || [];
    if (!(from >= 0) || from > pts.length) from = 0;
    if (from >= pts.length) return from;
    var w = Math.max(0.5, (stroke.size || 4) * xf.s * 2), i0 = Math.max(0, from - 1);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = ctx.strokeStyle = "#000";
    ctx.lineWidth = w; ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    var p = pts[i0], x = p[0] * xf.sx + xf.ox, y = p[1] * xf.sy + xf.oy;
    if (i0 === pts.length - 1) { ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.moveTo(x, y); for (var i = i0 + 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * xf.sx + xf.ox, pts[i][1] * xf.sy + xf.oy); ctx.stroke(); }
    ctx.restore();
    return pts.length;
  }

  // ---------- 电脑端书写工具（v0.8.4）：主窗口和屏幕标注层共用一套，与 iPad 同样的用法 ----------
  // 工具：画笔（英文斜体 / 中国毛笔）、荧光笔、橡皮；颜色与荧光笔颜色分开记；笔头大小按“画笔 / 荧光笔 / 橡皮”分别记住
  // 状态存在本机（两个窗口同源，读同一份），所以在主窗口选好，屏幕标注层直接沿用
  var PC_BRUSHES = ["italic", "soft"];
  var PC_SIZE_RANGE = { write: [1, 48], marker: [4, 96], eraser: [3, 96] };
  var PC_SIZE_DEFAULT = { marker: 16, eraser: 10 };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  // v0.8.7：旧版本（v0.8.2 前后）连接 iPad 时会把 iPad 当时的粗细存进电脑端，升级后英文斜体 / 中国毛笔不是新默认值（6 / 9）。
  // 与 iPad 端的 wb_sz_rev 相同做法：升级时清一次这两支笔记住的大小
  if (lsGet("wb_pc_sz_rev") !== "1") {
    try { localStorage.removeItem("wb_pc_sz_italic"); localStorage.removeItem("wb_pc_sz_soft"); } catch (e) {}
    lsSet("wb_pc_sz_rev", "1");
  }
  function hexOr(v, d) { return /^#[0-9a-f]{6}$/i.test(v || "") ? v.toLowerCase() : d; }
  function pcTool() {
    var kind = lsGet("wb_pc_kind"), brush = lsGet("wb_pc_brush");
    if (brush === "marker") { kind = kind || "marker"; brush = null; } // v0.8.2/0.8.3 把荧光笔当作一支画笔记
    if (kind !== "marker" && kind !== "eraser") kind = "write";
    if (PC_BRUSHES.indexOf(brush) < 0) brush = PC_BRUSHES[0];
    return { kind: kind, brush: brush, color: hexOr(lsGet("wb_pc_color"), "#e5484d"), markerColor: hexOr(lsGet("wb_pc_mcolor"), "#f5b700") };
  }
  function savePcTool(t) {
    lsSet("wb_pc_kind", t.kind); lsSet("wb_pc_brush", t.brush);
    lsSet("wb_pc_color", t.color); lsSet("wb_pc_mcolor", t.markerColor);
  }
  function pcSizeKey(t) { return t.kind === "write" ? t.brush : t.kind; }
  function pcSizeRange(key) { return PC_SIZE_RANGE[key === "marker" || key === "eraser" ? key : "write"]; }
  // 默认值与 iPad 相同：英文斜体 6、中国毛笔 9、荧光笔 16、橡皮 10
  function pcSize(key) {
    var r = pcSizeRange(key), v = parseFloat(lsGet("wb_pc_sz_" + key));
    if (v >= r[0] && v <= r[1]) return v;
    return BRUSHES[key] ? BRUSHES[key].sizes[1] : (PC_SIZE_DEFAULT[key] || 6);
  }
  function setPcSize(key, v) {
    var r = pcSizeRange(key); v = Math.max(r[0], Math.min(r[1], +v));
    if (!isFinite(v)) return pcSize(key);
    v = Math.round(v * 10) / 10; lsSet("wb_pc_sz_" + key, String(v)); return v;
  }
  // 一笔的工具串、大小、颜色和笔感层（坐标用 CSS 像素，时间用毫秒）。
  // 鼠标没有压力：用书写速度模拟（慢写粗、快写细）；数位板用真实压力
  function pcStroke(t) {
    var key = pcSizeKey(t), size = pcSize(key);
    if (t.kind === "eraser") return { tool: "eraser", size: size, color: "#000000", input: Input({ stab: 0 }, { rawPressure: true, R: 0 }) };
    if (t.kind === "marker") return { tool: "marker", size: size, color: t.markerColor, input: Input({ stab: 0 }, { rawPressure: true }) };
    var b = BRUSHES[t.brush] || BRUSHES[PC_BRUSHES[0]];
    var dyn = {}; for (var k in b.dyn) dyn[k] = b.dyn[k];
    dyn.pFull = 0.6; // 数位板的压力范围是完整的 0–1（iPad 网页拿到的压力偏小，所以 iPad 默认 0.22）
    dyn.stab = 0;    // 电脑端：平滑窗口取最小（前后各 1 个采样），笔迹紧跟鼠标
    return { tool: encodeTool(b.render), size: size, color: t.color, input: Input(dyn, { mouseSim: true }) };
  }

  return { PC_BRUSHES: PC_BRUSHES, PC_SIZE_RANGE: PC_SIZE_RANGE, pcTool: pcTool, savePcTool: savePcTool, pcSizeKey: pcSizeKey, pcSizeRange: pcSizeRange,
           pcSize: pcSize, setPcSize: setPcSize, pcStroke: pcStroke, drawStroke: drawStroke, eraseSegment: eraseSegment, outline: outline, samplesOf: samplesOf, hasRealPressure: hasRealPressure, TOOLS: TOOLS,
           BRUSHES: BRUSHES, Input: Input, encodeTool: encodeTool, specOf: specOf, toolOf: toolOf };
});
