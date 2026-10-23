# 04 放行 iPad 连接（需要你本人点管理员确认）
# 做三件事：① 删除 Windows 为本程序自动生成的"阻止"入站规则；② 新增一条"允许"规则：
#   只对本程序、只限 TCP、只允许同一局域网子网（LocalSubnet）的设备访问；③ 记录到 logs\04-firewall.txt
# 撤销：运行 05-undo-firewall.bat
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$ErrorActionPreference = 'Stop'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Start-Process powershell -Verb RunAs -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', ('"' + $PSCommandPath + '"'))
  exit
}
$log = Join-Path $PSScriptRoot 'logs\04-firewall.txt'
# 目标程序：INKCAST_APP_DIR\无线白板.exe → 项目旁“无线白板”文件夹 → 本项目 dist 里最新的 exe
$cand = @()
if ($env:INKCAST_APP_DIR) { $cand += (Join-Path $env:INKCAST_APP_DIR '无线白板.exe') }
$cand += (Join-Path $PSScriptRoot '..\..\无线白板\无线白板.exe')
$cand += (Get-ChildItem (Join-Path $PSScriptRoot '..\dist') -Filter '*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { $_.FullName })
$exe = ($cand | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1)
if (-not $exe) { throw '找不到程序：请先运行 02-build.bat' }
$exe = (Resolve-Path $exe).Path
$lines = @("程序：$exe")
$auto = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $exe } | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' -and $_.Direction -eq 'Inbound' }
foreach ($r in $auto) { $lines += "删除阻止规则：$($r.DisplayName) [$($r.Profile)]"; Remove-NetFirewallRule -Name $r.Name }
Get-NetFirewallRule -Group 'WirelessWhiteboardTest' -ErrorAction SilentlyContinue | Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -eq $exe } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName '无线白板（仅本局域网 TCP）' -Group 'WirelessWhiteboardTest' -Direction Inbound -Action Allow `
  -Program $exe -Protocol TCP -RemoteAddress LocalSubnet -Profile Private,Public | Out-Null
$lines += '新增允许规则：无线白板（仅本局域网 TCP），配置文件 Private+Public，远程地址 LocalSubnet'
$lines += "完成于 $(Get-Date -Format s)"
$lines | Set-Content $log -Encoding UTF8
$lines | ForEach-Object { Write-Host $_ }
Write-Host "`n完成。窗口 15 秒后关闭。" -ForegroundColor Green
Start-Sleep 15
