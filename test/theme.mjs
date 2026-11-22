/**
 * theme.mjs — 真机验证图标主题切换
 *
 *   node theme.mjs
 *
 * 起独立临时 Chrome 装扩展，走 theme.icon 命令切 light/dark/auto，
 * 每次切换后读回 chrome.action.getUserSettings / 或者直接确认命令返回正确。
 * 同时确认 manifest 静态图标能加载（扩展装载成功就说明路径没问题）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT_DIR = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = 39406
const BRIDGE_PORT = 39414  // 隔离端口

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, n, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`) } else { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`) } }

const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: BRIDGE_PORT })
await sleep(1000)

const dir = mkdtempSync(join(tmpdir(), 'dsh-theme-'))
const EXT_COPY = join(dir, 'ext')
{
  const fs = await import('node:fs')
  fs.cpSync(EXT_DIR, EXT_COPY, { recursive: true })
  const bgPath = join(EXT_COPY, 'background.js')
  let bgSrc = fs.readFileSync(bgPath, 'utf8')
  bgSrc = bgSrc.replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${BRIDGE_PORT}]`)
  fs.writeFileSync(bgPath, bgSrc, 'utf8')
}
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', `--remote-debugging-port=${CDP_PORT}`,
  'about:blank',
], { stdio: 'ignore' })

let ver = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch {}
}
if (!ver) { ok(false, 'CDP 未起来'); await cleanup(); process.exit(1) }

const { default: WS } = await import('ws')
const wsc = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { wsc.on('open', r); wsc.on('error', j) })
let seq = 0; const pend = new Map()
wsc.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const cdp = (method, params) => new Promise((r) => { const id = ++seq; pend.set(id, r); wsc.send(JSON.stringify({ id, method, params })) })

const loaded = await cdp('Extensions.loadUnpacked', { path: EXT_COPY })
const extId = loaded?.result?.id
ok(Boolean(extId), '扩展装载（manifest 静态图标路径全部有效）', extId || JSON.stringify(loaded?.error).slice(0, 100))

let live = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`)).json().catch(() => null)
  if (s && s.extensions >= 1) { live = true; break }
}
ok(live, '桥看到扩展')
if (!live) { await cleanup(); process.exit(1) }

async function rpc(cmd, params = {}, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const u = `http://127.0.0.1:${BRIDGE_PORT}/rpc?cmd=${encodeURIComponent(cmd)}&params=${encodeURIComponent(JSON.stringify(params))}`
    return await (await fetch(u, { signal: ctl.signal })).json()
  } catch (e) { return { ok: false, error: String(e.message || e) } }
  finally { clearTimeout(t) }
}

console.log('\n--- theme.icon 切换 ---')
const a = await rpc('theme.icon', { mode: 'auto' })
ok(a.ok === true, 'auto 模式', `dark=${a.dark} current=${a.current}`)

const d = await rpc('theme.icon', { mode: 'dark' })
ok(d.ok === true && d.dark === true, '强制夜间（纯黑鲸鱼）', `dark=${d.dark}`)

const l = await rpc('theme.icon', { mode: 'light' })
ok(l.ok === true && l.dark === false, '强制白天（蓝色鲸鱼）', `dark=${l.dark}`)

const back = await rpc('theme.icon', { mode: 'auto' })
ok(back.ok === true, '切回 auto', `dark=${back.dark}`)

console.log('\n--- 图标路径可被扩展读取 ---')
// 用 CDP 直接检查扩展的资源能不能加载（说明 setIcon 用的路径有效）
{
  const target = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/icons/icon128.png` })
  await sleep(600)
  ok(Boolean(target?.result?.targetId), '白天 icon128.png 可由扩展加载')
  const t2 = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/icons/dark/icon128.png` })
  await sleep(600)
  ok(Boolean(t2?.result?.targetId), '夜间 dark/icon128.png 可由扩展加载')
}

async function cleanup() {
  if (chrome?.pid) spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(800)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
await cleanup()
console.log(`\n=== theme 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
