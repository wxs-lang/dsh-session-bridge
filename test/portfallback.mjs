#!/usr/bin/env node
/**
 * portfallback.mjs — 端口被占时自动降级
 *
 * 场景：两个 DSH 实例同时跑，第二个撞 EADDRINUSE。
 * 之前直接失败，表现为「桥起不来、扩展连不上」。
 * 现在应该降级到备用端口，功能照常。
 *
 * 做法：先用 net.createServer 占住 39411，再让 Bridge 从 39411 起，
 * 断言它落到了候选列表里的别的端口。
 */
import { _internals } from '../impl.js'
import net from 'node:net'

const { Bridge } = _internals
const quiet = { info() {}, warn() {}, debug() {} }

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// 39401 通常被运行中的 DSH 占着，所以拿 39411 当「被占用」的端口来测
const blocker = net.createServer()
await new Promise((res) => blocker.listen(39411, '127.0.0.1', res))
console.log('  已占住 39411（模拟端口冲突）')

const bridge = new Bridge(quiet)
await bridge.start(39411)
await new Promise((r) => setTimeout(r, 300))

ok(bridge.port !== 39411, '★ 首选端口被占时换到别的端口', String(bridge.port))
ok([39401, 39421].includes(bridge.port), '★ 落在候选端口里', String(bridge.port))
ok(Boolean(bridge.server && bridge.server.listening), '新端口确实在监听')
ok(bridge.lastError === null, '没有残留错误', String(bridge.lastError || 'null'))

// 真的能连
const probeOk = await new Promise((resolve) => {
  const s = net.connect(bridge.port, '127.0.0.1', () => {
    s.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
  })
  let buf = ''
  s.on('data', (d) => { buf += d.toString() })
  s.on('end', () => resolve(buf.startsWith('HTTP/1.1 200')))
  s.on('error', () => resolve(false))
  setTimeout(() => { s.destroy(); resolve(false) }, 4000)
})
ok(probeOk, '★ 新端口可以正常应答 HTTP')

bridge.stop()
await new Promise((res) => blocker.close(res))

console.log(`\n=== portfallback 结果: pass=${pass} fail=${fail} ===`)
setTimeout(() => process.exit(fail ? 1 : 0), 200)
