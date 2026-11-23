<#
.SYNOPSIS
    dsh-session-bridge 卸载

.DESCRIPTION
    按安装的反序清理：
      1. 从 cordis.patch.yml 移除插件条目（先备份）
      2. 注销 native messaging 宿主注册表项（新旧两个名字都清）
      3. 删除 vendor 目录与 node_modules 副本
      4. 提示手动移除浏览器扩展

    不动 $DSH_HOME 里的其他任何东西。

.PARAMETER DshHome
    DSH 配置目录。默认 $env:DSH_HOME，没设则用 ~/.dsh

.PARAMETER KeepFiles
    只注销、不删目录（想保留源码时用）

.PARAMETER Yes
    跳过确认
#>
[CmdletBinding()]
param(
    [string]$DshHome,
    [switch]$KeepFiles,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)        { Write-Host "    + $text" -ForegroundColor Green }
function Warn($text)      { Write-Host "    ! $text" -ForegroundColor Yellow }

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome 'profiles\desktop'
$target = Join-Path $profileDir 'vendor\dsh-session-bridge'

Write-Host ''
Write-Host '即将卸载 dsh-session-bridge：' -ForegroundColor White
Write-Host "  profile : $profileDir"
Write-Host "  vendor  : $target"
Write-Host ''
if (-not $Yes) {
    $a = Read-Host '确认？(y/N)'
    if ($a -notmatch '^[yY]') { Write-Host '已取消'; exit 0 }
}

# ── 1. 配置条目 ────────────────────────────────────────────────────────
Step 1 '从 cordis.patch.yml 移除插件条目'

$cordis = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $cordis) {
    $lines = Get-Content $cordis -Encoding UTF8
    $out = New-Object System.Collections.Generic.List[string]
    $removed = 0
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        if ($line -match 'dsh-session-bridge' -and $line -match '^\s*-\s*id:') {
            # 回退到 "- insert:" 并删掉整块
            while ($out.Count -gt 0 -and $out[$out.Count - 1] -notmatch '^\s*-\s*insert:') {
                $out.RemoveAt($out.Count - 1)
            }
            if ($out.Count -gt 0) { $out.RemoveAt($out.Count - 1) }
            $removed++
            $j = $i + 1
            while ($j -lt $lines.Count -and $lines[$j] -match '^\s{4,}\S') { $j++ }
            $i = $j - 1
            continue
        }
        $out.Add($line)
    }
    if ($removed -gt 0) {
        $backup = "$cordis.bak-uninstall-" + (Get-Date -Format 'yyyyMMddHHmmss')
        Copy-Item $cordis $backup
        ($out -join "`n") | Set-Content -Path $cordis -Encoding UTF8 -NoNewline
        Ok "已移除 $removed 条（备份：$backup）"
    } else {
        Warn '没找到插件条目，跳过'
    }
} else {
    Warn "找不到 $cordis"
}

# ── 2. 原生宿主 ────────────────────────────────────────────────────────
Step 2 '注销原生消息宿主'

$keys = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.session',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.session',
    'HKCU:\Software\Tencent\QQBrowser\NativeMessagingHosts\com.dsh.session',
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.bridge',
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.bridge',
    'HKCU:\Software\Tencent\QQBrowser\NativeMessagingHosts\com.dsh.bridge'
)
$any = $false
foreach ($k in $keys) {
    if (Test-Path $k) {
        try {
            Remove-Item $k -Recurse -Force
            Ok "已注销 $k"
            $any = $true
        } catch {
            Warn "注销失败：$k"
        }
    }
}
if (-not $any) { Warn '没有找到任何注册项' }

# ── 3. 目录 ────────────────────────────────────────────────────────────
if ($KeepFiles) {
    Step 3 '保留文件（-KeepFiles）'
    Warn "目录未删：$target"
} else {
    Step 3 '删除插件目录'
    if (Test-Path $target) {
        Remove-Item $target -Recurse -Force
        Ok "已删除 $target"
    } else {
        Warn "不存在：$target"
    }
    $nm = Join-Path $profileDir 'node_modules\dsh-session-bridge'
    if (Test-Path $nm) {
        Remove-Item $nm -Recurse -Force
        Ok "已删除 $nm"
    }
}

# ── 4. 扩展 ────────────────────────────────────────────────────────────
Step 4 '浏览器扩展（需手动移除）'

Write-Host ''
Write-Host '    chrome://extensions → 找到「大肥鱼 · DSH Session Bridge」→ 移除' -ForegroundColor White
Write-Host '    Edge / QQ浏览器 如装过，同样操作。' -ForegroundColor DarkGray
Write-Host ''
Write-Host '    完全退出 DSH 再启动，插件就彻底不在了。' -ForegroundColor DarkGray
Write-Host ''
