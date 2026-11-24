/**
 * dsh-session-bridge — 浏览器操控桥插件
 *
 * 让 DSH 直接操控用户**自己的** Chrome / Edge / QQ浏览器：
 *   · 复用用户已经登录的会话（cookie / 登录态 / 扩展环境）
 *   · 不启动新的浏览器实例，不接管 CDP 端口，不改用户 profile
 *
 * 架构：
 *   本机 WS 服务 127.0.0.1:39401  ←—  MV3 扩展（service worker）作为客户端连上来
 *   工具 execute() → 一行 JSON 请求 → 等响应（默认 20s）→ 返回结构化结果
 *
 * 协议（JSON 行，\n 分隔）：
 *   扩展 → 插件：{"type":"hello","version":"1.0.0","browser":"Chrome/…","tabs":N}
 *                {"type":"pong","t":...}
 *   插件 → 扩展：{"id":1,"cmd":"tabs.list","params":{}}
 *   扩展 → 插件：{"id":1,"ok":true,"result":{…}}
 *                {"id":1,"ok":false,"error":{"code":"restricted_page","message":"…"}}
 *
 * 失败永远是结构化返回值 {ok:false, error:<code>, message}，不抛异常。
 */

import { createServer } from 'node:http'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'


const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * 扩展目录：插件可能跑在 node_modules 副本里，但扩展目录希望指向 vendor 原件
 * （用户会改原件，node_modules 里的是装机副本）。优先 vendor 原件，找不到用自己旁边的。
 */
function pickExtDir() {
  const own = join(PLUGIN_DIR, 'extension')
  // <profile>/node_modules/dsh-session-bridge  → <profile>/vendor/dsh-session-bridge/extension
  const parent = dirname(dirname(PLUGIN_DIR)) // profile 根
  const vendorExt = join(parent, 'vendor', 'dsh-session-bridge', 'extension')
  try {
    if (existsSync(join(vendorExt, 'manifest.json')) && existsSync(join(own, 'manifest.json'))) {
      // 原件与副本同时存在：优先原件（用户编辑的那份）
      return vendorExt
    }
  } catch { /* 忽略 */ }
  return own
}

const EXT_DIR = pickExtDir()
const HOST = '127.0.0.1'
const DEFAULT_PORT = 39401
/** 首选端口被占用时依次尝试。扩展侧 BRIDGE_PORTS 必须包含同样的列表。 */
const FALLBACK_PORTS = [39411, 39421]
const DEFAULT_TIMEOUT = 20000

/* ── 依赖解析：ws ─────────────────────────────────────────────────────
 * 插件可能位于 <profile>/vendor/dsh-session-bridge（原件）
 * 也可能位于 <profile>/node_modules/dsh-session-bridge（安装副本）
 * 两种位置 createRequire 向上都能摸到 <profile>/node_modules/ws。
 */
// 本模块被 import 的时刻。用来判断"磁盘上的文件是不是比内存里的代码新"。
// 注意：这跟进程启动时间不是一回事 —— fiber.restart 会重跑 apply()，
// 但 ESM 模块缓存不会失效，MODULE_LOADED_AT 不会更新。
// 这正是我们需要的语义：它变旧 = 内存里跑的是缓存代码 = 需要完整重启 DSH。
const MODULE_LOADED_AT = Date.now()

let WebSocketServer = null

/* ── 来源校验 ──────────────────────────────────────────────────────────
 *
 * 桥监听在 127.0.0.1，但这不等于安全：**任何网页都能连本地回环端口**。
 * 恶意页只要 `new WebSocket('ws://127.0.0.1:39401')` 就能借用户已登录的
 * 浏览器发请求、读页面、截屏 —— 桥自己没有任何鉴权。
 *
 * 浏览器发起 WebSocket 时一定带 Origin 头，Node 的 ws 客户端（原生宿主）
 * 不带。所以规则很简单：
 *
 *   无 Origin            → 放行（native host 这条通道）
 *   chrome-extension://  → 放行（我们自己的扩展，以及用户装的其他扩展）
 *   其他（http/https/…）  → 拒绝，这是网页
 *
 * 想更严可以收窄到具体扩展 ID，但那样重装扩展就得改配置，
 * 权衡后选择"允许扩展、拒绝网页"。
 */
function isTrustedOrigin(origin) {
  if (origin === undefined || origin === null || origin === '') return true
  const s = String(origin).toLowerCase()
  if (s === 'null') return false
  return s.startsWith('chrome-extension://')
    || s.startsWith('moz-extension://')
    || s.startsWith('safari-web-extension://')
}

async function loadWs() {
  const req = createRequire(join(PLUGIN_DIR, 'package.json'))
  try {
    const m = req('ws')
    const Ctor = m.WebSocketServer || (m.default && m.default.WebSocketServer)
    if (Ctor) return Ctor
  } catch { /* 继续兜底 */ }
  try {
    const m = await import('ws')
    const Ctor = m.WebSocketServer || (m.default && m.default.WebSocketServer)
    if (Ctor) return Ctor
  } catch { /* 继续兜底 */ }
  return null
}

/* ── 错误码 ─────────────────────────────────────────────────────────── */

const E = {
  disconnected: 'extension_disconnected',
  timeout: 'timeout',
  noTab: 'tab_not_found',
  badArgs: 'bad_args',
  ext: 'extension_error',
  noAttachments: 'attachments_unavailable',
}

function fail(code, message, extra) {
  return { ok: false, error: code, message: String(message == null ? '' : message), ...(extra || {}) }
}

/* ── 单连接请求串行化 + 超时关联 ─────────────────────────────────────── */

class Bridge {
  constructor(logger) {
    this.log = logger
    this.server = null
    this.sockets = new Set()
    this.primary = null            // 主连接（sticky：定了就不乱跳）
    this.connSeq = 0               // 无窗口指纹时的自增 id
    // tabId → 持有它的连接。tabId 全局唯一，所以只要记住了归属，
    // 后续所有带 tabId 的命令都能精确送达，不用猜品牌、不用关别的浏览器。
    this.tabOwner = new Map()
    this.hello = null              // { version, browser, at }
    this.seq = 0
    this.pending = new Map()       // id -> { resolve, reject, timer }
    this.queue = Promise.resolve() // 串行化链
    this.port = DEFAULT_PORT
    this.startedAt = 0
    this.lastError = null
    // 调试通道 /rpc 的令牌：每次启动随机生成，只在状态里告诉本机调用方。
    // 目的是让"从网页里盲目触发命令"变成不可能 —— 网页读不到这个值。
    this.rpcToken = randomBytes(16).toString('hex')
    // 原生宿主的握手令牌：写到临时文件，宿主读它并在 URL 里回传。
    // 读不到文件的旧宿主会传空串，桥侧对此放行（见 onConnection）。
    this.nativeToken = randomBytes(16).toString('hex')
    this.nativeTokenPath = join(tmpdir(), 'dsh-session-bridge.token')
  }

  get ready() {
    return Boolean(this.primary && this.primary.readyState === 1 && this.primary.dshHelloAt)
  }

  extCount() {
    let n = 0
    for (const s of this.sockets) if (s.readyState === 1 && s.dshHelloAt) n += 1
    return n
  }

  /** 检查磁盘上的 index.js 是否比当前进程新（即改动未加载）。 */
  /** 磁盘上的 index.js 是否比**内存里的模块**新。
   *
   *  判定基准是 MODULE_LOADED_AT（模块被 import 的时刻），不是进程启动时间。
   *  原因：fiber.restart() 只重跑 apply()，ESM 模块缓存不失效，
   *  所以热重载之后内存里仍是旧代码 —— 用进程启动时间判断会永远为 true，
   *  用模块加载时间判断才准确。
   */
  codeFresh() {
    try {
      // 检查 impl.js（真正的实现），不是薄入口 index.js。
      // 入口每次都会 import 最新的 impl，所以"是否过时"要看 impl 的 mtime。
      const self = fileURLToPath(import.meta.url)
      const mtime = statSync(self).mtimeMs
      const procStart = Date.now() - Math.round(process.uptime() * 1000)
      const stale = mtime > MODULE_LOADED_AT + 500
      return {
        fileMtime: new Date(mtime).toISOString(),
        moduleLoadedAt: new Date(MODULE_LOADED_AT).toISOString(),
        procStart: new Date(procStart).toISOString(),
        stale,
        // 热重载不能清模块缓存 → stale 只能靠完整重启 DSH 归零
        hint: stale
          ? '磁盘代码比内存里的新。browser_reload 无法清除 ESM 模块缓存，需要完整重启 DSH。'
          : '已是最新',
        reloadable: !stale ? 'n/a' : 'browser_reload 只能重跑 apply()，改 TOOL_SPECS 无效',
      }
    } catch (e) {
      return { error: String((e && e.message) || e) }
    }
  }

  status() {
    // 每次读状态顺手清一次孤儿（代价极小），避免"旧的连接一直挂着"
    const reaped = this.reapOrphanSockets()
    if (reaped.length > 0) {
      this.log.info(`[session-bridge] 清理了 ${reaped.length} 条孤儿连接: ${reaped.map((r) => r.connId || r.reason).join(', ')}`)
    }
    return {
      ok: true,
      available: this.ready,
      wsUrl: `ws://${HOST}:${this.port}`,
      listening: Boolean(this.server && this.server.listening),
      // /rpc 需要它；网页想读这个状态会被 CORS 挡住，只能本机 CLI 读
      rpcToken: this.rpcToken,
      extensions: this.extCount(),
      extensionVersion: this.hello ? this.hello.version : null,
      browser: this.hello ? this.hello.browser : null,
      connections: [...this.sockets]
        .filter((s) => s.readyState === 1 && s.dshHelloAt)
        .map((s) => ({
          connId: s.dshConnId || null,
          brand: s.dshBrand || 'Unknown',
          commands: s.dshCaps ? s.dshCaps.size : 0,
          windows: s.dshWindows,
          ua: (s.dshUa || '').slice(0, 120),
        })),
      browsers: [...new Set([...this.sockets]
        .filter((s) => s.readyState === 1 && s.dshHelloAt)
        .map((s) => s.dshBrand || 'Unknown'))],
      extensionDir: EXT_DIR,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      lastError: this.lastError,
      groupError: this.lastGroupError || null,
      groupTouched: groupTouched.size,
      primaryConnId: this.primary ? this.primary.dshConnId || null : null,
      // 直接放在 status 里，任何读 / 的地方都能看到（不再只有 browser_status 工具才有）
      codeFresh: this.codeFresh(),
      // 扩展没连上时最容易卡住：给一句能照着做的提示，而不是只报空数组
      ...(this.extCount() === 0 ? {
        hint: '扩展没连上。依次检查：① chrome://extensions 里本扩展是否「已启用」；'
          + '② 点一下扩展图标的刷新箭头，让它重连；③ 若浏览器刚重启过，'
          + '扩展的 Service Worker 可能已休眠，点图标打开面板即可唤醒。'
          + `桥在 ${HOST}:${this.port} 正常监听中，问题一定在扩展侧。`,
      } : {}),
    }
  }

  async start(port) {
    if (this.server) return
    if (!WebSocketServer) WebSocketServer = await loadWs()
    if (!WebSocketServer) {
      this.lastError = 'ws module not resolvable'
      this.log.warn('[session-bridge] 解析不到 ws 模块，桥不启动')
      return
    }
    this.port = port || DEFAULT_PORT
    const httpServer = createServer((req, res) => {
      const send = (code, obj) => {
        const body = JSON.stringify(obj)
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      }
      // ── 网页发起的 HTTP 请求一律拒绝 ──
      // 浏览器的"简单请求"（GET / img / form）不带预检就能打到本地端口，
      // CORS 只挡读响应、不挡执行，所以必须在服务端按 Origin 拦。
      const reqOrigin = req.headers && req.headers.origin
      if (!isTrustedOrigin(reqOrigin)) {
        send(403, fail(E.badArgs, 'origin not allowed'))
        return
      }
      // ── Host 必须是回环地址 ──
      // 挡住 DNS rebinding：攻击者把 evil.com 解析到 127.0.0.1，网页里的
      // fetch('http://evil.com:39401/') 就能读到状态（含 rpcToken）。
      // 必须放在所有路由之前 —— 否则 GET / 这条会先把 token 吐出去。
      const reqHost = String((req.headers && req.headers.host) || '')
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqHost)) {
        send(403, fail(E.badArgs, 'host not allowed'))
        return
      }
      // GET /            → 状态
      // GET /rpc?cmd=…   → 调试用：把命令转发给扩展（本机 + 需 token）
      let u
      try { u = new URL(req.url || '/', `http://${HOST}:${this.port}`) } catch { u = null }
      if (u && u.pathname === '/rpc') {
        // 调试通道要 token：状态接口里有它就无从下手
        const given = u.searchParams.get('token') || ''
        if (this.rpcToken && given !== this.rpcToken) {
          send(401, fail(E.badArgs, 'bad or missing token'))
          return
        }
        const cmd = u.searchParams.get('cmd') || ''
        if (!cmd) { send(400, fail(E.badArgs, 'need ?cmd=')); return }
        let params = {}
        const raw = u.searchParams.get('params')
        if (raw) { try { params = JSON.parse(raw) } catch { send(400, fail(E.badArgs, 'params must be JSON')); return } }
        // 调试通道也要支持路由：?brand=chrome / ?connId=... 从 params 里摘出来
        const opts = {}
        if (params && typeof params === 'object') {
          if (params.browser !== undefined) { opts.brand = params.browser; delete params.browser }
          if (params.connId !== undefined) { opts.connId = params.connId; delete params.connId }
          if (params.browser === undefined && u.searchParams.get('brand')) opts.brand = u.searchParams.get('brand')
        }
        // ?all=1 → 并发问所有连接并合并（调试聚合用）
        if (u.searchParams.get('all') === '1') {
          this.requestAll(cmd, params, 8000).then((r) => send(r.ok ? 200 : 502, r))
          return
        }
        this.request(cmd, params, opts).then((r) => send(r.ok ? 200 : 502, r))
        return
      }
      // 状态里带 rpcToken 会让 GET / 变成"token 分发器"——虽然 Host+Origin
      // 已经挡住了网页，但没必要。改成：带对 token 才返回完整状态（含新 token），
      // 否则去掉该字段。本机 CLI 自己知道 token（从进程内存/日志拿）。
      const st = this.status()
      if ((u && u.searchParams.get('token')) === this.rpcToken) {
        // 完整状态
      } else {
        delete st.rpcToken
      }
      send(200, st)
    })
    // 端口被占多半是上一代实例还在释放（热重载常见）。
    // 不做无限重试，只给一次 600ms 的宽限。
    const wss = new WebSocketServer({
      server: httpServer,
      path: '/',
      maxPayload: 64 * 1024 * 1024,
      // 拒绝网页发起的连接，只放行扩展与原生宿主（详见 isTrustedOrigin）
      verifyClient: (info) => {
        const origin = info && info.origin
        if (isTrustedOrigin(origin)) return true
        this.lastError = `拒绝来源不明的连接：Origin=${String(origin).slice(0, 60)}`
        this.log.warn(`[session-bridge] 拒绝 WebSocket 连接，Origin=${String(origin).slice(0, 80)}`)
        return false
      },
    })
    this.server = httpServer

    wss.on('connection', (sock, req) => this.onConnection(sock, req))
    wss.on('error', (e) => { this.lastError = String((e && e.message) || e) })

    // ── 监听：首选端口被占就依次降级 ──
    // 两个 DSH 实例同时跑时，第二个会撞 EADDRINUSE。原来直接失败，
    // 表现为"桥起不来、扩展连不上"。现在降级到备用端口，功能照常。
    const candidates = [this.port]
    for (const p of FALLBACK_PORTS) if (!candidates.includes(p)) candidates.push(p)

    let listenErr = null
    for (const candidate of candidates) {
      const ok = await new Promise((done) => {
        const onErr = (e) => {
          listenErr = e
          httpServer.removeListener('error', onErr)
          done(false)
        }
        httpServer.once('error', onErr)
        httpServer.listen(candidate, HOST, () => {
          httpServer.removeListener('error', onErr)
          this.port = candidate
          this.startedAt = Date.now()
          done(true)
        })
      })
      if (ok) {
        this.lastError = null
        // 写握手令牌供原生宿主读取。写失败不影响功能（宿主会传空串）。
        try {
          writeFileSync(this.nativeTokenPath, this.nativeToken, { mode: 0o600 })
        } catch (e) {
          this.log.warn('[session-bridge] 写 native token 失败（原生宿主将不做校验）: ' + ((e && e.message) || e))
        }
        this.log.info(`[session-bridge] WS 桥已就绪 ws://${HOST}:${this.port}`)
        return
      }
      this.log.warn(`[session-bridge] 端口 ${candidate} 不可用：${(listenErr && listenErr.message) || listenErr}`)
    }

    // 全部失败
    this.lastError = `所有端口都监听失败（试过 ${candidates.join(', ')}）：`
      + `${(listenErr && listenErr.message) || listenErr}`
    this.log.warn('[session-bridge] ' + this.lastError)
    this.server = null
  }

  /** 关掉指定的连接（按 connId）。 */
  closeConn(connId) {
    const want = String(connId)
    const hit = [...this.sockets].find((s) => s.dshConnId === want)
    if (!hit) return { ok: false, error: 'unknown_conn', known: [...this.sockets].map((s) => s.dshConnId) }
    try { hit.close(1000, 'manual-close') } catch { /* ignore */ }
    this.sockets.delete(hit)
    if (this.primary === hit) this.primary = null
    for (const [tid, owner] of [...this.tabOwner]) if (owner === hit) this.tabOwner.delete(tid)
    return { ok: true, connId: want }
  }

  /** 广播：让所有 native host 主动退出（它们退出后扩展会重连新实例）。 */
  async dropNativeHosts(reason = 'manual') {
    const hosts = [...this.sockets].filter((s) => String(s.dshBrand || '') === 'NativeHost')
    for (const h of hosts) {
      try {
        // 先让 native host 自己退出（它会关掉 stdio，浏览器会重连新的）
        h.send(JSON.stringify({ id: ++this.seq, cmd: '__host.shutdown', params: { reason } }) + '\n')
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 120))
      try { h.close(1000, reason) } catch { /* ignore */ }
      this.sockets.delete(h)
      if (this.primary === h) this.primary = null
    }
    return { ok: true, dropped: hosts.map((h) => h.dshConnId) }
  }

  stop() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve(fail(E.disconnected, 'bridge stopped'))
    }
    this.pending.clear()
    for (const s of this.sockets) {
      try { s.close() } catch { /* ignore */ }
    }
    this.sockets.clear()
    this.primary = null
    if (this.server) {
      try { this.server.close() } catch { /* ignore */ }
      this.server = null
    }
  }

  /** 向**所有**已连扩展并发发同一条命令，把结果合并。
   *  用于 tabs.list / group.list 这类"想看全貌"的查询：
   *  用户装了 3 个浏览器，就该看到 3 个浏览器的标签，而不是随机一个。 */
  async requestAll(cmd, params, timeoutMs = 8000, brand) {
    let live = [...this.sockets].filter((s) => s.readyState === 1 && s.dshHelloAt)
    // 中继通道会把同一个 tabs.list 再问一遍，导致结果重复、tabId 归属被抢。
    // 聚合查询只问真实浏览器；一个真实浏览器都没有时才退回中继。
    const realLive = live.filter((s) => !this._isRelay(s))
    if (realLive.length > 0) live = realLive
    // 指定了品牌就只问那类浏览器（NativeHost 是转发通道，不算独立浏览器）
    if (brand) {
      const want = String(brand).toLowerCase() === 'qq' ? 'qqbrowser' : String(brand).toLowerCase()
      const same = live.filter((s) => String(s.dshBrand || '').toLowerCase() === want)
      if (same.length > 0) live = same
    }
    if (live.length === 0) return { ok: false, error: E.disconnected, message: '浏览器扩展已断开' }
    // 带上每条连接的身份：扩展回包里不一定有 brand，但 sock 上一定有
    const per = await Promise.all(live.map(async (s) => {
      const r = await this._sendTo(s, cmd, params, timeoutMs)
      return r ? { ...r, brand: r.brand || s.dshBrand || 'Unknown', connId: s.dshConnId || null } : null
    }))
    const good = per.filter((r) => r && r.ok)
    if (good.length === 0) return per.find(Boolean) || { ok: false, error: E.timeout, message: '无响应' }
    return { ok: true, results: good, connCount: good.length, total: live.length }
  }

  /** 发到指定 socket（不经过路由）。 */
  _sendTo(sock, cmd, params, timeoutMs) {
    const id = ++this.seq
    return new Promise((resolveP) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolveP(fail(E.timeout, `命令 ${cmd} 超过 ${timeoutMs}ms 没有响应`))
      }, timeoutMs + 500)
      this.pending.set(id, { resolve: resolveP, timer, sock, cmd })
      try {
        sock.send(JSON.stringify({ id, cmd, params: params || {}, timeoutMs }) + '\n')
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        const f = fail(E.disconnected, String((e && e.message) || e))
        f.deadSock = sock
        resolveP(f)
      }
    })
  }

  /** 中继通道（NativeHost）不代表真实浏览器，不能拥有标签页。
   *  它只是把命令转发给扩展，回包里的 tabId 属于背后的那个浏览器。 */
  _isRelay(sock) {
    return String((sock && sock.dshBrand) || '').toLowerCase() === 'nativehost'
  }

  /** 从任意命令回包里抽取 tab 归属信息。 */
  _claimTabs(sock, result) {
    if (!result || typeof result !== 'object') return
    // 中继通道不登记归属：否则会把真实浏览器的 tabId 抢到自己名下，
    // 后续带 tabId 的命令全被路由到那条只声明了 18 个命令的窄通道上。
    if (this._isRelay(sock)) return
    const claim = (id) => {
      if (typeof id === 'number') this.tabOwner.set(id, sock)
    }
    if (Array.isArray(result.tabs)) {
      for (const t of result.tabs) if (t && typeof t.id === 'number') claim(t.id)
    }
    claim(result.tabId)
    if (result.tab && typeof result.tab.id === 'number') claim(result.tab.id)
    if (Array.isArray(result.closed)) {
      for (const t of result.closed) if (t && typeof t.id === 'number') this.tabOwner.delete(t.id)
    }
    if (Array.isArray(result.groups)) {
      for (const g of result.groups) {
        if (Array.isArray(g.tabs)) for (const t of g.tabs) if (t && typeof t.id === 'number') claim(t.id)
      }
    }
  }

  /** 清掉"只有占位 capabilities（如 ['*']）、始终没等到真清单"的连接。
   *
   *  症状：桥上一堆 NativeHost:xxx，commands=1，ua 空。它们是 native host 进程
   *  启动了但对应浏览器没 connectNative 成功留下的空壳。占着 primary、
   *  污染 requestAll 结果，还让 connId 列表变乱。
   *
   *  判据：hello 已到、capabilitiesFrom 不是 'extension'、且声明命令数 <= 1、
   *  且已过去 graceMs 还没收到真清单 → 认定为孤儿，主动 close。
   */
  reapOrphanSockets(graceMs = 15000) {
    const now = Date.now()
    const killed = []
    for (const sock of [...this.sockets]) {
      if (sock.readyState !== 1) { this.sockets.delete(sock); continue }
      if (!sock.dshHelloAt) {
        // 连上了但一直没 hello —— 可能是探测/僵尸
        if (sock.dshOpenedAt && now - sock.dshOpenedAt > graceMs) {
          try { sock.close(1000, 'no-hello') } catch { /* ignore */ }
          this.sockets.delete(sock)
          killed.push({ connId: null, reason: 'no-hello' })
        }
        continue
      }
      const capCount = sock.dshCaps ? sock.dshCaps.size : 0
      const isPlaceholder = sock.dshCapabilitiesFrom !== 'extension' && capCount <= 1
      if (isPlaceholder && sock.dshOpenedAt && now - sock.dshOpenedAt > graceMs) {
        try { sock.close(1000, 'orphan-native-host') } catch { /* ignore */ }
        this.sockets.delete(sock)
        if (this.primary === sock) this.primary = null
        killed.push({ connId: sock.dshConnId || null, reason: 'placeholder-caps' })
      }
    }
    return killed
  }

  onConnection(sock, req) {
    // 有真实连接进来，说明桥在正常工作 —— 之前的 listen 失败/超时是历史，
    // 留着只会让排查的人误以为现在还坏着。
    this.lastError = null
    sock.dshHelloAt = 0
    sock.dshBuf = ''
    sock.dshOpenedAt = Date.now()
    sock.dshCapabilitiesFrom = null
    // ── 从 WebSocket URL 的 query 直接读身份 ──
    // 扩展连上来时 URL 形如 ws://127.0.0.1:39401/?brand=Chrome&ver=1.4.6
    // 这样在 upgrade 那一刻就知道是谁，不用等 hello，也就没有路由空窗。
    try {
      const u = new URL(req && req.url ? req.url : '/', 'http://127.0.0.1')
      const brand = u.searchParams.get('brand')
      const ver = u.searchParams.get('ver')
      const pid = u.searchParams.get('pid')
      if (brand) sock.dshBrand = String(brand)
      if (ver) sock.dshVersion = String(ver)
      if (pid) sock.dshPid = Number(pid) || null

      // ── 原生宿主必须带对握手令牌 ──
      // 无 Origin 虽然挡住了网页，但挡不住"本机任意进程自称 NativeHost"。
      // 令牌从桥写出的临时文件里读，抬高门槛。
      // 传空串的情况放行：旧宿主 / 文件读不到，不能让功能因此坏掉。
      if (String(brand || '').toLowerCase() === 'nativehost') {
        const given = String(u.searchParams.get('token') || '')
        if (given && this.nativeToken && given !== this.nativeToken) {
          sock.dshBrand = 'Rejected'
          this.lastError = 'NativeHost 令牌不匹配，已拒绝'
          try { sock.close(1008, 'bad native token') } catch { /* ignore */ }
          return
        }
      }

      // ── connId 必须能区分"同一品牌的多个实例" ──
      // 浏览器扩展用窗口指纹（windows=1-2-3）；
      // native host 没有窗口，两个 Chrome profile 各拉起一个进程，
      // 只用 brand 会得到两个 "NativeHost:w" 互相覆盖。
      // 所以：有 pid 就用 pid，有窗口指纹就用指纹，都没有才退回 "w"。
      if (brand) {
        const wfp = (sock.dshWindows || []).join('-')
        const suffix = wfp || (sock.dshPid ? String(sock.dshPid) : '')
        sock.dshConnId = `${brand}:${suffix || 'w'}`
      }
      sock.dshConnIdFromQuery = true
    } catch { /* ignore */ }
    this.sockets.add(sock)
    // 注意：这里**不**把 sock 设成 primary —— 只有发过 hello 的才是扩展连接，
    // 否则任何本地连接（调试/探测）都会把真正的扩展挤掉。

    sock.on('message', (raw) => this.onData(sock, raw))
    sock.on('close', () => {
      this.sockets.delete(sock)
      // 这条连接死了，它持有的 tab 归属也失效（tabId 会被复用于别的浏览器）
      for (const [tid, owner] of [...this.tabOwner]) {
        if (owner === sock) this.tabOwner.delete(tid)
      }
      if (this.primary === sock) {
        // 优先挑另一个发过 hello 的连接
        this.primary = null
        for (const s of this.sockets) {
          if (s.readyState === 1 && s.dshHelloAt) { this.primary = s; break }
        }
        if (!this.primary) this.hello = null
      }
      // 该连接上的在途请求立刻失败，别让工具干等超时
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        const f = fail(E.disconnected, 'extension closed the connection')
        f.deadSock = sock
        p.resolve(f)
      }
      this.pending.clear()
    })
    sock.on('error', () => { /* close 会跟着来 */ })
  }

  onData(sock, raw) {
    sock.dshBuf += typeof raw === 'string' ? raw : raw.toString('utf8')
    let idx
    while ((idx = sock.dshBuf.indexOf('\n')) >= 0) {
      const line = sock.dshBuf.slice(0, idx).trim()
      sock.dshBuf = sock.dshBuf.slice(idx + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this.onMessage(sock, msg)
    }
    // 兼容不带换行的单条 JSON
    const tail = sock.dshBuf.trim()
    if (tail.startsWith('{') && tail.endsWith('}')) {
      try {
        const msg = JSON.parse(tail)
        sock.dshBuf = ''
        this.onMessage(sock, msg)
      } catch { /* 半包，等后续 */ }
    }
  }

  onMessage(sock, msg) {
    // ── 登记 tab 归属 ──
    // 任何回包里出现的 tab 对象，都记下"它属于这条连接"。
    // 这样后续带 tabId 的命令可以精确送达，不管同时连了几个浏览器。
    if (msg.id != null && msg.ok) {
      this._claimTabs(sock, msg.result)
    }
    if (msg.type === 'hello') {
      sock.dshHelloAt = Date.now()
      // 扩展在 hello 里声明支持的命令；旧版扩展开不声明 → capabilities 为空集。
      // commands：取并集而不是覆盖 —— native host 先报 ['*'] 占位，
      // 扩展的真实清单后到；两者合并才不会把已声明的丢掉。
      const incoming = Array.isArray(msg.commands) ? msg.commands.map(String) : []
      if (!sock.dshCaps) sock.dshCaps = new Set()
      for (const c of incoming) sock.dshCaps.add(c)
      sock.dshBrand = String(msg.brand || 'Unknown')
      sock.dshUa = String(msg.ua || '')
      sock.dshWindows = Array.isArray(msg.windows) ? msg.windows : null
      if (msg.pid) sock.dshPid = Number(msg.pid) || sock.dshPid
      if (msg.capabilitiesFrom) sock.dshCapabilitiesFrom = String(msg.capabilitiesFrom)
      // ── connId 修正 ──
      // 第一次 hello 可能还没有窗口指纹（onConnection 阶段拿到的是 undefined），
      // 所以 hello 到达后再用"窗口指纹 > pid > 自增"重算一次。
      // 但如果 connId 已经带了窗口指纹或 pid，就保持不变（避免同一条连接反复改名）。
      {
        const brand = sock.dshBrand || 'Unknown'
        const wfp = sock.dshWindows ? sock.dshWindows.join('-') : ''
        const pidPart = sock.dshPid ? String(sock.dshPid) : ''
        const best = wfp || pidPart
        const cur = sock.dshConnId || ''
        // 判断现有 connId 是否只是 "<brand>:w" 这种占位
        const isPlaceholder = cur === `${brand}:w` || cur === ''
        if (isPlaceholder) {
          sock.dshConnId = best ? `${brand}:${best}` : `${brand}:#${++this.connSeq}`
        } else if (best && !cur.includes(best)) {
          sock.dshConnId = `${brand}:${best}`
        }
      }
      this.hello = {
        version: msg.version || 'unknown',
        browser: msg.browser || 'unknown',
        at: sock.dshHelloAt,
        commands: [...sock.dshCaps],
      }
      // ── sticky primary：已有 primary 就不抢 ──
      // 旧逻辑每次 hello 都无条件 this.primary = sock，导致每新开一个浏览器
      // （或扩展重载）就把主连接切走，正在飞的命令落到切换瞬间的连接上 →
      // extension_disconnected。改成只在"没有 primary 或它已死"时才赋值。
      const cur = this.primary
      const curAlive = cur && cur.readyState === 1 && cur.dshHelloAt
      if (!curAlive) {
        this.primary = sock
      }
      sock.send(JSON.stringify({ type: 'hello-ack', version: '1.0.0' }) + '\n')
      this.log.info(`[session-bridge] 扩展已连接：${this.hello.browser} v${this.hello.version}`)
      return
    }
    if (msg.type === 'pong' || msg.type === 'ping') {
      sock.dshHelloAt = sock.dshHelloAt || Date.now()
      if (msg.type === 'ping') { try { sock.send(JSON.stringify({ type: 'pong' }) + '\n') } catch { /* ignore */ } }
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) {
        p.resolve({ ok: true, ...(msg.result && typeof msg.result === 'object' ? msg.result : { value: msg.result }) })
      } else {
        const err = msg.error || {}
        p.resolve(fail(err.code || E.ext, err.message || 'extension reported failure', err.data ? { data: err.data } : undefined))
      }
    }
  }

  /** 发一条命令，等对应 id 的结果。不抛异常。 */
  async request(cmd, params, opts = {}) {
    if (!this.ready) {
      return fail(E.disconnected, `浏览器扩展未连接。请在 chrome://extensions 加载已解压扩展：${EXT_DIR}`)
    }
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT
    // 连接在途中断开（新浏览器接入 / 扩展重载）时，自动换一个连接重试一次。
    // 不重试的话用户会看到偶发的 extension_disconnected。
    const run = async () => {
      // 显式指定了 connId 就别重试 —— 用户要的就是那条连接，换一条会答非所问。
      const explicit = opts.connId !== undefined && opts.connId !== null
      const first = await this._send(cmd, params, timeoutMs, opts.brand, opts.connId, null)
      if (first && first.ok) return first

      // 什么情况值得换连接重试：
      //  - disconnected：连接断了
      //  - timeout：多了一条 NativeHost 转发路径后，sticky primary 可能指向
      //    "宿主还活着但那头的扩展已断" 的通道，表现就是一路超时。
      const worthRetry = first && (first.error === E.disconnected || first.error === E.timeout)
      if (!worthRetry || explicit) return first

      const dead = first.deadSock || (first.error === E.timeout ? this.primary : null)
      if (this.primary && this.primary.readyState !== 1) this.primary = null
      // 超时的情况把当前 primary 也跳过，否则重试还是撞同一个
      const retry = await this._send(cmd, params, timeoutMs, opts.brand, opts.connId, dead)
      if (retry && retry.ok) {
        this.log.warn(`[session-bridge] ${cmd} 首次失败(${first.error})，已换连接重试成功`)
      }
      return retry
    }
    const p = this.queue.then(run, run)
    this.queue = p.then(() => undefined, () => undefined)
    return p
  }

  /** 挑一个声明支持该命令的连接。多实例混连（旧版扩展残留在别的浏览器/profile）
   *  时，绝不要把 group.* 发给只支持 tabs.list 的旧实例 —— 那会静默失败。
   *  都没有声明过 capabilities（老扩展）才退回 primary。 */
  /** 稳定地挑一个连接。
   *
   * 关键：多个扩展同时连着时（两个 Chrome profile / 两个窗口），
   * 绝不能在它们之间来回跳 —— 那会导致「这次命令发给 A、下次发给 B」，
   * 表现为分组/标签页状态来回横跳（用户看到的"滞后"）。
   *
   * 策略：
   *  1. 显式指定 brand → 只在该品牌里挑
   *  2. 显式指定 connId → 精确命中
   *  3. 否则用 sticky primary：一旦选定就固定，只有它断了才换
   *  4. 所有候选都必须声明支持该命令
   */
  socketFor(cmd, brand, connId, skip) {
    const all = [...this.sockets].filter((s) => s.readyState === 1 && s.dshHelloAt && s !== skip)
    // 优先真实浏览器；中继通道（NativeHost）只做兜底 ——
    // 只有当没有任何真实浏览器能处理这条命令时才用它。
    const real = all.filter((s) => !this._isRelay(s))
    const live = real.length > 0 ? real : all
    if (live.length === 0) return null

    const capable = live.filter((s) => {
      if (!s.dshCaps || s.dshCaps.size === 0) return true   // 老扩展没有 capabilities，别一棍子打死
      return s.dshCaps.has(cmd)
    })
    if (capable.length === 0) return null

    // 1) 指定连接 id
    if (connId !== undefined && connId !== null) {
      const want = String(connId)
      const hit = capable.find((s) => s.dshConnId === want)
      if (hit) return hit
      // 精确没中，允许按前缀匹配（pid 变了的旧 connId、或多窗口追加后缀时有用）。
      // 只有唯一命中才认，避免歧义。
      const prefix = capable.filter((s) => String(s.dshConnId || '').startsWith(want))
      if (prefix.length === 1) return prefix[0]
      // 记下失败原因，让 _send 报准确的错，而不是"不支持命令"
      this._lastRouteMiss = {
        connId: want,
        reason: hit ? 'ok' : (prefix.length > 1 ? 'ambiguous' : 'unknown_conn'),
        known: capable.map((s) => s.dshConnId),
        candidates: prefix.length,
      }
      return null
    }

    // 2) 指定品牌（兼容 qq / qqbrowser / chrome 等写法）
    if (brand) {
      const raw = String(brand).toLowerCase()
      const want = raw === 'qq' ? 'qqbrowser' : raw
      const same = capable.filter((s) => String(s.dshBrand || '').toLowerCase() === want)
      if (same.length === 0) return null
      // sticky：如果当前 primary 就在同品牌里且还没断，继续用它
      if (this.primary && same.includes(this.primary)) return this.primary
      this.primary = same[0]
      return this.primary
    }

    // 3) 没指定：sticky primary
    if (this.primary && this.primary.readyState === 1 && capable.includes(this.primary)) {
      return this.primary
    }
    this.primary = capable[0]
    return this.primary
  }

  _send(cmd, params, timeoutMs, brand, connId, skipSock) {
    // ── 优先按 tabId 归属路由 ──
    // 只要命令带 tabId 且我们知道它属于哪个连接，就直接发给那个连接。
    // 这样即使同时连着 Chrome / QQ浏览器 / Edge / 任何新浏览器，
    // 也不会把命令发错——不需要用户指定品牌，也不需要关掉其他扩展。
    let sock = null
    // 被标记跳过的连接（上一轮刚断的那个）不再选
    const tid = params && (params.tabId !== undefined ? params.tabId : (Array.isArray(params.tabIds) ? params.tabIds[0] : undefined))
    if (tid !== undefined && tid !== null && !brand && connId === undefined) {
      const owner = this.tabOwner.get(Number(tid))
      if (owner && owner !== skipSock && owner.readyState === 1 && owner.dshHelloAt) {
        if (!owner.dshCaps || owner.dshCaps.size === 0 || owner.dshCaps.has(cmd)) sock = owner
      }
    }
    if (!sock) sock = this.socketFor(cmd, brand, connId, skipSock)
    if (!sock) {
      const live = [...this.sockets].filter((s) => s.readyState === 1 && s.dshHelloAt)
      const miss = this._lastRouteMiss
      this._lastRouteMiss = null

      if (live.length === 0) return Promise.resolve(fail(E.disconnected, '浏览器扩展已断开'))

      // ── 区分三种失败，别一律说"不支持命令" ──
      if (connId !== undefined && connId !== null && miss && miss.reason === 'unknown_conn') {
        const known = (miss.known || []).join(', ') || '(无)'
        return Promise.resolve(fail(E.badArgs,
          `找不到 connId=${connId} 的连接。现有连接: ${known}。` +
          '（connId 里的 pid 会随 native host 重启变化，改用 brand 或先调 browser_status 看当前列表）'))
      }
      if (connId !== undefined && connId !== null && miss && miss.reason === 'ambiguous') {
        return Promise.resolve(fail(E.badArgs,
          `connId=${connId} 命中 ${miss.candidates} 条连接，无法唯一确定。请给完整 connId。现有: ${(miss.known || []).join(', ')}`))
      }

      // 有连接但没一个支持这条命令 → 明确告知，而不是超时
      const vers = live.map((s) => `${s.dshConnId || s.dshBrand || '?'}(${s.dshCaps ? s.dshCaps.size : 0})`).join(',')
      const anyHas = live.some((s) => s.dshCaps && s.dshCaps.has(cmd))
      if (anyHas) {
        // 有连接声明支持，但 unavailable（可能在别的 brand 下被过滤掉了）
        return Promise.resolve(fail(E.disconnected,
          `命令 ${cmd} 有连接支持，但当前路由条件（brand=${brand || 'any'}）下没有可用目标。连接: [${vers}]`))
      }
      return Promise.resolve(fail(E.ext,
        `当前所有连接都不支持命令 ${cmd}：扩展可能还是旧版，去 chrome://extensions 刷新。连接数=${live.length} [${vers}]`))
    }
    const id = ++this.seq
    return new Promise((resolveP) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          resolveP(fail(E.timeout, `命令 ${cmd} 超过 ${timeoutMs}ms 没有响应`))
        }
      }, timeoutMs + 500)
      this.pending.set(id, { resolve: resolveP, timer, sock, cmd })
      try {
        sock.send(JSON.stringify({ id, cmd, params: params || {}, timeoutMs }) + '\n')
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolveP(fail(E.disconnected, String((e && e.message) || e)))
      }
    })
  }
}

/* ── 工具定义 ───────────────────────────────────────────────────────── */

const OUT_OBJECT = { type: 'object', additionalProperties: true }

const WHEN = '什么时候用：需要**操作网页**（点击、填表、登录后翻页、抓需要登录态的内容），或要复用用户浏览器里已登录的会话时用它。只读取一个公开网页的文本内容用 web_fetch 更省。'

/** 自动归组：DSH 碰过的标签页会顺手收进「大肥鱼」分组。
 *  归组只是顺带的整理动作，任何异常都吞掉，绝不让它影响主操作的结果。 */
const GROUP_TITLE = '大肥鱼'
const GROUP_COLOR = 'cyan'
const groupTouched = new Set()   // 同一 tab 只归一次，省消息往返

let lastGroupError = null

async function autoGroup(bridge, tabId) {
  if (tabId === undefined || tabId === null) return null
  if (groupTouched.has(tabId)) return null
  try {
    const r = await bridge.request('group.ensure', {
      tabId, title: GROUP_TITLE, color: GROUP_COLOR,
    }, { timeoutMs: 8000 })
    if (r && r.ok) { groupTouched.add(tabId); lastGroupError = null; return r }
    lastGroupError = (r && (r.message || r.error)) || 'unknown'
  } catch (e) {
    lastGroupError = String((e && e.message) || e)
  }
  // 归组失败不打断主流程，但把原因留在 bridge 上，让 browser_status 能看到
  bridge.lastGroupError = lastGroupError
  return null
}

/* ── 运行时桥代理 ──────────────────────────────────────────────────
 *
 * 工具注册时，cordis 会把第二参数 `bridge` 固定成那一刻的实例。
 * 热重载会 new 一个新的 Bridge，但已注册工具的闭包里仍是旧的 ——
 * 于是 browser_status 永远读到"已停止的旧实例"，显示 extensions: 0，
 * 而扩展其实好端端连着新实例。
 *
 * 解法：注册时不给真实例，给一个代理。每次访问都从 globalThis 取当前的那个。
 * 这样无论重载多少次，工具永远打在活着的桥身上。
 */
function liveBridge(fallback) {
  const get = () => {
    const cur = globalThis.__dshBrowserBridge
    return (cur && typeof cur.status === 'function') ? cur : fallback
  }
  // 只代理 Bridge 上真正会被工具用到的方法/字段
  return new Proxy({}, {
    get(_t, prop) {
      const target = get()
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
    set(_t, prop, value) {
      get()[prop] = value
      return true
    },
    has(_t, prop) { return prop in get() },
  })
}

/** 本次 apply 注册过的工具 disposer（重载前逐个调用，避免工具重复/残留）。 */
const registeredToolDisposers = []

/** 注销本代注册的所有工具。browser_reload 会先调它。 */
function disposeRegisteredTools() {
  while (registeredToolDisposers.length > 0) {
    const d = registeredToolDisposers.pop()
    try { if (typeof d === 'function') d() } catch { /* ignore */ }
  }
}

const TOOL_SPECS = [
  {
    name: 'browser_status',
    description: `查询浏览器操控桥的状态：WS 端口、已连接的扩展数、扩展版本、是否可用、扩展目录绝对路径。扩展没连上、或浏览器类工具报 extension_disconnected 时，先调这个确认。${WHEN}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async run(_args, bridge) {
      const st = bridge.status()   // status() 里已含 codeFresh
      st.canSelfReload = typeof globalThis.__dshBrowserBridgeRestart === 'function'
      return st
    },
  },
  {
    name: 'browser_reload',
    description: `热重载浏览器插件本身（不重启 DSH）。改过 index.js 后调用它就能让改动生效。返回 ok=false 说明当前 cordis 版本不支持 fiber.restart，只能重启 DSH。${WHEN}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async run(_args, bridge) {
      const before = bridge.status()
      const fresh = bridge.codeFresh ? bridge.codeFresh() : null

      // ── 真正的热重载 ──
      // 入口（index.js）用 import(`./impl.js?t=<mtime>`) 加载实现，
      // 所以只要换一个 query 就是全新模块 —— TOOL_SPECS 会重新求值，
      // 新加的工具能立刻出现，不需要重启 DSH。
      const reloadImpl = globalThis.__dshBrowserBridgeReloadImpl
      if (typeof reloadImpl !== 'function') {
        return {
          ok: false,
          error: '入口没有暴露重载能力（index.js 可能是旧版）。需要重启 DSH 一次。',
          codeFresh: fresh,
        }
      }

      // 先注销本代工具，避免新实现注册时名字冲突／残留旧定义
      let disposed = 0
      try { disposed = registeredToolDisposers.length } catch { /* ignore */ }
      disposeRegisteredTools()

      let r
      try {
        r = await reloadImpl()
      } catch (e) {
        return {
          ok: false,
          error: String((e && e.message) || e),
          stack: String((e && e.stack) || '').split('\n').slice(0, 6).join(' | '),
          codeFresh: fresh,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))

      const after = globalThis.__dshBrowserBridge ? globalThis.__dshBrowserBridge.status() : null
      return {
        ...r,
        disposedTools: disposed,
        connectionsBefore: before.extensions,
        connectionsAfter: after ? after.extensions : null,
        note: '实现已重新加载（impl.js 用 mtime 破缓存）。新工具应当已可用。',
      }
    },
  },

  {
    name: 'browser_windows',
    description: `列出所有浏览器（Chrome / QQ浏览器 / Edge …）的窗口：窗口 id、品牌、标签数、当前标题、是否前台。多个浏览器同时连着、或一个浏览器开了多个窗口时，先用它看清楚目标，再把 windowId 传给 browser_tabs。${WHEN}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async run(_args, bridge) {
      const agg = await bridge.requestAll('windows.list', {}, 8000)
      if (!agg.ok) return agg
      // 去重：WS 和 NativeHost 通道可能各报一遍同一窗口
      const seen = new Set()
      const windows = []
      for (const r of agg.results) {
        if (r.brand === 'NativeHost') continue   // NativeHost 是转发通道，窗口信息以扩展直连为准
        const brand = r.brand || 'Unknown'
        for (const w of (r.windows || [])) {
          const key = String(w.windowId)
          if (seen.has(key)) continue
          seen.add(key)
          windows.push({ ...w, browser: w.brand || brand })
        }
      }
      return {
        ok: true,
        count: windows.length,
        browsers: [...new Set(windows.map((w) => w.browser))],
        windows,
        hint: '同一 browser 出现在多个 windowId = 该浏览器开了多个窗口。把 windowId 传给 browser_tabs 只看那个窗口。',
      }
    },
  },

  {
    name: 'browser_tabs',
    description: `列出用户当前打开的浏览器标签页（id / title / url / active / 所属窗口），用来挑目标标签页。后续 browser_snapshot / browser_click / browser_type 都可以用这里返回的 tabId；不传 tabId 时操作当前活动标签页。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        includeChrome: { type: 'boolean', description: '是否包含 chrome:// 等内部页（默认 true，仅列不操作）' },
        windowId: { type: 'number', description: '只看这个窗口的标签（从 browser_windows 拿）。省略=看全部' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      // 合并**所有**已连浏览器的标签：用户开了 Chrome + QQ浏览器，
      // 就该一次看到全部，而不是随机某一个。每条带 browser 标签便于区分。
      const agg = await bridge.requestAll('tabs.list', { includeChrome: args.includeChrome !== false }, 8000)
      if (!agg.ok) return agg
      const tabs = []
      for (const r of agg.results) {
        const brand = (r.brand || 'Unknown')
        for (const t of (Array.isArray(r.tabs) ? r.tabs : [])) {
          tabs.push({ ...t, browser: brand })
        }
      }
      // 同一 tab 多连接重复上报时去重（按 tabId）
      const seen = new Set()
      let uniq = tabs.filter((t) => {
        if (seen.has(t.id)) return false
        seen.add(t.id)
        return true
      })
      if (typeof args.windowId === 'number') {
        uniq = uniq.filter((t) => t.windowId === args.windowId)
      }
      return {
        ok: true,
        count: uniq.length,
        browsers: agg.results.map((r) => r.brand || 'Unknown'),
        activeTabId: (uniq.find((t) => t.active) || {}).id ?? null,
        tabs: uniq,
        hint: '每条带 browser 字段标明来自哪个浏览器。把 tabId 传给其他工具即可精确操作该页，路由会自动找对浏览器。',
      }
    },
  },
  {
    name: 'browser_snapshot',
    description: `取某个标签页的**可交互元素快照**：每个元素拿到一个短 ref（如 e12）以及 role / name / value / bounds，可在 browser_click / browser_type 里直接用 ref 指定目标，不用算坐标。传 text=true 只取页面可视文本（省 token，适合"读内容"）。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id，来自 browser_tabs；省略则用当前活动标签页' },
        text: { type: 'boolean', description: 'true 时主要返回页面可视文本（仍附带元素清单的前若干条）' },
        maxElements: { type: 'number', description: '元素上限，默认 120，最大 400' },
        selector: { type: 'string', description: '只看某个容器内的元素，CSS 选择器，如 "#login-form"' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      const r = await bridge.request('tab.snapshot', {
        tabId: args.tabId,
        text: args.text === true,
        maxElements: clampInt(args.maxElements, 120, 1, 400),
        selector: args.selector,
      }, { timeoutMs: 45000 })
      if (r && r.ok) await autoGroup(bridge, r.tabId)
      return r
    },
  },
  {
    name: 'browser_click',
    description: `点击元素。优先用 ref（来自 browser_snapshot，如 "e12"）；没有 ref 时可退化为视口坐标 x/y（CSS 像素，document.elementFromPoint 命中后派发真实事件序列）。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id；省略则用当前活动标签页' },
        ref: { type: 'string', description: '元素 ref，如 e12' },
        x: { type: 'number', description: '视口坐标 X（CSS px），ref 缺失时使用' },
        y: { type: 'number', description: '视口坐标 Y（CSS px），ref 缺失时使用' },
        double: { type: 'boolean', description: '双击' },
        snapshot: { type: 'boolean', description: '点击后是否返回新快照，默认 true' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      if (!args.ref && (args.x == null || args.y == null)) {
        return fail(E.badArgs, '需要 ref，或者同时给 x 和 y')
      }
      const r = await bridge.request('tab.click', {
        tabId: args.tabId,
        mode: args.mode || 'dom',
        ref: args.ref,
        x: args.x,
        y: args.y,
        double: args.double === true,
        snapshot: args.snapshot !== false,
      }, { timeoutMs: 20000 })
      if (r && r.ok) await autoGroup(bridge, r.tabId ?? args.tabId)
      return r
    },
  },
  {
    name: 'browser_type',
    description: `往输入框 / textarea / contenteditable 里输入文本。用 ref 指定元素（来自 browser_snapshot）。clear=true 先清空；submit=true 输入后按回车（会尝试提交表单）并返回新快照。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id；省略则用当前活动标签页' },
        ref: { type: 'string', description: '元素 ref，如 e12' },
        text: { type: 'string', description: '要输入的文本' },
        clear: { type: 'boolean', description: '输入前是否清空原值，默认 true' },
        submit: { type: 'boolean', description: '输入后按回车提交，默认 false' },
        snapshot: { type: 'boolean', description: '提交后是否返回新快照，默认与 submit 一致' },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      const r = await bridge.request('tab.type', {
        tabId: args.tabId,
        ref: args.ref,
        text: String(args.text == null ? '' : args.text),
        clear: args.clear !== false,
        submit: args.submit === true,
        snapshot: args.snapshot === undefined ? args.submit === true : args.snapshot === true,
      }, { timeoutMs: 25000 })
      if (r && r.ok) await autoGroup(bridge, r.tabId ?? args.tabId)
      return r
    },
  },
  {
    name: 'browser_key',
    description: `按键：单键或组合键。支持 Enter / Escape / Tab / Backspace / ArrowUp / F5 等，也支持 "Control+a"、"Shift+Tab"、"Control+Shift+Enter" 这类组合。不给 ref 就发到当前焦点元素。用于提交表单、关闭弹窗、全选后覆盖输入。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        key: { type: 'string', description: '键名或组合，如 "Enter" / "Escape" / "Control+a"' },
        mode: { type: 'string', enum: ['dom', 'cdp'], description: 'dom（默认，合成事件）或 cdp（真实按键，能触发 Google 搜索框这类只认 isTrusted 的站点）' },
        ref: { type: 'string', description: '发给哪个元素（省略=当前焦点）' },
        snapshot: { type: 'boolean', description: '按键后是否附带快照，默认 false' },
      },
      required: ['key'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.key', {
        tabId: args.tabId, key: args.key, ref: args.ref,
        mode: args.mode || 'dom',
        snapshot: args.snapshot === true,
      }, { timeoutMs: 25000 })
    },
  },

  {
    name: 'browser_scroll',
    description: `滚动页面。虚拟滚动列表（Gmail / Twitter / 长表格）里靠后的元素必须靠它进入视口，否则 snapshot 拿不到。mode: by（按屏/像素滚，默认）/ to（滚到 ref 元素）/ top / bottom。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        mode: { type: 'string', enum: ['by', 'to', 'top', 'bottom'], description: '滚动模式，默认 by' },
        direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], description: '方向，默认 down' },
        amount: { type: 'number', description: '滚几屏（mode=by），默认 1' },
        pixels: { type: 'number', description: '滚多少像素（优先于 amount）' },
        ref: { type: 'string', description: 'mode=to 时要滚到的元素 ref' },
        snapshot: { type: 'boolean', description: '滚完是否附带快照，默认 false' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.scroll', {
        tabId: args.tabId, mode: args.mode, direction: args.direction,
        amount: args.amount, pixels: args.pixels, ref: args.ref,
        snapshot: args.snapshot === true,
      }, { timeoutMs: 30000 })
    },
  },

  {
    name: 'browser_batch',
    description: `一次执行多个动作，只回一次结果。**最快的批量方式**：中间动作不产生往返，最后统一取一次快照。适合"点输入框→打字→回车→看结果"这类固定序列。
actions 每项：{ op: 'click'|'type'|'key'|'scroll'|'wait'|'navigate'|'snapshot', ...对应单命令参数 }。
例：[{op:'click',ref:'e5'},{op:'type',ref:'e7',text:'hello'},{op:'key',key:'Enter',waitAfter:800}]。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        actions: { type: 'array', description: '动作数组，最多 50 条', items: { type: 'object', additionalProperties: true } },
        snapshot: { type: 'boolean', description: '最后是否取快照，默认 true' },
        maxElements: { type: 'number', description: '最后快照的元素上限，默认 80' },
        continueOnError: { type: 'boolean', description: '出错后继续，默认 false' },
      },
      required: ['actions'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.batch', {
        tabId: args.tabId,
        actions: args.actions,
        snapshot: args.snapshot !== false,
        maxElements: args.maxElements,
        continueOnError: args.continueOnError === true,
      }, { timeoutMs: 90000 })
    },
  },

  {
    name: 'browser_eval',
    description: `在页面里执行一段 JS 表达式并拿到返回值。DOM 操作够不到时的逃生口：读页面自己的状态、调用页面内置 API、触发前端路由跳转（导航历史必须用它，chrome.tabs.update 对同页不同 query 不产生历史）。**谨慎使用**：会执行任意代码。返回值自动 JSON 化，超 2 万字符截断。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        expr: { type: 'string', description: 'JS 表达式或语句，支持 await。例：location.href 或 document.title' },
      },
      required: ['expr'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.evaluate', {
        tabId: args.tabId, expr: String(args.expr || ''),
      }, { timeoutMs: 25000 })
    },
  },

  {
    name: 'browser_drag',
    description: `拖拽（CDP 真实鼠标按下→移动→释放）。用于拖拽排序、滑块验证、可视化编辑器。from/to 可以是 ref 或视口坐标。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        fromRef: { type: 'string', description: '起点元素 ref' },
        fromX: { type: 'number', description: '起点视口 X（无 fromRef 时用）' },
        fromY: { type: 'number', description: '起点视口 Y' },
        toRef: { type: 'string', description: '终点元素 ref' },
        toX: { type: 'number', description: '终点视口 X（无 toRef 时用）' },
        toY: { type: 'number', description: '终点视口 Y' },
        steps: { type: 'number', description: '中间移动步数，默认 10（越大越平滑）' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.drag', {
        tabId: args.tabId,
        fromRef: args.fromRef, fromX: args.fromX, fromY: args.fromY,
        toRef: args.toRef, toX: args.toX, toY: args.toY,
        steps: args.steps,
      }, { timeoutMs: 30000 })
    },
  },

  {
    name: 'browser_mouse',
    description: `鼠标动作：move（移动）/ wheel（滚轮，CDP 真实滚动事件，和 browser_scroll 的 DOM 滚动互补）。x/y 是视口坐标。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        action: { type: 'string', enum: ['move', 'wheel'], description: '动作，默认 wheel' },
        x: { type: 'number', description: '视口 X' },
        y: { type: 'number', description: '视口 Y' },
        deltaX: { type: 'number', description: '横向滚动量（wheel）' },
        deltaY: { type: 'number', description: '纵向滚动量（wheel，负=向上）' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('tab.mouse', {
        tabId: args.tabId, action: args.action || 'wheel',
        x: args.x, y: args.y, deltaX: args.deltaX, deltaY: args.deltaY,
      }, { timeoutMs: 25000 })
    },
  },

  {
    name: 'browser_lease',
    description: `租约：给"这一轮操作新开的标签页/分组"设一个到期时间，到期自动关掉它们。**用户原有的标签永不触碰。**
用来避免跑完流程后标签栏堆一堆临时页。action: open（新建租约）/ renew（续期）/ attach（把 tab/group 挂上去）/ release（立即释放并清理）/ list（看现有租约）。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'renew', 'attach', 'release', 'list'], description: '动作' },
        leaseId: { type: 'string', description: 'open 后拿到的 id' },
        ttlMs: { type: 'number', description: '租约时长（毫秒），默认 10 分钟，范围 5 秒~1 小时' },
        tabIds: { type: 'array', items: { type: 'number' }, description: 'attach 时要挂上的标签' },
        groupIds: { type: 'array', items: { type: 'number' }, description: 'attach 时要挂上的分组' },
        keepTabs: { type: 'boolean', description: 'release 时保留标签（只释放记录）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      const a = String(args.action || '')
      const map = {
        open: 'lease.open', renew: 'lease.renew', attach: 'lease.attach',
        release: 'lease.release', list: 'lease.list',
      }
      const cmd = map[a]
      if (!cmd) return { ok: false, error: 'bad_args', message: `未知 action: ${a}` }
      return bridge.request(cmd, {
        leaseId: args.leaseId, ttlMs: args.ttlMs,
        tabIds: args.tabIds, groupIds: args.groupIds, keepTabs: args.keepTabs === true,
      }, { timeoutMs: 30000 })
    },
  },

  {
    name: 'browser_conn',
    description: `管理桥上的连接。多浏览器/多 profile 时会连上多条，出现"旧的连接一直挂着""某个 connId 已经失效"时用它清理。
action: list（列全部连接）/ close（关掉一个 connId）/ drop-native（让所有 native host 退出并重连）/ reap（立即清孤儿连接）。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'close', 'drop-native', 'reap'], description: '动作' },
        connId: { type: 'string', description: 'close 时要关掉的连接 id' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      const a = String(args.action || 'list')
      if (a === 'list') {
        const st = bridge.status()
        return { ok: true, count: (st.connections || []).length, connections: st.connections }
      }
      if (a === 'close') {
        if (!args.connId) return { ok: false, error: 'bad_args', message: 'close 需要 connId' }
        return bridge.closeConn(args.connId)
      }
      if (a === 'drop-native') {
        return bridge.dropNativeHosts('manual')
      }
      if (a === 'reap') {
        return { ok: true, killed: bridge.reapOrphanSockets(0) }
      }
      return { ok: false, error: 'bad_args', message: `未知 action: ${a}` }
    },
  },

  {
    name: 'browser_navigate',
    description: `在用户浏览器里打开一个 URL。newTab=true 新建标签页（默认），否则复用指定 tabId 的标签页；导航完成后返回页面快照（title / url / 元素）。**默认后台打开，不切换你的当前标签页、不抢焦点**（要前台就给 active=true）。复用已登录会话时用它替代 web_fetch。

新开的标签会登记到隐式租约，**默认 10 分钟后自动关闭**，避免标签越堆越多占内存；想长期留着这一页就传 keepAlive=true，或用 leaseTtlMs 调整时长（1 分钟~1 小时）。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整 URL，必须带 scheme，如 https://example.com（用 back/forward/reload 时可不填）' },
        back: { type: 'boolean', description: '后退一页' },
        forward: { type: 'boolean', description: '前进一页' },
        reload: { type: 'boolean', description: '刷新当前页' },
        bypassCache: { type: 'boolean', description: 'reload 时绕过缓存' },
        tabId: { type: 'number', description: '复用这个标签页；省略且 newTab=false 时用当前活动标签页' },
        newTab: { type: 'boolean', description: '是否新开标签页，默认 true' },
        active: { type: 'boolean', description: '新标签页是否切到前台。默认 false（后台打开，不动你的焦点）' },
        waitMs: { type: 'number', description: '导航后额外等待毫秒数（等前端渲染），默认 600' },
        keepAlive: {
          type: 'boolean',
          description: '是否长期保留这个标签页。默认 false —— 插件新开的标签会登记到隐式租约，'
            + '到期（默认 10 分钟）自动关闭，避免越堆越多占内存。想留着就传 true。',
        },
        leaseTtlMs: {
          type: 'number',
          description: '隐式租约时长（毫秒），默认 600000（10 分钟），范围 1 分钟~1 小时',
        },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      // ── 导航历史：不需要 url ──
      if (args.back === true || args.forward === true || args.reload === true) {
        const r = await bridge.request('tab.navigate', {
          tabId: args.tabId,
          back: args.back === true,
          forward: args.forward === true,
          reload: args.reload === true,
          bypassCache: args.bypassCache === true,
          waitMs: clampInt(args.waitMs, 600, 0, 10000),
          maxElements: args.maxElements,
        }, { timeoutMs: 40000 })
        if (r && r.ok) await autoGroup(bridge, r.tabId ?? args.tabId)
        return r
      }

      const url = String(args.url || '').trim()
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        return fail(E.badArgs, `url 需要带 scheme（如 https://example.com），收到：${url}（或用 back/forward/reload）`)
      }
      const r = await bridge.request('tab.navigate', {
        url,
        tabId: args.tabId,
        newTab: args.newTab !== false,
        active: args.active === true,
        waitMs: clampInt(args.waitMs, 600, 0, 10000),
        // 新开的标签默认纳入隐式租约，到期自动关，避免越堆越多。
        // keepAlive=true 豁免；leaseTtlMs 可调时长（1 分钟~1 小时）。
        keepAlive: args.keepAlive === true,
        leaseTtlMs: clampInt(args.leaseTtlMs, 600000, 60000, 3600000),
      }, { timeoutMs: 40000 })
      if (r && r.ok) await autoGroup(bridge, r.tabId ?? args.tabId)
      return r
    },
  },
  {
    name: 'browser_screenshot',
    description: `给标签页截图并作为图片回传（模型能直接看到）。看页面布局、验证点击结果、读图表/验证码时用。

**默认在后台截图，不切换标签页、不动你的焦点**（走 CDP Page.captureScreenshot）。
只有 CDP 不可用时才会考察 keepForeground：false（默认）时宁可报 capture_unavailable 也不切前台。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id；省略则用当前活动标签页' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式，默认 png' },
        quality: { type: 'number', description: 'jpeg 质量 1-100，默认 80' },
        keepForeground: { type: 'boolean', description: 'CDP 截图失败时是否允许把标签页切到前台再截。默认 false（不抢焦点）' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge, ctx) {
      const r = await bridge.request('tab.screenshot', {
        tabId: args.tabId,
        format: args.format === 'jpeg' ? 'jpeg' : 'png',
        quality: clampInt(args.quality, 80, 1, 100),
        keepForeground: args.keepForeground === true,
      }, { timeoutMs: 30000 })
      if (!r.ok) return r
      await autoGroup(bridge, r.tabId ?? args.tabId)
      return attachImage(ctx, r)
    },
  },
  {
    name: 'browser_close_tabs',
    description: `关掉一个或多个标签页。只关你明确点名的 id，不动其它页面。传 tabIds 批量，或 tabId 单个。返回实际关掉了哪些（含标题）以及哪些 id 本来就不存在。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '单个标签页 id' },
        tabIds: { type: 'array', items: { type: 'number' }, description: '批量，与 tabId 二选一' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      const ids = Array.isArray(args.tabIds) ? args.tabIds : (typeof args.tabId === 'number' ? [args.tabId] : [])
      if (ids.length === 0) return fail(E.badArgs, '需要 tabId 或 tabIds')
      return bridge.request('tab.close', { tabId: args.tabId, tabIds: args.tabIds }, { timeoutMs: 15000 })
    },
  },

  {
    name: 'browser_theme',
    description: `控制扩展图标主题。mode=auto 跟随系统深浅色（默认，白天蓝鲸 / 夜里纯黑）；light 强制蓝色；dark 强制黑色。系统切换时扩展会自己换，一般不用手动调。`,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['auto', 'light', 'dark'], description: '默认 auto' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('theme.icon', { mode: args.mode || 'auto' }, { timeoutMs: 8000 })
    },
  },

  /* ── 标签分组：把操作过的页面归到「大肥鱼」组 ───────────────────── */

  {
    name: 'browser_group_ensure',
    description: `把标签页收进 Chrome 标签分组（tab group），组名默认「大肥鱼」：已有同名同色的组就复用，没有就新建再搬进去。**默认折叠**，不占标签栏位置；想看就传 collapsed: false 展开。DSH 每操作一个页面都会自动调用它，于是标签栏上能一眼看出"这些页面正在被它摆弄"。支持 tabIds 批量。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '单个标签页 id' },
        tabIds: { type: 'array', items: { type: 'number' }, description: '批量，与 tabId 二选一' },
        title: { type: 'string', description: '分组名称，省略时用默认「大肥鱼」' },
        color: { type: 'string', description: '分组颜色：grey / blue / red / yellow / green / pink / purple / cyan / orange，默认 cyan' },
        collapsed: { type: 'boolean', description: '是否折叠分组。默认 true（折叠、省标签栏空间）；传 false 才展开' },
      },
      required: [],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('group.ensure', {
        tabId: args.tabId,
        tabIds: args.tabIds,
        title: args.title || '大肥鱼',
        color: args.color || 'cyan',
        collapsed: args.collapsed !== false,
      }, { timeoutMs: 12000 })
    },
  },

  {
    name: 'browser_group_assign',
    description: `把单个标签页放进指定分组；groupId 传 -1 表示移出分组、恢复独立标签。不给 groupId 时会自动寻找或新建「大肥鱼」组。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: '标签页 id' },
        groupId: { type: 'number', description: '目标分组 id；-1 表示移出分组' },
        title: { type: 'string', description: '不传 groupId 时新建分组用的名称，默认「大肥鱼」' },
        color: { type: 'string', description: '新建分组时的颜色，默认 cyan' },
      },
      required: ['tabId'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('group.assign', {
        tabId: args.tabId,
        groupId: args.groupId,
        title: args.title || '大肥鱼',
        color: args.color || 'cyan',
      }, { timeoutMs: 12000 })
    },
  },

  {
    name: 'browser_group_list',
    description: `列出浏览器当前所有标签分组：组名、颜色、折叠状态，以及组内每个标签页。想确认「大肥鱼」组里眼下收着哪些页面就用它。${WHEN}`,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async run(_args, bridge) {
      const agg = await bridge.requestAll('group.list', {}, 10000)
      if (!agg.ok) return agg
      // 去重：NativeHost 是转发通道，会把同一批分组再报一遍。
      // 只信扩展直连的结果，并按 groupId 去重（同一浏览器多 profile 时 groupId 也不同）。
      const seen = new Set()
      const groups = []
      for (const r of agg.results) {
        if (r.brand === 'NativeHost') continue
        const brand = r.brand || 'Unknown'
        for (const g of (Array.isArray(r.groups) ? r.groups : [])) {
          const key = `${brand}:${g.groupId}`
          if (seen.has(key)) continue
          seen.add(key)
          groups.push({ ...g, browser: brand })
        }
      }
      return {
        ok: true,
        count: groups.length,
        browsers: [...new Set(agg.results.filter((r) => r.brand !== 'NativeHost').map((r) => r.brand || 'Unknown'))],
        groups,
      }
    },
  },

  {
    name: 'browser_group_update',
    description: `改一个分组的名字 / 颜色 / 折叠状态。想把组名改成别的（比如带任务标识）就用它。${WHEN}`,
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: '分组 id（从 browser_group_list 拿）' },
        title: { type: 'string', description: '新组名' },
        color: { type: 'string', description: '新颜色' },
        collapsed: { type: 'boolean', description: 'true 折叠 / false 展开' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('group.update', {
        groupId: args.groupId, title: args.title, color: args.color, collapsed: args.collapsed,
      }, { timeoutMs: 10000 })
    },
  },

  {
    name: 'browser_group_close',
    description: `关掉整个标签分组的全部页面。任务收尾时清场用，别拿它清用户自己的组。${WHEN}`,
    parameters: {
      type: 'object',
      properties: { groupId: { type: 'number', description: '分组 id' } },
      required: ['groupId'],
      additionalProperties: false,
    },
    async run(args, bridge) {
      return bridge.request('group.close', { groupId: args.groupId }, { timeoutMs: 15000 })
    },
  },

]

function clampInt(v, dflt, min, max) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, Math.round(n)))
}

/* ── 截图 → 附件（图片块）───────────────────────────────────────────── */

function parseDataUrl(u) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(u || ''))
  if (!m) return null
  const mediaType = m[1]
  const isB64 = Boolean(m[2])
  const body = m[3]
  const bytes = isB64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'binary')
  return { mediaType, bytes }
}

async function attachImage(ctx, r) {
  const parsed = parseDataUrl(r.dataUrl)
  if (!parsed) {
    return fail(E.ext, '扩展没有返回可解码的截图 data URL', { result: { tabId: r.tabId } })
  }
  const mediaType = parsed.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  const base = {
    ok: true,
    tabId: r.tabId ?? null,
    title: r.title || '',
    url: r.url || '',
    bytes: parsed.bytes.byteLength,
    mediaType,
  }
  let attachments = null
  try { attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : null } catch { attachments = null }
  if (attachments && typeof attachments.saveImage === 'function') {
    try {
      const ref = await attachments.saveImage({ data: new Uint8Array(parsed.bytes), mediaType, name: `browser-shot-${Date.now()}.${mediaType === 'image/png' ? 'png' : 'jpg'}` })
      return {
        ...base,
        stored: 'attachment',
        image: {
          attachmentId: String(ref.attachmentId),
          mediaType: ref.mediaType || mediaType,
          bytes: Number(ref.bytes) || parsed.bytes.byteLength,
          width: Number(ref.width) || null,
          height: Number(ref.height) || null,
        },
      }
    } catch (e) {
      base.attachError = String((e && e.message) || e)
    }
  }
  // 兜底：落盘，把路径给模型
  try {
    const dir = join(tmpdir(), 'dsh-session-bridge')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `shot-${Date.now()}.${mediaType === 'image/png' ? 'png' : 'jpg'}`)
    writeFileSync(file, parsed.bytes)
    return { ...base, stored: 'file', path: file }
  } catch (e) {
    return fail(E.ext, `截图已拿到但落盘失败：${String((e && e.message) || e)}`, base)
  }
}

/** 渲染：有 attachment 就回图片块（下一 step 模型能看），否则文本 + 路径。 */
function renderWithImage(_args, value) {
  const head = {
    ok: value.ok !== false,
    tabId: value.tabId ?? null,
    url: value.url || '',
    title: value.title || '',
    bytes: value.bytes ?? null,
    stored: value.stored || null,
    ...(value.path ? { path: value.path } : {}),
    ...(value.error ? { error: value.error, message: value.message } : {}),
  }
  const blocks = [{ type: 'text', text: JSON.stringify(head, null, 2) }]
  if (value && value.image && value.image.attachmentId) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: value.image.attachmentId,
        mediaType: value.image.mediaType,
        bytes: value.image.bytes,
        width: value.image.width || 1,
        height: value.image.height || 1,
      },
    })
  }
  return blocks
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/* ── 注册 ───────────────────────────────────────────────────────────── */

function registerTools(ctx, bridge) {
  const disposers = []
  // 品牌路由包装：工具参数里的 browser 决定命令发给谁
  // （"chrome" / "qqbrowser" / "edge" / "auto"）。
  // 这是为了解决"扩展同时装在 Chrome 和 QQ浏览器里，命令发错人"的问题。
  const scoped = (args) => {
    const b = args && args.browser
    if (!b || String(b).toLowerCase() === 'auto') return bridge
    const brand = String(b).toLowerCase() === 'qq' ? 'qqbrowser' : String(b).toLowerCase()
    const origReq = bridge.request.bind(bridge)
    const origAll = bridge.requestAll ? bridge.requestAll.bind(bridge) : null
    return {
      status: () => bridge.status(),
      request: (cmd, params, opts = {}) => origReq(cmd, params, { ...opts, brand }),
      // ── 必须一并转发 requestAll ──
      // 某些工具（browser_tabs / browser_windows / browser_group_list）
      // 用 requestAll 合并所有浏览器。原来这个包装只给了 request，
      // 所以带 browser 参数调用就报 "bridge.requestAll is not a function"。
      requestAll: origAll
        ? (cmd, params, timeoutMs) => origAll(cmd, params, timeoutMs, brand)
        : async () => ({ ok: false, error: E.ext, message: 'requestAll 不可用' }),
      codeFresh: bridge.codeFresh ? bridge.codeFresh.bind(bridge) : undefined,
    }
  }


  if (!ctx.tools || typeof ctx.tools.register !== 'function') return
  for (const spec of TOOL_SPECS) {
    try {
      // 统一注入 browser 参数（不用逐个 spec 改）
      const params = spec.parameters && typeof spec.parameters === 'object'
        ? { ...spec.parameters, properties: { ...(spec.parameters.properties || {}) } }
        : { type: 'object', properties: {} }
      if (!params.properties.browser && spec.name !== 'browser_status') {
        params.properties.browser = {
          type: 'string',
          enum: ['auto', 'chrome', 'qqbrowser', 'edge'],
          description: '在哪个浏览器里执行。默认 auto（谁连着用谁；两个都连着时可能选错）。想锁定 Chrome 就传 chrome',
        }
      }
      const dispose = ctx.tools.register({
        name: spec.name,
        description: spec.description,
        parameters: params,
        output: {
          schema: OUT_OBJECT,
          render: spec.name === 'browser_screenshot' ? renderWithImage : renderJson,
        },
        async execute(args) {
          try {
            const a = args || {}
            const r = await spec.run(a, scoped(a), ctx)
            return r && typeof r === 'object' ? r : { ok: false, error: E.ext, message: 'empty result' }
          } catch (e) {
            return fail(E.ext, String((e && e.message) || e))
          }
        },
      })
      // 收集起来，重载时手动注销（tools.register 的 disposer 挂在 fiber 上，
      // 但动态 import 换模块不会触发 fiber 的 dispose，所以要自己管）。
      if (typeof dispose === 'function') registeredToolDisposers.push(dispose)
    } catch (e) {
      console.warn('[session-bridge] register tool failed:', spec.name, e && e.message)
    }
  }
}

function registerPrompt(ctx, bridge) {
  const section = {
    name: 'session-bridge',
    // 排在 computer-use 之后（数字大 = 更靠后）。
    // 提示词里已经写明「浏览器操作优先 browser_*」，这里靠后不影响那条指令被看到。
    order: 5400,
    content: () => [
      '## 浏览器操控（browser_* 工具）',
      '',
      `本机装了浏览器桥（ws://${HOST}:${bridge.port}）：DSH 可以操控用户**自己**的 Chrome/Edge/QQ浏览器，复用其已登录状态。`,
      '',
      '### ★ 操作浏览器只用 browser_*，不要用 cu_*',
      '',
      '凡是目标是**网页内容**（打开网站、点链接、填表单、读页面、截图网页），一律走 browser_*。',
      '理由：browser_* 走扩展注入 + CDP，不移动鼠标、不抢焦点、能直接读 DOM；',
      'cu_* 是给**非浏览器**的桌面程序（记事本、资源管理器、微信、设置面板）用的，它靠截屏+坐标点，',
      '在浏览器上既慢又容易点错，还会抢走用户正在看的窗口。',
      '',
      '判断口诀：',
      '- 目标在浏览器标签页里 → browser_*',
      '- 目标是一个独立的桌面程序窗口 → cu_*',
      '- 拿不准 → 先 browser_windows 看看目标是不是浏览器；是就用 browser_*',
      '',
      '### 标准循环',
      '',
      'browser_status 看扩展是否连上 → browser_windows 确认目标浏览器 → browser_tabs 挑标签页',
      '→ browser_snapshot 拿 ref → browser_click / browser_type 操作 → browser_screenshot 看结果。',
      '',
      '多浏览器时：browser_windows 列出所有窗口（Chrome/Edge/QQ浏览器各带自己的 windowId），',
      '把 browser 参数设成目标品牌（chrome / edge / qqbrowser），标签页路由会自动精确送达。',
      '**不要为了"专心操作一个浏览器"去关掉别的浏览器** —— 三个可以同时连着互不干扰。',
      '',
      '只读一个公开网页的正文时用 web_fetch；需要登录态、要点击填表、要看到页面渲染时才走 browser_*。',
      '',
      `扩展目录：${EXT_DIR}`,
      '桥报 extension_disconnected / available=false 时，让用户到 chrome://extensions（Edge 是 edge://extensions）打开开发者模式，点"加载已解压的扩展程序"，选上面这个目录；然后重试。',
      '桥不做坐标换算：优先用 snapshot 给的 ref；只有 ref 拿不到时才用 x/y。',
    ].join('\n'),
  }
  for (const holder of [ctx, ctx && ctx.systemPrompt && ctx.systemPrompt.ctx]) {
    try {
      if (holder && holder.systemPrompt && typeof holder.systemPrompt.section === 'function') {
        holder.systemPrompt.section(section)
        return
      }
    } catch { /* 试下一个宿主 */ }
  }
}

/* ── 插件入口 ───────────────────────────────────────────────────────── */

export function apply(ctx, config = {}) {
  const logger = (ctx && ctx.logger) || console
  const log = {
    info: (...a) => { try { (logger.info || console.log).apply(logger, a) } catch { /* ignore */ } },
    warn: (...a) => { try { (logger.warn || console.warn).apply(logger, a) } catch { /* ignore */ } },
  }
  const bridge = new Bridge(log)

  // ── 关键：先把这一代实例挂到 globalThis，再注册工具 ──
  // 工具收到的是 liveBridge 代理而不是真实例，这样热重载之后
  // 已注册的旧工具也会打到新的、活着的桥上。
  try {
    const prev = globalThis.__dshBrowserBridge
    if (prev && prev !== bridge && typeof prev.stop === 'function') prev.stop()
  } catch { /* 旧实例坏了也要继续 */ }
  globalThis.__dshBrowserBridge = bridge

  registerTools(ctx, liveBridge(bridge))
  registerPrompt(ctx, liveBridge(bridge))

  // 启动 WS（异步，失败不阻塞宿主启动）
  const port = clampInt(config && config.port, DEFAULT_PORT, 1024, 65535)
  Promise.resolve()
    .then(() => bridge.start(port))
    .catch((e) => { bridge.lastError = String((e && e.message) || e); log.warn('[session-bridge] start failed:', bridge.lastError) })

  if (ctx && typeof ctx.effect === 'function') {
    try { ctx.effect(() => () => bridge.stop()) } catch { /* ignore */ }
  }
  if (ctx && typeof ctx.on === 'function') {
    try { ctx.on('dispose', () => bridge.stop()) } catch { /* ignore */ }
  }

  // globalThis 接管已在上面 registerTools 之前完成

  // ── 自热重载 ──
  // cordis 的 fiber.restart() 会 dispose 再重新 apply，等于"只重启这个插件"。
  // 改完 index.js 调一次就生效，不用重启整个 DSH。
  // 不同 cordis 版本字段名不同，都试一遍。
  const fiber = ctx && (ctx.fiber || (ctx.scope && ctx.scope.fiber) || ctx)
  if (fiber && typeof fiber.restart === 'function') {
    globalThis.__dshBrowserBridgeRestart = async () => {
      try {
        await fiber.restart()
        return { ok: true }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }
  } else {
    globalThis.__dshBrowserBridgeRestart = async () => ({
      ok: false,
      error: 'fiber.restart 不可用，需要重启 DSH',
    })
  }
}

export const _internals = { Bridge, parseDataUrl, attachImage, TOOL_SPECS, E }
