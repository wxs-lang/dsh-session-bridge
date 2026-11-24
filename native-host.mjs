#!/usr/bin/env node
/**
 * native-host.mjs — 浏览器扩展 ↔ DSH 桥 的 native messaging 中转
 *
 *   DSH 桥 (ws://127.0.0.1:39401)  ⟷  本进程  ⟷  chrome.runtime.connectNative()
 *
 * 为什么需要它：
 *   MV3 扩展的 Service Worker 会被浏览器卸载。靠 WebSocket 长连时，
 *   一旦 SW 被卸载就断线，要等 chrome.alarms 唤醒（最长 60s）。
 *   nativeMessaging 由**浏览器**负责拉起本进程，扩展睡醒后自己 connectNative，
 *   不存在"等 alarm"的盲区。
 *
 * 通信协议（两侧不同）：
 *   浏览器侧：stdin/stdout，每条消息 = 4 字节小端长度 + UTF-8 JSON
 *   桥 侧  ：WebSocket，每行一条 JSON（\n 分隔）
 *
 * 用法（由浏览器自动拉起，一般不用手动跑）：
 *   node native-host.mjs                 # 读 env.DSH_BRIDGE_PORT，默认 39401
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

const PORT = Number(process.env.DSH_BRIDGE_PORT || 39401)

/* ── 桥的握手令牌 ──
 *
 * 桥在启动时把随机 token 写到 <tmpdir>/dsh-session-bridge.token，
 * 宿主启动时读它并回传。目的是让"随便哪个本地进程连上 39401 自称 NativeHost"
 * 这件事多一道门槛 —— 它至少得知道文件在哪。
 *
 * 读不到就返回空串，桥侧对此是放行的（不能让文件权限问题把功能弄坏）。
 */
function readBridgeToken() {
  try {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const { tmpdir } = require('node:os')
    const p = join(tmpdir(), 'dsh-session-bridge.token')
    return readFileSync(p, 'utf8').trim().slice(0, 128)
  } catch {
    return ''
  }
}
const HOST = '127.0.0.1'

/* ── stdout 写入：4 字节 LE 长度 + JSON ─────────────────────────────── */

function writeNative(obj) {
  try {
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    const head = Buffer.allocUnsafe(4)
    head.writeUInt32LE(body.length, 0)
    process.stdout.write(Buffer.concat([head, body]))
  } catch (e) {
    log('writeNative failed: ' + e.message)
  }
}

/* ── stdin 读取：按 4 字节长度切包 ───────────────────────────────────── */

let buf = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    if (buf.length < 4) return
    const len = buf.readUInt32LE(0)
    if (len === 0) {
      buf = buf.subarray(4)
      continue
    }
    if (buf.length < 4 + len) return
    const body = buf.subarray(4, 4 + len)
    buf = buf.subarray(4 + len)
    let msg
    try { msg = JSON.parse(body.toString('utf8')) } catch { continue }
    onNativeMessage(msg)
  }
})

process.stdin.on('end', () => {
  log('stdin closed, exiting')
  shutdown()
})

/* ── 与桥的 WebSocket ───────────────────────────────────────────────── */

let ws = null
let wsReady = false
let reconnectTimer = null
let seq = 0
const pending = new Map()   // 桥请求 id -> { resolve }

function wsConnect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  try {
    // URL 里带 pid：两个 Chrome profile 会各拉起一个 native host 进程，
    // 只靠 brand 的话两个 connId 都是 "NativeHost:w"，按 connId 精确指定会撞车。
    // 带上 pid 后变成 "NativeHost:12345"，天然唯一。
    const qs = new URLSearchParams({
      brand: 'NativeHost',
      ver: 'native',
      pid: String(process.pid),
      ppid: String(process.ppid || 0),
      // 桥侧据此确认"这是我写出去的那个 token"
      token: readBridgeToken(),
    })
    ws = new WebSocket(`ws://${HOST}:${PORT}/?${qs.toString()}`)
  } catch (e) {
    log('ws create failed: ' + e.message)
    scheduleWsReconnect()
    return
  }

  ws.on('open', () => {
    wsReady = true
    log('bridge connected')
    // ── commands 不再硬编码 ──
    // 原来这里写死 18 条，扩展加到 29 条后新的 11 个命令会被判成"不支持"，
    // WS 断开时走 native 通道就会失败。
    // 现在：向扩展要一次真实清单（ext.capabilities），拿到后转给桥。
    ws.send(JSON.stringify({
      type: 'hello',
      version: 'native',
      browser: { name: 'NativeHost' },
      brand: 'NativeHost',
      pid: process.pid,
      // capabilities 未到之前先声明消息通道本身可用，避免桥判定"不支持任何命令"
      commands: ['*'],
      capabilitiesPending: true,
    }) + '\n')

    // 请扩展上报真实命令清单
    writeNative({ type: 'need-capabilities' })
    // 桥重连后，让扩展也知道该重连（可选）
    writeNative({ type: 'bridge-status', connected: true })
  })

  ws.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let msg
      try { msg = JSON.parse(t) } catch { continue }
      // 桥发来的命令 → 转给扩展
      // 桥要求宿主主动退出（用于清理僵死的 native host 实例）。
      // 退出后浏览器会重新 connectNative 拉起一个新的，带着最新代码。
      if (msg.cmd === '__host.shutdown') {
        log('收到 shutdown 指令，退出')
        try { ws.close() } catch { /* ignore */ }
        shutdown()
        return
      }
      if (msg.id != null && msg.cmd) {
        writeNative({ type: 'cmd', id: msg.id, cmd: msg.cmd, params: msg.params || {}, timeoutMs: msg.timeoutMs })
      }
    }
  })

  ws.on('close', () => {
    wsReady = false
    writeNative({ type: 'bridge-status', connected: false })
    scheduleWsReconnect()
  })

  ws.on('error', () => { try { ws.close() } catch { /* ignore */ } })
}

function scheduleWsReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    wsConnect()
  }, 2000)
}

/* ── 扩展发来的消息 ─────────────────────────────────────────────────── */

function onNativeMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  // 扩展回报命令结果 → 转给桥
  if (msg.type === 'result' && msg.id != null) {
    if (!wsReady) return
    try {
      ws.send(JSON.stringify({
        id: msg.id,
        ok: msg.ok !== false,
        brand: msg.brand || 'NativeHost',
        extVersion: msg.extVersion,
        result: msg.result == null ? {} : msg.result,
        error: msg.error,
      }) + '\n')
    } catch (e) {
      log('relay result failed: ' + e.message)
    }
    return
  }

  // 扩展上报真实命令清单 → 转给桥，替换掉 hello 里的占位
  if (msg.type === 'capabilities') {
    if (!wsReady) return
    try {
      ws.send(JSON.stringify({
        type: 'hello',
        version: msg.version || 'native',
        browser: { name: 'NativeHost' },
        brand: 'NativeHost',
        pid: process.pid,
        commands: Array.isArray(msg.commands) ? msg.commands : [],
        ua: msg.ua || '',
        capabilitiesFrom: 'extension',
      }) + '\n')
      log(`capabilities 已转发: ${(msg.commands || []).length} 条命令`)
    } catch (e) {
      log('relay capabilities failed: ' + e.message)
    }
    return
  }

  // 扩展主动报告状态
  if (msg.type === 'ping') {
    writeNative({ type: 'pong', t: msg.t })
    return
  }

  if (msg.type === 'log') {
    log('ext: ' + String(msg.text || '').slice(0, 200))
    return
  }
}

/* ── 生命周期 ───────────────────────────────────────────────────────── */

function log(s) {
  // 注意：stdout 是协议通道，日志只能写 stderr
  try { process.stderr.write(`[native-host] ${s}\n`) } catch { /* ignore */ }
}

function shutdown() {
  try { if (ws) ws.close() } catch { /* ignore */ }
  process.exit(0)
}

wsConnect()

// 浏览器关掉 port 时会杀这个进程；额外兜底：父进程消失就退出
setInterval(() => {
  if (process.ppid === 1) shutdown()
}, 30000).unref?.()
