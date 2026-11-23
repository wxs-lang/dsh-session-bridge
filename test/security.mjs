#!/usr/bin/env node
/**
 * security.mjs — 桥的边界防护回归测试
 *
 * 验证三件事，每条都对应一个真实的攻击面：
 *
 *   ① Origin 校验：网页不能连 WS 桥
 *      任何网页都能 `new WebSocket('ws://127.0.0.1:39401')`，连上就能借用户
 *      已登录的浏览器发请求、读页面、截屏。浏览器发 WebSocket 一定带 Origin，
 *      Node 的 ws 客户端不带 —— 用这个差别区分"网页"和"扩展/宿主"。
 *
 *   ② Host 校验：DNS rebinding 不能读状态
 *      攻击者把 evil.com 解析到 127.0.0.1，网页里 fetch('http://evil.com:39401/')
 *      就能拿到状态（含调试 token）。HTTP 侧按 Host 头拦。
 *
 *   ③ /rpc 令牌：调试通道不再是"谁都能触发命令"
 *
 * 用法：node test/security.mjs
 */
import { _internals } from '../impl.js'
import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')
const { Bridge } = _internals

const PORT = 39478 + Math.floor(Math.random() * 10)
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

/** 用给定 Origin 连桥，回 'accepted' | 'rejected' | 'http<code>' */
function wsProbe(port, origin) {
  return new Promise((resolve) => {
    const opts = origin === null ? {} : { origin }
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?brand=Probe&ver=t`, opts)
    const timer = setTimeout(() => { try { ws.close() } catch {} resolve('timeout') }, 5000)
    ws.on('open', () => { clearTimeout(timer); try { ws.close() } catch {} resolve('accepted') })
    ws.on('error', () => { clearTimeout(timer); resolve('rejected') })
    ws.on('unexpected-response', (_q, r) => { clearTimeout(timer); resolve(`http${r.statusCode}`) })
  })
}

/** 原始 TCP，能伪造 Host */
function rawGet(port, hostHeader, path = '/') {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`)
    })
    let buf = ''
    const done = () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf)
      resolve(m ? Number(m[1]) : 0)
    }
    s.on('data', (d) => { buf += d.toString() })
    s.on('end', done)
    s.on('error', () => resolve(0))
    setTimeout(() => { s.destroy(); done() }, 5000)
  })
}

const bridge = new Bridge(quiet)
await bridge.start(PORT)
await new Promise((r) => setTimeout(r, 300))

console.log('\n──── ① Origin 校验（WS） ────')
const evil = await wsProbe(PORT, 'https://evil.example.com')
ok(evil !== 'accepted', '恶意网页的 WS 连接被拒', evil)
const localWeb = await wsProbe(PORT, 'http://127.0.0.1:8899')
ok(localWeb !== 'accepted', '本地网页的 WS 连接被拒', localWeb)
const nullOrigin = await wsProbe(PORT, 'null')
ok(nullOrigin !== 'accepted', 'Origin: null（沙箱 iframe）被拒', nullOrigin)
const ext = await wsProbe(PORT, 'chrome-extension://abcdefghijklmnop')
ok(ext === 'accepted', '扩展的 WS 连接放行', ext)
const native = await wsProbe(PORT, null)
ok(native === 'accepted', '原生宿主（无 Origin）放行', native)

console.log('\n──── ② Host 校验（HTTP，DNS rebinding） ────')
ok(await rawGet(PORT, `127.0.0.1:${PORT}`) === 200, 'Host=127.0.0.1 放行')
ok(await rawGet(PORT, `localhost:${PORT}`) === 200, 'Host=localhost 放行')
ok(await rawGet(PORT, 'evil.example.com') === 403, 'Host=evil.example.com 被拒')
ok(await rawGet(PORT, `evil.com:${PORT}`) === 403, 'Host=evil.com:port 被拒')

console.log('\n──── ③ 状态接口不泄露 token ────')
const st = await (await fetch(`http://127.0.0.1:${PORT}/`)).json()
ok(st.rpcToken === undefined, '无 token 请求拿不到 rpcToken')
ok(typeof bridge.rpcToken === 'string' && bridge.rpcToken.length === 32, 'token 是 32 位 hex', bridge.rpcToken.length + ' 字符')

console.log('\n──── ④ /rpc 令牌 ────')
const noTok = await fetch(`http://127.0.0.1:${PORT}/rpc?cmd=tabs.list`)
ok(noTok.status === 401, '无 token 被拒', 'HTTP ' + noTok.status)
const badTok = await fetch(`http://127.0.0.1:${PORT}/rpc?cmd=tabs.list&token=deadbeef`)
ok(badTok.status === 401, '错误 token 被拒', 'HTTP ' + badTok.status)
const goodTok = await fetch(`http://127.0.0.1:${PORT}/rpc?cmd=tabs.list&token=${bridge.rpcToken}`)
ok(goodTok.status !== 401, '正确 token 通过鉴权（无扩展时是 502）', 'HTTP ' + goodTok.status)

console.log('\n──── ⑤ 网页 Origin 的 HTTP 请求被拒 ────')
const evilHttp = await fetch(`http://127.0.0.1:${PORT}/`, {
  headers: { Origin: 'https://evil.example.com' },
})
ok(evilHttp.status === 403, '带网页 Origin 的状态请求被拒', 'HTTP ' + evilHttp.status)

bridge.stop()
setTimeout(() => {
  console.log(`\n══════════════════════════════════`)
  console.log(`=== security 结果: pass=${pass} fail=${fail}`)
  console.log(`══════════════════════════════════`)
  process.exit(fail === 0 ? 0 : 1)
}, 300)
