# InkCast（墨投）— 用 iPad 在电脑屏幕上写字批注

用 iPad 和 Apple Pencil 在电脑屏幕上手写批注、当电子白板。适合上课、开会、录屏讲解。扫码即连，免装 App；只在局域网内传输，不需要账号，不连云端。

Annotate your PC screen and use a whiteboard with iPad + Apple Pencil — for teaching, meetings and screencasts. Scan to connect, no app needed; everything stays on your local network, no account, no cloud.

**下载 / Download：** [最新版本 / Latest release](https://github.com/Jasper6261/InkCast/releases/latest)（Windows 免安装 zip / portable zip）

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

## 编译 / Build

**Windows（推荐用仓库里的脚本）：**

1. `win-dev\00-env-check.bat`：只读检查环境。
2. `win-dev\01-install-toolchain.bat`：安装 Rust 1.97 和 VS 2022 C++ 生成工具（从官方地址下载，校验 SHA256 / 微软签名后再运行）。默认装到 `D:\DevTools`，可用环境变量 `INKCAST_DEVTOOLS` 指定其他目录。
3. `win-dev\02-build.bat`：运行 `cargo test` 和 `cargo build --release`，生成 `dist\wireless-whiteboard-v<版本>-portable.exe`（免安装）。

也可以手动编译 / or build manually:

```
cd src-tauri
cargo test --locked
cargo build --release --locked
```

**macOS：** 用 GitHub Actions 里的 `build-macos` 工作流生成 `.dmg`，见 `MAC.md`。

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
