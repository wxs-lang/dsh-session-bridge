/**
 * lease.mjs — 验证租约机制
 *
 *   node test/lease.mjs
 *
 * 核心：
 *   1. 开租约 → 新建标签 → attach → release → 标签被关掉
 *   2. 用户原有的标签不受影响
 *   3. 到期自动回收
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
const PORT = 39422
const CDP_PORT = 39410
const LOCAL_PORT = 39494
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const http = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><title>L</title><h1>lease test</h1>')
})
await new Promise((r) => http.listen(LOCAL_PORT, '127.0.0.1', r))

const mod = await import(new URL('../impl.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: PORT })
await sleep(800)

const dir = mkdtempSync(join(tmpdir(), 'dsh-lease-'))
const extCopy = join(dir, 'ext')
cpSync(EXT, extCopy, { recursive: true })
const bg = join(extCopy, 'background.js')
writeFileSync(bg, readFileSync(bg, 'utf8').replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${PORT}]`), 'utf8')

const chrome = spawn(CHROME, [
  `--user-data-dir=${join(dir, 'ud')}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check',
  `http://127.0.0.1:${LOCAL_PORT}/?user=1`,
], { stdio: 'ignore' })

let ver = null
for (let i = 0; i < 40; i++) {
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch { await sleep(400) }
}
const { default: WS } = await import('ws')
const cdpWs = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { cdpWs.on('open', r); cdpWs.on('error', j) })
let seq = 0
const pend = new Map()
cdpWs.on('message', (raw) => {
  const m = JSON.parse(String(raw))
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
})
const cdp = (method, params = {}) => new Promise((r) => {
  const id = ++seq
  pend.set(id, r)
  cdpWs.send(JSON.stringify({ id, method, params }))
})
try { await cdp('Extensions.loadUnpacked', { path: extCopy }) } catch { /* ignore */ }

const bridge = globalThis.__dshBrowserBridge
for (let i = 0; i < 50; i++) {
  await sleep(400)
  if (bridge.status().extensions >= 1) break
}

const rpc = (cmd, params = {}, t = 30000) => bridge.request(cmd, params, { timeoutMs: t })

/* 找到用户原有的那个标签（?user=1） */
let userTab = null
for (let i = 0; i < 30; i++) {
  const r = await rpc('tabs.list', {})
  if (r.ok && r.tabs) {
    userTab = r.tabs.find((t) => String(t.url).includes('user=1'))
    if (userTab) break
  }
  await sleep(300)
}
console.log(`\n环境就绪  用户原有标签=${userTab ? userTab.id : 'null'}`)

/* ── 1. 开租约 ──────────────────────────────────────────────────────── */

console.log('\n[1] 开租约')
const lo = await rpc('lease.open', { ttlMs: 60000 })
ok(lo.ok === true, '租约已创建', lo.leaseId ? `${lo.leaseId} ttl=${lo.ttlMs}ms` : '')
const leaseId = lo.leaseId

/* ── 2. 新建两个临时标签并挂到租约 ─────────────────────────────────── */

console.log('\n[2] 新建临时标签并 attach')
// 扩展冷启动后第一批 tab.navigate 偶发拿不到 tabId（已知问题，扩展侧有兜底，
// 但冷启动窗口内仍可能漏）。这里统一重试一次，避免测试假阴性。
async function nav(url) {
  let r = await rpc('tab.navigate', { url, newTab: true, waitMs: 300 })
  if (!r.tabId) {
    await sleep(1200)
    r = await rpc('tab.navigate', { url, newTab: true, waitMs: 300 })
  }
  return r
}
const t1 = await nav(`http://127.0.0.1:${LOCAL_PORT}/?tmp=1`)
const t2 = await nav(`http://127.0.0.1:${LOCAL_PORT}/?tmp=2`)
ok(t1.ok && t1.tabId, '临时标签 1', String(t1.tabId))
ok(t2.ok && t2.tabId, '临时标签 2', String(t2.tabId))

const at = await rpc('lease.attach', { leaseId, tabIds: [t1.tabId, t2.tabId] })
ok(at.ok === true, '已挂到租约')

const list1 = await rpc('lease.list', {})
ok(list1.count === 1 && list1.leases[0].tabCount === 2, '租约记录 2 个标签', JSON.stringify(list1.leases))

const before = await rpc('tabs.list', {})
ok(before.tabs.length >= 3, '当前至少 3 个标签', String(before.tabs.length))

/* ── 3. release 应当关掉临时标签，保留用户标签 ─────────────────────── */

console.log('\n[3] release：关临时标签，保留用户标签')
const rel = await rpc('lease.release', { leaseId })
ok(rel.ok === true, 'release 成功', `closedTabs=${JSON.stringify(rel.closedTabs)}`)
await sleep(600)

const after = await rpc('tabs.list', {})
const remainIds = (after.tabs || []).map((t) => t.id)
ok(!remainIds.includes(t1.tabId), '临时标签 1 已关闭')
ok(!remainIds.includes(t2.tabId), '临时标签 2 已关闭')
ok(remainIds.includes(userTab.id), '★ 用户原有标签还在', String(userTab.id))

/* ── 4. 到期自动回收 ────────────────────────────────────────────────── */

console.log('\n[4] 到期自动回收（ttl=6000ms）')
const lo2 = await rpc('lease.open', { ttlMs: 6000 })
const t3 = await nav(`http://127.0.0.1:${LOCAL_PORT}/?tmp=3`)
await rpc('lease.attach', { leaseId: lo2.leaseId, tabIds: [t3.tabId] })
ok(lo2.ok && t3.ok, '新租约 + 新临时标签', `${lo2.leaseId} / ${t3.tabId}`)

console.log('     等 40 秒让它过期（alarm 周期 30s）...')
await sleep(40000)
const after2 = await rpc('tabs.list', {})
const ids2 = (after2.tabs || []).map((t) => t.id)
ok(!ids2.includes(t3.tabId), '★ 过期后临时标签被自动关闭', String(t3.tabId))
ok(ids2.includes(userTab.id), '★ 用户标签依然在')

const list2 = await rpc('lease.list', {})
ok(list2.count === 0, '过期租约已被清除', `count=${list2.count}`)

/* ── 5. keepTabs ────────────────────────────────────────────────────── */

console.log('\n[5] release keepTabs=true：只释放记录，不关标签')
const lo3 = await rpc('lease.open', { ttlMs: 60000 })
const t4 = await nav(`http://127.0.0.1:${LOCAL_PORT}/?keep=1`)
await rpc('lease.attach', { leaseId: lo3.leaseId, tabIds: [t4.tabId] })
const rel3 = await rpc('lease.release', { leaseId: lo3.leaseId, keepTabs: true })
await sleep(500)
const after3 = await rpc('tabs.list', {})
ok((after3.tabs || []).some((t) => t.id === t4.tabId), 'keepTabs 时标签保留', String(t4.tabId))
ok(rel3.ok === true, 'release 返回 ok')

console.log(`\n=== lease 结果: pass=${pass} fail=${fail} ===`)

try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
await sleep(700)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
try { http.close() } catch { /* ignore */ }
try { bridge.stop() } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
