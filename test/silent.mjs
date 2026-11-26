#!/usr/bin/env node
/**
 * silent.mjs — 静默调试提示的静态验证
 *
 * chrome.debugger.attach() 会让浏览器弹「XX 已开始调试此浏览器」，
 * 扩展 API 无法隐藏，只能靠浏览器启动参数 --silent-debugger-extension-api。
 * 扩展没法给自己所在的浏览器加参数，所以由原生宿主代劳。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../impl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const read = (f) => readFileSync(join(ROOT, f), 'utf8')
const IMPL = read('impl.js')
const NH = read('native-host.mjs')

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── ① 脚本存在 ──
console.log('\n──── ① 修复脚本 ────')
ok(existsSync(join(ROOT, 'silent-debugger.mjs')), 'silent-debugger.mjs 存在')
{
  const s = read('silent-debugger.mjs')
  ok(s.includes('--silent-debugger-extension-api'), '使用正确的开关名')
  ok(s.includes('--dry-run'), '支持 dry-run')
  ok(s.includes('--restore'), '支持还原')
  ok(s.includes('--create-user-shortcuts'), '支持用户级快捷方式')
  ok(s.includes('app-id'), '跳过 PWA 快捷方式')
  ok(s.includes('UnauthorizedAccess'), '区分权限不足')
}

// ── ② 宿主本地命令 ──
console.log('\n──── ② 宿主本地命令 ────')
ok(NH.includes("host.fix-silent-debugger"), '宿主处理 host.fix-silent-debugger')
ok(NH.includes('runSilentDebugger'), '有 runSilentDebugger 实现')
ok(NH.includes('replyToBridge'), '有回传机制')
ok(NH.includes("host.info"), '有 host.info 自检命令')
ok(!/host\.fix-silent-debugger[\s\S]{0,200}writeNative/.test(NH),
   '该命令不转发给扩展（本地处理）')

// ── ③ 桥侧 requestHost ──
console.log('\n──── ③ 桥侧路由 ────')
ok(IMPL.includes('requestHost('), '桥有 requestHost 方法')
ok(IMPL.includes('native_host_missing'), '没宿主时给明确错误')
ok(IMPL.includes("dshBrand || '') === 'NativeHost'"), '按 brand 找宿主连接')

// ── ④ 工具暴露 ──
console.log('\n──── ④ 工具 ────')
{
  const { TOOL_SPECS } = _internals
  const t = TOOL_SPECS.find((x) => x.name === 'browser_fix_debugger_banner')
  ok(Boolean(t), 'browser_fix_debugger_banner 已注册')
  if (t) {
    const p = Object.keys(t.parameters.properties)
    ok(p.includes('dryRun'), '有 dryRun 参数')
    ok(p.includes('restore'), '有 restore 参数')
    ok(p.includes('userShortcuts'), '有 userShortcuts 参数')
    ok(t.description.includes('silent-debugger-extension-api'), '描述里说明原理')
  }
}

// ── ⑤ .cmd 启动器必须纯 ASCII ──
console.log('\n──── ⑤ 启动器编码 ────')
{
  const p = join(ROOT, 'dsh-session-native.cmd')
  ok(existsSync(p), 'dsh-session-native.cmd 存在')
  if (existsSync(p)) {
    const buf = readFileSync(p)
    const nonAscii = [...buf].filter((b) => b > 127).length
    // cmd.exe 用系统代码页读文件，非 ASCII 注释会变成垃圾命令
    ok(nonAscii === 0, '★ 纯 ASCII（避免 cmd 按 GBK 解析乱码）', `${nonAscii} 个非 ASCII 字节`)
    const txt = buf.toString('latin1')
    ok(!/^\s*echo\s/m.test(txt), '没有 echo（会破坏协议通道）')
    ok(txt.includes('native-host.mjs'), '指向 native-host.mjs')
  }
}

// ── ⑥ 安装脚本接入 ──
console.log('\n──── ⑥ 安装脚本 ────')
{
  const ps1 = readFileSync(join(ROOT, 'install.ps1'), 'utf8')
  ok(ps1.includes('silent-debugger.mjs'), 'install.ps1 调用修复脚本')
  ok(ps1.includes('doctor.mjs'), 'install.ps1 跑自检')
  const sh = read('install.sh')
  ok(sh.includes('silent-debugger.mjs'), 'install.sh 调用修复脚本')
}

console.log(`\n=== silent 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail ? 1 : 0)
