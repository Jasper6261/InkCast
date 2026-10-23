# 02 编译：cargo test + cargo build --release，产出免安装 exe。日志：logs\02-*.log
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$ErrorActionPreference = 'Stop'
# 工具链目录：环境变量 INKCAST_DEVTOOLS 优先；否则沿用已装好的 CARGO_HOME 的上一级；再否则 D:\DevTools（有 D 盘时）或 %LOCALAPPDATA%\InkCastDevTools
$root = if ($env:INKCAST_DEVTOOLS) { $env:INKCAST_DEVTOOLS } elseif ($env:CARGO_HOME -and (Test-Path $env:CARGO_HOME)) { Split-Path $env:CARGO_HOME -Parent } elseif (Test-Path 'D:\') { 'D:\DevTools' } else { Join-Path $env:LOCALAPPDATA 'InkCastDevTools' }
$proj = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $PSScriptRoot 'logs'
$status = Join-Path $logDir '02-build-status.json'
$result = [ordered]@{ started = (Get-Date -Format s); mode = $env:WB_MODE }
function Save-Status { $result.updated = (Get-Date -Format s); $result | ConvertTo-Json | Set-Content $status -Encoding UTF8 }
Save-Status
try {
  $env:RUSTUP_HOME = "$root\rustup"; $env:CARGO_HOME = "$root\cargo"
  $env:Path = "$root\cargo\bin;" + $env:Path
  $env:TEMP = "$root\tmp"; $env:TMP = "$root\tmp"
  # 编译进程里去掉疑似凭据的环境变量（只影响本次进程）
  $removed = @()
  Get-ChildItem env: | Where-Object { $_.Name -match 'TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE' } | ForEach-Object { $removed += $_.Name; Remove-Item "env:$($_.Name)" }
  $result.removed_env_names = $removed
  # 网络：系统代理已开启时优先走系统代理（直连实测仅约 30 KB/s），不通再直连
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  $direct = $true
  if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
    $px = "http://$($ie.ProxyServer)"
    try { $r = [Net.WebRequest]::Create('https://index.crates.io/config.json'); $r.Proxy = New-Object Net.WebProxy($px); $r.Timeout = 10000; $r.GetResponse().Close(); $env:HTTPS_PROXY = $px; $env:HTTP_PROXY = $px; $env:NO_PROXY = "localhost,127.0.0.1"; $direct = $false } catch { }
  }
  $result.network = if ($direct) { 'direct' } else { "proxy $env:HTTPS_PROXY" }
  # 新版本文件夹第一次编译：从上一版文件夹复用编译缓存（robocopy 本机复制，比从头编译快很多）
  $tgt = Join-Path $proj 'src-tauri\target'
  if (-not (Test-Path (Join-Path $tgt 'release'))) {
    $prev = Get-ChildItem (Split-Path $proj -Parent) -Directory -Filter 'whiteboard-v*' |
      Where-Object { $_.FullName -ne $proj -and (Test-Path (Join-Path $_.FullName 'src-tauri\target\release')) } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($prev) {
      Write-Host "== 复用编译缓存：$($prev.Name) =="
      robocopy (Join-Path $prev.FullName 'src-tauri\target') $tgt /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
      $result.reused_cache_from = $prev.Name
      Save-Status
    }
  }
  Set-Location (Join-Path $proj 'src-tauri')
  $result.rustc = (rustc --version)
  Save-Status
  if ($env:WB_MODE -ne 'release-only') {
    Write-Host '== cargo test（约 5-10 分钟）=='
    cmd /c "cargo test --locked > `"$logDir\02-test.log`" 2>&1"
    $result.test_exit = $LASTEXITCODE
    $result.test_summary = (Select-String -Path "$logDir\02-test.log" -Pattern 'test result:' | ForEach-Object { $_.Line }) -join ' / '
    Save-Status
    if ($LASTEXITCODE -ne 0) { throw "cargo test 失败，见 logs\02-test.log" }
  }
  Write-Host '== cargo build --release =='
  cmd /c "cargo build --release --locked > `"$logDir\02-release.log`" 2>&1"
  $result.release_exit = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) { throw "release 编译失败，见 logs\02-release.log" }
  $ver = (Select-String -Path 'Cargo.toml' -Pattern '^version\s*=\s*"([^"]+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
  $dist = Join-Path $proj 'dist'; New-Item -ItemType Directory -Force $dist | Out-Null
  $out = Join-Path $dist "wireless-whiteboard-v$ver-portable.exe"
  Copy-Item 'target\release\wireless-whiteboard.exe' $out -Force
  $result.exe = $out
  $result.exe_sha256 = (Get-FileHash $out -Algorithm SHA256).Hash
  # 可选：复制到固定位置（防火墙规则与截图目录跨版本保持不变）。
  # 只有设置了环境变量 INKCAST_APP_DIR，或项目旁边已经有“无线白板”文件夹时才复制。
  $appDir = if ($env:INKCAST_APP_DIR) { $env:INKCAST_APP_DIR } else { Join-Path (Split-Path $proj -Parent) '无线白板' }
  if (-not $env:INKCAST_APP_DIR -and -not (Test-Path $appDir)) { $result.exe_mb = [math]::Round((Get-Item $out).Length/1MB,2); $result.ok = $true; Write-Host "`n完成：$out" -ForegroundColor Green; return }
  New-Item -ItemType Directory -Force $appDir | Out-Null
  # 程序正在运行（包括只剩托盘图标）时先退出，复制完再重新打开
  # 包括固定位置的程序，以及各版本 dist 里直接双击运行的 wireless-whiteboard-*-portable.exe
  $devRoot = Split-Path $proj -Parent
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($devRoot, [StringComparison]::OrdinalIgnoreCase) -and
    ($_.ProcessName -eq '无线白板' -or $_.ProcessName -like 'wireless-whiteboard*') })
  if ($running.Count -gt 0) { $running | Stop-Process -Force; Start-Sleep -Seconds 2; $result.app_restarted = $true }
  try { Copy-Item $out (Join-Path $appDir '无线白板.exe') -Force; $result.app_exe = (Join-Path $appDir '无线白板.exe') }
  catch { $result.app_exe_warning = "复制到固定位置失败（程序可能正在运行，请先退出后运行 02b）：$($_.Exception.Message)" }
  # 用资源管理器启动：程序拿到的是用户平时的环境变量（本脚本改过 TEMP、代理等，不能带给程序）
  if ($running.Count -gt 0 -and $result.app_exe) { Start-Process explorer.exe -ArgumentList ('"' + (Join-Path $appDir '无线白板.exe') + '"') }
  $result.exe_mb = [math]::Round((Get-Item $out).Length/1MB,2)
  $result.ok = $true
  Write-Host "`n完成：$out" -ForegroundColor Green
} catch {
  $result.ok = $false; $result.error = $_.Exception.Message
  Write-Host "`n出错：$($_.Exception.Message)" -ForegroundColor Red
} finally { Save-Status }
