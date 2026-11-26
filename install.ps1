<#
.SYNOPSIS
    dsh-session-bridge 一键安装

.DESCRIPTION
    把插件装进 DSH profile、装依赖、注册原生消息宿主，并打印扩展安装步骤。

    这个脚本只做不需要人工判断的事：
      1. 复制插件到 $DSH_HOME/profiles/desktop/vendor/dsh-session-bridge
      2. 装 ws 依赖（原生宿主需要）
      3. 注册 native messaging 宿主（Chrome / Edge / QQ浏览器）

    扩展本身必须手动在 chrome://extensions 里加载 —— Chrome 137+ 移除了
    --load-extension，没有绕过的办法。

    ── 重要 ──
    如果脚本就在目标目录里运行（从 vendor 里直接跑），它会跳过"复制"
    这一步 —— 否则会把正在执行的脚本自己删掉。

.PARAMETER DshHome
    DSH 配置目录。默认 $env:DSH_HOME，没设则用 ~/.dsh

.PARAMETER SkipNativeHost
    跳过原生宿主注册（那样断线后要等 alarm 唤醒，最多 60 秒）

.PARAMETER Force
    目标目录已存在时覆盖（源与目标相同时自动跳过）

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1

.EXAMPLE
    .\install.ps1 -DshHome 'D:\mydsh' -Force
#>
[CmdletBinding()]
param(
    [string]$DshHome,
    [switch]$SkipNativeHost,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)        { Write-Host "    + $text" -ForegroundColor Green }
function Warn($text)      { Write-Host "    ! $text" -ForegroundColor Yellow }
function Die($text)       { Write-Host "`n    x $text" -ForegroundColor Red; exit 1 }

# ── 0. 环境 ────────────────────────────────────────────────────────────
Step 0 '检查环境'

$pluginDir = $PSScriptRoot
if (-not (Test-Path (Join-Path $pluginDir 'impl.js'))) {
    Die "这个脚本要在插件根目录里运行（找不到 impl.js）。当前：$pluginDir"
}
Ok "插件目录：$pluginDir"

if (-not $DshHome) {
    if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
if (-not (Test-Path $DshHome)) {
    Die "找不到 DSH 配置目录：$DshHome`n    装过 DSH 再用；或用 -DshHome 指定。"
}
Ok "DSH 配置：$DshHome"

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die '找不到 node，请先装 Node.js 20+' }
$nodeVer = (& node -v).TrimStart('v')
if ([int]($nodeVer.Split('.')[0]) -lt 20) { Die "Node 版本太低：$nodeVer（需要 20+）" }
Ok "Node $nodeVer"

$profileDir = Join-Path $DshHome 'profiles\desktop'
if (-not (Test-Path $profileDir)) {
    Warn "profile 目录不存在：$profileDir"
    Die 'DSH 可能还没初始化过。先启动一次 DSH 再重跑本脚本。'
}
Ok "DSH profile：$profileDir"

# ── 1. 放置插件 ────────────────────────────────────────────────────────
Step 1 '放置插件文件'

$vendorDir = Join-Path $profileDir 'vendor'
$target = Join-Path $vendorDir 'dsh-session-bridge'
New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null

$sameDir = $false
try {
    $a = (Resolve-Path $pluginDir).Path.TrimEnd('\')
    $b = (Resolve-Path $target -ErrorAction SilentlyContinue)
    if ($b -and $a -ieq $b.Path.TrimEnd('\')) { $sameDir = $true }
} catch { }

if ($sameDir) {
    # 就地安装：脚本就在目标位置，绝不能再"清理并复制"
    Ok '脚本已在 vendor 目标目录里运行，跳过复制'
} else {
    if (Test-Path $target) {
        if (-not $Force) {
            Warn "目标已存在：$target"
            Die '用 -Force 覆盖，或先手动备份。'
        }
        # 保留 node_modules（重装依赖慢）
        $keep = Join-Path $target 'node_modules'
        $tmpKeep = $null
        if (Test-Path $keep) {
            $tmpKeep = Join-Path $env:TEMP ("dsb-keep-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
            Move-Item $keep $tmpKeep
        }
        Remove-Item $target -Recurse -Force
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        if ($tmpKeep) { Move-Item $tmpKeep $keep }
        Ok '已清理旧版本'
    }
    Get-ChildItem $pluginDir -Force | Where-Object {
        $_.Name -notin @('.git', 'node_modules', 'icon-src', 'test', '.gitignore',
                         'install.ps1', 'uninstall.ps1')
    } | ForEach-Object {
        Copy-Item $_.FullName -Destination $target -Recurse -Force
    }
    Ok "已复制到 $target"
}

# ── 2. 依赖 ────────────────────────────────────────────────────────────
Step 2 '安装依赖（ws —— 原生宿主连桥要用）'

Push-Location $target
try {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { Die '找不到 npm' }

    if (Test-Path (Join-Path $target 'node_modules\ws')) {
        Ok 'ws 已存在，跳过'
    } else {
        # registry 顺序：本地 .npmrc → 官方源 → 国内镜像
        $regs = @()
        $npmrc = Join-Path $env:USERPROFILE '.npmrc'
        if (Test-Path $npmrc) {
            $line = Get-Content $npmrc | Where-Object { $_ -match '^registry\s*=' } | Select-Object -First 1
            if ($line) { $regs += ($line -replace '^registry\s*=\s*', '').Trim() }
        }
        $regs += @('https://registry.npmjs.org', 'https://registry.npmmirror.com')
        $regs = $regs | Select-Object -Unique

        $installed = $false
        foreach ($reg in $regs) {
            Write-Host "    尝试 $reg ..." -NoNewline
            $job = Start-Job -ScriptBlock {
                param($dir, $r)
                Set-Location $dir
                & npm install ws --no-audit --no-fund --loglevel=error --registry=$r 2>&1 | Out-Null
                if (Test-Path (Join-Path $dir 'node_modules\ws')) { 0 } else { 1 }
            } -ArgumentList $target, $reg
            $done = Wait-Job $job -Timeout 90
            $rc = if ($done) { (Receive-Job $job | Select-Object -Last 1) } else { 1 }
            Stop-Job $job -ErrorAction SilentlyContinue
            Remove-Job $job -Force -ErrorAction SilentlyContinue
            if ($done -and $rc -eq 0) {
                Write-Host ' ok' -ForegroundColor Green
                $installed = $true
                break
            }
            Write-Host ' 失败/超时' -ForegroundColor Yellow
        }

        if ($installed) {
            Ok 'ws 已就位'
        } else {
            Warn 'ws 装不上。原生宿主无法启动，但插件主体仍可用（扩展直连 WebSocket）。'
            Warn ''
            Warn '  手动修复：'
            Warn "    cd `"$target`""
            Warn '    npm install ws'
            Warn ''
            Warn '  有代理的话先设环境变量再重跑：'
            Warn '    $env:HTTPS_PROXY = "http://127.0.0.1:7890"'
        }
    }

    # ── 同步到 node_modules 副本 ──
    # DSH 通过 name: 做模块解析，优先级 node_modules/ > vendor/。
    # 不同步会导致「改了代码不生效」，这是最常见的坑。
    $nmCopy = Join-Path $profileDir 'node_modules\dsh-session-bridge'
    if (Test-Path $nmCopy) {
        try {
            foreach ($f in @('impl.js', 'index.js', 'package.json', 'doctor.mjs')) {
                $src = Join-Path $target $f
                if (Test-Path $src) { Copy-Item $src (Join-Path $nmCopy $f) -Force }
            }
            $extSrc = Join-Path $target 'extension'
            $extDst = Join-Path $nmCopy 'extension'
            if (Test-Path $extSrc) {
                if (Test-Path $extDst) { Remove-Item $extDst -Recurse -Force }
                Copy-Item $extSrc $extDst -Recurse -Force
            }
            Ok '已同步到 node_modules 副本'
        } catch {
            Warn "副本同步失败：$($_.Exception.Message)"
        }
    } else {
        Ok '无 node_modules 副本（不需要同步）'
    }
} finally {
    Pop-Location
}

# ── 3. 原生宿主 ────────────────────────────────────────────────────────
if (-not $SkipNativeHost) {
    Step 3 '注册原生消息宿主'

    # 从浏览器 profile 里扫已装的扩展 ID
    $extId = $null
    $roots = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'),
        (Join-Path $env:LOCALAPPDATA 'Tencent\QQBrowser\User Data')
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $cand = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^(Default|Profile \d+)$' } |
            ForEach-Object {
                $extRoot = Join-Path $_.FullName 'Extensions'
                if (Test-Path $extRoot) {
                    Get-ChildItem $extRoot -Directory -ErrorAction SilentlyContinue |
                        Where-Object { $_.Name -match '^[a-p]{32}$' } |
                        Select-Object -First 1
                }
            } | Select-Object -First 1
        if ($cand) { $extId = $cand.Name; break }
    }

    if ($extId) {
        Ok "检测到扩展 ID：$extId"
    } else {
        Warn '还没装扩展，猜不到扩展 ID。'
        Warn '先按第 4 步装上扩展，然后重跑本脚本让它自动填入。'
    }

    $hostJson = Join-Path $target 'com.dsh.session.json'
    $launcher = Join-Path $target 'dsh-session-native.cmd'
    $origins = if ($extId) { @("chrome-extension://$extId/") }
               else { @('chrome-extension://REPLACE_WITH_YOUR_EXTENSION_ID/') }

    $manifest = [ordered]@{
        type            = 'stdio'
        name            = 'com.dsh.session'
        description     = 'DSH Session Bridge native messaging host'
        path            = $launcher
        allowed_origins = $origins
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $hostJson -Encoding UTF8
    Ok "已写 $hostJson"

    $regPaths = @(
        @{ Label = 'Chrome';   Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.session' },
        @{ Label = 'Edge';     Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.session' },
        @{ Label = 'QQBrowser'; Key = 'HKCU:\Software\Tencent\QQBrowser\NativeMessagingHosts\com.dsh.session' }
    )
    foreach ($r in $regPaths) {
        try {
            New-Item -Path $r.Key -Force | Out-Null
            Set-ItemProperty -Path $r.Key -Name '(Default)' -Value $hostJson
            Ok "$($r.Label) 已注册"
        } catch {
            Warn "$($r.Label) 注册失败（可能没装这个浏览器）"
        }
    }

    # 清掉旧包名留下的注册表项（2.2.0 用的是 com.dsh.bridge）
    $oldKeys = @(
        'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.dsh.bridge',
        'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.bridge',
        'HKCU:\Software\Tencent\QQBrowser\NativeMessagingHosts\com.dsh.bridge'
    )
    foreach ($k in $oldKeys) {
        if (Test-Path $k) {
            try { Remove-Item $k -Recurse -Force; Ok "已清理旧注册项 $k" } catch { }
        }
    }

    if (-not $extId) {
        Warn ''
        Warn 'allowed_origins 现在是占位符 —— 装上扩展后重跑本脚本会自动修正。'
    }
} else {
    Step 3 '跳过原生宿主（-SkipNativeHost）'
    Warn '扩展断线后要等 alarm 唤醒（最多 60 秒）才重连。'
}

# ── 4. 扩展 ────────────────────────────────────────────────────────────
Step 4 '加载浏览器扩展（必须手动，Chrome 137+ 无 API）'

$extDir = Join-Path $target 'extension'
Write-Host ''
Write-Host '    扩展目录：' -NoNewline
Write-Host $extDir -ForegroundColor White
Write-Host ''
Write-Host '    1. 地址栏打开  chrome://extensions'
Write-Host '    2. 右上角开启「开发者模式」'
Write-Host '    3. 点「加载已解压的扩展程序」'
Write-Host '    4. 选择上面那个 extension 目录'
Write-Host ''
Write-Host '    Edge / Brave / QQ浏览器 / 360 同样操作。'

if (-not $env:DSH_INSTALL_SILENT) {
    $answer = Read-Host '    现在打开扩展页？(Y/n)'
    if ($answer -notmatch '^[nN]') {
        try { Start-Process 'chrome.exe' 'chrome://extensions' } catch {
            try { Start-Process 'msedge.exe' 'chrome://extensions' } catch { Warn '自动打开失败，请手动打开' }
        }
    }
}

# ── 5. 启用插件 ────────────────────────────────────────────────────────
Step 5 '启用插件'

$cordis = Join-Path $profileDir 'cordis.patch.yml'
Write-Host ''
Write-Host '    需要在下面这个文件末尾追加（保持 0 缩进）：'
Write-Host "    $cordis" -ForegroundColor White
Write-Host ''
Write-Host @'
- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
'@ -ForegroundColor DarkGray
Write-Host ''

if (Test-Path $cordis) {
    $content = Get-Content $cordis -Raw -Encoding UTF8
    if ($content -match 'dsh-session-bridge') {
        Ok 'cordis.patch.yml 里已存在，跳过'
    } elseif (-not $env:DSH_INSTALL_SILENT) {
        $answer = Read-Host '    自动追加？(Y/n)'
        if ($answer -notmatch '^[nN]') {
            $backup = "$cordis.bak-dshsession-" + (Get-Date -Format 'yyyyMMddHHmmss')
            Copy-Item $cordis $backup
            $append = "`n- insert:`n    - id: dsh-session-bridge`n      name: dsh-session-bridge`n      inject: [ systemPrompt, tools ]`n      config: {}`n"
            Add-Content -Path $cordis -Value $append -Encoding UTF8 -NoNewline
            Ok "已追加（备份：$backup）"
        }
    } else {
        Warn '静默模式下不自动改配置，请手动加'
    }
}

# ── 6. 静默调试提示 ────────────────────────────────────────────────────
Step 6 '配置静默调试（去掉"已开始调试此浏览器"提示）'

Push-Location $target
try {
    node silent-debugger.mjs
} catch {
    Warn '配置失败（不影响插件功能，只是仍会显示调试提示）'
} finally {
    Pop-Location
}

# ── 7. 自检 ────────────────────────────────────────────────────────────
Step 7 '自检'

Push-Location $target
try {
    node doctor.mjs
} catch {
    Warn '自检脚本没跑起来（不影响已完成的安装）'
} finally {
    Pop-Location
}

# ── 8. 完成 ────────────────────────────────────────────────────────────
Step 8 '完成'

Write-Host ''
Write-Host '    下一步：' -ForegroundColor White
Write-Host '      1. 完全退出 DSH，再从快捷方式重新启动'
Write-Host '      2. 在 DSH 里说：browser_status'
Write-Host ''
Write-Host '    期望：extensions >= 1，extensionVersion 2.4.1，codeFresh.stale: false' -ForegroundColor DarkGray
Write-Host ''
Write-Host '    卡住了看 TROUBLESHOOTING.md。' -ForegroundColor DarkGray
Write-Host ''
