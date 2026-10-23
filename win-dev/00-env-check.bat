@echo off
chcp 65001 >nul
echo 正在做只读环境检查（不会安装或修改任何东西）...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0env-check.ps1"
echo 完成，结果在 logs\env-check.txt
timeout /t 3 >nul
