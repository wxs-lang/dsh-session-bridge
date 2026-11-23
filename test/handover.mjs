
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const WebSocket = require('ws')

const quiet = { info(){}, warn(){}, debug(){} }

// 简易 ctx 桩
const tools = new Map()
let disposers = []
const ctx = {
  logger: quiet,
  tools: {
    register(def) {
      tools.set(def.name, def)
      const d = () => tools.delete(def.name)
      disposers.push(d)
      return d
    },
  },
  systemPrompt: { add: () => () => {} },
  effect(fn) { try { const d = fn(); if (typeof d === 'function') disposers.push(d) } catch {} },
  on() {},
}

let pass = 0, fail = 0
const ok = (c, n, d='') => { c ? (pass++, console.log(`  OK  ${n}${d?' — '+d:''}`)) : (fail++, console.log(`  XX  ${n}${d?' — '+d:''}`)) }

// 第一代
const entry1 = await import('../index.js?t=gen1')
entry1.apply(ctx, { port: 39677 })
await new Promise(r => setTimeout(r, 900))

const bridgeA = globalThis.__dshBrowserBridge
ok(Boolean(bridgeA), '第一代桥已创建')
const stA = bridgeA.status()
ok(stA.listening === true, '第一代监听成功', `listening=${stA.listening} err=${stA.lastError||'null'}`)

// 模拟 reload：停旧 + 重新 apply
console.log('\n-- 模拟 browse_reload（停旧 → 重新 apply）--')
const reloadFn = globalThis.__dshBrowserBridgeReloadImpl
ok(typeof reloadFn === 'function', 'globalThis 里有 reloadImpl')

const r = await reloadFn()
ok(r && r.ok, 'reload 返回成功', JSON.stringify(r))

await new Promise(r2 => setTimeout(r2, 900))

const bridgeB = globalThis.__dshBrowserBridge
ok(bridgeB !== bridgeA, '★ globalThis 已指向新实例', bridgeB === bridgeA ? '仍是旧的' : '已更换')

const stB = bridgeB.status()
ok(stB.listening === true, '★ 新实例监听成功（端口已释放）', `listening=${stB.listening} lastError=${stB.lastError||'null'}`)

// 新注册的工具必须打到 B
const statusTool = tools.get('browser_status')
ok(Boolean(statusTool), 'browser_status 工具仍在')
const viaTool = await statusTool.execute({})
ok(viaTool.listening === true, '★ 工具读到的桥是活的', `listening=${viaTool.listening}`)

// 端口上真的能连
function probe() {
  return new Promise(res => {
    const ws = new WebSocket(`ws://127.0.0.1:39677/?brand=Test&ver=t`, { origin: 'chrome-extension://abc' })
    const t = setTimeout(() => { try{ws.close()}catch{}; res('timeout') }, 3000)
    ws.on('open', () => { clearTimeout(t); try{ws.close()}catch{}; res('accepted') })
    ws.on('error', () => { clearTimeout(t); res('rejected') })
  })
}
const p = await probe()
ok(p === 'accepted', '★ 端口可接受扩展连接', p)

console.log(`\n=== handover 结果: pass=${pass} fail=${fail} ===`)
try { globalThis.__dshBrowserBridge?.stop() } catch {}
setTimeout(() => process.exit(fail ? 1 : 0), 400)
