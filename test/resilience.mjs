/**
 * resilience.mjs — 验证"新浏览器接入不会影响已有连接"
 *
 *   node test/resilience.mjs
 *
 * 覆盖两个真实踩过的坑：
 *   1. 新连接 hello 抢走 primary → 之前的操作目标全变
 *   2. 命令飞到正在关闭的连接 → extension_disconnected
 */
import { WebSocket } from 'ws'

const PORT = 39415
const mod = await import(new URL('../impl.js', import.meta.url).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const stub = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}
mod.apply(stub, { port: PORT })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(600)

/** 起一个假扩展 */
function ext(brand, tabs, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?brand=${brand}&ver=test`)
    ws.alive = true
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', version: 'test', browser: { name: brand },
        brand, commands: ['tabs.list', 'group.list', 'tab.info'],
        windows: opts.windows || null,
      }) + '\n')
      setTimeout(() => resolve(ws), 80)
    })
    ws.on('message', (raw) => {
      if (!ws.alive) return
      for (const line of String(raw).split('\n')) {
        const t = line.trim(); if (!t) continue
        let m; try { m = JSON.parse(t) } catch { continue }
        if (!m.id || !m.cmd) continue
        ws.send(JSON.stringify({ id: m.id, ok: true, brand, result: { tabs } }) + '\n')
      }
    })
    ws.on('error', () => {})
  })
}

const bridge = globalThis.__dshBrowserBridge

console.log('\n[1] 第一个浏览器接入，成为 primary')
const a = await ext('Chrome', [{ id: 101, windowId: 1, title: 'A', url: 'a', active: true }])
await sleep(200)
ok(bridge.status().primaryConnId.startsWith('Chrome'), 'primary = Chrome', bridge.status().primaryConnId)

console.log('\n[2] 新浏览器接入，不能抢走 primary')
const b = await ext('Edge', [{ id: 201, windowId: 2, title: 'B', url: 'b', active: true }])
await sleep(300)
const p2 = bridge.status().primaryConnId
ok(p2.startsWith('Chrome'), 'primary 仍是 Chrome（没被 Edge 抢走）', p2)
ok(bridge.status().extensions === 2, '连接数 = 2')

console.log('\n[3] 第一个浏览器仍能正常收发')
const r1 = await bridge.request('tabs.list', {}, { timeoutMs: 3000 })
ok(r1.ok && r1.tabs && r1.tabs[0].id === 101, '仍拿到 Chrome 的标签')

console.log('\n[4] 第三个浏览器接入，primary 还是不能变')
const c = await ext('QQBrowser', [{ id: 301, windowId: 3, title: 'C', url: 'c', active: true }])
await sleep(300)
const p3 = bridge.status().primaryConnId
ok(p3.startsWith('Chrome'), 'primary 仍是 Chrome', p3)
ok(bridge.status().extensions === 3, '连接数 = 3')

console.log('\n[5] 命令飞到"正在死的连接"时自动换连接重试')
// 让 primary(Chrome) 立刻断开，然后马上发命令
a.alive = false
a.close()
// 不等 close 事件传播完就发命令 —— 模拟真实抖动
const r5 = await bridge.request('tabs.list', {}, { timeoutMs: 4000 })
ok(r5.ok === true, '断连后命令仍然成功（换到了别的连接）',
   r5.ok ? `tabs=${r5.tabs && r5.tabs.length}` : r5.message)

console.log('\n[6] 死连接清理后 primary 自动迁移')
await sleep(400)
const p6 = bridge.status().primaryConnId
ok(Boolean(p6) && !p6.startsWith('Chrome'), 'primary 迁到活着的连接', p6)

console.log(`\n=== resilience 结果: pass=${pass} fail=${fail} ===`)
b.close(); c.close()
await sleep(200)
process.exit(fail === 0 ? 0 : 1)
