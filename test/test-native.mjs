/**
 * test-native.mjs — 不用浏览器，直接测 native host 的协议桥接
 *
 *   node test/test-native.mjs
 *
 * 模拟 Chrome 的行为：
 *   1. 启动 native-host.mjs 子进程
 *   2. 向它 stdin 写 [4字节长度 + JSON]
 *   3. 读它 stdout，验证能收到桥转来的命令
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer, WebSocket } from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..')
const PORT = 39417

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}

/* ── 起一个假桥 ─────────────────────────────────────────────────────── */

const received = []
const wss = new WebSocketServer({ port: PORT, path: '/' })
let bridgeSock = null

wss.on('connection', (sock, req) => {
  bridgeSock = sock
  const u = new URL(req.url || '/', 'http://127.0.0.1')
  received.push({ kind: 'connect', brand: u.searchParams.get('brand') })

  let buf = ''
  sock.on('message', (raw) => {
    buf += String(raw)
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { received.push(JSON.parse(line)) } catch { /* ignore */ }
    }
  })
})

await new Promise((r) => wss.once('listening', r))
console.log(`假桥已起: ws://127.0.0.1:${PORT}`)

/* ── 起 native host ─────────────────────────────────────────────────── */

const child = spawn(process.execPath, [join(ROOT, 'native-host.mjs')], {
  env: { ...process.env, DSH_BRIDGE_PORT: String(PORT) },
  stdio: ['pipe', 'pipe', 'pipe'],
})

let outBuf = Buffer.alloc(0)
const fromHost = []

child.stdout.on('data', (c) => {
  outBuf = Buffer.concat([outBuf, c])
  for (;;) {
    if (outBuf.length < 4) return
    const len = outBuf.readUInt32LE(0)
    if (outBuf.length < 4 + len) return
    const body = outBuf.subarray(4, 4 + len)
    outBuf = outBuf.subarray(4 + len)
    try { fromHost.push(JSON.parse(body.toString('utf8'))) } catch { /* ignore */ }
  }
})

let stderrText = ''
child.stderr.on('data', (c) => { stderrText += String(c) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 工具：写一条 native 消息 ───────────────────────────────────────── */

function writeNative(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32LE(body.length, 0)
  child.stdin.write(Buffer.concat([head, body]))
}

/* ── 测试 ───────────────────────────────────────────────────────────── */

console.log('\n[1] native host 能连上桥')
for (let i = 0; i < 30; i++) {
  if (bridgeSock) break
  await sleep(200)
}
ok(Boolean(bridgeSock), '桥收到连接')
const hello = received.find((m) => m.type === 'hello')
ok(Boolean(hello), 'native host 发了 hello', hello ? `brand=${hello.brand}` : '')
ok(hello && hello.brand === 'NativeHost', 'hello 里 brand=NativeHost')

console.log('\n[2] 桥下发的命令能转成 native 消息')
bridgeSock.send(JSON.stringify({ id: 1001, cmd: 'tabs.list', params: {} }) + '\n')
await sleep(500)
const cmdMsg = fromHost.find((m) => m.type === 'cmd' && m.id === 1001)
ok(Boolean(cmdMsg), '收到 {type:cmd, id:1001}', cmdMsg ? `cmd=${cmdMsg.cmd}` : '')
ok(cmdMsg && cmdMsg.cmd === 'tabs.list', '命令名正确')

console.log('\n[3] 扩展回的结果能转回桥')
writeNative({ type: 'result', id: 1001, ok: true, result: { tabs: [{ id: 1, title: 'X' }] } })
await sleep(500)
const relayed = received.find((m) => m.id === 1001 && m.result)
ok(Boolean(relayed), '桥收到转发的 result')
ok(relayed && Array.isArray(relayed.result.tabs) && relayed.result.tabs[0].id === 1, '结果内容完整')

console.log('\n[4] 扩展主动 ping 会收到 pong')
writeNative({ type: 'ping', t: 12345 })
await sleep(400)
const pong = fromHost.find((m) => m.type === 'pong')
ok(Boolean(pong), '收到 pong', pong ? `t=${pong.t}` : '')
ok(pong && pong.t === 12345, 'pong 原样带回时间戳')

console.log('\n[5] stdout 只有协议数据（没有杂日志污染）')
const bad = fromHost.filter((m) => typeof m !== 'object' || m === null)
ok(bad.length === 0, '没有非 JSON 输出到 stdout')
if (stderrText) console.log(`     stderr: ${stderrText.split('\n')[0]}`)

console.log(`\n=== native 结果: pass=${pass} fail=${fail} ===`)

try { child.kill() } catch { /* ignore */ }
try { wss.close() } catch { /* ignore */ }
await sleep(300)
process.exit(fail === 0 ? 0 : 1)
