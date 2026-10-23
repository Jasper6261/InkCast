# 01 安装编译工具：Rust（官方 rustup）+ VS 2022 C++ 生成工具（微软官方）
# 默认放 D:\DevTools（可用环境变量 INKCAST_DEVTOOLS 指定）；下载后先校验（SHA256 / 微软签名）再运行。日志：logs\01-install.log
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$ErrorActionPreference = 'Stop'
# 工具链目录：环境变量 INKCAST_DEVTOOLS 优先；否则沿用已装好的 CARGO_HOME 的上一级；再否则 D:\DevTools（有 D 盘时）或 %LOCALAPPDATA%\InkCastDevTools
$root = if ($env:INKCAST_DEVTOOLS) { $env:INKCAST_DEVTOOLS } elseif ($env:CARGO_HOME -and (Test-Path $env:CARGO_HOME)) { Split-Path $env:CARGO_HOME -Parent } elseif (Test-Path 'D:\') { 'D:\DevTools' } else { Join-Path $env:LOCALAPPDATA 'InkCastDevTools' }
$logDir = Join-Path $PSScriptRoot 'logs'
$status = Join-Path $logDir '01-install-status.json'
Start-Transcript -Path (Join-Path $logDir '01-install.log') -Force | Out-Null
$result = [ordered]@{ started = (Get-Date -Format s) }

function Save-Status { $result.updated = (Get-Date -Format s); $result | ConvertTo-Json | Set-Content $status -Encoding UTF8 }
try {
  Save-Status
  foreach ($d in 'rustup','cargo','tmp','downloads','vs-cache','vs-shared') { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
  $env:TEMP = "$root\tmp"; $env:TMP = "$root\tmp"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'

  # 系统代理已开启时，rustup 也走系统代理（直连实测仅几 KB/s）
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  if ($ie.ProxyEnable -eq 1 -and $ie.ProxyServer) { $env:HTTPS_PROXY = "http://$($ie.ProxyServer)"; $env:HTTP_PROXY = $env:HTTPS_PROXY; $env:NO_PROXY = 'localhost,127.0.0.1' }
  $result.proxy = "$env:HTTPS_PROXY"

  # ---- Rust ----
  $env:RUSTUP_HOME = "$root\rustup"; $env:CARGO_HOME = "$root\cargo"
  $cargoBin = "$root\cargo\bin"
  if (-not (Test-Path "$cargoBin\rustc.exe") -or -not (Test-Path "$root\rustup\toolchains\1.97.0-x86_64-pc-windows-msvc\lib\rustlib\x86_64-pc-windows-msvc\lib")) {
    # 清掉上次中断留下的半成品（只限工具链目录下这两个目录）
    foreach ($d in "$root\rustup","$root\cargo") { if (Test-Path $d) { Remove-Item -Recurse -Force $d } ; New-Item -ItemType Directory -Force -Path $d | Out-Null }
    $exe = "$root\downloads\rustup-init.exe"
    $base = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe'
    Write-Host "下载 rustup-init.exe（官方 static.rust-lang.org）"
    Invoke-WebRequest -UseBasicParsing -Uri $base -OutFile $exe
    Invoke-WebRequest -UseBasicParsing -Uri "$base.sha256" -OutFile "$exe.sha256"
    $expected = ((Get-Content "$exe.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
    $result.rustup_init_sha256 = $actual
    $result.rustup_init_signature = (Get-AuthenticodeSignature $exe).Status.ToString()
    if ($expected -ne $actual) { throw "rustup-init.exe SHA256 不匹配：期望 $expected 实际 $actual" }
    Write-Host "SHA256 校验通过：$actual"
    & $exe -y --default-toolchain 1.97.0 --profile minimal --no-modify-path
    if ($LASTEXITCODE -ne 0) { throw "rustup-init 失败，退出码 $LASTEXITCODE" }
  }
  $result.rustc = (& "$cargoBin\rustc.exe" --version)
  $result.cargo = (& "$cargoBin\cargo.exe" --version)
  # 用户级环境变量：以后在任意终端都能用 cargo（只改当前用户，不改系统）
  [Environment]::SetEnvironmentVariable('RUSTUP_HOME', "$root\rustup", 'User')
  [Environment]::SetEnvironmentVariable('CARGO_HOME', "$root\cargo", 'User')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $cargoBin) { [Environment]::SetEnvironmentVariable('Path', ($cargoBin + ';' + $userPath).TrimEnd(';'), 'User') }
  Save-Status

  # ---- VS 2022 C++ 生成工具 ----
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vc = $null
  if (Test-Path $vswhere) { $vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
  if (-not $vc) {
    $bt = "$root\downloads\vs_BuildTools.exe"
    Write-Host "下载 VS 2022 生成工具引导程序（微软官方 aka.ms）"
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vs_BuildTools.exe' -OutFile $bt
    $sig = Get-AuthenticodeSignature $bt
    $result.vs_bootstrapper_signature = "$($sig.Status) | $($sig.SignerCertificate.Subject)"
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw "vs_BuildTools.exe 签名校验失败：$($result.vs_bootstrapper_signature)" }
    Write-Host "微软签名校验通过。即将弹出管理员确认（UAC），请点“是”。安装约 10-20 分钟。"
    Save-Status
    $vsArgs = @('--wait','--passive','--norestart','--nocache',
      '--add','Microsoft.VisualStudio.Workload.VCTools','--includeRecommended',
      '--installPath',"$root\VSBuildTools",'--path',"cache=$root\vs-cache",'--path',"shared=$root\vs-shared")
    $p = Start-Process -FilePath $bt -ArgumentList $vsArgs -Verb RunAs -Wait -PassThru
    $result.vs_install_exit = $p.ExitCode
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "VS 生成工具安装失败，退出码 $($p.ExitCode)" }
    $vc = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  }
  $result.vs_vctools = "$vc"
  if (-not $vc) { throw '未检测到 VC++ 工具' }
  $result.ok = $true
  Write-Host "`n全部完成。" -ForegroundColor Green
} catch {
  $result.ok = $false; $result.error = $_.Exception.Message
  Write-Host "`n出错：$($_.Exception.Message)" -ForegroundColor Red
} finally { Save-Status; Stop-Transcript | Out-Null }
