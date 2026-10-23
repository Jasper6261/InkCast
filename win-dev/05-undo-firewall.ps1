# 05 撤销 04 新增的防火墙允许规则（需要管理员确认）
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"')); exit }
Get-NetFirewallRule -Group 'WirelessWhiteboardTest' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
"已删除分组 WirelessWhiteboardTest 的规则 $(Get-Date -Format s)" | Set-Content (Join-Path $PSScriptRoot 'logs\05-undo-firewall.txt') -Encoding UTF8
Write-Host '已撤销。窗口 10 秒后关闭。'; Start-Sleep 10
