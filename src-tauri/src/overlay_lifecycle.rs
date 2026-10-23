//! 窗口操作由调用方串行化；事件回调只需同步发信号，不等待调用方的锁。

use std::time::Duration;
use tokio::sync::watch;

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Open,
    Closing,
    Destroyed,
}

#[derive(Clone)]
pub(crate) struct WindowSignal(watch::Sender<Phase>);

impl WindowSignal {
    pub(crate) fn closing(&self) {
        self.0.send_if_modified(|phase| {
            if *phase == Phase::Open {
                *phase = Phase::Closing;
                true
            } else {
                false
            }
        });
    }

    pub(crate) fn destroyed(&self) {
        // send_replace 在暂时没有等待者时也保留结果，避免先销毁后等待丢失通知。
        self.0.send_replace(Phase::Destroyed);
    }
}

struct WindowGeneration {
    generation: u64,
    signal: WindowSignal,
}

#[derive(Default)]
pub(crate) struct OverlayLifecycle {
    next_generation: u64,
    window: Option<WindowGeneration>,
}

impl OverlayLifecycle {
    pub(crate) fn has_window(&self) -> bool {
        self.window.is_some()
    }

    pub(crate) fn is_open(&self) -> bool {
        self.window.as_ref().is_some_and(|window| *window.signal.0.borrow() == Phase::Open)
    }

    pub(crate) fn begin_window(&mut self) -> Result<(u64, WindowSignal), String> {
        if self.window.is_some() {
            return Err("旧标注窗口尚未销毁，请稍后重试".into());
        }
        self.next_generation += 1;
        let generation = self.next_generation;
        let (sender, _) = watch::channel(Phase::Open);
        let signal = WindowSignal(sender);
        self.window = Some(WindowGeneration { generation, signal: signal.clone() });
        Ok((generation, signal))
    }

    /// 只用于 builder 返回错误且没有生成窗口时释放预留代次。
    pub(crate) fn cancel_unbuilt(&mut self, generation: u64) -> bool {
        if self.window.as_ref().is_some_and(|window| window.generation == generation) {
            self.window = None;
            true
        } else {
            false
        }
    }

    pub(crate) fn closing(&self) {
        if let Some(window) = &self.window {
            window.signal.closing();
        }
    }

    /// 返回 true 表示本代销毁已确认，可清理关联状态；超时不移除本代。
    pub(crate) async fn wait_for_close(&mut self, timeout: Duration) -> Result<bool, String> {
        let Some(window) = &self.window else { return Ok(false); };
        let mut receiver = window.signal.0.subscribe();
        if *receiver.borrow() == Phase::Open {
            return Ok(false);
        }
        tokio::time::timeout(timeout, async {
            loop {
                if *receiver.borrow_and_update() == Phase::Destroyed {
                    return Ok::<(), String>(());
                }
                receiver.changed().await.map_err(|_| "标注窗口销毁通知中断".to_string())?;
            }
        }).await.map_err(|_| "标注层仍在关闭，请稍后重试；若持续无法关闭，请重启应用".to_string())??;
        self.window = None;
        Ok(true)
    }

    pub(crate) fn finish_destroyed(&mut self, generation: u64) -> bool {
        if self.window.as_ref().is_some_and(|window| {
            window.generation == generation && *window.signal.0.borrow() == Phase::Destroyed
        }) {
            self.window = None;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 等待者不能在销毁前重开；销毁信号先于等待到达也不会丢失。
    #[tokio::test]
    async fn reopening_waits_for_destroyed_and_keeps_an_early_signal() {
        let mut lifecycle = OverlayLifecycle::default();
        let (_, signal) = lifecycle.begin_window().unwrap();
        signal.closing();
        assert!(!lifecycle.is_open());
        assert!(lifecycle.begin_window().is_err());
        let mut wait = Box::pin(lifecycle.wait_for_close(Duration::from_secs(2)));
        assert!(futures_util::poll!(wait.as_mut()).is_pending());
        signal.destroyed();
        assert!(wait.await.unwrap());
        let (_, early) = lifecycle.begin_window().unwrap();
        early.destroyed();
        // 再来的关闭通知不能把已经销毁的状态退回 Closing。
        early.closing();
        assert!(lifecycle.wait_for_close(Duration::from_secs(2)).await.unwrap());
        assert!(lifecycle.begin_window().is_ok());
    }

    /// 超时不能变成允许复用；晚到的真实销毁事件仍可解除等待。
    #[tokio::test]
    async fn timeout_keeps_closing_until_a_late_destroyed_event() {
        let mut lifecycle = OverlayLifecycle::default();
        let (_, signal) = lifecycle.begin_window().unwrap();
        lifecycle.closing();
        assert!(lifecycle.wait_for_close(Duration::from_millis(1)).await.is_err());
        assert!(lifecycle.has_window());
        assert!(!lifecycle.is_open());
        assert!(lifecycle.begin_window().is_err());
        assert!(lifecycle.wait_for_close(Duration::from_millis(1)).await.is_err());
        signal.destroyed();
        assert!(lifecycle.wait_for_close(Duration::from_secs(2)).await.unwrap());
        assert!(lifecycle.begin_window().is_ok());
    }

    /// 未建成的窗口可释放预留；旧代清理不能清新代；建成后设置失败必须等销毁。
    #[tokio::test]
    async fn failed_creation_and_old_cleanup_cannot_release_a_new_window() {
        let mut lifecycle = OverlayLifecycle::default();
        let (failed, old_signal) = lifecycle.begin_window().unwrap();
        assert!(lifecycle.cancel_unbuilt(failed));
        let (current, current_signal) = lifecycle.begin_window().unwrap();
        assert_ne!(failed, current);
        old_signal.destroyed();
        assert!(!lifecycle.finish_destroyed(failed));
        assert!(!lifecycle.cancel_unbuilt(failed));
        assert!(!lifecycle.finish_destroyed(current));
        assert!(lifecycle.is_open());
        // 模拟已创建窗口在定位/显示失败后的清理请求。
        lifecycle.closing();
        assert!(lifecycle.begin_window().is_err());
        current_signal.destroyed();
        assert!(lifecycle.finish_destroyed(current));
        assert!(lifecycle.begin_window().is_ok());
    }
}
