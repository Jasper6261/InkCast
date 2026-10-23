# 03 局域网自检（只读）：本机访问配对页 + 查看防火墙对白板程序的规则。结果：logs\03-lan-check.txt
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'logs') | Out-Null  # 新克隆的仓库里没有 logs 文件夹
$ErrorActionPreference = 'Continue'
$out = New-Object System.Collections.Generic.List[string]
function Add($k,$v){ $out.Add(("{0}: {1}" -f $k,$v)) }
$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -eq 'WLAN' } | Select-Object -First 1).IPAddress
Add 'WLAN_IP' $ip
Add 'WLAN_Profile' ((Get-NetConnectionProfile -InterfaceAlias 'WLAN' -ErrorAction SilentlyContinue).NetworkCategory)
$listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in ((Get-Process -Name 'wireless-whiteboard*','无线白板' -ErrorAction SilentlyContinue).Id) }
foreach ($l in $listen) { Add 'Listening' "$($l.LocalAddress):$($l.LocalPort)" }
foreach ($l in ($listen | Where-Object { $_.LocalAddress -eq $ip })) {
  try { $r = [Net.WebRequest]::Create("http://$($ip):$($l.LocalPort)/pad"); $r.Proxy = $null; $r.Timeout = 5000
        $resp = $r.GetResponse(); $sr = New-Object IO.StreamReader($resp.GetResponseStream()); $body = $sr.ReadToEnd()
        Add 'GET /pad' "$([int]$resp.StatusCode) bytes=$($body.Length) title=$([regex]::Match($body,'<title>(.*?)</title>').Groups[1].Value)"; $resp.Close() }
  catch { Add 'GET /pad' "失败：$($_.Exception.Message)" }
}
$filters = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { ($_.Program -like '*wireless-whiteboard*' -or $_.Program -like '*无线白板*') }
if (-not $filters) { Add 'FirewallRules' '没有针对白板程序的规则' }
foreach ($f in $filters) {
  $ru = $f | Get-NetFirewallRule -ErrorAction SilentlyContinue
  $pf = $ru | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  $af = $ru | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
  Add 'FirewallRule' "$($ru.DisplayName) | 动作=$($ru.Action) 启用=$($ru.Enabled) 配置文件=$($ru.Profile) 协议=$($pf.Protocol) 远程=$($af.RemoteAddress) | 程序=$($f.Program)"
}
Add 'CheckedAt' (Get-Date -Format s)
$out | Set-Content (Join-Path $PSScriptRoot 'logs\03-lan-check.txt') -Encoding UTF8
