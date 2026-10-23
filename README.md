# InkCast（墨投）— 用 iPad 在电脑屏幕上写字批注

用 iPad 和 Apple Pencil 在电脑屏幕上手写批注、当电子白板。适合上课、开会、录屏讲解。扫码即连，免装 App；只在局域网内传输，不需要账号，不连云端。

Annotate your PC screen and use a whiteboard with iPad + Apple Pencil — for teaching, meetings and screencasts. Scan to connect, no app needed; everything stays on your local network, no account, no cloud.

## 两种使用方法 / Two ways to use InkCast

| | **方式一：下载程序（推荐）** | **方式二：从源码编译** |
|---|---|---|
| 适合谁 | 只想直接用 | 想看 / 改代码，或自己编译 |
| 在哪里下载 | 右侧 **Releases** → 最新版本 → 下方 **Assets** 里的 `InkCast-<版本>-windows-x64.zip` | 页面上方绿色的 **Code → Download ZIP**，或 `git clone` |
| 下载到的是什么 | 编译好的程序 `InkCast.exe` + 快速上手说明 | 源代码（**没有** `InkCast.exe`） |
| 需要准备什么 | 不需要，解压就能用 | 安装 Rust 和 VS C++ 生成工具（数 GB，首次准备约半小时以上） |

> 注意：Releases 的 Assets 里 GitHub 还会自动附上 “Source code (zip / tar.gz)”，那也是源代码，和 Code → Download ZIP 一样，不是程序。

### 方式一：下载程序（推荐）

1. 打开 [最新版本 / Latest release](https://github.com/Jasper6261/InkCast/releases/latest)，在页面下方 **Assets** 里下载 `InkCast-<版本>-windows-x64.zip`。
2. 解压到任意文件夹，双击 `InkCast.exe`（免安装）。第一次运行如果出现“Windows 已保护你的电脑”，点“更多信息”→“仍要运行”（程序没有数字签名）。
3. 点右上角“连接 iPad”，用 iPad 相机扫描二维码，在 Safari 中打开。
4. iPad 上默认是**白板**；点上方“屏幕 | 白板”切换到**屏幕标注**，字会浮在电脑屏幕最上层。

设置和存档保存在 `InkCast.exe` 旁边的 `data` 文件夹里；删除整个文件夹即完全卸载。

### 方式二：从源码编译（Windows）

1. **下载源码：** 点 **Code → Download ZIP** 并解压，或 `git clone https://github.com/Jasper6261/InkCast.git`。
2. **检查环境：** 双击 `win-dev\00-env-check.bat`。它只读检查，不改动电脑。
3. **安装工具链（只需一次）：** 双击 `win-dev\01-install-toolchain.bat`。它会安装 Rust 1.97 和 VS 2022 C++ 生成工具：
   - 从官方地址下载，校验 SHA256 / 微软签名后再运行；
   - 安装 VS 生成工具时会弹出管理员确认；
   - 默认装到 `D:\DevTools`（没有 D 盘时装到 `%LOCALAPPDATA%\InkCastDevTools`），可用环境变量 `INKCAST_DEVTOOLS` 指定目录。
4. **编译：** 双击 `win-dev\02-build.bat`。它会先运行测试，再编译，生成 `dist\wireless-whiteboard-v<版本>-portable.exe`。
5. **运行：** 双击生成的 exe，之后的连接步骤和方式一相同。
   - 想让设置和存档放在 exe 旁边（免安装模式），在 exe 所在文件夹新建一个空文件 `portable.txt`；
   - 否则它们保存在 `%APPDATA%\com.inkcast.app`。

也可以手动编译（需已装好 Rust 和 C++ 生成工具）：

```
cd src-tauri
cargo test --locked
cargo build --release --locked
```

生成的程序在 `src-tauri\target\release\` 里。

**macOS（实验）：** 用 GitHub Actions 里的 `build-macos` 工作流生成 `.dmg`，见 `MAC.md`。

---

**Option 1 — Download the app (recommended).**
1. Open the [latest release](https://github.com/Jasper6261/InkCast/releases/latest) and download `InkCast-<version>-windows-x64.zip` under **Assets**. Unzip it and run `InkCast.exe` (portable). If Windows SmartScreen appears, click “More info” → “Run anyway” (the app is not code-signed).
2. Click “Connect iPad” and scan the QR code with the iPad camera; open it in Safari.
3. The iPad starts on the **Whiteboard**; tap “Screen | Whiteboard” to annotate the PC screen.

**Option 2 — Build from source.** **Code → Download ZIP** (or `git clone`) gives you the source code only, with no `InkCast.exe`. On Windows:
1. Run `win-dev\00-env-check.bat`.
2. Run `win-dev\01-install-toolchain.bat` once to install Rust 1.97 and the VS 2022 C++ build tools.
3. Run `win-dev\02-build.bat`. It builds `dist\wireless-whiteboard-v<version>-portable.exe`.
4. Optional: put an empty `portable.txt` next to the exe to keep settings beside it. Otherwise they go to `%APPDATA%\com.inkcast.app`.

The “Source code (zip / tar.gz)” files that GitHub adds to every release are also source only.

## 扫码后连不上？/ Can't connect?

按顺序检查，大多数情况第 1、2 步就能解决：

| # | 现象 / 原因 | 怎么做 |
|---|---|---|
| 1 | 电脑开着 **VPN / 代理软件**（v2rayN、Clash 等的 TUN 模式），或装了 WSL、Docker、虚拟机：二维码里的地址可能是虚拟网卡的（如 `172.18.0.1`、`198.18.x.x`），iPad 访问不到 | 在连接窗口点“**换一个网络地址**”，选标着 **WLAN / 以太网**的那一项（一般 `192.168` 开头）。标着“虚拟网卡 / VPN”的不要选。 |
| 2 | **Windows 防火墙**挡住了（第一次运行时弹出的“Windows 安全中心警报”点了“取消”，或程序换了位置） | 连接窗口 → “iPad 打不开页面？” → “**允许墨投通过 Windows 防火墙**”，在管理员确认框点“是”，然后在 iPad 上刷新页面。 |
| 3 | iPad 和电脑**不在同一个 Wi-Fi**，或连的是**访客网络**（访客网络通常禁止设备互访） | 两边连同一个 Wi-Fi 的主网络。手机热点也可以。 |
| 4 | **iPad 上开着 VPN / 代理** | 关掉 iPad 上的 VPN 后重新扫码。 |
| 5 | 电脑上**已经开着一个墨投**（托盘里） | 程序只能运行一个；再次双击只会打开已经在运行的那个。先在托盘图标上选“退出”，再打开想用的那个。 |

---

1. **VPN / proxy apps on the PC** (v2rayN, Clash in TUN mode), WSL, Docker or VMs may put a virtual adapter's address in the QR code (e.g. `172.18.0.1`). Click “**Use a different network address**” and pick the **Wi-Fi / Ethernet** one (usually `192.168.…`), not one marked “virtual adapter / VPN”.
2. **Windows Firewall**: “iPad can't open the page?” → “**Allow InkCast through Windows Firewall**”, confirm the admin prompt, then reload on the iPad.
3. The iPad and PC must be on the **same Wi-Fi** (guest networks usually isolate devices).
4. Turn off any **VPN on the iPad**.
5. Only one copy of InkCast runs at a time: quit the one in the system tray before starting another.

## 功能 / Features

- **屏幕标注：** iPad 上显示电脑屏幕画面，写的字浮在电脑屏幕最上层（盖在任何窗口上）；鼠标可以穿透标注继续操作下面的窗口。
- **白板：** 在白纸上写，显示在电脑的墨投窗口里，可导出 PNG / SVG。
- **笔感：** 压感、笔锋、平滑；内置英文斜体和中国毛笔，可在“画笔工作室”调节和新建画笔。
- **手势：** 两指轻点撤销、三指轻点重做、捏合缩放、书写时手掌防误触。
- **电脑端也能写：** 鼠标在白板或屏幕上书写，工具与 iPad 一致。
- **8 种语言：** 简体中文、繁體中文、English、日本語、한국어、Deutsch、Français、Español；内置图解使用说明。

## 系统要求 / Requirements

- Windows 10 / 11（主要平台）；macOS 11+（实验，见 `MAC.md`）
- iPad + Apple Pencil，iPadOS 自带 Safari
- 电脑和 iPad 在同一个 Wi-Fi

## 测试 / Tests

- Rust：`cd src-tauri && cargo test --locked`（含真实局域网服务的端到端测试）。
- 网页（iPad 页面、主窗口、标注层）：`node scripts/verify-browser.mjs --browser <Chromium 可执行文件> --temp <临时目录>`。

## 目录 / Layout

| 路径 | 内容 |
|---|---|
| `src-tauri/` | 桌面程序（Rust + Tauri 2）：局域网服务、配对、屏幕截取、标注层、托盘 |
| `src/` | 电脑端界面（主窗口、标注层、使用说明、多语言、笔迹引擎） |
| `pad/` | iPad 端页面 |
| `tests/`、`scripts/` | 浏览器测试 |
| `win-dev/` | Windows 开发脚本（环境检查、安装工具链、编译、防火墙） |
| `brand/` | 图标源文件 |

## 安全与隐私 / Security & privacy

- 隐私说明见 `PRIVACY.md`：不收集任何数据。
- 安全模型和已知限制见 `SECURITY.md`。**局域网内是明文传输，请只在信任的网络中使用。**
- 发现安全问题请按 `SECURITY.md` 私下报告。

## 许可证 / License

Apache License 2.0，见 `LICENSE` 和 `NOTICE`。第三方组件的许可证见 `src-tauri/THIRD_PARTY_NOTICES.txt`（程序“关于 › 开源组件许可”里也能查看）。
