# 只读环境检查：不安装、不修改任何东西，结果写到 logs\env-check.txt
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot 'logs\env-check.txt'
$out = New-Object System.Collections.Generic.List[string]
function Add($k, $v) { $out.Add(("{0}: {1}" -f $k, $v)) }
$os = Get-CimInstance Win32_OperatingSystem
Add 'OS' "$($os.Caption) | build $($os.BuildNumber) | $($os.OSArchitecture)"
Add 'EditionID' (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').EditionID
Add 'DisplayVersion' (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').DisplayVersion
$cs = Get-CimInstance Win32_ComputerSystem
Add 'RAM_GB' ([math]::Round($cs.TotalPhysicalMemory/1GB,1))
Add 'HypervisorPresent' $cs.HypervisorPresent
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
Add 'CPU' "$($cpu.Name) cores=$($cpu.NumberOfCores) threads=$($cpu.NumberOfLogicalProcessors)"
Add 'VirtualizationFirmwareEnabled' $cpu.VirtualizationFirmwareEnabled
Add 'WindowsSandbox.exe' (Test-Path "$env:windir\System32\WindowsSandbox.exe")
foreach ($d in 'C','D') { $v = Get-PSDrive $d -ErrorAction SilentlyContinue; if ($v) { Add "Free_$d`_GB" ([math]::Round($v.Free/1GB,1)) } }
foreach ($c in 'rustc','cargo','rustup','node','npm','git','winget') {
  $p = Get-Command $c -ErrorAction SilentlyContinue
  if ($p) { $ver = try { (& $c --version 2>&1 | Select-Object -First 1) } catch { '?' }; Add $c "$($p.Source) | $ver" } else { Add $c 'not found' }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (Test-Path $vswhere) { Add 'VS_with_VCTools' ((& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) -join ';') } else { Add 'vswhere' 'not found' }
$wv = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
Add 'WebView2' $(if ($wv) { $wv.pv } else { 'not found (HKLM)' })
Add 'IsAdmin' ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | ForEach-Object {
  $prof = (Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).NetworkCategory
  Add 'IPv4' "$($_.InterfaceAlias) = $($_.IPAddress)/$($_.PrefixLength) profile=$prof"
}
$px = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
Add 'SystemProxy' "enable=$($px.ProxyEnable) server=$($px.ProxyServer)"
Add 'CheckedAt' (Get-Date -Format s)
$out | Set-Content -Path $log -Encoding UTF8
