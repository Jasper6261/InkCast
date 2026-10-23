# 更新记录 / Changelog

## 1.0.0 — 2026-10-23

第一个正式版。 / First public release.

- **屏幕标注：**iPad 上看到电脑屏幕画面，写的字浮在电脑屏幕最上层；鼠标可穿透标注操作下面的窗口。
- **白板：**白纸书写，可导出 PNG / SVG，可保存和打开存档。
- **扫码连接：**iPad 用 Safari 扫二维码即可，不装 App、不需要账号、不连云端；连接成功后二维码窗口自动关闭，断开后自动重连。
- **笔感：**压感、笔锋、平滑；英文斜体、中国毛笔，“画笔工作室”可调节和新建画笔；荧光笔、橡皮。
- **手势：**两指轻点撤销、三指轻点重做、捏合缩放、手掌防误触。
- **电脑端也能写：**鼠标在白板或屏幕上书写，工具与 iPad 一致。
- **8 种语言：**简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español；内置水墨风图解使用说明（电脑右上角书本图标、iPad 菜单“使用说明”）。
- **安全：**一次性配对码 + 令牌、Host / Origin 校验、页面内容安全策略；详见 `SECURITY.md`。

修复（相对内部测试版）：
- 放大后橡皮擦过的笔迹又露出来（很长的橡皮笔画在放大重画时被截断）。
- iPad 橡皮擦落笔不能马上擦除（屏幕画面里带着标注时，擦除后立即刷新画面）。

---

- **Screen annotation:** see your PC screen on the iPad; ink floats above all windows on the PC, and the mouse clicks through it.
- **Whiteboard:** write on a blank page; export PNG / SVG; save and open boards.
- **Scan to connect:** Safari on the iPad, no app, no account, no cloud; the QR window closes on connect and the iPad reconnects automatically.
- **Pens:** pressure, tapering, smoothing; italic and Chinese brush pens, Brush Studio, highlighter, eraser.
- **Gestures:** two-finger tap undo, three-finger tap redo, pinch zoom, palm rejection.
- **Write with the mouse** on the PC with the same tools.
- **8 languages** and a built-in illustrated guide.
- **Security:** one-time pairing code + token, Host / Origin checks, CSP. See `SECURITY.md`.
