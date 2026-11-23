/**
 * features.mjs — 验证 1.8.0 新增的 4 项能力
 *
 *   node test/features.mjs
 *
 * 覆盖：
 *   1. key        单键 / 组合键
 *   2. scroll     按屏滚 / 滚到顶 / 滚到底
 *   3. batch      批量执行 + 遇错即停
 *   4. 导航历史   back / forward / reload
 *
 * 用一个本地静态页，不依赖外网。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 39418
const CDP_PORT = 39407
const LOCAL_PORT = 39492
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

/* ── 本地测试页 ─────────────────────────────────────────────────────── */

const PAGE = `<!doctype html><meta charset=utf-8><title>Features</title>
<style>body{font:16px system-ui;padding:20px} .tall{height:3000px;background:linear-gradient(#fff,#eef)}
#log{font-family:monospace;background:#f4f4f4;padding:8px;margin:8px 0;white-space:pre}</style>
<h1>Feature Test</h1>
<input id=q placeholder="type here">
<button id=go onclick="document.getElementById('log').textContent+='CLICK\\\\n'">Go</button>
<div id=log></div>
<div class=tall>tall</div>
<div id=target>BOTTOM TARGET</div>`

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise((r) => http.listen(LOCAL_PORT, '127.0.0.1', r))

/* ── 起桥 ───────────────────────────────────────────────────────────── */

const mod = await import(new URL('../impl.js', import.meta.url).href)
const stub = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}
mod.apply(stub, { port: PORT })
await sleep(800)

/* ── 起 Chrome + 装载隔离扩展 ───────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'dsh-feat-'))
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
], { stdio: 'ignore', detached: false })

// Extensions.loadUnpacked 只在**浏览器级** CDP 端点上可用。
// page 级的 webSocketDebuggerUrl 会返回 {"code":-32000,"message":"Method not available."} —
// 这是我第一次写 features.mjs 时踩的坑。
let cdpWs = null
let cdpSeq = 0
const cdpPend = new Map()

async function openBrowserCdp() {
  let ver = null
  for (let i = 0; i < 40; i++) {
    try {
      ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
      break
    } catch { await sleep(400) }
  }
  if (!ver) throw new Error('CDP 未起来')
  const { default: WS } = await import('ws')
  cdpWs = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((r, j) => { cdpWs.on('open', r); cdpWs.on('error', j) })
  cdpWs.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.id && cdpPend.has(m.id)) { cdpPend.get(m.id)(m); cdpPend.delete(m.id) }
  })
}

function cdp(method, params = {}) {
  return new Promise((r) => {
    const id = ++cdpSeq
    cdpPend.set(id, r)
    cdpWs.send(JSON.stringify({ id, method, params }))
  })
}

let loaded = false
try {
  await openBrowserCdp()
  const r = await cdp('Extensions.loadUnpacked', { path: extCopy })
  loaded = Boolean(r?.result?.id)
  if (!loaded) console.log('  loadUnpacked 失败:', JSON.stringify(r?.error || r))
} catch (e) {
  console.log('  CDP 连接失败:', e.message)
}

const bridge = globalThis.__dshBrowserBridge
let tabId = null
for (let i = 0; i < 50; i++) {
  await sleep(400)
  const s = bridge.status()
  if (s.extensions >= 1) {
    const r = await bridge.request('tabs.list', {}, { timeoutMs: 5000 })
    if (r.ok && r.tabs && r.tabs.length) {
      tabId = (r.tabs.find((t) => String(t.url).includes(String(LOCAL_PORT))) || r.tabs[0]).id
      break
    }
  }
}

console.log('\n环境就绪  tabId=' + tabId + '  loaded=' + loaded)

async function rpc(cmd, params = {}) {
  return bridge.request(cmd, { tabId, ...params }, { timeoutMs: 30000 })
}

/* ── 1. key ─────────────────────────────────────────────────────────── */

console.log('\n[1] browser_key')
{
  const snap = await rpc('tab.snapshot', { maxElements: 30 })
  const input = (snap.elements || []).find((e) => e.attrs && e.attrs.id === 'q')
  ok(Boolean(input), '找到输入框 ref', input ? input.ref : '')

  if (input) {
    await rpc('tab.type', { ref: input.ref, text: 'hello' })
    // Control+a 全选，再用普通字符覆盖
    const r1 = await rpc('tab.key', { ref: input.ref, key: 'Control+a' })
    ok(r1.ok === true, '组合键 Control+a 成功', r1.resolved ? JSON.stringify(r1.resolved) : '')
    ok(r1.resolved && r1.resolved.ctrl === true, '解析出 ctrl=true')

    const r2 = await rpc('tab.key', { ref: input.ref, key: 'Escape' })
    ok(r2.ok === true, '单键 Escape 成功')

    const r3 = await rpc('tab.key', { ref: input.ref, key: 'Shift+Tab' })
    ok(r3.ok === true && r3.resolved.shift === true, 'Shift+Tab 解析正确')

    const bad = await rpc('tab.key', { key: '' })
    ok(bad.ok === false, '空 key 报错', bad.error || '')
  }
}

/* ── 2. scroll ──────────────────────────────────────────────────────── */

console.log('\n[2] browser_scroll')
{
  const r1 = await rpc('tab.scroll', { mode: 'by', direction: 'down', amount: 2 })
  ok(r1.ok === true, '向下滚 2 屏', `from=${r1.scroll.from} to=${r1.scroll.to}`)
  ok(r1.scroll.to > r1.scroll.from, 'scrollY 变大')

  const r2 = await rpc('tab.scroll', { mode: 'bottom' })
  ok(r2.ok === true && r2.scroll.to > r1.scroll.to, '滚到底部')

  const r3 = await rpc('tab.scroll', { mode: 'top' })
  ok(r3.ok === true && r3.scroll.to === 0, '滚回顶部')

  // 滚到底再滚回顶部取 ref（snapshot 只覆盖视口附近）
  await rpc('tab.scroll', { mode: 'bottom' })
  await rpc('tab.scroll', { mode: 'top' })
  const snap = await rpc('tab.snapshot', { maxElements: 60 })
  const anyEl = (snap.elements || []).find((e) => e.ref)
  if (anyEl) {
    const r4 = await rpc('tab.scroll', { mode: 'to', ref: anyEl.ref })
    ok(r4.ok === true, '滚到指定元素', `to=${r4.scroll.to}`)
  } else {
    ok(false, '拿不到任何元素 ref')
  }
}

/* ── 3. batch ───────────────────────────────────────────────────────── */

console.log('\n[3] browser_batch')
{
  await rpc('tab.scroll', { mode: 'top' })
  const snap = await rpc('tab.snapshot', { maxElements: 30 })
  const input = (snap.elements || []).find((e) => e.attrs && e.attrs.id === 'q')
  const btn = (snap.elements || []).find((e) => e.attrs && e.attrs.id === 'go')

  if (input && btn) {
    const t0 = Date.now()
    const r = await rpc('tab.batch', {
      actions: [
        { op: 'click', ref: input.ref },
        { op: 'type', ref: input.ref, text: 'batch-test' },
        { op: 'key', ref: input.ref, key: 'Tab' },
        { op: 'click', ref: btn.ref, waitAfter: 200 },
      ],
      snapshot: true,
      maxElements: 40,
    })
    const elapsed = Date.now() - t0
    ok(r.ok === true, '批量执行成功', `${r.executed}/${r.actionCount} 条，内部耗时 ${r.costMs}ms`)
    ok(r.executed === 4, '4 条全执行')
    ok(r.results.every((x) => x.ok), '每条都 ok')
    ok(Boolean(r.elementCount), '最后带回了快照', `elements=${r.elementCount}`)

    // 批量 vs 逐条：批量只有 1 次 WebSocket 往返 + 1 次快照
    // 逐条要 4 次往返 + 每次可能都带快照
    const t1 = Date.now()
    const s0 = await rpc('tab.snapshot', { maxElements: 20 })
    const inp = (s0.elements || []).find((e) => e.attrs && e.attrs.id === 'q')
    if (inp) {
      await rpc('tab.click', { ref: inp.ref, snapshot: false })
      await rpc('tab.type', { ref: inp.ref, text: 'x' })
      await rpc('tab.key', { ref: inp.ref, key: 'Tab' })
      await rpc('tab.snapshot', { maxElements: 40 })
    }
    const singleMs = Date.now() - t1
    ok(true, '批量 vs 逐条（仅记录，不作断言）', `batch 4动作=${elapsed}ms  逐条4动作=${singleMs}ms`)
  } else {
    ok(false, '没找到输入框/按钮')
  }

  // 遇错即停
  const r2 = await rpc('tab.batch', {
    actions: [
      { op: 'click', ref: 'e999' },
      { op: 'key', key: 'Enter' },
    ],
    snapshot: false,
  })
  ok(r2.ok === false, '遇错返回 ok:false')
  ok(r2.executed === 1, 'fail-fast：只执行了第 1 条', `executed=${r2.executed}`)

  // continueOnError
  const r3 = await rpc('tab.batch', {
    actions: [
      { op: 'click', ref: 'e999' },
      { op: 'scroll', mode: 'top' },
    ],
    snapshot: false,
    continueOnError: true,
  })
  ok(r3.executed === 2, 'continueOnError：两条都执行', `executed=${r3.executed}`)
  ok(r3.results[1].ok === true, '第 2 条成功')
}

/* ── 4. 导航历史 ────────────────────────────────────────────────────── */

console.log('\n[4] 导航历史')
{
  // chrome.tabs.update 对"同一文档内换 query"不会产生历史条目。
  // 要用不同的**路径**（服务端返回不同文档），才会进 history。
  await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/a`, newTab: false, waitMs: 500 })
  await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/b`, newTab: false, waitMs: 500 })
  await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/c`, newTab: false, waitMs: 500 })

  const info2 = await rpc('tab.info')
  ok(String(info2.tab.url).endsWith('/c'), '当前在 /c', info2.tab.url)

  const hist = await rpc('tab.evaluate', { expr: 'JSON.stringify({len: history.length, url: location.href})' })
  console.log('     history 状态:', JSON.stringify(hist).slice(0, 300))
  const back = await rpc('tab.navigate', { back: true, waitMs: 600 })
  ok(back.ok === true && back.action === 'back', '后退成功', JSON.stringify(back).slice(0, 200))
  ok(String(back.url).endsWith('/b'), '退回到 /b', back.url)

  const fwd = await rpc('tab.navigate', { forward: true, waitMs: 600 })
  ok(fwd.ok === true && fwd.action === 'forward', '前进成功')
  ok(String(fwd.url).endsWith('/c'), '前进到 /c', fwd.url)

  const rl = await rpc('tab.navigate', { reload: true, waitMs: 500 })
  ok(rl.ok === true && rl.action === 'reload', '刷新成功')
}

console.log(`\n=== features 结果: pass=${pass} fail=${fail} ===`)

try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
await sleep(800)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
try { http.close() } catch { /* ignore */ }
try { bridge.stop() } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
