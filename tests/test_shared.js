// node tests/test_shared.js — 验证共享状态机（ESM）
import "../src/shared.js";
const WB = globalThis.Whiteboard;
import assert from "assert";

var strokes = [];
// 1. 一笔完整笔画
WB.applyMessage(strokes, WB.strokeStart("a", "#ff0000", 6, "pen"));
WB.applyMessage(strokes, WB.strokePoint("a", 0.1, 0.2, 0.5));
WB.applyMessage(strokes, WB.strokePoint("a", 0.3, 0.4, 0.8));
WB.applyMessage(strokes, WB.strokeEnd("a"));
assert.strictEqual(strokes.length, 1);
assert.strictEqual(strokes[0].points.length, 2);
assert.strictEqual(strokes[0].color, "#ff0000");

// 2. 重复 stroke-start 不重复建笔
var r = WB.applyMessage(strokes, WB.strokeStart("a", "#000", 4, "pen"));
assert.strictEqual(r.changed, false);
assert.strictEqual(strokes.length, 1);

// 3. 不存在的 point 被忽略
r = WB.applyMessage(strokes, WB.strokePoint("zzz", 0.5, 0.5, 0.5));
assert.strictEqual(r.changed, false);

// 4. undo 按 server 广播的 id 删除
WB.applyMessage(strokes, WB.strokeStart("b", "#0000ff", 4, "pen"));
WB.applyMessage(strokes, WB.strokePoint("b", 0.5, 0.5, 0.5));
r = WB.applyMessage(strokes, { t: "undo", id: "a" });
assert.strictEqual(r.changed, true);
assert.strictEqual(r.removedId, "a");
assert.strictEqual(strokes.length, 1);
assert.strictEqual(strokes[0].id, "b");

// 5. undo 不存在的 id 不变
r = WB.applyMessage(strokes, { t: "undo", id: "nope" });
assert.strictEqual(r.changed, false);

// 6. clear
r = WB.applyMessage(strokes, WB.clearMsg());
assert.strictEqual(r.changed, true);
assert.strictEqual(strokes.length, 0);
r = WB.applyMessage(strokes, WB.clearMsg());
assert.strictEqual(r.changed, false);

// 7. full-state 替换
WB.applyMessage(strokes, { t: "full-state", strokes: [
  { id: "x", color: "#000", size: 5, tool: "pen", points: [[0.1, 0.1, 0.5]] },
  { id: "y", color: "#000", size: 20, tool: "eraser", points: [[0.2, 0.2, 0.5]] }
]});
assert.strictEqual(strokes.length, 2);
assert.strictEqual(strokes[1].tool, "eraser");

// 8. SVG 导出：两笔 path + 白底 rect，橡皮擦按白色导出
var svg = WB.serializeSvg(strokes);
assert.ok(svg.indexOf("<svg") === 0);
assert.strictEqual((svg.match(/<path /g) || []).length, 2);
assert.ok(svg.indexOf('stroke="#ffffff"') !== -1);

// 9. 未知消息类型不崩
r = WB.applyMessage(strokes, { t: "whatever" });
assert.strictEqual(r.changed, false);

console.log("shared.js: 全部 9 组断言通过");
