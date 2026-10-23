# 安全说明 / Security

## 报告安全问题 / Reporting a vulnerability

请不要在公开 Issue 里描述可被利用的细节。请在本仓库的 **Security → Report a vulnerability**（GitHub 私下报告）提交，我们会在那里回复。

Please do not post exploitable details in public issues. Use **Security → Report a vulnerability** (GitHub private vulnerability reporting) on this repository.

只为最新版本提供安全修复。 / Security fixes are provided for the latest release only.

## 安全模型 / Security model

InkCast 在电脑上运行一个只在局域网内使用的服务，iPad 用 Safari 打开它的页面。不连接任何云服务，不需要账号。

| 环节 | 做法 |
|---|---|
| 监听地址 | 本机界面只用 `127.0.0.1`；局域网服务只在用户点“连接 iPad”后启动，只绑定用户选择的那个网卡 IPv4 地址。 |
| 配对 | 二维码里带一次性配对码（128 位随机数，5 分钟有效，用过即作废；连续 5 次错误后作废）。配对成功后换成 128 位令牌，WebSocket 第一条消息必须带令牌，5 秒内不发就断开。“重新配对”会让旧令牌失效。 |
| 比较 | 配对码和令牌用定长比较。 |
| 来源校验 | 每个 WebSocket 和配对请求都严格校验 `Host` 与 `Origin`（防 DNS rebinding 和跨站 WebSocket）。局域网连接只能以 iPad 身份接入，不能冒充本机窗口。 |
| 页面 | 局域网页面带 `Content-Security-Policy`（只允许本服务自己的脚本、禁止被其他网站嵌入）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。桌面窗口启用 Tauri CSP。页面不加载任何外部资源。 |
| 输入限制 | WebSocket 单条消息上限 10 MB；笔画数量和点数有上限；保存截图、诊断文件时只接受数字、`-`、`_` 组成的短名字，写在程序自己的目录里；诊断文件最多保留 20 个。 |
| 文件读写 | 导出、截图、打开存档的位置都由用户在系统“保存 / 打开”对话框里选择；截图命令只写 `.png` 文件；局域网共享只能绑定本机网卡上的具体地址。 |
| 防火墙 | “允许墨投通过 Windows 防火墙”会弹出管理员确认，只放行本程序、只限 TCP、只允许同一局域网子网（LocalSubnet）。 |

## 已知限制 / Known limitations

- **局域网内是明文传输（HTTP / WS，没有 TLS）。** 同一网络里能抓包的人可以看到笔迹、电脑屏幕画面和配对令牌，拿到令牌后可以冒充 iPad 写字或请求屏幕画面。请只在自己信任的网络（家里、公司内网）使用；在咖啡馆等公共 Wi-Fi 上不要使用，或在设置里关闭“向 iPad 发送屏幕画面”。
- 配对令牌保存在程序数据目录的 `data/lan.json`（用于重启后自动重连），能读这个文件的人可以冒充 iPad。“停止共享”或“重新配对”会删除它。
- Windows 防火墙规则同时适用于“专用”和“公用”网络配置文件（很多家庭网络被 Windows 误判为“公用”），范围限制在本子网。
- “授权 / 激活码”目前是开发占位实现，不做任何功能限制，也不能防伪造。

- **Traffic on the local network is not encrypted (HTTP / WS, no TLS).** Anyone who can sniff the same network can see strokes, screen images and the pairing token, and could use the token to act as the iPad. Use InkCast only on networks you trust, or turn off “Send screen to iPad”.
- The pairing token is stored in `data/lan.json` in the app data folder so the iPad can reconnect after a restart. “Stop sharing” or “Re-pair” deletes it.
- The optional Windows Firewall rule applies to both Private and Public profiles, limited to the local subnet.
- The license / activation code is a development placeholder: it unlocks nothing and is not tamper-proof.
