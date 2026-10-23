# InkCast（墨投）Mac 版：打包与首次使用

## 打包（不需要 Mac）
1. Fork 或克隆本仓库到你自己的 GitHub 账号下（编译产物、日志已被 `.gitignore` 排除）。
2. 打开仓库的 **Actions → build-macos → Run workflow**。
3. 大约 20–30 分钟后，在这次运行页面的底部下载 **InkCast-macos**，里面有 `.dmg` 安装包。

打出来的是“通用”安装包，Apple 芯片（M1–M4）和 Intel Mac 都能用，需要 macOS 11 或更新版本。

## 第一次打开（未正式签名时）
1. 双击 `.dmg`，把 InkCast 拖进“应用程序”。
2. 第一次打开时，在“应用程序”里**右键 InkCast → 打开 → 打开**。如果还是打不开，去“系统设置 › 隐私与安全性”，点“仍要打开”。
3. 系统询问“是否允许接受传入的网络连接”时，点“允许”，iPad 才能连上。
4. iPad 第一次进入“屏幕标注”时，Mac 会请求“屏幕录制”权限：在“系统设置 › 隐私与安全性 › 屏幕录制”里打开 InkCast，然后重新打开程序。

## 与 Windows 版的差别
- 快捷键：⌘⌥⇧A（Command + Option + Shift + A）切换“穿透 / 绘制”。
- 托盘图标在屏幕顶部的菜单栏。
- 数据在 `~/Library/Application Support/com.inkcast.app`，截图在“图片 / InkCast”。

## 正式签名（需要苹果开发者账号，每年 99 美元）
在仓库的 **Settings → Secrets** 里添加 `APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、`APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`，然后打开 `build-macos.yml` 里已注释好的签名配置。签名并公证后，用户双击就能直接打开。
