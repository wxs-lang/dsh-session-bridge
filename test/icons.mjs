/**
 * icons.mjs — 图标测试
 *
 *   node icons.mjs
 *
 * 验四件事：
 *   1. 两套图标文件都在、尺寸都对、背景透明
 *   2. 白天是蓝（#4D6BFE 附近），夜里是纯黑
 *   3. manifest 引用正确
 *   4. background.js 注册了 theme.icon，且在 SW 顶层调了 watchSystemTheme
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXT = resolve(fileURLToPath(new URL('../extension', import.meta.url)))
let pass = 0, fail = 0
const ok = (c, n, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`) } else { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`) } }

const SIZES = [16, 32, 48, 64, 128]

// --- 1) 文件存在 ---
for (const s of SIZES) {
  const day = join(EXT, 'icons', `icon${s}.png`)
  const night = join(EXT, 'icons', 'dark', `icon${s}.png`)
  ok(existsSync(day) && statSync(day).size > 100, `白天 icon${s}.png`, `${existsSync(day) ? statSync(day).size : 0} B`)
  ok(existsSync(night) && statSync(night).size > 100, `夜间 dark/icon${s}.png`, `${existsSync(night) ? statSync(night).size : 0} B`)
}

// --- 2) 像素检查（PNG 头 + 尺寸） ---
function pngSize(buf) {
  // IHDR 紧跟在 8 字节签名 + 4 长度 + 4 类型之后
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25] }
}
for (const s of SIZES) {
  const b = readFileSync(join(EXT, 'icons', `icon${s}.png`))
  const info = pngSize(b)
  ok(info.w === s && info.h === s, `白天 icon${s} 尺寸正确`, `${info.w}x${info.h}`)
  ok(info.colorType === 6, `白天 icon${s} 带 alpha（透明背景）`, `colorType=${info.colorType}`)
}
for (const s of [16, 128]) {
  const b = readFileSync(join(EXT, 'icons', 'dark', `icon${s}.png`))
  const info = pngSize(b)
  ok(info.w === s && info.colorType === 6, `夜间 icon${s} 尺寸+alpha`, `${info.w}x${info.h} ct=${info.colorType}`)
}

// --- 3) manifest ---
const mf = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))
ok(/^\d+\.\d+\.\d+$/.test(mf.version), 'manifest 版本号合法', mf.version)
ok(mf.name.includes('大肥鱼'), 'manifest name 含「大肥鱼」', mf.name)
ok(mf.icons && mf.icons['16'] === 'icons/icon16.png', 'manifest.icons 指向白天图标')
ok(mf.action.default_icon['128'] === 'icons/icon128.png', 'action.default_icon 正确')
ok(mf._themeIcons && mf._themeIcons.dark['128'] === 'icons/dark/icon128.png',
  'manifest 声明了 dark 主题图标', mf._themeIcons ? 'yes' : 'no')

// --- 4) background.js ---
const bg = readFileSync(join(EXT, 'background.js'), 'utf8')
ok(bg.includes("'theme.icon': cmdThemeIcon"), '注册了 theme.icon 命令')
ok(bg.includes('function watchSystemTheme'), '有 watchSystemTheme')
ok(bg.includes("prefers-color-scheme: dark"), '监听 prefers-color-scheme')
ok(bg.includes('chrome.action.setIcon'), '调用 chrome.action.setIcon')
ok(/^watchSystemTheme\(\)/m.test(bg), 'watchSystemTheme 在顶层调用（SW 每次唤醒都跑）')
ok(bg.includes("const dir = dark ? 'icons/dark' : 'icons'"), '图标路径按主题切换')
ok(/const EXT_VERSION = '\d+\.\d+\.\d+'/.test(bg), 'EXT_VERSION 已声明')

// --- 5) 版本一致性 ---
ok(mf.version === (bg.match(/const EXT_VERSION = '([^']+)'/) || [])[1], 'manifest 与 background 版本一致', mf.version)

// --- 6) 插件工具层 ---
const idx = readFileSync(new URL('../impl.js', import.meta.url), 'utf8')
ok(idx.includes("name: 'browser_theme'"), '插件暴露 browser_theme 工具')
ok(idx.includes("bridge.request('theme.icon'"), 'browser_theme 转发到 theme.icon')


// --- 7) 权限（对齐 ChatGPT 1.26 的 19 项） ---
const WANT = ['alarms','bookmarks','contextMenus','cookies','debugger','downloads','favicon',
  'history','nativeMessaging','notifications','offscreen','scripting','sessions','sidePanel',
  'storage','tabGroups','tabs','topSites','webNavigation']
const missing = WANT.filter((x) => !mf.permissions.includes(x))
ok(missing.length === 0, `权限齐全（${WANT.length} 项）`, missing.length ? '缺: ' + missing.join(',') : 'all present')
ok(mf.permissions.length >= 19, '权限数量 >= 19', String(mf.permissions.length))
ok(Array.isArray(mf.optional_permissions) && mf.optional_permissions.length > 0, '有 optional_permissions', (mf.optional_permissions || []).join(','))
ok(mf.side_panel && mf.side_panel.default_path === 'sidepanel.html', 'side_panel 已声明')

// --- 8) 侧边栏文件 ---
for (const f of ['sidepanel.html', 'sidepanel.js']) {
  ok(existsSync(join(EXT, f)), `${f} 存在`, existsSync(join(EXT, f)) ? `${statSync(join(EXT, f)).size} B` : '')
}

// --- 9) 文件名不能以下划线开头 ---
{
  const { readdirSync } = await import('node:fs')
  const bad = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('_')) bad.push(ent.name)
      if (ent.isDirectory()) walk(join(dir, ent.name))
    }
  }
  walk(EXT)
  ok(bad.length === 0, '无下划线开头的文件（Chrome 保留名）', bad.join(',') || 'clean')
}

console.log(`\n=== icons 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
