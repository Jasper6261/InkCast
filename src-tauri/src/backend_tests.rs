//! v0.5.2 新边界：容量双维阈值、未知笔画、预算中途用尽及旧版本直发。
//! 网络层的定向/去重/关闭行为另由 e2e_tests 与原样 limit_tests 验证。

use crate::*;
use board::{Point, Stroke, MAX_POINTS_PER_STROKE, MAX_STROKES, MAX_TOTAL_POINTS};

fn archived_board(points: usize, strokes: usize) -> Vec<Stroke> {
    assert!(points <= strokes * MAX_POINTS_PER_STROKE);
    let mut remaining = points;
    (0..strokes).map(|i| {
        let len = remaining.min(MAX_POINTS_PER_STROKE);
        remaining -= len;
        Stroke {
            id: format!("s{i}"), color: "#123456".into(), size: 4.0, tool: "pen".into(),
            points: vec![Point(0.5, 0.5, 0.5); len],
        }
    }).collect()
}

fn start(id: &str) -> ClientMsg {
    ClientMsg::StrokeStart { id: id.into(), color: "#000".into(), size: 4.0, tool: None }
}

fn point(id: &str) -> ClientMsg {
    ClientMsg::StrokePoint { id: id.into(), x: 0.6, y: 0.4, p: None, ts: None }
}

fn usage_count(out: &[ServerMsg]) -> usize {
    out.iter().filter(|msg| matches!(msg, ServerMsg::BoardUsage { .. })).count()
}

#[test]
fn usage_crosses_all_thresholds_up_and_down_without_per_point_notifications() {
    let mut board = Board::new();
    for threshold in [80, 95, 100] {
        let point_limit = MAX_TOTAL_POINTS * threshold / 100;
        board.handle(ClientMsg::BoardLoad { strokes: archived_board(point_limit - 1, 10) });
        let out = board.handle(point("s9"));
        assert_eq!(usage_count(&out), 1, "点数向上跨 {threshold}%");
        assert_eq!(out.last(), Some(&board.usage()));
        let more = board.handle(point("s9"));
        assert_eq!(usage_count(&more), 0, "同一阈值区间不应每点广播");
        let out = board.handle(ClientMsg::BoardLoad { strokes: archived_board(point_limit - 1, 10) });
        assert_eq!(usage_count(&out), 1, "点数向下跨 {threshold}%");

        let stroke_limit = MAX_STROKES * threshold / 100;
        board.handle(ClientMsg::BoardLoad { strokes: archived_board(0, stroke_limit - 1) });
        let out = board.handle(start("cross"));
        assert_eq!(usage_count(&out), 1, "笔数向上跨 {threshold}%");
        let out = board.handle(ClientMsg::Undo);
        assert_eq!(usage_count(&out), 1, "笔数向下跨 {threshold}%");
    }
}

#[test]
fn usage_tracks_two_independent_dimensions_and_clear_releases_both() {
    let mut board = Board::new();
    board.handle(ClientMsg::BoardLoad { strokes: archived_board(160_000, 1_599) });
    let out = board.handle(start("cross-strokes"));
    assert_eq!(usage_count(&out), 1, "点数已有 80% 不应掩盖笔数跨过 80%");
    let out = board.handle(ClientMsg::BoardLoad { strokes: archived_board(190_000, 1_600) });
    assert_eq!(usage_count(&out), 1, "笔数不变时点数跨过 95% 也应提示");
    let out = board.handle(ClientMsg::Clear);
    assert_eq!(usage_count(&out), 1, "一次清空跨多个阈值只发送一条当前用量");
    assert_eq!(board.usage(), ServerMsg::BoardUsage {
        points: 0, max_points: MAX_TOTAL_POINTS, strokes: 0, max_strokes: MAX_STROKES,
    });
    assert_eq!(usage_count(&board.handle(ClientMsg::Clear)), 0);
}

#[test]
fn unknown_points_and_end_are_silent_even_when_board_is_full() {
    let mut board = Board::new();
    board.handle(ClientMsg::BoardLoad { strokes: archived_board(MAX_TOTAL_POINTS, 10) });
    assert!(board.handle(point("unknown")).is_empty());
    assert!(board.handle(ClientMsg::StrokePoint {
        id: "unknown".into(), x: f32::NAN, y: 2.0, p: None, ts: None,
    }).is_empty());
    assert!(board.handle(ClientMsg::StrokeEnd { id: "unknown".into() }).is_empty());
    assert_eq!(board.strokes().len(), 10);
}

#[test]
fn total_budget_exhausted_mid_stroke_keeps_prefix_and_rejects_only_once() {
    let mut board = Board::new();
    board.handle(ClientMsg::BoardLoad { strokes: archived_board(MAX_TOTAL_POINTS - 1, 10) });
    let mut connection = RejectedStrokes::default();
    connection.handle(&mut board, start("last")).unwrap();
    let accepted = connection.handle(&mut board, point("last")).unwrap();
    assert!(matches!(accepted[0], ServerMsg::StrokePoint { .. }));
    assert_eq!(usage_count(&accepted), 1);
    let rejected = connection.handle(&mut board, point("last")).unwrap();
    assert!(matches!(rejected.as_slice(), [ServerMsg::StrokeTruncate { id, len: 1, .. }] if id == "last"));
    for _ in 0..20 { assert!(connection.handle(&mut board, point("last")).unwrap().is_empty()); }
    assert_eq!(board.strokes().last().unwrap().points.len(), 1);
    assert_eq!(usage_count(&rejected), 0);
}

#[tokio::test]
async fn queued_direct_replies_are_discarded_after_successful_resets_only() {
    let board = Mutex::new(Board::new());
    let old = board.lock().await.reset_epoch();
    let reply = |epoch| DirectMessage { epoch: Some(epoch), msgs: vec![axum::extract::ws::Message::Text("a queued correction".into())] };

    let invalid = Stroke { color: "invalid".into(), ..archived_board(1, 1).remove(0) };
    board.lock().await.handle(ClientMsg::BoardLoad { strokes: vec![invalid] });
    assert!(current_direct_message(&board, reply(old)).await.len() == 1, "导入失败不能改变白板版本");
    board.lock().await.handle(ClientMsg::Clear);
    assert!(current_direct_message(&board, reply(old)).await.is_empty());
    let before_load = board.lock().await.reset_epoch();
    board.lock().await.handle(ClientMsg::BoardLoad { strokes: archived_board(2, 1) });
    assert!(current_direct_message(&board, reply(before_load)).await.is_empty());
    let current = board.lock().await.reset_epoch();
    assert!(current_direct_message(&board, reply(current)).await.len() == 1);
    assert!(current_direct_message(&board, DirectMessage {
        epoch: None, msgs: vec![axum::extract::ws::Message::Text("a failed import still needs feedback".into())],
    }).await.len() == 1);
}
