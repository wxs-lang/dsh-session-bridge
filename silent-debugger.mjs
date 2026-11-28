#!/usr/bin/env node
/**
 * silent-debugger.mjs — 自动给浏览器加 --silent-debugger-extension-api
 *
 * 为什么需要这个：
 *   chrome.debugger.attach() 会让浏览器显示「XX 已开始调试此浏览器」，
 *   这是 Chrome 的强制提示，扩展 API 无法隐藏。
 *   唯一的出口是浏览器启动参数 --silent-debugger-extension-api。
 *
 * 但扩展没法给自己所在的浏览器加参数 —— 需要外部进程代劳。
 * 原生宿主（native-host.mjs）正好以用户权限在本机跑，由它来做。
 *
 * 做法：
 *   1. 枚举所有浏览器快捷方式（桌面 / 开始菜单 / 任务栏 / 快速启动）
 *   2. 只改指向 chrome.exe / msedge.exe / QQBrowser.exe 的
 *   3. 参数里没有该开关就追加，有就跳过
 *   4. 备份原参数到 JSON，支持 --restore 还原
 *
 * 用法：
 *   node silent-debugger.mjs            # 应用
 *   node silent-debugger.mjs --dry-run  # 只看会改什么
 *   node silent-debugger.mjs --restore  # 还原
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
/* 备份写到用户数据目录，不放代码目录。
 *
 * 原因：备份里含本机快捷方式绝对路径（带用户名）。
 * 放在仓库根目录会被 git 追踪、弄脏工作区，还有把
 * 本机路径推到公开仓库的风险。
 */
const DATA_DIR = join(os.homedir(), '.dsh-session-bridge')
const BACKUP = join(DATA_DIR, 'silent-debugger-backup.json')

function ensureDataDir() {
  try { mkdirSync(DATA_DIR, { recursive: true }) } catch { /* ignore */ }
}
const SWITCH = '--silent-debugger-extension-api'

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const RESTORE = args.includes('--restore')
// 权限不足时的补救：在用户目录建一个带开关的快捷方式副本
const MAKE_USER_LINKS = args.includes('--create-user-shortcuts')

/* ── Windows 上用 PowerShell 操作 .lnk ──
 * Node 没有内置读写快捷方式的能力，WScript.Shell COM 是最稳的。
 */
function ps(script) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
  return out.trim()
}

const TARGET_EXES = ['chrome.exe', 'msedge.exe', 'qqbrowser.exe', 'chromium.exe', 'brave.exe']

function listShortcuts() {
  const json = ps(`
$dirs = @(
  "$env:USERPROFILE\\Desktop",
  "$env:PUBLIC\\Desktop",
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:APPDATA\\Microsoft\\Internet Explorer\\Quick Launch"
)
$sh = New-Object -ComObject WScript.Shell
$out = @()
foreach ($d in $dirs) {
  if (-not (Test-Path $d)) { continue }
  Get-ChildItem $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      $l = $sh.CreateShortcut($_.FullName)
      if ($l.TargetPath) {
        $out += [pscustomobject]@{
          Path = $_.FullName
          Target = $l.TargetPath
          Arguments = [string]$l.Arguments
        }
      }
    } catch { }
  }
}
$out | ConvertTo-Json -Compress -Depth 3
`)
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : [v]
  } catch {
    return []
  }
}

function setShortcutArgs(lnkPath, newArgs) {
  // 用 -LiteralPath 避免路径里的方括号被当通配符
  const escaped = newArgs.replace(/'/g, "''")
  const p = lnkPath.replace(/'/g, "''")
  ps(`
$sh = New-Object -ComObject WScript.Shell
$l = $sh.CreateShortcut('${p}')
$l.Arguments = '${escaped}'
$l.Save()
`)
}

function main() {
  if (process.platform !== 'win32') {
    console.log('这个脚本只处理 Windows 快捷方式。macOS/Linux 见 README。')
    process.exit(0)
  }

  /* ── 还原模式 ── */
  if (RESTORE) {
    if (!existsSync(BACKUP)) {
      console.log('没有备份文件，无法还原：' + BACKUP)
      process.exit(1)
    }
    const bak = JSON.parse(readFileSync(BACKUP, 'utf8'))
    let n = 0
    for (const rec of bak.records || []) {
      if (!existsSync(rec.path)) continue
      try {
        setShortcutArgs(rec.path, rec.originalArgs || '')
        n += 1
        console.log('  还原 ' + rec.path)
      } catch (e) {
        console.log('  失败 ' + rec.path + ' — ' + e.message)
      }
    }
    console.log(`\n还原了 ${n} 个快捷方式。重启浏览器生效。`)
    return
  }

  /* ── 应用模式 ── */
  console.log('枚举快捷方式...')
  const all = listShortcuts()
  console.log(`  找到 ${all.length} 个 .lnk`)

  const targets = all.filter((s) => {
    const t = String(s.Target || '').toLowerCase()
    if (!TARGET_EXES.some((exe) => t.endsWith(exe))) return false
    // 跳过 PWA / 应用模式快捷方式：它们启动的是应用窗口，不是浏览器主界面。
    // 加调试开关没意义，还会让用户以为改错了。
    const a = String(s.Arguments || '')
    if (/--app-id=|--app=|--kiosk/.test(a)) return false
    return true
  })

  console.log(`  其中 ${targets.length} 个指向浏览器：`)
  for (const s of targets) {
    console.log(`    ${s.Target}`)
    console.log(`      ${s.Path}`)
  }

  const need = targets.filter((s) => !String(s.Arguments || '').includes(SWITCH))
  const already = targets.length - need.length

  console.log()
  console.log(`需要改：${need.length} 个（已含开关：${already} 个）`)

  if (need.length === 0) {
    console.log('\n全部已配置，无需改动。')
    return
  }

  if (DRY) {
    console.log('\n--dry-run，只显示不修改：')
    for (const s of need) {
      const before = String(s.Arguments || '').trim()
      const after = (before ? before + ' ' : '') + SWITCH
      console.log(`  ${s.Path}`)
      console.log(`    原: [${before}]`)
      console.log(`    新: [${after}]`)
    }
    return
  }

  // 备份
  const bak = {
    at: new Date().toISOString(),
    switch: SWITCH,
    records: need.map((s) => ({ path: s.Path, target: s.Target, originalArgs: String(s.Arguments || '') })),
  }
  ensureDataDir()
  writeFileSync(BACKUP, JSON.stringify(bak, null, 2), 'utf8')
  console.log(`\n已备份原参数到 ${BACKUP}`)

  let ok = 0
  const denied = []
  const failed = []
  for (const s of need) {
    const before = String(s.Arguments || '').trim()
    const after = (before ? before + ' ' : '') + SWITCH
    try {
      setShortcutArgs(s.Path, after)
      ok += 1
      console.log(`  ✓ ${s.Path}`)
    } catch (e) {
      const msg = String((e && e.message) || e)
      // PowerShell 抛 UnauthorizedAccessException 时 Node 只拿到 stderr 文本
      if (/UnauthorizedAccess|拒绝访问|Access is denied/i.test(msg)) {
        denied.push(s)
        console.log(`  ! 权限不足 ${s.Path}`)
      } else {
        failed.push({ s, msg })
        console.log(`  ✗ ${s.Path} — ${msg.slice(0, 100)}`)
      }
    }
  }

  console.log(`\n完成：${ok} 成功 / ${denied.length} 权限不足 / ${failed.length} 失败`)

  if (denied.length > 0) {
    console.log()
    console.log('  这些在公共目录（ProgramData / 公共桌面），需要管理员权限：')
    for (const s of denied) console.log('    ' + s.Path)
    console.log()
    console.log('  两个办法：')
    console.log('    ① 以管理员身份重跑：')
    console.log('         node silent-debugger.mjs')
    console.log('    ② 或改用用户级快捷方式（不需要管理员）：')
    console.log('         node silent-debugger.mjs --create-user-shortcuts')
    console.log('       会在你的桌面建一个带开关的副本，从它启动即可。')
  }
  console.log()
  /* ── 用户级快捷方式（绕过管理员权限）── */
  if (MAKE_USER_LINKS) {
    console.log()
    console.log('创建用户级快捷方式...')
    const desktop = process.env.USERPROFILE + '\\Desktop'
    const startMenu = process.env.APPDATA +
      '\\Microsoft\\Windows\\Start Menu\\Programs'

    // 从已改成功的快捷方式里提取目标，去重
    const seen = new Set()
    const targets = []
    for (const rec of bak.records) {
      if (seen.has(rec.target)) continue
      seen.add(rec.target)
      targets.push(rec.target)
    }

    for (const target of targets) {
      const base = target.split('\\').pop().replace(/\.exe$/i, '')
      const name = base + ' (静默调试).lnk'
      for (const dir of [desktop, startMenu]) {
        if (!existsSync(dir)) continue
        const out = join(dir, name)
        try {
          ps(`
$sh = New-Object -ComObject WScript.Shell
$l = $sh.CreateShortcut('${out.replace(/'/g, "''")}')
$l.TargetPath = '${target.replace(/'/g, "''")}'
$l.Arguments = '${SWITCH}'
$l.WorkingDirectory = '${dirname(target).replace(/'/g, "''")}'
$l.Save()
`)
          console.log('  ✓ ' + out)
        } catch (e) {
          console.log('  ✗ ' + out + ' — ' + String(e.message).slice(0, 80))
        }
      }
    }
  }

  console.log('下一步：')
  console.log('  1. 完全退出浏览器（所有窗口）')
  console.log('  2. 从改过的快捷方式重新启动')
  console.log('  3. 之后 attach 就不会再弹提示了')
  console.log()
  console.log('还原：node silent-debugger.mjs --restore')
}

main()
