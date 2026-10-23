# 更新记录 / Changelog

## 1.0.2 — 2026-10-23

- **“录屏/共享时显示标注”默认打开**：录屏（OBS、Xbox Game Bar、截图工具）和会议共享里默认就能看到屏幕标注。以前默认关闭，录屏时标注会丢失。关掉后标注对录屏和共享隐身；设置会记住你的选择。iPad 上关于“画面里带着标注”的说明，每台 iPad 只提示一次。
- **延迟显示更准**：电脑底部的“延迟 p50 / p95”以前把 iPad 和电脑的时钟差也算进去了（时钟差 1 秒就显示 1000ms 以上，并标红）。现在扣掉时钟差，只统计 iPad 的笔画。
- **提示文字**：底部提示改为“iPad 默认进入白板”；设置和使用说明里关于这个开关的说明同步更新（8 种语言）。
- **README**：加入白板和屏幕标注的演示动图。

---

- **“Show annotations in recordings/screen sharing” is now on by default**, so recordings and meeting shares include your ink. Turning it off is remembered.
- **Latency readout** no longer includes the clock difference between the iPad and the PC.
- Updated hints and the built-in guide; demo GIFs in the README.

## 1.0.1 — 2026-10-23

- **连接更顺**：电脑开着 VPN / 代理软件（v2rayN、Clash 的 TUN 模式）或装了 WSL、Docker 时，以前二维码里可能是虚拟网卡的地址（如 `172.18.0.1`），iPad 打不开。现在优先用 WLAN / 以太网的地址；“换一个网络地址”里显示网卡名，并标出“虚拟网卡 / VPN”；选到虚拟网卡时会提示。“iPad 打不开页面？”里新增 VPN / 代理的说明。
- **iPad 默认白板**：第一次连接（或换了网络地址）时，iPad 默认显示白板；之后记住上次选的模式。
- **切换“屏幕 | 白板”时电脑不再闪出“连接你的 iPad”**：iPad 切换模式时会短暂重连，以前电脑上的连接引导会闪一下。现在 iPad 连上过以后不再弹出引导，短暂断开也不立即显示“未连接”。
- **防火墙**：“允许墨投通过 Windows 防火墙”只替换当前这个程序文件的规则，不再删掉其他位置墨投的规则。
- **README**：新增“快速开始”和“扫码后连不上？”排查表；说明要下载 Release 里的 zip，而不是 Code → Download ZIP（源代码）。

---

- **Smoother connection:** with a VPN / proxy app (v2rayN, Clash TUN), WSL or Docker on the PC, the QR code could use a virtual adapter's address the iPad can't reach. Wi-Fi / Ethernet is now preferred; the address list shows adapter names and marks virtual adapters / VPN, with a warning if one is chosen.
- **iPad starts on the Whiteboard** the first time it connects; afterwards it remembers your last mode.
- **No more flashing “Connect your iPad” card** on the PC when switching Screen / Whiteboard on the iPad.
- **Firewall button** only replaces the rule for the running copy of InkCast.
- **README:** quick start and a “Can't connect?” checklist.

## 1.0.0 — 2026-10-23

第一个正式版。 / First public release.

- **屏幕标注**：iPad 上看到电脑屏幕画面，写的字浮在电脑屏幕最上层；鼠标可穿透标注操作下面的窗口。
- **白板**：白纸书写，可导出 PNG / SVG，可保存和打开存档。
- **扫码连接**：iPad 用 Safari 扫二维码即可，不装 App、不需要账号、不连云端；连接成功后二维码窗口自动关闭，断开后自动重连。
- **笔感**：压感、笔锋、平滑；英文斜体、中国毛笔，“画笔工作室”可调节和新建画笔；荧光笔、橡皮。
- **手势**：两指轻点撤销、三指轻点重做、捏合缩放、手掌防误触。
- **电脑端也能写**：鼠标在白板或屏幕上书写，工具与 iPad 一致。
- **8 种语言**：简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español；内置水墨风图解使用说明（电脑右上角书本图标、iPad 菜单“使用说明”）。
- **安全**：一次性配对码 + 令牌、Host / Origin 校验、页面内容安全策略；详见 `SECURITY.md`。

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
