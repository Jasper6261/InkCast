@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp001-install-toolchain.ps1"
echo.
echo 窗口将在 30 秒后关闭，日志在 logs 文件夹。
timeout /t 30 >nul
