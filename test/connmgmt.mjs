/**
 * connmgmt.mjs — 验证连接清理能力
 *
 *   node test/connmgmt.mjs
 *
 * 覆盖：
 *   1. 孤儿连接（只报 ['*'] 占位）会被 reap 掉
 *   2. close 能精确关掉一个 connId
 *   3. drop-native 会让所有 NativeHost 连接断开
 *   4. 正常连接不会被误杀
 */

import { WebSocketServer, WebSocket } from 'ws'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const PORT = 39427

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const mod = await import(new URL('../impl.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: PORT })
await sleep(700)

const bridge = globalThis.__dshBrowserBridge

function connect(qs, hello, opts = {}) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?${qs}`)
    ws.closedByPeer = null
    ws.on('open', () => {
      if (hello) ws.send(JSON.stringify(hello) + '\n')
      setTimeout(() => res(ws), 150)
    })
    ws.on('close', (code, reason) => { ws.closedByPeer = { code, reason: String(reason) } })
    ws.on('error', () => res(null))
  })
}

const REAL_CMDS = [
  'tabs.list', 'tab.snapshot', 'tab.click', 'tab.key', 'tab.scroll', 'tab.batch',
  'tab.evaluate', 'tab.navigate', 'tab.screenshot', 'tab.info', 'tab.close',
  'windows.list', 'group.list', 'group.ensure', 'group.close',
  'lease.open', 'lease.list', 'theme.icon', 'debug.info', 'debug.ua',
]

/* ── 准备：1 个真扩展 + 1 个正常 native host + 2 个孤儿 ────────────── */

console.log('\n[准备] 建 4 条连接')
const ext = await connect('brand=Chrome&ver=2.1.1', {
  type: 'hello', version: '2.1.1', brand: 'Chrome',
  browser: { name: 'Chrome' }, commands: REAL_CMDS, windows: [777],
})
const goodHost = await connect('brand=NativeHost&ver=native&pid=33333', {
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 33333,
  browser: { name: 'NativeHost' }, commands: ['*'],
})
// 正常 host 会紧跟着收到 capabilities，模拟这一过程
goodHost.send(JSON.stringify({
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 33333,
  browser: { name: 'NativeHost' }, commands: REAL_CMDS, capabilitiesFrom: 'extension',
}) + '\n')

const orphan1 = await connect('brand=NativeHost&ver=native&pid=44444', {
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 44444,
  browser: { name: 'NativeHost' }, commands: ['*'],
})
const orphan2 = await connect('brand=NativeHost&ver=native&pid=55555', {
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 55555,
  browser: { name: 'NativeHost' }, commands: ['*'],
})

await sleep(500)

const st0 = bridge.status()
console.log(`     连接数 = ${st0.connections.length}`)
ok(st0.connections.length === 4, '起了 4 条连接', String(st0.connections.length))

/* ── 1. reap 清孤儿 ─────────────────────────────────────────────────── */

console.log('\n[1] reap 清掉只报占位 capabilities 的孤儿')
{
  // graceMs=0 立刻清
  const killed = bridge.reapOrphanSockets(0)
  ok(killed.length === 2, '★ 清掉 2 条孤儿', JSON.stringify(killed.map((k) => k.connId)))

  await sleep(400)
  const st = bridge.status()
  const hosts = (st.connections || []).filter((c) => c.brand === 'NativeHost')
  ok(hosts.length === 1, '只剩 1 个 NativeHost', String(hosts.length))
  ok(hosts.length === 1 && hosts[0].commands >= REAL_CMDS.length, '★ 留下的是带真清单的那个',
     hosts[0] ? `commands=${hosts[0].commands}` : '')
  ok(Boolean(ext.closedByPeer) === false, '真扩展没有被误杀')
  ok(Boolean(goodHost.closedByPeer) === false, '正常的 native host 没有被误杀')
  ok(orphan1.closedByPeer !== null, 'orphan1 确实被关闭', JSON.stringify(orphan1.closedByPeer))
  ok(orphan2.closedByPeer !== null, 'orphan2 确实被关闭')
}

/* ── 2. close 精确关一个 ────────────────────────────────────────────── */

console.log('\n[2] close 按 connId 精确关闭')
{
  const before = bridge.status().connections.length
  const target = bridge.status().connections.find((c) => c.brand === 'NativeHost')
  const r = bridge.closeConn(target.connId)
  ok(r.ok === true, 'close 成功', target.connId)
  await sleep(400)
  const after = bridge.status().connections.length
  ok(after === before - 1, '★ 连接数减 1', `${before} → ${after}`)
  ok(Boolean(goodHost.closedByPeer) || Boolean(orphan1.closedByPeer), '目标连接已关闭')

  const bad = bridge.closeConn('不存在的connId')
  ok(bad.ok === false && bad.error === 'unknown_conn', 'close 不存在的 connId 报 unknown_conn')
  ok(Array.isArray(bad.known) && bad.known.length > 0, '并告知现有 connId', (bad.known || []).join(', '))
}

/* ── 3. drop-native ─────────────────────────────────────────────────── */

console.log('\n[3] drop-native 让所有 NativeHost 断开')
{
  const h2 = await connect('brand=NativeHost&ver=native&pid=66666', {
    type: 'hello', version: 'native', brand: 'NativeHost', pid: 66666,
    browser: { name: 'NativeHost' }, commands: REAL_CMDS, capabilitiesFrom: 'extension',
  })
  await sleep(300)
  ok(bridge.status().connections.some((c) => c.connId && c.connId.includes('66666')), '新 host 已连上')

  const r = await bridge.dropNativeHosts('test')
  ok(r.ok === true, 'drop-native 执行成功', `dropped=${JSON.stringify(r.dropped)}`)
  await sleep(500)

  const st = bridge.status()
  ok(!(st.connections || []).some((c) => c.brand === 'NativeHost'), '★ 所有 NativeHost 已断开')
  ok((st.connections || []).some((c) => c.brand === 'Chrome'), '★ 真扩展仍在', String(st.connections.length))
}

/* ── 4. 正常连接不该被 reap 误杀（时间未到） ────────────────────────── */

console.log('\n[4] 新连上但还没到 grace 的，不该被误杀')
{
  const fresh = await connect('brand=NativeHost&ver=native&pid=77777', {
    type: 'hello', version: 'native', brand: 'NativeHost', pid: 77777,
    browser: { name: 'NativeHost' }, commands: ['*'],
  })
  await sleep(300)
  // 用默认 grace（15s），刚连上的不该被杀
  const killed = bridge.reapOrphanSockets()      // 默认 15000ms
  ok(killed.length === 0, '★ 刚连上的占位连接没被误杀', JSON.stringify(killed))
  ok(Boolean(fresh.closedByPeer) === false, '连接仍然活着')

  // grace=0 就应该杀掉
  const killed2 = bridge.reapOrphanSockets(0)
  ok(killed2.length === 1, 'grace=0 时才清掉', JSON.stringify(killed2))
}

/* ── 5. status() 里自动 reap ─────────────────────────────────────────── */

console.log('\n[5] status() 会自动清孤儿')
{
  const orphanX = await connect('brand=NativeHost&ver=native&pid=88888', {
    type: 'hello', version: 'native', brand: 'NativeHost', pid: 88888,
    browser: { name: 'NativeHost' }, commands: ['*'],
  })
  await sleep(16000)   // 等超过默认 grace 15s
  const st = bridge.status()   // 这次调用内部会 reap
  const hosts = (st.connections || []).filter((c) => c.brand === 'NativeHost')
  ok(!hosts.some((c) => c.connId && c.connId.includes('88888')), '★ status() 已清掉过期孤儿')
}

console.log(`\n=== connmgmt 结果: pass=${pass} fail=${fail} ===`)

for (const ws of [ext, goodHost, orphan1, orphan2]) {
  try { ws.close() } catch { /* ignore */ }
}
try { bridge.stop() } catch { /* ignore */ }
await sleep(300)
process.exit(fail === 0 ? 0 : 1)
