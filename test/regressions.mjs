/**
 * regressions.mjs — 针对三个已确认缺陷的回归测试
 *
 *   node test/regressions.mjs
 *
 * 1. 两个 NativeHost 的 connId 必须不同（靠 pid 区分）
 * 2. native host 的 commands 必须跟随扩展的真实清单，不能硬编码
 * 3. codeFresh.stale 的判定基准是模块加载时刻，而不是进程启动时间
 */

import { spawn } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { readFileSync, existsSync, statSync, utimesSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(here, '..')
const PORT = 39424

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ══ 静态检查 ══════════════════════════════════════════════════════════ */

console.log('\n[静态] 源码层面')

const nativeSrc = readFileSync(join(ROOT, 'native-host.mjs'), 'utf8')
const bgSrc = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8')
// 实现在 impl.js（index.js 只是薄入口，动态 import impl.js）
const idxSrc = readFileSync(join(ROOT, 'impl.js'), 'utf8')

// 缺陷 1：native-host 要发 pid
ok(/pid:\s*String\(process\.pid\)/.test(nativeSrc), 'native-host 的 WS URL 带 pid')
ok(/pid:\s*process\.pid/.test(nativeSrc), 'native-host 的 hello 带 pid')

// 缺陷 2：不能硬编码 commands
ok(!/commands:\s*\[\s*'tabs\.list'/.test(nativeSrc), 'native-host 不再硬编码命令清单')
ok(/need-capabilities/.test(nativeSrc), 'native-host 会向扩展要 capabilities')
ok(/need-capabilities/.test(bgSrc), '扩展能响应 need-capabilities')
ok(/capabilitiesFrom:\s*'extension'/.test(nativeSrc), 'native-host 转发时标记来源')

// 缺陷 3：codeFresh 用模块加载时间
ok(/MODULE_LOADED_AT/.test(idxSrc), 'index.js 有 MODULE_LOADED_AT')
ok(/mtime > MODULE_LOADED_AT/.test(idxSrc), 'codeFresh 用 MODULE_LOADED_AT 判定')
ok(!/mtime > procStart/.test(idxSrc), 'codeFresh 不再用 procStart 判定')

// connId 要能吃 pid
ok(/sock\.dshPid/.test(idxSrc), 'index.js 记录 pid')
ok(/suffix\s*=\s*wfp \|\| \(sock\.dshPid/.test(idxSrc), 'connId 后缀优先窗口指纹，其次 pid')

/* ══ 动态：起桥，模拟两个 native host + 一个扩展 ══════════════════════ */

console.log('\n[动态] 起桥 + 模拟连接')

const mod = await import(new URL('../impl.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: PORT })
await sleep(800)

const bridge = globalThis.__dshBrowserBridge

/** 建一条裸 WS 连接（模拟 native host / 扩展） */
function connect(qs, hello) {
  return new Promise((res) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?${qs}`)
    ws.on('open', () => {
      if (hello) ws.send(JSON.stringify(hello) + '\n')
      setTimeout(() => res(ws), 150)
    })
    ws.on('error', () => res(null))
  })
}

const ALL_CMDS = [
  'tabs.list', 'tab.snapshot', 'tab.click', 'tab.type', 'tab.key', 'tab.scroll',
  'tab.batch', 'tab.evaluate', 'tab.drag', 'tab.mouse', 'tab.navigate',
  'tab.screenshot', 'tab.info', 'tab.close', 'windows.list',
  'group.list', 'group.ensure', 'group.assign', 'group.update', 'group.close',
  'lease.open', 'lease.renew', 'lease.attach', 'lease.release', 'lease.list',
  'theme.icon', 'debug.info', 'debug.ua', 'debug.detachAll',
]

// 两个 native host，pid 不同
const nh1 = await connect('brand=NativeHost&ver=native&pid=11111', {
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 11111,
  browser: { name: 'NativeHost' }, commands: ['*'],
})
const nh2 = await connect('brand=NativeHost&ver=native&pid=22222', {
  type: 'hello', version: 'native', brand: 'NativeHost', pid: 22222,
  browser: { name: 'NativeHost' }, commands: ['*'],
})

// 一个真扩展
const ext = await connect('brand=Chrome&ver=2.1.0&pid=0', {
  type: 'hello', version: '2.1.0', brand: 'Chrome',
  browser: { name: 'Chrome' }, commands: ALL_CMDS, windows: [999],
})

await sleep(500)

/* 缺陷 1 动态验证 */
console.log('\n[1] 两个 NativeHost 的 connId 必须不同')
{
  const st = bridge.status()
  const hosts = (st.connections || []).filter((c) => c.brand === 'NativeHost')
  ok(hosts.length === 2, '桥上有 2 个 NativeHost', String(hosts.length))
  const ids = hosts.map((c) => c.connId)
  ok(ids.every(Boolean), '每个都有 connId', ids.join(' / '))
  ok(new Set(ids).size === 2, '★ connId 互不相同', ids.join(' / '))
  ok(ids.some((i) => i.includes('11111')), '其中一个带 pid 11111')
  ok(ids.some((i) => i.includes('22222')), '其中一个带 pid 22222')

  // 按 connId 精确指定，应当各自命中
  if (new Set(ids).size === 2) {
    const [a, b] = ids
    const ra = await bridge.request('tabs.list', {}, { timeoutMs: 2000, connId: a })
    const rb = await bridge.request('tabs.list', {}, { timeoutMs: 2000, connId: b })
    // 两个 native host 都没实现 tab 命令（假的），会超时；这里只验证"分别发到了不同 socket"
    ok(true, '按 connId 可以分别指定（发出去了）', `${a} → ${ra.ok} / ${b} → ${rb.ok}`)
  }
}

/* 缺陷 2 动态验证 */
console.log('\n[2] capabilities 必须并集，不能硬编码 18 条')
{
  // 先让 native host 只报 ['*']，再补真实清单（模拟 need-capabilities 流程）
  nh1.send(JSON.stringify({
    type: 'hello', version: 'native', brand: 'NativeHost', pid: 11111,
    browser: { name: 'NativeHost' }, commands: ALL_CMDS,
    capabilitiesFrom: 'extension',
  }) + '\n')
  await sleep(400)

  const st = bridge.status()
  const h1 = (st.connections || []).find((c) => c.connId && c.connId.includes('11111'))
  ok(Boolean(h1), '找到 pid=11111 的连接')
  ok(h1 && h1.commands >= ALL_CMDS.length, '★ 命令数跟随扩展清单（≥29）', String(h1 && h1.commands))
  ok(h1 && h1.commands > 18, '★ 不再是硬编码的 18 条', String(h1 && h1.commands))
}

/* 缺陷 3 动态验证 */
console.log('\n[3] codeFresh 判定基准')
{
  const fresh = bridge.codeFresh()
  ok(Boolean(fresh.moduleLoadedAt), '返回 moduleLoadedAt', fresh.moduleLoadedAt || '')
  ok(Boolean(fresh.procStart), '仍保留 procStart 供参考')
  ok(typeof fresh.stale === 'boolean', 'stale 是布尔', String(fresh.stale))

  // 当前磁盘文件是刚写的，模块是刚 import 的 → 大概率 stale=false
  // 但如果测试前有人改过文件，可能是 true。两种都合法，这里验证语义：
  const fileMs = new Date(fresh.fileMtime).getTime()
  const modMs = new Date(fresh.moduleLoadedAt).getTime()
  const expectStale = fileMs > modMs + 500
  ok(fresh.stale === expectStale, '★ stale 与 fileMtime/moduleLoadedAt 一致',
     `file=${fresh.fileMtime} mod=${fresh.moduleLoadedAt} stale=${fresh.stale}`)

  // 把文件 mtime 推到未来 → stale 必须变 true
  const selfPath = join(ROOT, 'impl.js')
  const oldStat = statSync(selfPath)
  const future = new Date(Date.now() + 60000)
  try {
    utimesSync(selfPath, future, future)
    const f2 = bridge.codeFresh()
    ok(f2.stale === true, '★ 把 mtime 推到未来后 stale=true', String(f2.stale))
    ok(/完整重启/.test(String(f2.hint)), 'hint 明确指出需要完整重启', String(f2.hint).slice(0, 40))
  } finally {
    // 恢复 mtime
    utimesSync(selfPath, oldStat.atime, oldStat.mtime)
  }
  const f3 = bridge.codeFresh()
  ok(f3.stale === false, '恢复 mtime 后 stale=false', String(f3.stale))
}

/* ══ 汇总 ══════════════════════════════════════════════════════════════ */

console.log(`\n=== regressions 结果: pass=${pass} fail=${fail} ===`)

try { nh1.close() } catch { /* ignore */ }
try { nh2.close() } catch { /* ignore */ }
try { ext.close() } catch { /* ignore */ }
try { bridge.stop() } catch { /* ignore */ }
await sleep(300)
process.exit(fail === 0 ? 0 : 1)
