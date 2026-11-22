/**
 * multi-browser.mjs — 验证"多个浏览器同时连着也不会发错" 
 *
 *   node test/multi-browser.mjs
 *
 * 思路：不开真浏览器，起一份新代码的桥，用两个假扩展模拟
 * Chrome 和 QQBrowser，各自持有不同 tabId，验证：
 *   1. tabs.list 合并两边结果
 *   2. 带 tabId 的命令精确送到持有它的那个连接
 *   3. 不指定时 sticky 不漂移
 */
import { WebSocket } from 'ws'

const PORT = 39413
const mod = await import(new URL('../index.js', import.meta.url).href)

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

const received = { Chrome: [], QQBrowser: [] }

/** 一个假扩展：连桥，声明 commands，收到命令就按预设回包 */
function fakeExtension(brand, tabs) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?brand=${brand}&ver=test`)
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello',
        version: 'test',
        browser: { name: brand },
        brand,
        commands: ['tabs.list', 'group.list', 'tab.info', 'tab.screenshot', 'tab.navigate'],
      }) + '\n')
      setTimeout(() => resolve({ ws, brand, tabs }), 100)
    })
    ws.on('message', (raw) => {
      for (const line of String(raw).split('\n')) {
        const t = line.trim()
        if (!t) continue
        let msg
        try { msg = JSON.parse(t) } catch { continue }
        if (!msg.id || !msg.cmd) continue
        received[brand].push(msg.cmd)
        let result = {}
        if (msg.cmd === 'tabs.list') result = { tabs }
        else if (msg.cmd === 'group.list') result = { groups: [] }
        else if (msg.cmd === 'tab.info') result = { tab: tabs.find((x) => x.id === msg.params.tabId) || null }
        ws.send(JSON.stringify({ id: msg.id, ok: true, brand, result }) + '\n')
      }
    })
  })
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

// Chrome 持有 101/102，QQBrowser 持有 201/202
const chromeTabs = [
  { id: 101, windowId: 1, title: 'Chrome-A', url: 'https://a.example', active: true },
  { id: 102, windowId: 1, title: 'Chrome-B', url: 'https://b.example', active: false },
]
const qqTabs = [
  { id: 201, windowId: 2, title: 'QQ-A', url: 'https://c.example', active: true },
  { id: 202, windowId: 2, title: 'QQ-B', url: 'https://d.example', active: false },
]

const A = await fakeExtension('Chrome', chromeTabs)
const B = await fakeExtension('QQBrowser', qqTabs)
await sleep(400)

const bridge = globalThis.__dshBrowserBridge

console.log('\n[1] 两个连接都在')
const st = bridge.status()
ok(st.extensions === 2, '连接数 = 2', String(st.extensions))

console.log('\n[2] tabs.list 合并两个浏览器')
const agg = await bridge.requestAll('tabs.list', {}, 5000)
ok(agg.ok === true, '合并成功')
const merged = agg.results.flatMap((r) => r.tabs || [])
ok(merged.length === 4, '合并后 4 个标签', String(merged.length))
ok(merged.some((t) => t.id === 101), '含 Chrome 的 101')
ok(merged.some((t) => t.id === 201), '含 QQ 的 201')

console.log('\n[3] 带 tabId 的命令精确送达')
// 先让桥通过 tabs.list 学到归属
await bridge.requestAll('tabs.list', {}, 5000)
await sleep(100)

received.Chrome.length = 0
received.QQBrowser.length = 0
const r101 = await bridge.request('tab.info', { tabId: 101 }, { timeoutMs: 3000 })
ok(r101.ok === true && r101.tab && r101.tab.id === 101, 'tab.info(101) 成功')
ok(received.Chrome.includes('tab.info'), '101 的命令发到了 Chrome')
ok(!received.QQBrowser.includes('tab.info'), 'QQ 没收到 101 的命令')

received.Chrome.length = 0
received.QQBrowser.length = 0
const r201 = await bridge.request('tab.info', { tabId: 201 }, { timeoutMs: 3000 })
ok(r201.ok === true && r201.tab && r201.tab.id === 201, 'tab.info(201) 成功')
ok(received.QQBrowser.includes('tab.info'), '201 的命令发到了 QQBrowser')
ok(!received.Chrome.includes('tab.info'), 'Chrome 没收到 201 的命令')

console.log('\n[4] 不指定 tabId 时 sticky 不漂移')
const seen = []
for (let i = 0; i < 5; i++) {
  received.Chrome.length = 0
  received.QQBrowser.length = 0
  await bridge.request('group.list', {}, { timeoutMs: 3000 })
  seen.push(received.Chrome.length > 0 ? 'Chrome' : (received.QQBrowser.length > 0 ? 'QQBrowser' : 'none'))
}
const unique = [...new Set(seen)]
ok(unique.length === 1, '5 次都落在同一个连接', unique.join(','))

console.log(`\n=== multi-browser 结果: pass=${pass} fail=${fail} ===`)
A.ws.close()
B.ws.close()
await sleep(200)
process.exit(fail === 0 ? 0 : 1)
