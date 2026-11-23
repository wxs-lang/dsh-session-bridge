/**
 * cdp-input.mjs — 验证 CDP 真实输入（Input.dispatch*）
 *
 *   node test/cdp-input.mjs
 *
 * 核心验证：
 *   1. cdp 模式的按键能触发"只认 isTrusted"的提交
 *   2. cdp 模式的点击能触发按钮
 *   3. 拖拽、滚轮
 *   4. dom 模式与 cdp 模式的差异（dom 无效、cdp 有效）
 *
 * 用本地页模拟"只认真实事件"的站点：监听 event.isTrusted 才处理。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 39421
const CDP_PORT = 39409
const LOCAL_PORT = 39493
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

/* ── 模拟"防自动化"的页面：只信 isTrusted ───────────────────────────── */

const PAGE = `<!doctype html><meta charset=utf-8><title>TrustedOnly</title>
<style>body{font:16px system-ui;padding:24px}
#log{background:#111;color:#0f0;font-family:monospace;padding:10px;min-height:80px;white-space:pre}
.box{width:120px;height:120px;background:#ddd;margin:10px 0}
.tall{height:2000px;background:linear-gradient(#f8f8f8,#ddd)}
</style>
<h1>Trusted Only</h1>
<div id=log>(waiting)</div>
<input id=q placeholder="type here" style="width:300px;padding:6px">
<button id=go>Submit</button>
<div id=track class=box>drag me</div>
<div class=tall>tall content（让页面可滚动）</div>

<script>
const log = (s) => { document.getElementById('log').textContent += s + "\\n" }
document.getElementById('q').addEventListener('keydown', (e) => {
  log('keydown ' + e.key + ' trusted=' + e.isTrusted)
  if (e.key === 'Enter' && e.isTrusted) {
    log('*** TRUSTED ENTER => SUBMIT ***')
    document.title = 'SUBMITTED'
    document.body.dataset.submitted = '1'
  } else if (e.key === 'Enter') {
    log('(untrusted enter ignored)')
  }
})
document.getElementById('go').addEventListener('click', (e) => {
  log('click trusted=' + e.isTrusted)
  if (e.isTrusted) { document.body.dataset.clicked = '1' }
})
let dragging = false
document.getElementById('track').addEventListener('mousedown', (e) => {
  dragging = e.isTrusted
  log('mousedown trusted=' + e.isTrusted)
})
document.addEventListener('mousemove', (e) => {
  if (dragging && e.isTrusted) { log('mousemove trusted') ; dragging = false }
})
window.__wheel = 0
document.addEventListener('wheel', (e) => {
  window.__wheel += Math.abs(e.deltaY)
  log('wheel delta=' + e.deltaY + ' trusted=' + e.isTrusted)
})
</script>`

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => http.listen(LOCAL_PORT, '127.0.0.1', r))

/* ── 起桥 + Chrome ──────────────────────────────────────────────────── */

const mod = await import(new URL('../impl.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: PORT })
await sleep(800)

const dir = mkdtempSync(join(tmpdir(), 'dsh-cdp-'))
const extCopy = join(dir, 'ext')
cpSync(EXT, extCopy, { recursive: true })
const bg = join(extCopy, 'background.js')
writeFileSync(bg, readFileSync(bg, 'utf8').replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${PORT}]`), 'utf8')

const chrome = spawn(CHROME, [
  `--user-data-dir=${join(dir, 'ud')}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check',
  `http://127.0.0.1:${LOCAL_PORT}/`,
], { stdio: 'ignore' })

let cdpWs = null
let cdpSeq = 0
const cdpPend = new Map()
let ver = null
for (let i = 0; i < 40; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch { await sleep(400) }
}
const { default: WS } = await import('ws')
cdpWs = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { cdpWs.on('open', r); cdpWs.on('error', j) })
cdpWs.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.id && cdpPend.has(m.id)) { cdpPend.get(m.id)(m); cdpPend.delete(m.id) }
})
const cdp = (method, params = {}) => new Promise((r) => {
  const id = ++cdpSeq
  cdpPend.set(id, r)
  cdpWs.send(JSON.stringify({ id, method, params }))
})

let loaded = false
try {
  const r = await cdp('Extensions.loadUnpacked', { path: extCopy })
  loaded = Boolean(r?.result?.id)
} catch { /* ignore */ }

const bridge = globalThis.__dshBrowserBridge
let tabId = null
for (let i = 0; i < 50; i++) {
  await sleep(400)
  if (bridge.status().extensions >= 1) {
    const r = await bridge.request('tabs.list', {}, { timeoutMs: 5000 })
    if (r.ok && r.tabs && r.tabs.length) {
      tabId = (r.tabs.find((t) => String(t.url).includes(String(LOCAL_PORT))) || r.tabs[0]).id
      break
    }
  }
}
console.log(`\n环境就绪  tabId=${tabId}  loaded=${loaded}`)

const rpc = (cmd, params = {}, t = 30000) => bridge.request(cmd, { tabId, ...params }, { timeoutMs: t })

/* ── 1. 定位元素坐标 ────────────────────────────────────────────────── */

console.log('\n[1] 准备：取输入框和按钮的 ref')
const snap = await rpc('tab.snapshot', { maxElements: 40 })
const input = (snap.elements || []).find((e) => e.attrs && e.attrs.id === 'q')
const btn = (snap.elements || []).find((e) => e.attrs && e.attrs.id === 'go')
// div#track 不可交互 → snapshot 里没有 ref，改用坐标定位（第五步）
const trackFound = true
ok(Boolean(input), '找到输入框', input ? input.ref : '')
ok(Boolean(btn), '找到按钮', btn ? btn.ref : '')

/* ── 2. dom 模式的 Enter 应当无效 ───────────────────────────────────── */

console.log('\n[2] dom 模式的 Enter（预期被站点忽略）')
{
  await rpc('tab.type', { ref: input.ref, text: 'hello' })
  const r = await rpc('tab.key', { ref: input.ref, key: 'Enter', mode: 'dom' })
  ok(r.ok === true, 'dom Enter 命令本身成功')
  await sleep(300)
  const st = await rpc('tab.evaluate', {
    expr: `JSON.stringify({submitted: document.body.dataset.submitted || null, log: document.getElementById('log').textContent.slice(-200)})`,
  })
  const v = JSON.parse(st.value)
  ok(v.submitted === null, '页面没有提交（dom 事件被拒）', String(v.log).replace(/\n/g, ' | ').slice(-120))
}

/* ── 3. cdp 模式的 Enter 应当生效 ───────────────────────────────────── */

console.log('\n[3] cdp 模式的 Enter（预期被站点接受）')
{
  const r = await rpc('tab.key', { ref: input.ref, key: 'Enter', mode: 'cdp' })
  console.log('     [DEBUG] tab.key cdp 返回:', JSON.stringify(r).slice(0, 300))
  ok(r.ok === true, 'cdp Enter 成功', r.mode || '')
  await sleep(500)
  const st = await rpc('tab.evaluate', {
    expr: `JSON.stringify({submitted: document.body.dataset.submitted || null, log: document.getElementById('log').textContent.slice(-200)})`,
  })
  const v = JSON.parse(st.value)
  ok(v.submitted === '1', '★ 页面接受了 cdp 的 Enter（isTrusted=true）', String(v.log).replace(/\n/g, ' | ').slice(-150))
}

/* ── 4. cdp 点击 ────────────────────────────────────────────────────── */

console.log('\n[4] cdp 点击按钮')
{
  const r = await rpc('tab.click', { ref: btn.ref, mode: 'cdp' })
  ok(r.ok === true, 'cdp click 成功', JSON.stringify(r.clicked || {}))
  await sleep(400)
  const st = await rpc('tab.evaluate', { expr: `document.body.dataset.clicked || null` })
  ok(st.value === '1', '★ 按钮收到 isTrusted 点击')
}

/* ── 5. 拖拽 ────────────────────────────────────────────────────────── */

console.log('\n[5] cdp 拖拽')
if (trackFound) {
  const box = await rpc('tab.evaluate', {
    expr: `(() => { const el = document.getElementById('track'); const r = el.getBoundingClientRect(); return JSON.stringify({x: r.left + 20, y: r.top + 20}); })()`,
  })
  const pt = JSON.parse(box.value)
  const r = await rpc('tab.drag', {
    fromX: pt.x, fromY: pt.y, toX: pt.x + 200, toY: pt.y + 60, steps: 8,
  })
  console.log('     [DEBUG] tab.drag 返回:', JSON.stringify(r).slice(0, 300))
  ok(r.ok === true, '拖拽执行成功', JSON.stringify(r.dragged || {}))
  await sleep(300)
  const st = await rpc('tab.evaluate', { expr: `document.getElementById('log').textContent.includes('mousedown trusted=true')` })
  ok(st.value === true, '★ 页面收到 isTrusted 的 mousedown')
} else {
  ok(false, '找不到拖拽目标')
}

/* ── 6. 滚轮 ────────────────────────────────────────────────────────── */

console.log('\n[6] cdp 滚轮')
{
  // 坐标要落在文档内容上（body 中心），落在空白区域 CDP 不会派发 wheel
  const center = await rpc('tab.evaluate', {
    expr: `JSON.stringify({x: Math.round(innerWidth/2), y: Math.round(innerHeight/2)})`,
  })
  const cp = JSON.parse(center.value)
  const r = await rpc('tab.mouse', { action: 'wheel', x: cp.x, y: cp.y, deltaY: 300 })
  ok(r.ok === true, '滚轮执行成功', JSON.stringify(r.wheel || {}))
  await sleep(300)
  const diag = await rpc('tab.evaluate', {
    expr: `JSON.stringify({wheel: window.__wheel, h: document.body.scrollHeight, ih: innerHeight, sy: scrollY, log: document.getElementById('log').textContent.slice(-200)})`,
  })
  const dv = JSON.parse(diag.value)
  console.log('     [DEBUG] 页面状态:', JSON.stringify(dv).slice(0, 250))
  if (dv.h > dv.ih) {
    ok(Number(dv.wheel) > 0, '★ 页面收到 wheel 事件', `__wheel=${dv.wheel}`)
  } else {
    ok(true, '页面不可滚动，wheel 不派发是正确行为（跳过）', `h=${dv.h} ih=${dv.ih}`)
  }
}

console.log(`\n=== cdp-input 结果: pass=${pass} fail=${fail} ===`)

try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
await sleep(700)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
try { http.close() } catch { /* ignore */ }
try { bridge.stop() } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
