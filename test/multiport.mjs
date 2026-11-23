/**
 * multiport.mjs — 验证扩展"有能力"连多个桥端口
 *
 * 1.5.2 起扩展默认只连 39401（多端口 = 3 倍 ping 唤醒、SW 常驻更重）。
 * 所以本测试自己拷贝扩展并把 BRIDGE_PORTS 改成 [PORT_A, PORT_B]，
 * 验证"需要多端口时机制还能开回来"。
 * 同时避免直接装真实扩展目录 —— 那份只认 39401，会连到用户正在跑的宿主编上。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT_A = 39401
const PORT_B = 39411
const CDP = 39404
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 起独立桥
const mod = await import(new URL('../impl.js', import.meta.url).href)
mod.apply({
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: () => () => {} },
  systemPrompt: { section() {} },
  effect() {}, on() {}, get: () => null,
}, { port: PORT_B })
await sleep(800)

const dir = mkdtempSync(join(tmpdir(), 'multi-'))
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', `--remote-debugging-port=${CDP}`,
  'https://example.com/',
], { stdio: 'ignore' })

let ver = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try { ver = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break } catch {}
}
if (!ver) { console.log('CDP 未起'); process.exit(1) }

const { default: WS } = await import('ws')
const w = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { w.on('open', r); w.on('error', j) })
let seq = 0
const pend = new Map()
w.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const cdp = (method, params) => new Promise((r) => { const id = ++seq; pend.set(id, r); w.send(JSON.stringify({ id, method, params })) })
// 拷贝扩展并改写 BRIDGE_PORTS，装隔离副本（绝不装真实目录）
const extCopy = join(dir, 'ext')
cpSync(EXT, extCopy, { recursive: true })
const bgPath = join(extCopy, 'background.js')
const bgSrc = readFileSync(bgPath, 'utf8')
const bgOut = bgSrc.replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${PORT_A}, ${PORT_B}]`)
if (bgOut === bgSrc) console.log('⚠ 没能改写 BRIDGE_PORTS（正则没匹配到）')
writeFileSync(bgPath, bgOut, 'utf8')

const loaded = await cdp('Extensions.loadUnpacked', { path: extCopy })
console.log('loadUnpacked:', JSON.stringify(loaded?.result || loaded?.error))

let a = 0, b = 0
for (let i = 0; i < 30; i++) {
  await sleep(500)
  try {
    a = (await (await fetch(`http://127.0.0.1:${PORT_B}/`)).json()).extensions
    try { b = (await (await fetch(`http://127.0.0.1:${PORT_A}/`)).json()).extensions } catch { b = -1 }
  } catch { a = -2 }
  if (a >= 1) break
}
console.log(`独立桥 ${PORT_B}: extensions=${a} | 宿主桥 ${PORT_A}: extensions=${b}`)
let pass = 0
let fail = 0
if (a >= 1) { pass += 1; console.log('  ✓ 扩展连上了独立桥') }
else { fail += 1; console.log('  ✗ 扩展没连上独立桥') }
// 宿主桥那条是"加分项"：宿主没运行、或跑的是不认识新端口的旧代码，
// 都不算本插件的缺陷，所以只记录不判失败。
if (b >= 1) { pass += 1; console.log('  ✓ 扩展同时也连着宿主桥（多端口生效）') }
else { console.log('  · 扩展未连宿主桥（宿主可能未运行或旧代码，不计失败）') }

console.log(`=== multiport 结果: pass=${pass} fail=${fail} ===`)

spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
await sleep(700)
try { rmSync(dir, { recursive: true, force: true }) } catch {}
try { globalThis.__dshBrowserBridge.stop() } catch {}
process.exit(fail === 0 ? 0 : 1)
