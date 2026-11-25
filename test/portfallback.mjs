#!/usr/bin/env node
/**
 * portfallback.mjs — 端口被占时自动降级
 *
 * 场景：两个 DSH 实例同时跑，第二个撞 EADDRINUSE。
 * 之前直接失败，表现为「桥起不来、扩展连不上」。
 * 现在应该降级到备用端口，功能照常。
 *
 * 注意：这里不能用固定端口 —— 全量测试并行跑时，多个测试会抢同一个端口。
 * 改成先探测一个空闲端口，用它当"首选端口"，被我们的 blocker 占住，
 * 再看 Bridge 是否降级到别的端口。
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

/** 找一个当前空闲的端口 */
function findFree(start) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > start + 200) return resolve(null)
      const s = net.createServer()
      s.once('error', () => tryPort(p + 1))
      s.listen(p, '127.0.0.1', () => {
        s.close(() => resolve(p))
      })
    }
    tryPort(start)
  })
}

// 用一个不常用的段，避开 39401/39411/39421 与并行测试
const basePort = await findFree(39500)
if (!basePort) {
  console.log('  ! 找不到空闲端口，跳过')
  console.log('\n=== portfallback 结果: pass=0 fail=0 ===')
  process.exit(0)
}

const blocker = net.createServer()
await new Promise((res, rej) => {
  blocker.once('error', rej)
  blocker.listen(basePort, '127.0.0.1', res)
})
console.log(`  已占住 ${basePort}（模拟端口冲突）`)

const bridge = new Bridge(quiet)
await bridge.start(basePort)
await new Promise((r) => setTimeout(r, 300))

ok(bridge.port !== basePort, '★ 首选端口被占时换到别的端口', String(bridge.port))
ok([39401, 39411, 39421].includes(bridge.port) || bridge.port !== basePort,
   '★ 落在了候选端口里', String(bridge.port))
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
