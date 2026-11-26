#!/usr/bin/env node
/**
 * features24.mjs — 2.4.0 新增能力的静态验证
 *
 * 这些测试不需要真浏览器，检查的是：
 *   · 工具参数是否暴露（fullPage / maxHeight）
 *   · 错误码是否细化（restricted_store / restricted_pdf / ...）
 *   · 断线退避是否实现
 *   · 批量中断是否上报 remaining
 *   · doctor.mjs 是否存在且可解析
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../impl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BG = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8')
const IMPL = readFileSync(join(ROOT, 'impl.js'), 'utf8')

const { TOOL_SPECS } = _internals

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ── ① 整页截图参数 ──
console.log('\n──── ① 整页截图 ────')
{
  const shot = TOOL_SPECS.find((t) => t.name === 'browser_screenshot')
  ok(Boolean(shot), 'browser_screenshot 存在')
  const props = Object.keys((shot && shot.parameters && shot.parameters.properties) || {})
  ok(props.includes('fullPage'), '暴露 fullPage 参数')
  ok(props.includes('maxHeight'), '暴露 maxHeight 参数')
  ok(String(shot.description).includes('整页'), '描述里说明整页截图')

  ok(BG.includes('captureFullPage'), '扩展侧有 captureFullPage')
  ok(BG.includes('16000'), '有纹理上限保护')

  // ── 关键：整页截图不能改视口，否则页面会重排两次（肉眼可见的跳动）──
  const code = BG.replace(/\/\*[\s\S]*?\*\//g, '')   // 去掉注释再判断
  ok(!/Emulation\.setDeviceMetricsOverride\s*,?\s*\{/.test(code)
     && !/sendCommand\([^)]*'Emulation\.setDeviceMetricsOverride'/.test(code),
     '★ 不再调 setDeviceMetricsOverride（页面不重排）')
  ok(!/sendCommand\([^)]*'Emulation\.clearDeviceMetricsOverride'/.test(code),
     '★ 不再调 clearDeviceMetricsOverride')
  ok(!/sendCommand\([^)]*'Emulation\.setFocusEmulationEnabled'/.test(code),
     '★ 不再伪造焦点（避免 :focus-within 等副作用）')
  ok(BG.includes('captureBeyondViewport'), '用 captureBeyondViewport 截视口外')
  ok(BG.includes('clip:'), '用 clip 指定截取区域')
}

// ── ② 快照视口提示 ──
console.log('\n──── ② 快照视口提示 ────')
{
  ok(BG.includes('docHeight'), 'pageSnapshot 返回 docHeight')
  ok(BG.includes('uncoveredBelow'), '返回 uncoveredBelow')
  ok(BG.includes('browser_scroll'), '提示里说明怎么滚动')
}

// ── ③ 错误码细化 ──
console.log('\n──── ③ 错误码细化 ────')
{
  const codes = ['restricted_page', 'restricted_store', 'restricted_pdf', 'restricted_extension']
  for (const c of codes) {
    ok(BG.includes(`'${c}'`), `定义了 ${c}`)
  }
}

// ── ④ 断线退避 ──
console.log('\n──── ④ 断线退避 ────')
{
  ok(BG.includes('RECONNECT_MAX_MS'), '有退避上限常量')
  ok(BG.includes('RECONNECT_BACKOFF'), '有退避系数')
  ok(BG.includes('reconnectAttempt'), '记录重试次数')
  ok(BG.includes('l.reconnectAttempt = 0'), '连上后重置')
}

// ── ⑤ 批量中断上报 ──
console.log('\n──── ⑤ 批量中断上报 ────')
{
  ok(BG.includes('navigation_interrupted'), '识别导航中断')
  ok(BG.includes('remaining'), '返回 remaining')
  ok(BG.includes('aborted'), '返回 aborted 详情')
}

// ── ⑥ doctor 自检 ──
console.log('\n──── ⑥ doctor 自检 ────')
{
  ok(existsSync(join(ROOT, 'doctor.mjs')), 'doctor.mjs 存在')
  const doc = readFileSync(join(ROOT, 'doctor.mjs'), 'utf8')
  for (const k of ['Node 版本', 'ws 模块', '桥端口', '扩展连接', '副本同步']) {
    ok(doc.includes(k), `检查项「${k}」`)
  }
  ok(doc.includes('--json'), '支持 --json 输出')
}

// ── ⑦ 跨平台安装脚本 ──
console.log('\n──── ⑦ 跨平台安装 ────')
{
  ok(existsSync(join(ROOT, 'install.ps1')), 'install.ps1（Windows）')
  ok(existsSync(join(ROOT, 'install.sh')), 'install.sh（macOS/Linux）')
  ok(existsSync(join(ROOT, 'dsh-session-native.sh')), 'native 启动器（POSIX）')
  const sh = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  ok(sh.includes('NativeMessagingHosts'), 'Linux/macOS 宿主目录')
  ok(sh.includes('doctor.mjs'), '装完跑自检')
}

// ── ⑧ 权限收敛 ──
console.log('\n──── ⑧ 权限收敛 ────')
{
  const mf = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8'))
  ok(mf.permissions.length <= 10, '权限数 <= 10', String(mf.permissions.length))
  const unused = ['history', 'bookmarks', 'cookies', 'downloads', 'topSites',
                  'sessions', 'favicon', 'notifications', 'offscreen',
                  'webNavigation', 'storage']
  const still = unused.filter((p) => mf.permissions.includes(p))
  ok(still.length === 0, '未使用权限已全部移除', still.join(',') || 'clean')
}

console.log(`\n=== features24 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail ? 1 : 0)
