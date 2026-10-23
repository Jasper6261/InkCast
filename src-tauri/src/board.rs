//! 白板状态机：棋盘是唯一的事实来源。
//! pad / viewer 发来的 ClientMsg 在这里应用；错误与笔画修正由连接层定向回复。
//! 与 src/shared.js 的 applyMessage 保持语义一致。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_STROKES: usize = 2_000;
pub const MAX_POINTS_PER_STROKE: usize = 20_000;
pub const MAX_TOTAL_POINTS: usize = 200_000;

/// 归一化坐标点 (x, y in 0..1, 压力 p in 0..1)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Point(pub f32, pub f32, pub f32);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Stroke {
    pub id: String,
    pub color: String,
    pub size: f32,
    pub tool: String, // "pen" | "eraser"
    pub points: Vec<Point>,
}

/// pad / viewer -> server
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum ClientMsg {
    #[serde(rename = "stroke-start")]
    StrokeStart { id: String, color: String, size: f32, tool: Option<String> },
    #[serde(rename = "stroke-point")]
    StrokePoint { id: String, x: f32, y: f32, p: Option<f32>, ts: Option<u64> },
    #[serde(rename = "stroke-end")]
    StrokeEnd { id: String },
    #[serde(rename = "undo")]
    Undo,
    #[serde(rename = "clear")]
    Clear,
    #[serde(rename = "board-load")]
    BoardLoad { strokes: Vec<Stroke> },
}

/// server -> clients（绘画/控制广播；错误与修正只回发起连接）
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "t")]
pub enum ServerMsg {
    #[serde(rename = "stroke-start")]
    StrokeStart { id: String, color: String, size: f32, tool: String },
    #[serde(rename = "stroke-point")]
    StrokePoint { id: String, x: f32, y: f32, p: f32, ts: Option<u64> },
    #[serde(rename = "stroke-end")]
    StrokeEnd { id: String },
    #[serde(rename = "undo")]
    Undo { id: Option<String> },
    #[serde(rename = "clear")]
    Clear,
    #[serde(rename = "full-state")]
    FullState { strokes: Vec<Stroke> },
    #[serde(rename = "pad-status")]
    PadStatus { online: usize },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "stroke-rejected")]
    StrokeRejected { id: String, reason: String },
    #[serde(rename = "stroke-truncate")]
    StrokeTruncate { id: String, len: usize, reason: String },
    #[serde(rename = "board-usage")]
    BoardUsage {
        points: usize,
        #[serde(rename = "maxPoints")]
        max_points: usize,
        strokes: usize,
        #[serde(rename = "maxStrokes")]
        max_strokes: usize,
    },
}

impl ServerMsg {
    pub(crate) fn is_direct(&self) -> bool {
        matches!(self, Self::Error { .. } | Self::StrokeRejected { .. } | Self::StrokeTruncate { .. })
    }

    /// 是否为绘画消息（需要排除发送者，避免本地回声重复）
    pub(crate) fn is_drawing(&self) -> bool {
        matches!(
            self,
            ServerMsg::StrokeStart { .. } | ServerMsg::StrokePoint { .. } | ServerMsg::StrokeEnd { .. }
        )
    }
}

#[derive(Debug, Default)]
pub struct Board {
    strokes: Vec<Stroke>,
    total_points: usize,
    reset_epoch: u64,
}

fn valid_style(id: &str, color: &str, size: f32, tool: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && matches!(color.len(), 4 | 7)
        && color.starts_with('#')
        && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
        && size.is_finite()
        && size > 0.0
        && size <= 100.0
        && valid_tool(tool)
}

/// 内置工具，或 v2 自研笔刷的渲染参数串（如 "v2/n0.55/a-25/s0.8/e3.2/f0.35/g0.04/o1"）
fn valid_tool(tool: &str) -> bool {
    matches!(tool, "pen" | "eraser" | "marker" | "syrup" | "gel" | "looney")
        || (tool.starts_with("v2/")
            && tool.len() <= 96
            && tool.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'/' || b == b'.' || b == b'-'))
}

fn valid_point(point: &Point) -> bool {
    [point.0, point.1, point.2]
        .iter()
        .all(|value| value.is_finite() && (0.0..=1.0).contains(value))
}

fn validate_strokes(strokes: &[Stroke]) -> Result<usize, String> {
    if strokes.len() > MAX_STROKES {
        return Err("存档超过 2000 笔上限".into());
    }
    let mut ids = HashSet::new();
    let mut total = 0;
    for stroke in strokes {
        if !valid_style(&stroke.id, &stroke.color, stroke.size, &stroke.tool)
            || !ids.insert(stroke.id.as_str())
            || stroke.points.len() > MAX_POINTS_PER_STROKE
            || !stroke.points.iter().all(valid_point)
        {
            return Err("存档包含无效、重复或超出上限的笔画".into());
        }
        total += stroke.points.len();
        if total > MAX_TOTAL_POINTS {
            return Err("存档超过 200000 个点上限".into());
        }
    }
    Ok(total)
}

impl Board {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn strokes(&self) -> &[Stroke] {
        &self.strokes
    }

    pub(crate) fn reset_epoch(&self) -> u64 {
        self.reset_epoch
    }

    pub(crate) fn usage(&self) -> ServerMsg {
        ServerMsg::BoardUsage {
            points: self.total_points, max_points: MAX_TOTAL_POINTS,
            strokes: self.strokes.len(), max_strokes: MAX_STROKES,
        }
    }

    fn usage_bands(&self) -> (u8, u8) {
        fn band(value: usize, limit: usize) -> u8 {
            if value >= limit { 3 }
            else if value * 100 >= limit * 95 { 2 }
            else if value * 100 >= limit * 80 { 1 }
            else { 0 }
        }
        // 两个维度独立比较，避免点数已满时掩盖笔数跨阈值。
        (band(self.total_points, MAX_TOTAL_POINTS), band(self.strokes.len(), MAX_STROKES))
    }

    /// 应用消息；连接层将 is_direct 消息与广播分开，绝不为拒绝重发整板。
    pub fn handle(&mut self, msg: ClientMsg) -> Vec<ServerMsg> {
        let before = self.usage_bands();
        let mut out = self.apply(msg);
        if self.usage_bands() != before {
            out.push(self.usage());
        }
        out
    }

    fn apply(&mut self, msg: ClientMsg) -> Vec<ServerMsg> {
        match msg {
            ClientMsg::StrokeStart { id, color, size, tool } => {
                if self.strokes.iter().any(|s| s.id == id) {
                    return vec![]; // 重复 start：忽略（与 JS 端语义一致）
                }
                let tool = tool.unwrap_or_else(|| "pen".to_string());
                let reason = if !valid_style(&id, &color, size, &tool) {
                    Some("笔画参数无效，请重新落笔")
                } else if self.strokes.len() >= MAX_STROKES {
                    Some("白板已达 2000 笔上限，请先存档再清屏")
                } else if self.total_points >= MAX_TOTAL_POINTS {
                    Some("白板已满，请先存档再清屏")
                } else { None };
                if let Some(reason) = reason {
                    return vec![ServerMsg::StrokeRejected { id, reason: reason.into() }];
                }
                self.strokes.push(Stroke { id: id.clone(), color: color.clone(), size, tool: tool.clone(), points: vec![] });
                vec![ServerMsg::StrokeStart { id, color, size, tool }]
            }
            ClientMsg::StrokePoint { id, x, y, p, ts } => {
                let p = p.unwrap_or(0.5);
                match self.strokes.iter_mut().find(|s| s.id == id) {
                    Some(s) => {
                        let reason = if !valid_point(&Point(x, y, p)) {
                            Some("坐标无效，该笔已停止，请重新落笔")
                        } else if self.total_points >= MAX_TOTAL_POINTS {
                            Some("白板已满，请先存档再清屏")
                        } else if s.points.len() >= MAX_POINTS_PER_STROKE {
                            Some("单笔已达 20000 个点上限，请重新落笔")
                        } else { None };
                        if let Some(reason) = reason {
                            return vec![ServerMsg::StrokeTruncate { id, len: s.points.len(), reason: reason.into() }];
                        }
                        s.points.push(Point(x, y, p));
                        self.total_points += 1;
                        vec![ServerMsg::StrokePoint { id, x, y, p, ts }]
                    }
                    None => vec![], // 点先于 start 到达：丢弃
                }
            }
            ClientMsg::StrokeEnd { id } => {
                if self.strokes.iter().any(|stroke| stroke.id == id) {
                    vec![ServerMsg::StrokeEnd { id }]
                } else { vec![] }
            }
            ClientMsg::Undo => match self.strokes.pop() {
                Some(s) => {
                    self.total_points -= s.points.len();
                    vec![ServerMsg::Undo { id: Some(s.id) }]
                },
                None => vec![ServerMsg::Undo { id: None }],
            },
            ClientMsg::Clear => {
                self.strokes.clear();
                self.total_points = 0;
                self.reset_epoch = self.reset_epoch.wrapping_add(1);
                vec![ServerMsg::Clear]
            }
            ClientMsg::BoardLoad { strokes } => match validate_strokes(&strokes) {
                Ok(total) => {
                    self.strokes = strokes;
                    self.total_points = total;
                    self.reset_epoch = self.reset_epoch.wrapping_add(1);
                    // 整板替换必须回送发起者，避免导入者继续显示旧画面。
                    vec![ServerMsg::FullState { strokes: self.strokes.clone() }]
                }
                Err(message) => vec![ServerMsg::Error { message }],
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(id: &str, x: f32, y: f32) -> ClientMsg {
        ClientMsg::StrokePoint { id: id.into(), x, y, p: Some(0.5), ts: None }
    }

    #[test]
    fn full_stroke_lifecycle() {
        let mut b = Board::new();
        let out = b.handle(ClientMsg::StrokeStart { id: "a".into(), color: "#f00".into(), size: 6.0, tool: None });
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], ServerMsg::StrokeStart { tool, .. } if tool == "pen"));
        b.handle(pt("a", 0.1, 0.2));
        b.handle(pt("a", 0.3, 0.4));
        assert_eq!(b.strokes()[0].points.len(), 2);
        // 重复 start 被忽略
        let out = b.handle(ClientMsg::StrokeStart { id: "a".into(), color: "#000".into(), size: 4.0, tool: None });
        assert!(out.is_empty());
        assert_eq!(b.strokes().len(), 1);
    }

    #[test]
    fn point_before_start_dropped() {
        let mut b = Board::new();
        let out = b.handle(pt("ghost", 0.5, 0.5));
        assert!(out.is_empty());
        assert!(b.strokes().is_empty());
    }

    #[test]
    fn undo_pops_last_and_broadcasts_id() {
        let mut b = Board::new();
        b.handle(ClientMsg::StrokeStart { id: "a".into(), color: "#f00".into(), size: 6.0, tool: None });
        b.handle(ClientMsg::StrokeStart { id: "b".into(), color: "#00f".into(), size: 4.0, tool: None });
        let out = b.handle(ClientMsg::Undo);
        assert_eq!(out, vec![ServerMsg::Undo { id: Some("b".into()) }]);
        assert_eq!(b.strokes().len(), 1);
        assert_eq!(b.strokes()[0].id, "a");
        // 空棋盘 undo：广播 id=None，客户端忽略
        b.handle(ClientMsg::Undo);
        let out = b.handle(ClientMsg::Undo);
        assert_eq!(out, vec![ServerMsg::Undo { id: None }]);
    }

    #[test]
    fn clear_empties() {
        let mut b = Board::new();
        b.handle(ClientMsg::StrokeStart { id: "a".into(), color: "#f00".into(), size: 6.0, tool: None });
        let out = b.handle(ClientMsg::Clear);
        assert_eq!(out, vec![ServerMsg::Clear]);
        assert!(b.strokes().is_empty());
    }

    fn archived_stroke(id: &str) -> Stroke {
        Stroke {
            id: id.into(), color: "#123456".into(), size: 6.0, tool: "pen".into(),
            points: vec![Point(0.1, 0.2, 0.5), Point(0.3, 0.4, 1.0)],
        }
    }

    #[test]
    fn board_load_replaces_atomically_and_is_not_filtered_as_drawing() {
        let mut board = Board::new();
        board.handle(ClientMsg::StrokeStart { id: "old".into(), color: "#000".into(), size: 4.0, tool: None });
        let replacement = vec![archived_stroke("new")];
        let messages = board.handle(ClientMsg::BoardLoad { strokes: replacement.clone() });
        assert_eq!(board.strokes(), replacement.as_slice());
        assert_eq!(messages, vec![ServerMsg::FullState { strokes: replacement }]);
        assert!(!messages[0].is_drawing());
        assert_eq!(board.total_points, 2);

        // 重复 id 导入失败，不能先清空旧数据再发现错误。
        let before = board.strokes().to_vec();
        let rejected = board.handle(ClientMsg::BoardLoad {
            strokes: vec![archived_stroke("dup"), archived_stroke("dup")],
        });
        assert!(matches!(rejected.as_slice(), [ServerMsg::Error { .. }]));
        assert_eq!(board.strokes(), before.as_slice());
        assert_eq!(board.total_points, 2);
    }

    #[test]
    fn invalid_archive_values_and_resource_limits_are_rejected() {
        let mut board = Board::new();
        for invalid in [
            Stroke { size: f32::NAN, ..archived_stroke("nan") },
            Stroke { color: "red".into(), ..archived_stroke("color") },
            Stroke { tool: "script".into(), ..archived_stroke("tool") },
            Stroke { points: vec![Point(1.1, 0.5, 0.5)], ..archived_stroke("outside") },
            Stroke { points: vec![Point(0.1, 0.5, 0.5); MAX_POINTS_PER_STROKE + 1], ..archived_stroke("long") },
        ] {
            let out = board.handle(ClientMsg::BoardLoad { strokes: vec![invalid] });
            assert!(matches!(out.as_slice(), [ServerMsg::Error { .. }]));
            assert!(board.strokes().is_empty());
        }
        let many: Vec<Stroke> = (0..=MAX_STROKES).map(|i| archived_stroke(&format!("s{}", i))).collect();
        assert!(validate_strokes(&many).is_err());
        let dense: Vec<Stroke> = (0..11).map(|i| Stroke {
            points: vec![Point(0.5, 0.5, 0.5); MAX_POINTS_PER_STROKE],
            ..archived_stroke(&format!("dense{}", i))
        }).collect();
        assert!(validate_strokes(&dense).is_err());
    }

    #[test]
    fn undo_and_clear_release_point_budget() {
        let mut board = Board::new();
        board.handle(ClientMsg::BoardLoad { strokes: vec![archived_stroke("a"), archived_stroke("b")] });
        assert_eq!(board.total_points, 4);
        board.handle(ClientMsg::Undo);
        assert_eq!(board.total_points, 2);
        board.handle(ClientMsg::Clear);
        assert_eq!(board.total_points, 0);
    }
}
