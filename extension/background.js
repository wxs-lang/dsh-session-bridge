/**
 * DSH Session Bridge — MV3 service worker
 *
 * 连接本机 DSH 插件的 WS 桥（127.0.0.1:39401），执行 browser_* 命令。
 * 全部能力都靠 chrome.scripting.executeScript 注入纯 JS 实现（不用 CDP），
 * 所以不需要 --remote-debugging-port，也不会跟用户的调试端口抢。
 *
 * 协议：一行一个 JSON（\n 结尾）
 *   收：{ "id": 1, "cmd": "tab.snapshot", "params": {…} }
 *   发：{ "id": 1, "ok": true, "result": {…} }
 *       { "id": 1, "ok": false, "error": { "code": "…", "message": "…" } }
 */

// 只连主端口。原来连 3 个端口是为了"多开桥时也能连上"，
// 但代价是 3 份 WebSocket + 3 倍 ping 唤醒，SW 常驻更重。
// 需要备用口时手动加回来（并同步改 index.js 的 DEFAULT_PORT / 测试端口）。
// 桥的候选端口。桥在首选端口被占时会降级到后面的（见 impl.js 的 FALLBACK_PORTS），
// 扩展要跟着连，否则桥起来了却没人接。
const BRIDGE_PORTS = [39401, 39411, 39421]

/** 允许连桥的浏览器品牌白名单。
 *  QQ浏览器/360/搜狗 会加载同一扩展目录，两边都连桥 → 命令随机落一边，
 *  用户看到的就是"分组建了又没了""状态滞后"。
 *  改这里并刷新扩展即可；想看 QQ浏览器 就把它加进来。 */
const ALLOWED_BRANDS = ['Chrome', 'Edge', 'Unknown']

const EXT_VERSION = '2.5.0'
const RECONNECT_MS = 2000          // 首次重连间隔
const RECONNECT_MAX_MS = 30000     // 退避上限
const RECONNECT_BACKOFF = 2        // 每次失败乘这个系数

// 冷启动兜底：chrome.tabs.create 偶发返回没有 id 的对象
// （实测约 20% 概率，出现在刚装扩展、SW 冷启动后的第一批调用里）
const CREATE_RETRY_COUNT = 3
const CREATE_RETRY_MS = 120
const PING_MS = 20000
// MV3 的 Service Worker 被浏览器卸载后，WS 会一起断，而插件侧无法主动唤醒扩展。
// 用 alarm 定期把 SW 叫醒重连，保证 DSH 随时能连上（代价是 SW 每分钟醒一次）。
const KEEPALIVE_ALARM = 'dsh-bridge-keepalive'
const LEASE_ALARM = 'dsh-bridge-lease-reap'
const KEEPALIVE_MINUTES = 1

/** port -> { ws, connectedAt, reconnectTimer, pingTimer, helloSent } */
/* ── 错误记录 ──────────────────────────────────────────────────────────
 *
 * 空 catch 在扩展里很常见 —— finally 里 detach 失败没人能补救，
 * 记下来反而会盖住真实错误。但**用户操作失败**被吞掉就麻烦了：
 * 表现是"点了没反应，也不知道为什么"。
 *
 * noteErr 只用于后一种：记进环形缓冲，通过 debug.info 命令能取出来。
 */
const ERR_LOG = []
const ERR_LOG_MAX = 50

function noteErr(where, e) {
  const msg = String((e && e.message) || e || 'unknown')
  ERR_LOG.push({ t: Date.now(), where, msg: msg.slice(0, 200) })
  if (ERR_LOG.length > ERR_LOG_MAX) ERR_LOG.shift()
  try { console.warn(`[bridge] ${where}: ${msg}`) } catch { /* ignore */ }
}

const links = new Map()
const inflight = new Map() // id -> { startedAt, cmd, port }

/* ── 连接管理 ────────────────────────────────────────────────────────── */

function link(port) {
  let l = links.get(port)
  if (!l) {
    l = { ws: null, connectedAt: 0, reconnectTimer: null, pingTimer: null, helloSent: false }
    links.set(port, l)
  }
  return l
}

/**
 * 断线重连，带指数退避。
 *
 * 固定 2 秒重试在桥没起来时会每秒打一次日志、烧 CPU；
 * 退避到 30 秒上限既能快速恢复，又不会在长时间断开时刷屏。
 * 连上之后 attempt 归零（见 sock.onopen）。
 */
function scheduleReconnect(port) {
  const l = link(port)
  if (l.reconnectTimer) return
  const attempt = Number(l.reconnectAttempt) || 0
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * Math.pow(RECONNECT_BACKOFF, attempt))
  l.reconnectAttempt = attempt + 1
  l.reconnectTimer = setTimeout(() => {
    l.reconnectTimer = null
    connect(port)
  }, delay)
}

async function connect(port) {
  const l = link(port)
  if (l.ws && (l.ws.readyState === WebSocket.OPEN || l.ws.readyState === WebSocket.CONNECTING)) return
  let sock
  try {
    // 身份在 URL 里上报：桥在 upgrade 时就能读到，不必等 hello，
    // 也就不会出现"命令发给还没 hello 的连接"这种路由空窗。
    const qs = new URLSearchParams({
      brand: detectBrand(),
      ver: EXT_VERSION,
    })
    sock = new WebSocket(`ws://127.0.0.1:${port}/?${qs.toString()}`)
  } catch {
    scheduleReconnect(port)
    return
  }
  l.ws = sock
  l.helloSent = false

  sock.onopen = async () => {
    l.connectedAt = Date.now()
    l.helloSent = true
    l.reconnectAttempt = 0   // 连上了，退避归零
    // hello 里声明支持哪些命令：桥侧据此路由（多实例/旧版本混连时不会把命令
    // 发给不支持它的那个实例），也方便一眼看出扩展有没有刷到最新。
    send(l, {
      type: 'hello',
      version: EXT_VERSION,
      browser: navigatorInfo(),
      commands: Object.keys(handlers),
      // 精确区分浏览器：QQ浏览器 / Edge / Chrome 的 UA 都带 "Chrome/xxx"，
      // 只有品牌字段能分开。桥按这个路由，避免操作错浏览器。
      brand: detectBrand(),
      ua: (self.navigator && self.navigator.userAgent || '').slice(0, 220),
      windows: await (async () => {
        try { return (await chrome.windows.getAll({ populate: false })).map((w) => w.id).sort((a, b) => a - b) }
        catch { return null }
      })(),
    })
    startPing(port)
  }

  sock.onmessage = (ev) => {
    const text = typeof ev.data === 'string' ? ev.data : ''
    if (!text) return
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      let msg
      try { msg = JSON.parse(t) } catch { continue }
      if (msg.type === 'hello-ack' || msg.type === 'pong') continue
      if (msg.id != null && msg.cmd) handleCommand(msg, l)
    }
  }

  sock.onclose = () => {
    stopPing(port)
    if (l.ws === sock) l.ws = null
    scheduleReconnect(port)
  }

  sock.onerror = () => {
    try { sock.close() } catch { /* onclose 会接上 */ }
  }
}

function connectAll() {
  // 不拦任何浏览器：身份靠 WebSocket URL 的 query 上报，
  // 桥按 brand 精确路由，两个浏览器可以同时连着互不干扰。
  for (const port of BRIDGE_PORTS) connect(port)
}

/* ── 租约（lease）────────────────────────────────────────────────────
 *
 * 借鉴 WorkBuddy 的 channel 机制，但更轻：不搞 epoch 握手，
 * 直接给"我这轮操作占用的标签页"打一个带 deadline 的租约。
 *
 * 为什么需要：模型跑一个流程会临时开若干标签页、建标签组。
 * 流程结束（或超时）后如果不清理，用户的标签栏会越堆越多。
 * 有了租约，到期自动关掉「本次流程新建的」标签页 / 分组，
 * 用户原有的标签永远不动。
 */
const leases = new Map()   // leaseId -> { tabs:Set<number>, groups:Set<number>, deadline, keepTabs:boolean }
const LEASE_REAP_MS = 5000
const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000

let leaseSeq = 0

/* ── 隐式租约：插件新建的标签自动纳入清理 ──
 *
 * 调用方不必先 browser_lease 开一个。只要标签是插件自己开的（tab.navigate
 * 走了 chrome.tabs.create），就登记到 '__auto__' 名下，到期自动关。
 *
 * 用户自己开的标签永远不会进来 —— 只有 chrome.tabs.create 返回的 id 才会
 * 走到 trackAutoTab()。
 */
const AUTO_LEASE_ID = '__auto__'

function autoLease() {
  let l = leases.get(AUTO_LEASE_ID)
  if (!l) {
    l = {
      tabs: new Set(),
      groups: new Set(),
      createdAt: Date.now(),
      deadline: Date.now() + DEFAULT_LEASE_TTL_MS,
      keepTabs: false,
    }
    leases.set(AUTO_LEASE_ID, l)
  }
  return l
}

/** 登记一个插件新建的标签，并顺延隐式租约的到期时间。 */
function trackAutoTab(tabId, ttlMs) {
  if (typeof tabId !== 'number') return
  const l = autoLease()
  l.tabs.add(tabId)
  const ttl = Math.min(60 * 60 * 1000, Math.max(60000, Number(ttlMs) || DEFAULT_LEASE_TTL_MS))
  l.deadline = Date.now() + ttl
}

function newLease(opts = {}) {
  const ttl = Math.min(60 * 60 * 1000, Math.max(5000, Number(opts.ttlMs) || DEFAULT_LEASE_TTL_MS))
  const id = `L${++leaseSeq}-${Date.now().toString(36)}`
  leases.set(id, {
    tabs: new Set(),
    groups: new Set(),
    createdAt: Date.now(),
    deadline: Date.now() + ttl,
    keepTabs: opts.keepTabs === true,
  })
  return { leaseId: id, ttlMs: ttl }
}

function renewLease(id, ttlMs) {
  const l = leases.get(id)
  if (!l) return null
  const ttl = Math.min(60 * 60 * 1000, Math.max(5000, Number(ttlMs) || DEFAULT_LEASE_TTL_MS))
  l.deadline = Date.now() + ttl
  return { leaseId: id, ttlMs: ttl, deadline: l.deadline }
}

/** 把 tab / group 挂到租约上（之后新建的标签会自动归属当前租约） */
function attachToLease(id, { tabIds, groupIds } = {}) {
  const l = leases.get(id)
  if (!l) return false
  for (const t of (tabIds || [])) l.tabs.add(Number(t))
  for (const g of (groupIds || [])) l.groups.add(Number(g))
  return true
}

/**
 * 扫一遍所有租约，把过期的清掉。
 *
 * 由 chrome.alarms 每 LEASE_REAP_MS 触发。MV3 的 Service Worker 会被浏览器
 * 卸载，setInterval 随之停摆 —— 只有 alarm 能在 SW 休眠时把它叫醒。
 *
 * 清理时只关租约登记的 tab / group，用户自己开的标签一律不动。
 */
async function reapExpiredLeases() {
  const now = Date.now()
  const expired = []
  for (const [id, l] of leases) {
    if (l.deadline <= now) expired.push(id)
  }
  const closed = []
  for (const id of expired) {
    try {
      const r = await releaseLease(id)
      if (r && r.ok) closed.push({ leaseId: id, tabs: r.closedTabs.length, groups: r.closedGroups.length })
    } catch { /* 单个租约清理失败不影响其他 */ }
  }
  if (closed.length > 0) {
    try { console.log('[bridge] 自动清理过期租约:', JSON.stringify(closed)) } catch { /* ignore */ }
  }
  return closed
}

/** 释放租约：关掉它名下"本次新建"的标签和分组。 */
async function releaseLease(id, opts = {}) {
  const l = leases.get(id)
  if (!l) return { ok: false, error: 'unknown_lease' }
  leases.delete(id)
  const closedTabs = []
  const closedGroups = []

  if (opts.keepTabs !== true && !l.keepTabs) {
    for (const tid of l.tabs) {
      try {
        const t = await chrome.tabs.get(tid)
        // 只关掉仍然存在的。标签已经不在（用户自己关了 / 浏览器回收）就跳过。
        // 这里的集合 l.tabs 只包含调用方显式登记过的标签，不会误伤用户原有页面。
        if (t) { await chrome.tabs.remove(tid); closedTabs.push(tid) }
      } catch { /* 已经关了 */ }
    }
  }
  for (const gid of l.groups) {
    try {
      const tabs = await chrome.tabs.query({ groupId: gid })
      if (tabs.length > 0) {
        await chrome.tabs.remove(tabs.map((t) => t.id))
        closedGroups.push(gid)
      }
    } catch { /* 组已消失 */ }
  }
  l.tabs.clear()
  l.groups.clear()
  return { ok: true, leaseId: id, closedTabs, closedGroups }
}

async function cmdLeaseOpen(params) {
  return { ok: true, ...newLease(params) }
}

async function cmdLeaseRenew(params) {
  const r = renewLease(String(params.leaseId || ''), params.ttlMs)
  return r ? { ok: true, ...r } : { ok: false, error: 'unknown_lease' }
}

async function cmdLeaseAttach(params) {
  const okAttach = attachToLease(String(params.leaseId || ''), {
    tabIds: params.tabIds, groupIds: params.groupIds,
  })
  return { ok: okAttach, leaseId: params.leaseId }
}

async function cmdLeaseRelease(params) {
  return releaseLease(String(params.leaseId || ''), { keepTabs: params.keepTabs === true })
}

async function cmdLeaseList() {
  const now = Date.now()
  const out = []
  for (const [id, l] of leases) {
    out.push({
      leaseId: id,
      tabCount: l.tabs.size,
      groupCount: l.groups.size,
      remainingMs: Math.max(0, l.deadline - now),
    })
  }
  return { ok: true, count: out.length, leases: out }
}

/* ── native messaging 通道 ────────────────────────────────────────────
 *
 * 和 WebSocket 并存，不是替代：
 *   WebSocket  : SW 活着时最快（0 延迟）
 *   native msg : SW 被浏览器卸载后，扩展下次醒来能立刻 connectNative 拉起
 *                不需要等 chrome.alarms（最长 60s）
 *
 * 桥侧把 brand=NativeHost 也当成一个"连接"来路由，所以两边都可用。
 */
const NATIVE_HOST_NAME = 'com.dsh.session'
let nativePort = null
let nativeReconnectTimer = null

/** 伪 link：让全局 send(l, obj) 知道这条消息该走 native 通道。 */
const nativeLink = {
  native: true,
  ws: null,
  helloSent: true,
  connectedAt: 0,
}

function connectNative() {
  if (nativePort) return
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME)
  } catch (e) {
    scheduleNativeReconnect()
    return
  }

  nativePort.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'cmd' && msg.id != null) {
      // 桥下发的命令：走和 WS 完全相同的执行路径。
      // handleCommand 内部调用全局 send(l, obj)，所以这里给一个
      // 带 ws 形状的伪 link，send 会走 native 分支转发出去。
      handleCommand({ id: msg.id, cmd: msg.cmd, params: msg.params || {} }, nativeLink)
      return
    }
    if (msg.type === 'bridge-status') {
      // 桥连没连上，只影响日志
      return
    }
    if (msg.type === 'pong') return

    // native host 问"你支持哪些命令" → 把真实清单给它，别让它硬编码
    // （原来 native-host.mjs 写死 18 条，扩展加到 29 条后新增命令会被判"不支持"）
    if (msg.type === 'need-capabilities') {
      try {
        nativePort?.postMessage({
          type: 'capabilities',
          version: EXT_VERSION,
          brand: detectBrand(),
          commands: Object.keys(handlers),
          ua: (self.navigator && self.navigator.userAgent || '').slice(0, 220),
        })
      } catch { /* ignore */ }
      return
    }
  })

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError
    nativePort = null
    if (err) {
      // 最常见：native host 没注册 / node 不在 PATH
      console.warn('[dsh-bridge] native host 断开:', err.message)
    }
    scheduleNativeReconnect()
  })
}

function scheduleNativeReconnect() {
  if (nativeReconnectTimer) return
  nativeReconnectTimer = setTimeout(() => {
    nativeReconnectTimer = null
    connectNative()
  }, 5000)
}

function send(l, obj) {
  // native messaging 通道：把消息转成 native 协议发出去
  if (l && l.native) {
    try {
      nativePort?.postMessage({
        type: 'result',
        id: obj.id,
        ok: obj.ok,
        brand: obj.brand || detectBrand(),
        extVersion: obj.extVersion || EXT_VERSION,
        result: obj.result,
        error: obj.error,
      })
      return true
    } catch { return false }
  }
  if (!l || !l.ws || l.ws.readyState !== WebSocket.OPEN) return false
  if (obj && obj.type !== 'ping' && obj.type !== 'pong') l.lastTrafficAt = Date.now()
  try {
    l.ws.send(JSON.stringify(obj) + '\n')
    return true
  } catch {
    return false
  }
}

function startPing(port) {
  const l = link(port)
  stopPing(port)
  // ── 固定心跳，**不主动断开** ──
  //
  // 曾经试过"空闲 5 分钟就 close()，让浏览器回收 Service Worker 省内存"。
  // 那是个错误设计：close 会触发 onclose → scheduleReconnect → 2 秒后重连，
  // 而 lastTrafficAt 没有真实命令可更新，于是 5 分钟后又断 —— 无限循环。
  // 每一次断开都恰好可能撞上在途命令，表现为偶发 extension_disconnected。
  //
  // 结论：这个插件的价值是"随时可用"，不是"省那几十 MB"。
  // 保持长连接 + 固定心跳，让 SW 常驻；内存代价约 20~50 MB，可接受。
  l.pingTimer = setInterval(() => {
    if (!l.ws || l.ws.readyState !== WebSocket.OPEN) { stopPing(port); return }
    send(l, { type: 'ping', t: Date.now() })
  }, PING_MS)
}

function stopPing(port) {
  const l = link(port)
  if (l.pingTimer) { clearInterval(l.pingTimer); l.pingTimer = null }
}

/** 判定真实品牌：QQ浏览器 / Edge / 360 / Chrome。
 *  QQ浏览器的 UA 里有 "QQBrowser"；Edge 有 "Edg/"；Chrome 什么都没有。 */
function detectBrand() {
  const ua = String((self.navigator && self.navigator.userAgent) || '')
  if (/QQBrowser|TencentTraveler/i.test(ua)) return 'QQBrowser'
  if (/Edg\//i.test(ua)) return 'Edge'
  if (/360SE|360EE|QIHU/i.test(ua)) return '360'
  if (/Sogou|MetaSr/i.test(ua)) return 'Sogou'
  if (/Chrome\//i.test(ua)) return 'Chrome'
  return 'Unknown'
}

function navigatorInfo() {
  const ua = navigator.userAgent || ''
  const m = /(Edg|Chrome|OPR)\/([\d.]+)/.exec(ua)
  const brand = m ? m[1] : 'Chromium'
  const ver = m ? m[2].split('.')[0] : ''
  return `${brand}/${ver}`
}

/* ── 命令分发 ────────────────────────────────────────────────────────── */

const handlers = {
  'tabs.list': cmdTabsList,
  'tab.snapshot': cmdTabSnapshot,
  'tab.click': cmdTabClick,
  'tab.type': cmdTabType,
  'tab.key': cmdTabKey,
  'tab.scroll': cmdTabScroll,
  'tab.batch': cmdTabBatch,
  'lease.open': cmdLeaseOpen,
  'lease.renew': cmdLeaseRenew,
  'lease.attach': cmdLeaseAttach,
  'lease.release': cmdLeaseRelease,
  'lease.list': cmdLeaseList,
  'tab.evaluate': cmdTabEval,
  'tab.drag': cmdTabDrag,
  'tab.mouse': cmdTabMouse,
  'tab.navigate': cmdTabNavigate,
  'tab.screenshot': cmdTabScreenshot,
  'tab.info': cmdTabInfo,
  'tab.close': cmdTabClose,
  'debug.info': cmdDebugInfo,
  'debug.ua': cmdDebugUa,
  'debug.detachAll': cmdDebugDetachAll,
  // ── 标签分组：DSH 碰过的页面自动收进「大肥鱼」组 ──────────────
  'windows.list': cmdWindowsList,
  'group.ensure': cmdGroupEnsure,
  'group.assign': cmdGroupAssign,
  'group.list': cmdGroupList,
  'group.update': cmdGroupUpdate,
  'group.close': cmdGroupClose,
  // ── 图标主题 ──
  'theme.icon': cmdThemeIcon,
}

async function handleCommand(msg, l) {
  const { id, cmd } = msg
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {}
  inflight.set(id, { cmd, startedAt: Date.now() })
  try {
    const fn = handlers[cmd]
    if (!fn) throw bridgeError('unknown_command', `未知命令 ${cmd}`)
    const result = await fn(params)
    // 每条回复都盖章：brand + 标签页总数。
    // 桥据此知道"这条数据来自 Chrome 还是 QQ浏览器"，不依赖只在连上时发一次的 hello。
    // 每条回复盖章：品牌 + 窗口指纹。桥据此区分"两个 Chrome profile/窗口"
    let winFingerprint = null
    try {
      const wins = await chrome.windows.getAll({ populate: false })
      winFingerprint = wins.map((w) => w.id).sort((a, b) => a - b)
    } catch { /* ignore */ }
    send(l, {
      id, ok: true,
      brand: detectBrand(),
      extVersion: EXT_VERSION,
      windows: winFingerprint,
      result: result == null ? {} : result,
    })
  } catch (e) {
    const code = (e && e.code) || 'extension_error'
    const message = String((e && e.message) || e)
    send(l, { id, ok: false, brand: detectBrand(), error: { code, message } })
  } finally {
    inflight.delete(id)
  }
}

function bridgeError(code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

/* ── 公共辅助 ───────────────────────────────────────────────────────── */

/**
 * 被浏览器回收（discarded）的标签页要先唤醒才能操作。
 *
 * 浏览器会在内存紧张或标签久置后台时把标签的渲染进程丢掉 —— 标签还在标签栏上，
 * 但内容已经卸载，往里注入脚本必然失败，CDP 也会报 "Not attached to an active page"。
 *
 * 唤醒方式：chrome.tabs.reload()。它是**后台重载**，不会把标签切到前台，
 * 所以不会抢用户焦点。重载完成前不阻塞：给一段短等待，够多数页面起来即可，
 * 剩下的交给后续的 waitForLoad。
 */
async function wakeIfDiscarded(tab, waitMs = 1200) {
  if (!tab || !tab.discarded) return tab
  try {
    await chrome.tabs.reload(tab.id, { bypassCache: false })
  } catch (e) { noteErr('wakeIfDiscarded', e) }
  // 等它 status 变成 complete，但不死等
  const deadline = Date.now() + waitMs
  for (;;) {
    if (Date.now() > deadline) break
    try {
      const fresh = await chrome.tabs.get(tab.id)
      if (!fresh.discarded && fresh.status === 'complete') return fresh
    } catch { break }
    await sleep(150)
  }
  try { return await chrome.tabs.get(tab.id) } catch { return tab }
}

async function resolveTab(tabId, preferActive = true) {
  if (typeof tabId === 'number' && Number.isFinite(tabId)) {
    let tab
  try { tab = await chrome.tabs.get(tabId) } catch { tab = null }
    if (!tab) throw bridgeError('tab_not_found', `标签页 ${tabId} 不存在（可能已关闭）`)
    // 被浏览器丢了渲染进程 —— 先静默唤醒，否则后续注入/CDP 必然失败
    if (tab.discarded) tab = await wakeIfDiscarded(tab)
    return tab
  }
  const tabs = await chrome.tabs.query(preferActive ? { active: true, lastFocusedWindow: true } : {})
  if (tabs.length > 0) return tabs[0]
  const all = await chrome.tabs.query({})
  if (all.length === 0) throw bridgeError('no_tab', '浏览器里没有打开的标签页')
  return all[0]
}

/**
 * 判断这个标签能不能注入脚本，不能的话给出**具体的**错误码。
 *
 * 之前所有情况都报 restricted_page，调用方无法区分"浏览器限制"和"可以换条路"。
 * 细分之后：
 *   restricted_store   → 商店页，任何扩展都动不了，只能换页面
 *   restricted_pdf     → 内置 PDF 阅读器，可以试着下载原文件
 *   restricted_extension → 扩展页面，同上
 *   restricted_page    → 其他浏览器内部页
 */
function assertInjectable(tab) {
  const url = tab.url || tab.pendingUrl || ''

  if (/^(chrome-extension|moz-extension|safari-web-extension):/i.test(url)) {
    throw bridgeError('restricted_extension',
      `扩展页面不允许脚本注入：${url.slice(0, 120)}。换一个普通网页标签再试。`)
  }

  const blocked = ['chrome.google.com/webstore', 'chromewebstore.google.com',
                   'microsoftedge.microsoft.com/addons', 'addons.mozilla.org']
  if (blocked.some((b) => url.includes(b))) {
    throw bridgeError('restricted_store',
      `扩展商店页面不允许脚本注入：${url.slice(0, 120)}。这是浏览器强制限制，任何扩展都绕不过。`)
  }

  // 内置 PDF 阅读器：chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/
  if (/\.pdf($|\?)/i.test(url) || url.includes('mhjfbmdgcfjbbpaeojofohoefgiehjai')) {
    throw bridgeError('restricted_pdf',
      `内置 PDF 阅读器不允许脚本注入：${url.slice(0, 120)}。`
      + '要读内容可以先下载原文件，或在浏览器设置里关掉「在浏览器中打开 PDF」。')
  }

  if (/^(chrome|edge|about|devtools|view-source|chrome-untrusted|qqbrowser|brave):/i.test(url)) {
    throw bridgeError('restricted_page',
      `浏览器内部页不允许脚本注入：${url.slice(0, 120)}。换一个普通网页标签再试。`)
  }

  if (!url) {
    throw bridgeError('restricted_page',
      '这个标签还没有 URL（可能是空白页或正在加载）。等页面加载完再试。')
  }
}

/** 给注入加超时护栏：大页面上的快照可能几十秒，不能拖死调用方。 */
function injectWithTimeout(tabId, fn, args, ms) {
  return Promise.race([
    inject(tabId, fn, args),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`inject timeout ${ms}ms`)), ms)),
  ])
}

async function inject(tabId, func, args) {
  let frames
  try {
    frames = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func,
      args: args === undefined ? [] : [args],
    })
  } catch (e) {
    const m = String((e && e.message) || e)
    if (/cannot access|cannot be scripted|Cannot access contents|The extensions gallery/i.test(m)) {
      throw bridgeError('restricted_page', `此页面不允许脚本注入：${m.slice(0, 200)}`)
    }
    if (/No tab with id/i.test(m)) throw bridgeError('tab_not_found', m)
    throw bridgeError('inject_failed', m)
  }
  const r = Array.isArray(frames) && frames.length > 0 ? frames[0].result : undefined
  if (r === undefined) throw bridgeError('inject_failed', '注入脚本没有返回值（页面可能已导航）')
  if (r && typeof r === 'object' && r.__error) throw bridgeError(r.__error, r.__message || r.__error)
  return r
}

/* ── CDP 真实输入 ─────────────────────────────────────────────────────
 *
 * 为什么需要：注入的合成事件 `isTrusted === false`，很多站点（Google 搜索框、
 * 支付密码框、Canvas 应用）会直接忽略。只有 CDP 的 Input.* 才是真实输入。
 *
 * 代价：需要 chrome.debugger.attach，期间标签页会有调试横幅；
 * 而且会独占该 tab 的调试会话（用完必须 detach）。
 */

/** 在 tab 上跑一段需要 debugger 的操作，确保 detach。 */
async function withDebugger(tabId, fn) {
  let attached = false
  const target = { tabId }   // 和截图路径一致：复用同一个 target 对象
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    // Input.* domain 必须先 enable，否则 dispatchKeyEvent 会被静默丢弃
    try { await chrome.debugger.sendCommand(target, 'Runtime.enable') } catch { /* ignore */ }
    try { await chrome.debugger.sendCommand(target, 'Page.enable') } catch { /* ignore */ }
    // 这里原本调 Emulation.setFocusEmulationEnabled，让后台标签以为自己是"有焦点"的。
    // 但它的副作用比收益大：会触发 :focus-within 样式、影响懒加载和
    // IntersectionObserver，用户能看到布局微调。
    // 而 Input.dispatchMouseEvent / dispatchKeyEvent 直接进合成器，不等 rAF，
    // 根本不需要它。所以去掉。
  } catch (e) {
    const m = String((e && e.message) || e)
    // 已经有别的调试器（另一个扩展 / DevTools）挂着
    if (/Another debugger|already attached|Cannot attach/i.test(m)) {
      throw bridgeError('debugger_busy', `标签页已被其他调试器占用：${m.slice(0, 200)}`)
    }
    throw bridgeError('debugger_failed', `attach 失败：${m.slice(0, 200)}`)
  }
  try {
    return await fn((method, params) => chrome.debugger.sendCommand(target, method, params))
  } catch (e) {
    const m = String((e && e.message) || e)
    throw bridgeError('cdp_failed', `CDP 命令失败：${m.slice(0, 200)}`)
  } finally {
    if (attached) { try { await chrome.debugger.detach(target) } catch { /* ignore */ } }
  }
}

/** 真实鼠标点击（CDP）。x/y 是视口 CSS 像素坐标。 */
async function cdpClick(tabId, x, y, opts = {}) {
  const clicks = opts.double ? 2 : (Number(opts.clickCount) || 1)
  const button = opts.button || 'left'
  return withDebugger(tabId, async (send) => {
    // 先把页面滚到能看见这个点（CDP 坐标是视口坐标，不滚动就会点错）
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: clicks })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: clicks })
    return { clicked: { x, y, button, clicks } }
  })
}

/** 真实鼠标移动 / 拖拽（CDP）。拖拽走 press → move×N → release。 */
async function cdpDrag(tabId, from, to, opts = {}) {
  const steps = Math.max(2, Math.min(50, Number(opts.steps) || 10))
  return withDebugger(tabId, async (send) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    return { dragged: { from, to, steps } }
  })
}

/** 真实滚轮（CDP）。deltaY 负=向上。 */
async function cdpScroll(tabId, x, y, deltaX, deltaY) {
  const dy = Number(deltaY) || 0
  const dx = Number(deltaX) || 0
  if (dy === 0 && dx === 0) throw bridgeError('bad_args', 'wheel 需要 deltaX 或 deltaY')

  let viaCdp = false
  try {
    await withDebugger(tabId, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, pointerType: 'mouse',
      })
    })
    viaCdp = true
  } catch (e) { noteErr('input.cdp', e) }

  // ── DOM 兜底 ──
  // 实测某些 Chrome 版本/页面上 Input.dispatchMouseEvent(type:'mouseWheel')
  // 不派发 wheel 事件也不滚动。这里补一次原生 wheel 派发 + 真滚动，
  // 保证"滚轮"这个动作一定有可观察效果。
  const r = await inject(tabId, (opts) => {
    const { x: px, y: py, dx, dy } = opts
    const el = document.elementFromPoint(px, py) || document.body
    const before = window.scrollY
    // 先派发一个 wheel 事件让监听器有机会反应
    try {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaX: dx, deltaY: dy, bubbles: true, cancelable: true, composed: true, clientX: px, clientY: py,
      }))
    } catch { /* ignore */ }
    // 再真的滚（CDP 没生效时的兜底）
    if (Math.abs(window.scrollY - before) < 1) {
      window.scrollBy({ top: dy, left: dx, behavior: 'instant' })
    }
    return { from: before, to: Math.round(window.scrollY), scrolled: Math.abs(window.scrollY - before) >= 1 }
  }, { x, y, dx: dx, dy: dy }).catch(() => null)

  return {
    wheel: { x, y, deltaX: dx, deltaY: dy },
    viaCdp,
    dom: r,
  }
}

/** 真实按键（CDP）。支持组合键，能被只认 isTrusted 的站点收到。 */
async function cdpKey(tabId, combo) {
  const parts = String(combo || '').split('+').map((x) => x.trim()).filter(Boolean)
  const main = parts.length > 1 ? parts[parts.length - 1] : parts[0]
  const mods = new Set(parts.slice(0, -1).map((x) => x.toLowerCase()))
  const ctrl = mods.has('control') || mods.has('ctrl')
  const shift = mods.has('shift')
  const alt = mods.has('alt')
  const meta = mods.has('meta') || mods.has('command') || mods.has('cmd')

  // CDP 需要 windowsVirtualKeyCode，常用键先查表
  const KEYMAP = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
  }
  const info = KEYMAP[main] || (main.length === 1
    ? { code: /[a-z]/i.test(main) ? 'Key' + main.toUpperCase() : 'Digit' + main, keyCode: main.toUpperCase().charCodeAt(0), text: main }
    : { code: main, keyCode: 0 })

  const modifiers = (ctrl ? 2 : 0) | (shift ? 8 : 0) | (alt ? 1 : 0) | (meta ? 4 : 0)

  return withDebugger(tabId, async (send) => {
    const base = {
      key: main, code: info.code,
      windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode,
      modifiers,
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
    // 有可打印字符时补一个 char 事件，页面才能收到 input
    if (info.text && !ctrl && !alt && !meta) {
      await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: info.text, unmodifiedText: info.text })
    }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return { key: main, modifiers, cdp: true }
  })
}

/** 真实文本输入（CDP Input.insertText）。比逐键更快，且 isTrusted。 */
async function cdpType(tabId, text) {
  return withDebugger(tabId, async (send) => {
    await send('Input.insertText', { text: String(text || '') })
    return { typed: String(text || '').length }
  })
}

/** 在页面**主世界**执行表达式（受页面 CSP 约束会失败）。
 *  用 CDP Runtime.evaluate：它能读页面真实变量、调页面自家 API，
 *  且不受 ISOLATED world 的隔离限制。失败时回退到注入式。 */
async function evaluateInPage(tabId, expr) {
  // 首选 CDP：能力最全
  let attached = false
  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attached = true
    const r = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (r && r.exceptionDetails) {
      const m = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed'
      return { ok: false, error: { code: 'eval_failed', message: String(m).slice(0, 500) } }
    }
    const v = r && r.result ? r.result.value : undefined
    return {
      ok: true,
      value: v === undefined ? null : v,
      type: r && r.result ? r.result.type : 'undefined',
      via: 'cdp',
    }
  } catch (e) {
    return { ok: false, error: { code: 'eval_failed', message: String((e && e.message) || e).slice(0, 500) }, via: 'cdp' }
  } finally {
    if (attached) { try { await chrome.debugger.detach({ tabId }) } catch { /* ignore */ } }
  }
}

/* ── 注入脚本（必须自包含，不能引用外部符号）────────────────────────── */

/** 快照：给可交互元素打 data-dsh-ref，返回元素清单 + 可视文本。 */
function pageSnapshot(opts) {
  const t0 = Date.now()
  try {
    const maxElements = Math.max(1, Math.min(400, (opts && opts.maxElements) || 120))
    const scopeSel = (opts && opts.selector) || null
    const textOnly = Boolean(opts && opts.text)

    // 清掉上一轮的 ref，保证 ref 编号跟这次快照一致
    for (const old of document.querySelectorAll('[data-dsh-ref]')) {
      try { old.removeAttribute('data-dsh-ref') } catch { /* ignore */ }
    }

    let root = document
    if (scopeSel) {
      const el = document.querySelector(scopeSel)
      if (!el) return { __error: 'bad_args', __message: `选择器没匹配到元素：${scopeSel}` }
      root = el
    }

    const SEL = [
      'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
      '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
      '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
      '[role="switch"]', '[role="searchbox"]', '[role="textbox"]',
      '[onclick]', '[contenteditable=""]', '[contenteditable="true"]',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',')

    // ── 性能关键：getComputedStyle 会强制样式重算，对每个候选元素调一次
    //    在 muse.ai 这类重型 SPA 上会跑几十秒（实测 20s 超时）。
    //    改成「先用零成本判据快速筛选，再只对幸存者读一次 computed style」。
    const vh = window.innerHeight || 0
    const isVisible = (el) => {
      // 1) 零成本：几何判断（getBoundingClientRect 一次）
      const rect = el.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      // 视野外太远的直接丢（保留上下各 2000px 的余量，滚动后仍可用）
      if (rect.bottom < -2000 || rect.top > vh + 2000) return false
      // 2) 零成本：hidden 属性 / 内联 display:none
      if (el.hidden) return false
      if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) return false
      // 3) 只剩少数幸存者才读 computed style
      const cs = window.getComputedStyle(el)
      if (!cs) return false
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false
      return true
    }

    const roleOf = (el) => {
      const explicit = el.getAttribute && el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') return 'link'
      if (tag === 'button') return 'button'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (tag === 'input') {
        const t = (el.type || 'text').toLowerCase()
        if (t === 'checkbox') return 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
        if (t === 'search') return 'searchbox'
        return 'textbox'
      }
      if (el.isContentEditable) return 'textbox'
      return tag
    }

    const nameOf = (el) => {
      const pick = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
      let n = pick(el.getAttribute && el.getAttribute('aria-label'))
      if (n) return n
      const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby')
      if (labelledBy) {
        const parts = labelledBy.split(/\s+/).map((id) => {
          const t = document.getElementById(id)
          return t ? pick(t.textContent) : ''
        }).filter(Boolean)
        if (parts.length) return pick(parts.join(' '))
      }
      n = pick(el.innerText || el.textContent)
      if (n) return n.slice(0, 160)
      n = pick(el.getAttribute && (el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')))
      if (n) return n
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea') {
        n = pick(el.value)
        if (n) return n.slice(0, 160)
        n = pick(el.getAttribute('name') || el.getAttribute('id'))
        if (n) return n.slice(0, 160)
      }
      return tag
    }

    const valueOf = (el) => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'input') {
        const t = (el.type || '').toLowerCase()
        if (t === 'checkbox' || t === 'radio') return el.checked ? 'checked' : 'unchecked'
        if (t === 'password') return el.value ? '••••' : ''
        return String(el.value || '').slice(0, 200)
      }
      if (tag === 'textarea') return String(el.value || '').slice(0, 200)
      if (tag === 'select') {
        const o = el.selectedOptions && el.selectedOptions[0]
        return o ? String(o.textContent || o.value).slice(0, 120) : ''
      }
      if (el.isContentEditable) return String(el.innerText || '').slice(0, 200)
      return undefined
    }

    const seen = new Set()
    const nodes = []
    // 候选集封顶：超大页面（gmail / muse / jira）querySelectorAll 能返回几万个节点，
    // 全量判可见会超时。先取前 N 个，够模型用就行。
    const CANDIDATE_CAP = Math.min(1500, Math.max(maxElements * 8, 400))
    const candidates = Array.from(root.querySelectorAll(SEL)).slice(0, CANDIDATE_CAP)
    // 表单容器内的 label 也值得给一个 ref（很多站用 label 触发 radio）
    for (const el of candidates) {
      if (seen.has(el)) continue
      seen.add(el)
      if (!isVisible(el)) continue
      nodes.push(el)
      if (nodes.length >= maxElements) break
    }

    const elements = nodes.map((el, i) => {
      const ref = 'e' + (i + 1)
      try { el.setAttribute('data-dsh-ref', ref) } catch { /* ignore */ }
      const rect = el.getBoundingClientRect()
      const role = roleOf(el)
      const name = nameOf(el)
      const value = valueOf(el)
      const attrs = {}
      if (el.id) attrs.id = String(el.id).slice(0, 80)
      if (el.getAttribute('name')) attrs.name = String(el.getAttribute('name')).slice(0, 80)
      if (el.getAttribute('type')) attrs.type = String(el.getAttribute('type')).slice(0, 40)
      if (el.getAttribute('href')) attrs.href = String(el.getAttribute('href')).slice(0, 300)
      if (el.disabled) attrs.disabled = true
      if (el.readOnly) attrs.readonly = true
      const item = {
        ref,
        role,
        name: name || '',
        bounds: {
          x: Math.round(rect.left + (window.scrollX || 0)),
          y: Math.round(rect.top + (window.scrollY || 0)),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || 0) && rect.right <= (window.innerWidth || 0),
      }
      if (value !== undefined && value !== '') item.value = value
      if (Object.keys(attrs).length > 0) item.attrs = attrs
      return item
    })

    let text = ''
    const textStart = Date.now()
    try {
      const bodyEl = document.body || document.documentElement
      if (bodyEl) {
        // innerText 会强制布局，大页面很慢。textContent 快但没换行。
        // 折中：先试 textContent（零布局成本），只在内容不超限时才用 innerText。
        const quick = String(bodyEl.textContent || '')
        // 阈值从 40 万降到 8 万：innerText 要跑完整布局，
        // 10 万字符的页面就能烧掉好几秒。宁可文本粗一点也不能卡死。
        if (quick.length > 80000) {
          // 超大页面：直接用 textContent 截断，不碰 innerText
          text = quick.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
        } else {
          text = String(bodyEl.innerText || quick).replace(/\n{3,}/g, '\n\n').trim()
        }
      }
    } catch { text = '' }
    const textCost = Date.now() - textStart
    // text=true 才给 1.2 万；普通快照只给 2500，省 token 也省传输
    const TEXT_LIMIT = textOnly ? 12000 : 2500
    if (text.length > TEXT_LIMIT) text = text.slice(0, TEXT_LIMIT) + `\n…[已截断，共 ${text.length} 字符]`

    return {
      title: document.title || '',
      url: location.href,
      // 页面总高：调用方据此判断"视口下方还有多少没取"
      docHeight: Math.max(
        document.documentElement.scrollHeight || 0,
        document.body ? document.body.scrollHeight : 0,
      ),
      costMs: { total: Date.now() - t0, text: textCost, candidates: candidates.length, kept: nodes.length },
      scroll: { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) },
      viewport: { w: window.innerWidth || 0, h: window.innerHeight || 0 },
      elementCount: elements.length,
      truncated: nodes.length >= maxElements,
      elements: textOnly ? elements.slice(0, 10) : elements,
      text,
    }
  } catch (e) {
    return { __error: 'snapshot_failed', __message: String((e && e.message) || e) }
  }
}

/** 按 ref 点击；没有 ref 就用坐标命中。 */
function pageClick(opts) {
  try {
    const ref = opts && opts.ref
    const dbl = Boolean(opts && opts.double)
    let el = null
    let hit = 'ref'
    if (ref) {
      el = document.querySelector(`[data-dsh-ref="${String(ref).replace(/"/g, '')}"]`)
      if (!el) return { __error: 'stale_ref', __message: `找不到 ref=${ref} 的元素（页面可能已变化，重新取快照）` }
    } else {
      const x = Number(opts && opts.x)
      const y = Number(opts && opts.y)
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { __error: 'bad_args', __message: '需要 ref 或 x/y' }
      el = document.elementFromPoint(x, y)
      hit = 'point'
      if (!el) return { __error: 'no_element_at_point', __message: `(${x},${y}) 处没有元素` }
    }
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch { /* ignore */ }

    const what = { tag: el.tagName.toLowerCase(), text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').slice(0, 120), hit }

    // ── 关键：如果 el.click() 触发导航，本脚本的 JS 上下文会被销毁，
    //    永远没机会 return → executeScript 挂到超时（实测 Google 广告 20s）。
    //    解法：链接类元素改成"先返回，再用 setTimeout(0) 异步点"。
    const isNavigating = (() => {
      const tag = el.tagName.toLowerCase()
      if (tag === 'a' && el.getAttribute('href')) {
        const href = String(el.getAttribute('href'))
        return !/^javascript:|^#/i.test(href)
      }
      return false
    })()

    if (hit === 'ref' && isNavigating) {
      const el2 = el
      const dbl2 = dbl
      // 异步点：本次注入立即返回，导航在下一个宏任务发生
      setTimeout(() => {
        try {
          el2.click()
          if (dbl2) setTimeout(() => { try { el2.click() } catch { } }, 80)
        } catch { /* ignore */ }
      }, 0)
      const r0 = el2.getBoundingClientRect()
      return {
        clicked: { ...what, deferred: true, reason: 'link-navigates' },
        url: location.href,
        title: document.title || '',
        rect: { x: Math.round(r0.left), y: Math.round(r0.top), w: Math.round(r0.width), h: Math.round(r0.height) },
      }
    }

    if (hit === 'ref') {
      // 原生 click 最贴近真实用户（会走冒泡/默认行为）；个别站点需要完整事件序列
      try { el.click() } catch { /* 下面兜底 */ }
    } else {
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const base = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window }
      const seq = dbl
        ? ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']
        : ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
      for (const type of seq) {
        let ev
        if (type.startsWith('pointer')) ev = new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 })
        else if (type === 'click' || type === 'dblclick') ev = new MouseEvent(type, { ...base, button: 0, detail: type === 'dblclick' ? 2 : 1 })
        else ev = new MouseEvent(type, { ...base, button: 0 })
        el.dispatchEvent(ev)
      }
    }

    // 焦点：让后续 type 有落点
    try { if (typeof el.focus === 'function') el.focus() } catch { /* ignore */ }

    const rect = el.getBoundingClientRect()
    return {
      clicked: what,
      url: location.href,
      title: document.title || '',
      rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    }
  } catch (e) {
    return { __error: 'click_failed', __message: String((e && e.message) || e) }
  }
}

/** 在页面里执行一段 JS 表达式，返回值转成 JSON 安全的形式。
 *
 *  用途：DOM 够不到的场景（读 canvas 状态、调用页面自有 API、触发路由跳转）、
 *  或需要精确控制时的逃生口。对应 WorkBuddy 的 cua.execute。
 */
function pageEval(opts) {
  try {
    const expr = String((opts && opts.expr) || '')
    if (!expr) return { __error: 'bad_args', __message: 'expr 必填' }
    // eslint-disable-next-line no-new-func
    const fn = new Function('return (async () => { ' + expr + ' })()')
    const raw = fn()
    // 支持 Promise
    if (raw && typeof raw.then === 'function') {
      // 导航会让这个 Promise 永远不 resolve —— 上面 cmdTabEval 已用 race 兜住，
      // 这里再包一层超时，避免异常情况下卡死注入通道。
      return Promise.race([
        raw.then(
          (v) => safeJson(v),
          (e) => ({ __error: 'eval_failed', __message: String((e && e.message) || e) }),
        ),
        new Promise((res) => setTimeout(() => res({ value: null, type: 'pending' }), 5000)),
      ])
    }
    return safeJson(raw)
  } catch (e) {
    return { __error: 'eval_failed', __message: String((e && e.message) || e) }
  }
  function safeJson(v) {
    if (v === undefined) return { value: null, type: 'undefined' }
    try {
      const s = JSON.stringify(v)
      if (s === undefined) return { value: String(v), type: typeof v }
      // 太大的结果截断，避免把整页 DOM 塞进消息
      return { value: s.length > 20000 ? JSON.parse(s.slice(0, 20000) + '"') : v, type: typeof v }
    } catch {
      return { value: String(v), type: typeof v }
    }
  }
}

/** 按键：支持单键、组合键（Control+a / Shift+Tab / Control+Shift+Enter）。
 *
 *  为什么不用 chrome.debugger 的 Input.dispatchKeyEvent：
 *  那需要 attach + 会弹调试横幅；扩展注入的合成事件对绝大多数 SPA 够用，
 *  且不抢焦点。真正的系统级快捷键（如 Ctrl+W 关标签）注入做不到，需要用户手动。
 */
function pageKey(opts) {
  try {
    const combo = String((opts && opts.key) || '').trim()
    if (!combo) return { __error: 'bad_args', __message: 'key 必填，例如 "Enter" 或 "Control+a"' }

    const ref = opts && opts.ref
    let target = null
    if (ref) {
      target = document.querySelector(`[data-dsh-ref="${String(ref).replace(/"/g, '')}"]`)
      if (!target) return { __error: 'stale_ref', __message: `找不到 ref=${ref} 的元素（重新取快照）` }
      try { target.focus() } catch { /* ignore */ }
    } else {
      target = document.activeElement || document.body
    }

    // 解析 "Control+Shift+a" → { key:'a', ctrl:true, shift:true }
    const parts = combo.split('+').map((x) => x.trim()).filter(Boolean)
    const main = parts.length > 1 ? parts[parts.length - 1] : parts[0]
    const mods = new Set(parts.slice(0, -1).map((x) => x.toLowerCase()))
    const ctrl = mods.has('control') || mods.has('ctrl')
    const shift = mods.has('shift')
    const alt = mods.has('alt')
    const metakey = mods.has('meta') || mods.has('command') || mods.has('cmd')

    const init = {
      key: main.length === 1 ? main : main,
      code: main.length === 1 ? `Key${main.toUpperCase()}` : main,
      bubbles: true, cancelable: true, composed: true,
      ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: metakey,
    }

    const fire = (type) => {
      let ev
      if (type === 'keydown' || type === 'keyup') ev = new KeyboardEvent(type, init)
      else ev = new KeyboardEvent(type, init)
      target.dispatchEvent(ev)
      return ev.defaultPrevented
    }

    fire('keydown')
    // 单字符且无修饰键：补一个 keypress（有些老站只监听 keypress）
    if (main.length === 1 && !ctrl && !alt && !metakey) {
      try { target.dispatchEvent(new KeyboardEvent('keypress', init)) } catch { /* ignore */ }
    }
    fire('keyup')

    return {
      key: combo,
      resolved: { key: main, ctrl, shift, alt, meta: metakey },
      tag: target.tagName ? target.tagName.toLowerCase() : 'body',
      active: target === document.activeElement,
    }
  } catch (e) {
    return { __error: 'key_failed', __message: String((e && e.message) || e) }
  }
}

/** 滚动：按像素 / 按屏 / 滚到指定元素。
 *  虚拟列表（Gmail、Twitter）必须靠这个才能让后面的元素进入视口。 */
function pageScroll(opts) {
  try {
    const mode = String((opts && opts.mode) || 'by')   // by | to | top | bottom
    const ref = opts && opts.ref
    const dir = String((opts && opts.direction) || 'down')
    const amount = Number((opts && opts.amount) || 1)
    const pixels = Number((opts && opts.pixels) || 0)

    const before = window.scrollY

    if (mode === 'to' || ref) {
      const el = ref ? document.querySelector(`[data-dsh-ref="${String(ref).replace(/"/g, '')}"]`) : null
      if (!el) return { __error: 'stale_ref', __message: `找不到 ref=${ref} 的元素（重新取快照）` }
      try { el.scrollIntoView({ block: (opts && opts.block) || 'center', behavior: 'instant' }) } catch { /* ignore */ }
    } else if (mode === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' })
    } else if (mode === 'bottom') {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
    } else {
      const vh = window.innerHeight || 600
      const delta = pixels || (amount * vh * 0.85)
      const dy = dir === 'up' ? -delta : delta
      const dx = dir === 'left' ? -delta : (dir === 'right' ? delta : 0)
      window.scrollBy({ top: dy, left: dx, behavior: 'instant' })
    }

    // 有些站点的滚动容器不是 window，而是某个 div —— 兜底再滚一下
    if (window.scrollY === before) {
      const scroller = document.scrollingElement || document.documentElement
      const vh = window.innerHeight || 600
      const delta = pixels || (amount * vh * 0.85)
      const dy = dir === 'up' ? -delta : delta
      if (scroller && mode === 'by') scroller.scrollTop += dy
    }

    return {
      mode, direction: dir,
      from: Math.round(before),
      to: Math.round(window.scrollY),
      max: Math.round(Math.max(0, (document.body.scrollHeight || 0) - window.innerHeight)),
    }
  } catch (e) {
    return { __error: 'scroll_failed', __message: String((e && e.message) || e) }
  }
}

/** 输入文本：input/textarea 走原生 setter + input/change；contenteditable 走 execCommand。 */
function pageType(opts) {
  try {
    const ref = opts && opts.ref
    const text = String((opts && opts.text) == null ? '' : opts.text)
    const clear = opts && opts.clear !== false
    const el = ref ? document.querySelector(`[data-dsh-ref="${String(ref).replace(/"/g, '')}"]`) : null
    if (!el) return { __error: 'stale_ref', __message: `找不到 ref=${ref} 的元素（重新取快照）` }

    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }) } catch { /* ignore */ }
    try { el.focus() } catch { /* ignore */ }

    const isEditable = el.isContentEditable === true
    const tag = el.tagName.toLowerCase()

    if (isEditable) {
      if (clear) {
        const sel = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(el)
        if (sel) { sel.removeAllRanges(); sel.addRange(range) }
        try { document.execCommand('delete') } catch { el.textContent = '' }
      }
      const ok = (() => {
        try { return document.execCommand('insertText', false, text) } catch { return false }
      })()
      if (!ok) {
        el.textContent = (clear ? '' : String(el.textContent || '')) + text
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
      }
    } else if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      const next = clear ? text : String(el.value || '') + text
      if (desc && desc.set) desc.set.call(el, next)
      else el.value = next
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else if (tag === 'select') {
      el.value = text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    } else {
      // 兜底：不可编辑元素上直接塞文本
      el.textContent = text
      el.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }

    const submitted = { done: false, via: null }
    if (opts && opts.submit) {
      const keyInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true }
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit))
      el.dispatchEvent(new KeyboardEvent('keypress', keyInit))
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit))
      const form = el.form || (el.closest ? el.closest('form') : null)
      if (form) {
        try {
          if (typeof form.requestSubmit === 'function') { form.requestSubmit(); submitted.done = true; submitted.via = 'requestSubmit' }
          else { form.submit(); submitted.done = true; submitted.via = 'form.submit' }
        } catch { /* ignore */ }
      }
      if (!submitted.done) {
        const btn = (form && form.querySelector('button[type="submit"],input[type="submit"],button:not([type])')) ||
          document.querySelector('button[type="submit"],input[type="submit"]')
        if (btn) { try { btn.click(); submitted.done = true; submitted.via = 'button.click' } catch { /* ignore */ } }
      }
    }

    const value = tag === 'input' || tag === 'textarea' ? String(el.value || '') : String(el.textContent || '')
    return {
      typed: { ref: ref || null, valueLength: value.length, value: value.slice(0, 200), tag },
      submitted,
      url: location.href,
      title: document.title || '',
    }
  } catch (e) {
    return { __error: 'type_failed', __message: String((e && e.message) || e) }
  }
}

/* ── 主题自适应图标 ──────────────────────────────────────────────────
 *
 * Chrome 扩展图标本身不会跟随系统深浅色。要做"白天蓝鲸、夜里黑鲸"，
 * 只能自己监听系统的 prefers-color-scheme，然后调 chrome.action.setIcon。
 *
 * 判据用 matchMedia('(prefers-color-scheme: dark)')，它跟随 Windows 的
 * 「应用模式」（设置 → 个性化 → 颜色）。系统切换时会触发 change 事件。
 */

const ICON_SIZES = [16, 32, 48, 64, 128]

function iconPaths(dark) {
  const dir = dark ? 'icons/dark' : 'icons'
  const out = {}
  for (const s of ICON_SIZES) out[s] = `${dir}/icon${s}.png`
  return out
}

async function applyThemeIcon(dark) {
  try {
    await chrome.action.setIcon({ path: iconPaths(dark) })
    await chrome.action.setTitle({
      title: dark ? '大肥鱼 · DSH Session Bridge（夜间模式）' : '大肥鱼 · DSH Session Bridge（日间模式）',
    })
    currentDarkIcon = dark
    return true
  } catch {
    return false
  }
}

let currentDarkIcon = null
let themeWatcher = null

/** 订阅系统主题；切换时换图标。重复调用安全（只装一次）。 */
function watchSystemTheme() {
  if (themeWatcher) return
  // MV3 Service Worker 里 matchMedia 不一定存在（不是 window 上下文）。
  // 有就用它订阅变化；没有就退化成"每次唤醒读一次"——SW 每次启动都会跑
  // 这段顶层代码，所以用户切换系统主题后再触发一次扩展活动，图标也会跟上。
  try {
    if (typeof self !== 'undefined' && typeof self.matchMedia === 'function') {
      const mq = self.matchMedia('(prefers-color-scheme: dark)')
      currentDarkIcon = Boolean(mq.matches)
      applyThemeIcon(currentDarkIcon)
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', (e) => { applyThemeIcon(Boolean(e.matches)) })
      } else if (typeof mq.addListener === 'function') {
        mq.addListener((e) => { applyThemeIcon(Boolean(e.matches)) })
      }
      themeWatcher = mq
      return
    }
  } catch { /* 往下走兜底 */ }

  // 没有 matchMedia：用 offscreen 文档也过重，直接保持白天图标（蓝鲸）。
  // 用户若要强制夜间：chrome.action.setIcon 由下面的 theme 命令暴露。
  applyThemeIcon(false)
}

/** 手动指定图标主题：'auto' | 'light' | 'dark'（给 tool 层用） */
async function cmdThemeIcon(params) {
  const mode = String(params.mode || 'auto')
  if (mode === 'dark') { await applyThemeIcon(true); return { ok: true, mode, dark: true } }
  if (mode === 'light') { await applyThemeIcon(false); return { ok: true, mode, dark: false } }
  // auto
  let dark = false
  try {
    if (typeof self !== 'undefined' && typeof self.matchMedia === 'function') {
      dark = Boolean(self.matchMedia('(prefers-color-scheme: dark)').matches)
    }
  } catch { /* ignore */ }
  await applyThemeIcon(dark)
  return { ok: true, mode: 'auto', dark, current: currentDarkIcon }
}

/* ── 各命令实现 ─────────────────────────────────────────────────────── */

async function cmdTabsList(params) {
  const tabs = await chrome.tabs.query({})
  const includeChrome = params.includeChrome !== false
  const out = []
  for (const t of tabs) {
    const url = t.url || t.pendingUrl || ''
    const internal = /^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)
    if (!includeChrome && internal) continue
    out.push({
      id: t.id,
      windowId: t.windowId,
      index: t.index,
      title: t.title || '',
      url,
      active: Boolean(t.active),
      pinned: Boolean(t.pinned),
      audible: Boolean(t.audible),
      discarded: Boolean(t.discarded),
      status: t.status || '',
      injectable: !internal && !t.discarded,
    })
  }
  out.sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index))
  return { tabs: out, count: out.length }
}

async function cmdTabInfo(params) {
  const tab = await resolveTab(params.tabId)
  return { ok: true, tab: { id: tab.id, title: tab.title || '', url: tab.url || '', active: Boolean(tab.active) } }
}

async function cmdTabSnapshot(params) {
  const tab = await resolveTab(params.tabId)
  assertInjectable(tab)
  const r = await inject(tab.id, pageSnapshot, {
    maxElements: params.maxElements || 120,
    selector: params.selector || null,
    text: params.text === true,
  })
  // ── 视口覆盖情况 ──
  // 快照只取当前视口附近。长页面/虚拟滚动列表里靠后的元素取不到，
  // 调用方需要知道"还有多少没看到"，否则会以为页面就这么多东西。
  const scroll = r.scroll || { x: 0, y: 0 }
  const viewport = r.viewport || { w: 0, h: 0 }
  const docH = Number(r.docHeight) || 0
  const coveredBottom = scroll.y + viewport.h
  const uncoveredBelow = docH > 0 ? Math.max(0, docH - coveredBottom) : null

  return {
    ok: true,
    tabId: tab.id,
    title: r.title,
    url: r.url,
    scroll,
    viewport,
    docHeight: docH || null,
    // 视口下方还有多少像素没覆盖（null = 拿不到页面总高）
    uncoveredBelow,
    coveredRange: docH > 0 ? { from: scroll.y, to: Math.min(coveredBottom, docH) } : null,
    // 明确告诉调用方怎么拿到下面的内容
    hint: uncoveredBelow && uncoveredBelow > 50
      ? `当前视口只覆盖到 ${Math.round(coveredBottom)}px，页面总高 ${docH}px，`
        + `下方还有 ${Math.round(uncoveredBelow)}px 未取。`
        + '用 browser_scroll({ mode: "by", pixels: N }) 往下滚再取快照。'
      : null,
    elementCount: r.elementCount,
    truncated: r.truncated,
    elements: r.elements,
    text: r.text,
  }
}

async function cmdTabClick(params) {
  const tab = await resolveTab(params.tabId)

  // ── CDP 模式：真实鼠标事件（isTrusted）──
  // 用于注入点击被忽略的站点（Canvas 应用、防自动化站点）。
  const mode = String(params.mode || 'dom').toLowerCase()
  if (mode === 'cdp') {
    let x = Number(params.x)
    let y = Number(params.y)
    // 给了 ref 就先算它的视口中心坐标
    if (params.ref) {
      const box = await inject(tab.id, (opts) => {
        const el = document.querySelector(`[data-dsh-ref="${String(opts.ref).replace(/"/g, '')}"]`)
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, { ref: params.ref }).catch(() => null)
      if (!box) throw bridgeError('stale_ref', `找不到 ref=${params.ref} 的元素`)
      x = box.x; y = box.y
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw bridgeError('bad_args', 'cdp 模式需要 ref 或 x/y')
    }
    const r = await cdpClick(tab.id, x, y, { double: params.double === true })
    return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
  }

  assertInjectable(tab)
  const beforeUrl = tab.url || ''

  // ── 关键：**不等**注入脚本返回 ──
  // 点击链接会触发导航，页面 JS 上下文在导航瞬间销毁，
  // executeScript 的 Promise 可能永远不 resolve（实测 Google 搜索结果卡 20s）。
  // 所以这里 fire-and-forget：只把"去点"这件事丢进页面，立刻返回，
  // 然后用 chrome.tabs 的 URL 变化来判断结果。永不挂死。
  const fire = inject(tab.id, pageClick, {
    ref: params.ref || null,
    x: params.x,
    y: params.y,
    double: params.double === true,
  })

  let clickMeta = null
  let clickErr = null
  // 给注入脚本最多 2.5s 回话；不回就算了，不影响结论
  const raced = await Promise.race([
    fire.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e })),
    sleep(2500).then(() => ({ ok: false, e: new Error('inject-no-reply') })),
  ])
  if (raced.ok) {
    clickMeta = raced.v
  } else if (raced.e && String(raced.e.message) !== 'inject-no-reply') {
    // inject() 已把页面侧的 {__error} 转成 bridgeError，
    // 这里原样上抛（stale_ref / bad_args / no_element_at_point …）
    throw raced.e
  }

  // ── 等页面反应：URL 变了 / status 变 loading 都算点成功 ──
  let changed = false
  for (let i = 0; i < 30; i++) {
    await sleep(100)
    let now
    try { now = await chrome.tabs.get(tab.id) } catch { break }
    if (now.url && now.url !== beforeUrl) { changed = true; break }
    if (now.status === 'loading') { changed = true; break }
  }

  // 等到不再是 loading（最多 12s），给 SPA 渲染时间
  for (let i = 0; i < 60; i++) {
    let now
    try { now = await chrome.tabs.get(tab.id) } catch { break }
    if (now.status !== 'loading') break
    await sleep(200)
  }
  await sleep(250)

  const out = { ok: true, tabId: tab.id, navigated: changed }
  if (clickMeta) {
    out.clicked = clickMeta.clicked
    out.rect = clickMeta.rect
  }
  if (clickErr) out.clickError = clickErr

  if (params.snapshot !== false) {
    try {
      const snap = await injectWithTimeout(tab.id, pageSnapshot,
        { maxElements: params.maxElements || 80, text: false }, 6000)
      out.url = snap.url
      out.title = snap.title
      out.elementCount = snap.elementCount
      out.elements = snap.elements
      out.text = snap.text
      if (snap.costMs) out.snapshotCostMs = snap.costMs
    } catch (e) {
      out.snapshotError = String((e && e.message) || e)
    }
  }
  return out
}

async function cmdTabType(params) {
  const tab = await resolveTab(params.tabId)
  const tMode = String(params.mode || 'dom').toLowerCase()

  // ── CDP 模式：Input.insertText，isTrusted，且比逐键快 ──
  if (tMode === 'cdp') {
    if (params.ref) {
      await inject(tab.id, (opts) => {
        const el = document.querySelector(`[data-dsh-ref="${String(opts.ref).replace(/"/g, '')}"]`)
        if (el && typeof el.focus === 'function') el.focus()
        // 需要清空就先全选
        if (opts.clear && el && typeof el.select === 'function') { try { el.select() } catch { } }
        return true
      }, { ref: params.ref, clear: params.clear !== false }).catch(() => null)
    }
    const r = await cdpType(tab.id, params.text)
    return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
  }

  assertInjectable(tab)
  const r = await inject(tab.id, pageType, {
    ref: params.ref,
    text: params.text,
    clear: params.clear !== false,
    submit: params.submit === true,
  })
  const out = { ok: true, tabId: tab.id, typed: r.typed, submitted: r.submitted, url: r.url, title: r.title }
  if (params.snapshot === true) {
    await sleep(params.submit ? 900 : 300)
    try {
      const snap = await inject(tab.id, pageSnapshot, { maxElements: params.maxElements || 80, text: true })
      out.url = snap.url
      out.title = snap.title
      out.elementCount = snap.elementCount
      out.elements = snap.elements
      out.text = snap.text
    } catch (e) {
      out.snapshotError = String((e && e.message) || e)
    }
  }
  return out
}

async function cmdTabNavigate(params) {
  // ── 导航历史：back / forward / reload ──
  if (params.back === true || params.forward === true || params.reload === true) {
    const tab = await resolveTab(params.tabId)
    if (params.back === true || params.forward === true) {
      // 用 CDP 的 Page.navigateToHistoryEntry 或 Runtime.evaluate 调 history.back()
      // 注意：不能走 inject(pageEval) —— new Function 会被页面 CSP 拦掉。
      const before = tab.url || ''
      let changed = false
      let via = 'cdp'

      // 先查能不能后退（用 CDP 读 history.length 和前一条 URL）
      const hist = await evaluateInPage(tab.id, `JSON.stringify({len: history.length, href: location.href})`)
      if (!hist.ok) throw bridgeError('eval_failed', hist.error.message)
      let histInfo = {}
      try { histInfo = JSON.parse(hist.value) } catch { /* ignore */ }

      if (!histInfo.len || histInfo.len < 2) {
        throw bridgeError('no_history', params.back ? '没有上一页' : '没有下一页')
      }

      // 用 CDP 执行 history.back/forward（不受 CSP 限制）
      const r = await evaluateInPage(tab.id,
        `(() => { history.${params.back ? 'back' : 'forward'}(); return 'ok' })()`)
      if (!r.ok) throw bridgeError('eval_failed', r.error.message)

      // history.back 是异步的，等 URL 变化
      for (let i = 0; i < 50; i++) {
        await sleep(120)
        let now
        try { now = await chrome.tabs.get(tab.id) } catch { break }
        if (now.url && now.url !== before) { changed = true; break }
        if (now.status === 'loading') { changed = true; break }
      }
      // 兜底：URL 没变就试 chrome.tabs.goBack
      if (!changed) {
        via = 'tabs-api'
        try {
          if (params.back) await chrome.tabs.goBack(tab.id)
          else await chrome.tabs.goForward(tab.id)
          await sleep(500)
          const now = await chrome.tabs.get(tab.id)
          changed = Boolean(now.url && now.url !== before)
        } catch {
          throw bridgeError('no_history', params.back ? '没有上一页' : '没有下一页')
        }
      }
      if (!changed) throw bridgeError('no_history', params.back ? '没有上一页' : '没有下一页')
    } else {
      await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true })
    }

    await waitForLoad(tab.id, Math.max(800, Number(params.waitMs) || 600))
    const fresh = await chrome.tabs.get(tab.id)
    const out = { ok: true, tabId: tab.id, url: fresh.url || '', title: fresh.title || '', action: params.back ? 'back' : (params.forward ? 'forward' : 'reload') }
    try {
      const snap = await injectWithTimeout(tab.id, pageSnapshot, { maxElements: params.maxElements || 60, text: false }, 8000)
      out.elementCount = snap.elementCount
      out.elements = snap.elements
    } catch (e) { out.snapshotError = String((e && e.message) || e) }
    return out
  }

  const url = String(params.url || '')
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) throw bridgeError('bad_args', `url 需要带 scheme：${url}`)
  let tab
  if (params.newTab === false) {
    tab = await resolveTab(params.tabId)
    await chrome.tabs.update(tab.id, { url, active: params.active === true })
  } else if (typeof params.tabId === 'number') {
    await chrome.tabs.update(params.tabId, { url, active: params.active === true })
    tab = await chrome.tabs.get(params.tabId)
  } else {
    const cur = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = await chrome.tabs.create({
      url,
      active: params.active === true,   // 默认后台打开，不抢焦点
      windowId: cur.length > 0 ? cur[0].windowId : undefined,
    })
    // 插件自己开的标签登记到隐式租约 —— 到期自动关，不占内存。
    // params.keepAlive === true 可豁免（调用方想长期留着这页）。
    if (params.keepAlive !== true) trackAutoTab(tab && tab.id, params.leaseTtlMs)
  }

  // ── 立刻归组：不等加载完。
  //    chrome.tabs.create 返回时 tab 已经存在，马上 group 进去，
  //    用户视角就是"标签一出现就已经在组里"，没有裸标签的过渡态。
  if (params.group !== false && tab && tab.id !== undefined) {
    try {
      await cmdGroupEnsure({
        tabId: tab.id,
        title: params.groupTitle || DEFAULT_GROUP_TITLE,
        color: params.groupColor,
        collapsed: params.collapsed,
      })
    } catch (e) { noteErr('autoGroup', e) }
  }

  // 兜底：chrome.tabs.create 偶发返回没有 id 的对象（实测约 20% 概率，
  // 出现在刚装扩展、SW 冷启动后的第一批调用里）。
  // 拿不到 id 就按 url + 剩余标签集合重新定位。
  if (!tab || tab.id === undefined || tab.id === null) {
    const all = await chrome.tabs.query({})
    const hit = all.find((t) => (t.url || '') === url || (t.pendingUrl || '') === url)
      || all.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
    if (hit) tab = hit
  }
  if (!tab || tab.id === undefined || tab.id === null) {
    throw bridgeError('create_failed', `开新标签失败：chrome.tabs.create 没返回 id（url=${url}）`)
  }

  await waitForLoad(tab.id, Math.max(1500, Number(params.waitMs) || 600))
  const fresh = await chrome.tabs.get(tab.id)
  const out = { ok: true, tabId: tab.id, url: fresh.url || url, title: fresh.title || '' }
  try {
    const snap = await inject(tab.id, pageSnapshot, { maxElements: params.maxElements || 100, text: false })
    out.url = snap.url
    out.title = snap.title
    out.elementCount = snap.elementCount
    out.elements = snap.elements
    out.text = snap.text
  } catch (e) {
    out.snapshotError = String((e && e.message) || e)
  }
  return out
}

async function cmdTabKey(params) {
  const tab = await resolveTab(params.tabId)
  const keyMode = String(params.mode || 'dom').toLowerCase()

  // ── CDP 模式：真实按键，能触发只认 isTrusted 的站点（如 Google 搜索框回车）──
  if (keyMode === 'cdp') {
    if (params.ref) {
      // 先把焦点放到目标元素上
      await inject(tab.id, (opts) => {
        const el = document.querySelector(`[data-dsh-ref="${String(opts.ref).replace(/"/g, '')}"]`)
        if (el && typeof el.focus === 'function') el.focus()
        return true
      }, { ref: params.ref }).catch(() => null)
    }
    const r = await cdpKey(tab.id, params.key)
    return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
  }

  assertInjectable(tab)
  const r = await inject(tab.id, pageKey, {
    key: params.key,
    ref: params.ref || null,
  })
  const out = { ok: true, tabId: tab.id, key: r.key, resolved: r.resolved, active: r.active }
  if (params.snapshot === true) {
    try {
      const snap = await injectWithTimeout(tab.id, pageSnapshot, { maxElements: 60, text: false }, 6000)
      out.url = snap.url
      out.title = snap.title
      out.elementCount = snap.elementCount
      out.elements = snap.elements
    } catch (e) { out.snapshotError = String((e && e.message) || e) }
  }
  return out
}

async function cmdTabScroll(params) {
  const tab = await resolveTab(params.tabId)
  assertInjectable(tab)
  const r = await inject(tab.id, pageScroll, {
    mode: params.mode || 'by',
    direction: params.direction || 'down',
    amount: params.amount,
    pixels: params.pixels,
    ref: params.ref || null,
    block: params.block,
  })
  const out = { ok: true, tabId: tab.id, scroll: r }
  if (params.snapshot === true) {
    try {
      const snap = await injectWithTimeout(tab.id, pageSnapshot, { maxElements: 80, text: false }, 8000)
      out.url = snap.url
      out.title = snap.title
      out.elementCount = snap.elementCount
      out.elements = snap.elements
    } catch (e) { out.snapshotError = String((e && e.message) || e) }
  }
  return out
}

/** 批量执行：一条消息里跑多个动作，只回一次结果。
 *
 *  为什么快：每个命令单独发要一次 WebSocket 往返（本机约 2-5ms，
 *  但 DOM 操作本身要等渲染），批量后中间动作不产生往返，
 *  只在最后取一次快照。WorkBuddy 的 features:["batch"] 就是这个。
 *
 *  actions: [{ op:'click', ref }, { op:'type', ref, text }, { op:'key', key }, ...]
 *  每条都是上面单个命令的 params 再加 op 字段。
 */
async function cmdTabBatch(params) {
  const tab = await resolveTab(params.tabId)
  assertInjectable(tab)
  const actions = Array.isArray(params.actions) ? params.actions : []
  if (actions.length === 0) throw bridgeError('bad_args', 'actions 必须是非空数组')
  if (actions.length > 50) throw bridgeError('bad_args', 'actions 最多 50 条')

  const results = []
  const t0 = Date.now()
  let aborted = null   // { index, op, reason, code }

  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] || {}
    const op = String(a.op || '').toLowerCase()
    const started = Date.now()
    try {
      let r
      if (op === 'click') {
        r = await inject(tab.id, pageClick, { ref: a.ref || null, x: a.x, y: a.y, double: a.double === true })
        // 点击可能触发导航：给一点时间，别立刻注入下一条
        if (a.waitAfter) await sleep(Math.min(5000, Number(a.waitAfter)))
        else await sleep(80)
      } else if (op === 'type') {
        r = await inject(tab.id, pageType, { ref: a.ref, text: a.text, clear: a.clear !== false })
      } else if (op === 'key') {
        r = await inject(tab.id, pageKey, { key: a.key, ref: a.ref || null })
        if (a.waitAfter) await sleep(Math.min(5000, Number(a.waitAfter)))
      } else if (op === 'scroll') {
        r = await inject(tab.id, pageScroll, {
          mode: a.mode || 'by', direction: a.direction || 'down',
          amount: a.amount, pixels: a.pixels, ref: a.ref || null,
        })
        if (a.waitAfter) await sleep(Math.min(5000, Number(a.waitAfter)))
      } else if (op === 'wait') {
        await sleep(Math.min(10000, Number(a.ms) || 300))
        r = { waited: Number(a.ms) || 300 }
      } else if (op === 'navigate') {
        await chrome.tabs.update(tab.id, { url: String(a.url || '') })
        await waitForLoad(tab.id, Math.max(500, Number(a.waitMs) || 400))
        r = { navigated: true }
      } else if (op === 'snapshot') {
        r = await injectWithTimeout(tab.id, pageSnapshot,
          { maxElements: a.maxElements || 60, text: a.text === true }, 8000)
      } else {
        throw bridgeError('bad_args', `不支持的 op: ${op}（可用 click/type/key/scroll/wait/navigate/snapshot）`)
      }
      results.push({ index: i, op, ok: true, costMs: Date.now() - started, result: r })
    } catch (e) {
      const msg = String((e && e.message) || e)
      // 导航会让页面 JS 上下文销毁，注入类动作会报这几类错
      const navLike = /context|destroyed|detached|frame|navigation|Cannot access|no tab with id/i.test(msg)
      const code = navLike ? 'navigation_interrupted' : ((e && e.code) || 'action_failed')

      results.push({
        index: i, op, ok: false, costMs: Date.now() - started,
        error: { code, message: msg },
      })

      // 默认遇错即停（fail-fast），除非显式 continueOnError
      if (params.continueOnError !== true) {
        aborted = { index: i, op, code, reason: msg.slice(0, 200) }
        break
      }
    }
  }

  // 最后统一取一次快照（批量最大的收益点）
  const remaining = actions.length - results.length
  const out = {
    ok: results.every((x) => x.ok),
    tabId: tab.id,
    actionCount: actions.length,
    executed: results.length,
    // 明确告诉调用方还有几个没跑 —— 之前只能靠 actionCount - executed 自己算
    remaining,
    aborted,
    costMs: Date.now() - t0,
    results,
  }
  if (aborted) {
    out.hint = aborted.code === 'navigation_interrupted'
      ? `第 ${aborted.index} 个动作（${aborted.op}）触发了页面导航，`
        + `后续 ${remaining} 个动作未执行。请重新取快照确认新页面状态后再继续。`
      : `第 ${aborted.index} 个动作（${aborted.op}）失败，`
        + `后续 ${remaining} 个动作未执行。`
  }
  if (params.snapshot !== false) {
    try {
      const snap = await injectWithTimeout(tab.id, pageSnapshot,
        { maxElements: params.maxElements || 80, text: false }, 10000)
      out.url = snap.url
      out.title = snap.title
      out.elementCount = snap.elementCount
      out.elements = snap.elements
      out.text = snap.text
    } catch (e) { out.snapshotError = String((e && e.message) || e) }
  }
  return out
}

async function cmdTabEval(params) {
  const tab = await resolveTab(params.tabId)
  assertInjectable(tab)
  const expr = String(params.expr || '')
  const beforeUrl = tab.url || ''

  // 表达式里如果有导航（location.href= / location.assign / location.replace /
  // window.open），注入脚本会被卸载 → Promise 永不 resolve → 20s 超时。
  // 处理方式和点击导航一致：先返回，再让页面自己跳。
  const navigates = /\blocation\s*\.\s*(href\s*=|assign|replace)|window\s*\.\s*open\s*\(/.test(expr)

  if (navigates) {
    const fire = evaluateInPage(tab.id, expr)
    // 最多等 1.5s 拿返回值；拿不到就认为它去导航了
    const raced = await Promise.race([
      fire.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, e })),
      sleep(1500).then(() => ({ ok: false, e: new Error('navigating') })),
    ])

    // 等 URL 变化 + 加载完成
    for (let i = 0; i < 40; i++) {
      await sleep(150)
      let now
      try { now = await chrome.tabs.get(tab.id) } catch { break }
      if (now.url && now.url !== beforeUrl && now.status === 'complete') break
    }
    let fresh = tab
    try { fresh = await chrome.tabs.get(tab.id) } catch (e) { noteErr('screenshot.getTab', e) }
    return {
      ok: true, tabId: tab.id, navigated: true,
      url: fresh.url || '', title: fresh.title || '',
      value: raced.ok && raced.v ? raced.v.value : null,
    }
  }

  const r = await evaluateInPage(tab.id, expr)
  if (!r.ok) throw bridgeError(r.error.code, r.error.message)
  return { ok: true, tabId: tab.id, value: r.value, type: r.type, via: r.via }
}

/** 拖拽（CDP 真实鼠标）。from/to 都是视口坐标，也可以给两个 ref。 */
async function cmdTabDrag(params) {
  const tab = await resolveTab(params.tabId)
  const resolvePoint = async (ref, x, y) => {
    if (ref) {
      const box = await inject(tab.id, (opts) => {
        const el = document.querySelector(`[data-dsh-ref="${String(opts.ref).replace(/"/g, '')}"]`)
        if (!el) return null
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, { ref }).catch(() => null)
      if (!box) throw bridgeError('stale_ref', `找不到 ref=${ref}`)
      return box
    }
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
      throw bridgeError('bad_args', '需要 ref 或 x/y')
    }
    return { x: Number(x), y: Number(y) }
  }
  const from = await resolvePoint(params.fromRef, params.fromX, params.fromY)
  const to = await resolvePoint(params.toRef, params.toX, params.toY)
  const r = await cdpDrag(tab.id, from, to, { steps: params.steps })
  return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
}

/** 鼠标动作：move / wheel。 */
async function cmdTabMouse(params) {
  const tab = await resolveTab(params.tabId)
  const action = String(params.action || 'wheel').toLowerCase()
  const x = Number(params.x)
  const y = Number(params.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw bridgeError('bad_args', '需要 x/y')

  if (action === 'wheel' || action === 'scroll') {
    const r = await cdpScroll(tab.id, x, y, Number(params.deltaX) || 0, Number(params.deltaY) || 0)
    return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
  }
  if (action === 'move') {
    const r = await withDebugger(tab.id, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      return { moved: { x, y } }
    })
    return { ok: true, tabId: tab.id, mode: 'cdp', ...r }
  }
  throw bridgeError('bad_args', `不支持的 action: ${action}（可用 move/wheel）`)
}

/**
 * 整页截图：用 clip 指定区域，**不改视口**。
 *
 * 历史：早先用 Emulation.setDeviceMetricsOverride 把视口临时设成整页高度，
 * 再截一次、再清掉。问题是这样会让页面按新尺寸重排两次（设一次、清一次），
 * 肉眼能看到明显跳动 —— 用户正在看这个标签时会很难受。
 *
 * 现在改成 Page.captureScreenshot 的 clip + captureBeyondViewport：
 * 渲染器在不改变视口的前提下按 clip 区域渲染一帧。页面布局完全不动。
 *
 * 超长页面处理：Chrome 单帧纹理上限约 16384px，超过就降 scale。
 * 再超过 maxHeight 就截断，返回里标 truncated。
 */
async function captureFullPage(tabId, fmt, quality, maxHeight = 16000) {
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true

    // 1) 页面真实尺寸
    const m1 = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')
    const css = m1.cssContentSize || m1.contentSize
    const fullW = Math.ceil(css.width)
    const rawH = Math.ceil(css.height)
    if (!fullW || !rawH) throw bridgeError('capture_failed', '拿不到页面尺寸')

    const vp = m1.cssLayoutViewport || m1.layoutViewport
    const vpW = Math.ceil(vp.clientWidth) || 1280
    const vpH = Math.ceil(vp.clientHeight) || 800

    // 2) 决定截取高度与缩放
    const targetH = Math.min(rawH, maxHeight)
    // 纹理上限 16384，留一点余量
    const scale = Math.min(1, 16000 / Math.max(targetH, 1))

    // 3) 直接按 clip 截，不动视口
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: fmt,
      quality: fmt === 'jpeg' ? quality : undefined,
      clip: {
        x: 0,
        y: 0,
        width: fullW,
        height: targetH,
        scale,
      },
      captureBeyondViewport: true,   // 允许渲染视口外区域
      fromSurface: true,
    })
    if (!shot || !shot.data) throw bridgeError('capture_failed', 'CDP 没有返回图像数据')

    return {
      dataUrl: `data:image/${fmt};base64,${shot.data}`,
      fullWidth: Math.round(fullW * scale),
      fullHeight: Math.round(targetH * scale),
      originalWidth: fullW,
      originalHeight: rawH,
      scale,
      truncated: rawH > targetH,
      viewportWidth: vpW,
      viewportHeight: vpH,
      // 标记：这版不再改视口，页面不会重排
      layoutUntouched: true,
    }
  } finally {
    if (attached) { try { await chrome.debugger.detach(target) } catch { /* ignore */ } }
  }
}

async function cmdTabScreenshot(params) {
  const tab = await resolveTab(params.tabId)
  const fmt = params.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = Math.max(1, Math.min(100, Number(params.quality) || 80))
  const wantActive = params.keepForeground === true   // 默认绝不切前台

  // ── 整页截图：分块取，交给插件侧拼 ──
  if (params.fullPage === true) {
    const r = await captureFullPage(tab.id, fmt, quality, Number(params.maxHeight) || 16000)
    return {
      ok: true,
      tabId: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      mode: 'fullpage',
      dataUrl: r.dataUrl,
      width: r.fullWidth,
      height: r.fullHeight,
      originalWidth: r.originalWidth,
      originalHeight: r.originalHeight,
      scale: r.scale,
      truncated: r.truncated,
      viewport: { w: r.viewportWidth, h: r.viewportHeight },
      format: fmt,
    }
  }

  // ── 首选：CDP Page.captureScreenshot，后台截，完全不碰焦点 ──
  // captureVisibleTab 只有在标签页可见时才有画面，所以它必须先把 tab 切前台 ——
  // 那就是"抢焦点"的根源。CDP 直接问渲染器要一帧，后台也能拿。
  let dataUrl = null
  let method = ''
  let cdpErr = null
  const target = { tabId: tab.id }

  try {
    await chrome.debugger.attach(target, '1.3')
    try {
      // 同上：不调 setFocusEmulationEnabled。
      // Page.captureScreenshot 不依赖 rAF，不需要伪造焦点。
      const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format: fmt,
        quality: fmt === 'jpeg' ? quality : undefined,
        captureBeyondViewport: false,
        fromSurface: true,
      })
      if (shot && shot.data) {
        dataUrl = `data:image/${fmt};base64,${shot.data}`
        method = 'cdp'
      }
    } finally {
      try { await chrome.debugger.detach(target) } catch { /* ignore */ }
    }
  } catch (e) {
    cdpErr = e
  }

  // ── 兜底：cdp 不可用（某些受保护页 / debugger 被占）才退回 captureVisibleTab。
  //        这时如果调用方明确允许切前台才切，否则宁可报错也不抢用户焦点。
  if (!dataUrl) {
    const isActive = Boolean(tab.active) && Boolean((await chrome.tabs.get(tab.id)).active)
    if (!isActive && !wantActive) {
      const m = String((cdpErr && cdpErr.message) || cdpErr || 'unknown')
      throw bridgeError('capture_unavailable',
        `无法在后台截图（CDP 失败：${m}）。为不抢你的焦点，没有自动切前台。`
        + `如果需要这张图，可以传 keepForeground=true 允许切前台再截，或先手动切到该标签页。`)
    }
    if (wantActive) {
      const wid = (await chrome.tabs.get(tab.id)).windowId
      try { await chrome.windows.update(wid, { focused: true }) } catch { /* ignore */ }
      try { await chrome.tabs.update(tab.id, { active: true }) } catch { /* ignore */ }
      await sleep(220)
    }
    const opts = { format: fmt }
    if (fmt === 'jpeg') opts.quality = quality
    let lastErr = null
    for (let attempt = 0; attempt < 2 && !dataUrl; attempt += 1) {
      try {
        dataUrl = await chrome.tabs.captureVisibleTab((await chrome.tabs.get(tab.id)).windowId, opts)
        method = 'captureVisibleTab'
      } catch (e) { lastErr = e; await sleep(350) }
    }
    if (!dataUrl) {
      const m = String((lastErr && lastErr.message) || lastErr || 'unknown')
      throw bridgeError('capture_failed', `截图失败：${m}`)
    }
  }

  const fresh = await chrome.tabs.get(tab.id)
  return {
    ok: true,
    tabId: tab.id,
    title: fresh.title || '',
    url: fresh.url || '',
    dataUrl,
    bytesApprox: Math.round(dataUrl.length * 0.75),
    format: fmt,
    method,
    foregroundUntouched: method === 'cdp',
  }
}

/** 诊断：debugger 是否还附着、哪些 target 在调试中。
 *  Chrome 在扩展**正在调试页面**时会在该扩展的图标上叠一个提示角标
 *  （看起来像相机/虫子）。detach 掉就消失。 */
/** 回报扩展自身环境：品牌、UA、平台。用来确认"我在哪个浏览器里"。 */
async function cmdDebugUa() {
  const nav = self.navigator || {}
  let winCount = null
  try { winCount = (await chrome.windows.getAll({})).length } catch { /* ignore */ }
  return {
    ok: true,
    brand: detectBrand(),
    version: EXT_VERSION,
    userAgent: String(nav.userAgent || ''),
    vendor: String(nav.vendor || ''),
    platform: String(nav.platform || ''),
    language: String(nav.language || ''),
    windowCount: winCount,
  }
}

async function cmdDebugInfo() {
  let targets = []
  try {
    const all = await chrome.debugger.getTargets()
    targets = all.map((t) => ({
      id: t.id, tabId: t.tabId, type: t.type, title: t.title || '', url: String(t.url || '').slice(0, 80),
      attached: Boolean(t.attached),
    }))
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  const attached = targets.filter((t) => t.attached)
  return {
    ok: true,
    total: targets.length,
    attachedCount: attached.length,
    attached,
    targets: targets.slice(0, 20),
    // 最近的用户操作失败记录（noteErr 收集）。排查"点了没反应"时看这里。
    recentErrors: ERR_LOG.slice(-20),
  }
}

/** 强制 detach 所有调试会话（清理"相机角标"用）。 */
async function cmdDebugDetachAll() {
  let all = []
  try { all = await chrome.debugger.getTargets() } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  const done = []
  for (const t of all) {
    if (!t.attached) continue
    try {
      await chrome.debugger.detach({ targetId: t.id })
      done.push({ id: t.id, tabId: t.tabId })
    } catch (e) {
      done.push({ id: t.id, tabId: t.tabId, error: String((e && e.message) || e) })
    }
  }
  return { ok: true, detached: done.length, detail: done }
}

/** 关掉一个或多个标签页。只关明确点名的，绝不动用户其它页面。 */
async function cmdTabClose(params) {
  const ids = Array.isArray(params.tabIds)
    ? params.tabIds.map(Number).filter(Number.isFinite)
    : (typeof params.tabId === 'number' ? [params.tabId] : [])
  if (ids.length === 0) throw bridgeError('bad_args', 'tabId 或 tabIds 必填')

  // 先确认每个都真实存在，避免"关了一半才发现有个 id 是错的"
  const missing = []
  const closable = []
  for (const id of ids) {
    try {
      const t = await chrome.tabs.get(id)
      closable.push({ id: t.id, title: t.title || '', url: t.url || '' })
    } catch { missing.push(id) }
  }
  if (closable.length === 0) {
    throw bridgeError('tab_not_found', `这些标签页都不存在：${ids.join(',')}`)
  }
  await chrome.tabs.remove(closable.map((t) => t.id))
  return { ok: true, closed: closable, closedCount: closable.length, missing }
}

/* ── 标签分组 ──────────────────────────────────────────────────────────
 *
 * Chrome 的 tabGroups API：一个分组属于一个窗口，有 title / color / collapsed。
 * 要实现的效果：DSH 一动手，被操作的页面就自动落进「大肥鱼」这个分组，
 * 名称与配色由我们统一，用户在标签栏上扫一眼就知道"这些页面是它在操作"。
 *
 * 注意：groupId 是 -1 表示"不属于任何组"，且一个组只属于一个窗口 —— 跨窗口时
 * 必须每个窗口各建一个同名组（title 相同，groupId 不同）。
 */

/** 默认分组名与配色。扩展里读不到 DSH 的环境变量，只能靠参数或常量传递。 */
const DEFAULT_GROUP_TITLE = '大肥鱼'
const VALID_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']

function normColor(c) {
  const v = String(c || '').toLowerCase()
  return VALID_COLORS.includes(v) ? v : 'cyan'
}

/** 在给定窗口里找同名同色的既有分组；没有就建一个。 */
async function ensureGroup(tabId, title, color) {
  const tab = await chrome.tabs.get(tabId)
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    try {
      const g = await chrome.tabGroups.get(tab.groupId)
      // 已在目标组里且组名一致 → 复用
      if (g.title === title) return { groupId: g.id, created: false, reused: true }
    } catch { /* 组已消失，继续 */ }
  }
  // 在该窗口里找同名组（跨 tab 复用同一个组）
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId })
  const hit = groups.find((g) => g.title === title)
  if (hit) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: hit.id })
    return { groupId: hit.id, created: false, reused: true }
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] })
  await chrome.tabGroups.update(groupId, { title, color: normColor(color) })
  return { groupId, created: true, reused: false, windowId: tab.windowId }
}

/** 确保目标组存在并把 tab 放进去（可批量）。 */
/** 列出所有浏览器窗口（含窗口 id、标签数、是否前台）。
 *  多浏览器/多窗口时，先看这个再决定操作哪个。 */
async function cmdWindowsList() {
  const wins = await chrome.windows.getAll({ populate: true })
  const out = []
  for (const w of wins) {
    const tabs = w.tabs || []
    out.push({
      windowId: w.id,
      focused: Boolean(w.focused),
      incognito: Boolean(w.incognito),
      state: w.state || '',
      tabCount: tabs.length,
      brand: detectBrand(),
      title: (tabs.find((t) => t.active) || tabs[0] || {}).title || '',
    })
  }
  return { ok: true, count: out.length, brand: detectBrand(), windows: out }
}

async function cmdGroupEnsure(params) {
  const tabIds = Array.isArray(params.tabIds) && params.tabIds.length > 0
    ? params.tabIds.map(Number)
    : (params.tabId !== undefined ? [Number(params.tabId)] : [])
  if (tabIds.length === 0) throw bridgeError('bad_args', 'tabId 或 tabIds 必填')
  const title = params.title || DEFAULT_GROUP_TITLE
  const color = normColor(params.color)
  // 默认折叠：不占标签栏空间。想看就传 collapsed:false 或点一下组标签。
  const collapsed = params.collapsed !== false

  const results = []
  // 按窗口分组处理：不同窗口的组不能共用
  const byWindow = new Map()
  for (const id of tabIds) {
    const t = await chrome.tabs.get(id)
    if (!byWindow.has(t.windowId)) byWindow.set(t.windowId, [])
    byWindow.get(t.windowId).push(id)
  }
  for (const [windowId, ids] of byWindow) {
    const groups = await chrome.tabGroups.query({ windowId })
    let g = groups.find((x) => x.title === title)
    let created = false
    if (!g) {
      const gid = await chrome.tabs.group({ tabIds: ids })
      // 建组时就把 collapsed 一起设上，避免出现"先展开再折叠"的闪动
      await chrome.tabGroups.update(gid, { title, color, collapsed })
      g = await chrome.tabGroups.get(gid)
      created = true
    } else {
      await chrome.tabs.group({ tabIds: ids, groupId: g.id })
      // 已存在的组：也归一化到目标折叠状态（原来可能是展开的）
      if (g.collapsed !== collapsed) {
        await chrome.tabGroups.update(g.id, { collapsed })
        g = await chrome.tabGroups.get(g.id)
      }
    }
    results.push({
      windowId,
      groupId: g.id,
      title: g.title,
      color: g.color,
      collapsed: Boolean(g.collapsed),
      created,
      tabIds: ids,
    })
  }
  return { ok: true, title, color, collapsed, groups: results }
}

/** 把单个 tab 塞进指定 groupId（-1 = 移出分组）。 */
async function cmdGroupAssign(params) {
  const tabId = Number(params.tabId)
  if (!tabId) throw bridgeError('bad_args', 'tabId 必填')
  if (params.groupId === -1 || params.ungroup === true) {
    await chrome.tabs.ungroup([tabId])
    return { ok: true, tabId, groupId: -1, ungroupped: true }
  }
  if (params.groupId !== undefined) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: Number(params.groupId) })
    return { ok: true, tabId, groupId: Number(params.groupId) }
  }
  const r = await ensureGroup(tabId, params.title || DEFAULT_GROUP_TITLE, params.color)
  return { ok: true, tabId, ...r }
}

/** 列出当前所有分组（含每组的标签页）。 */
async function cmdGroupList() {
  const groups = await chrome.tabGroups.query({})
  const out = []
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id })
    out.push({
      groupId: g.id,
      windowId: g.windowId,
      title: g.title || '',
      color: g.color,
      collapsed: Boolean(g.collapsed),
      tabCount: tabs.length,
      tabs: tabs.map((t) => ({ id: t.id, title: t.title || '', url: t.url || '', active: Boolean(t.active) })),
    })
  }
  out.sort((a, b) => (a.windowId - b.windowId) || (a.groupId - b.groupId))
  return { ok: true, groups: out, count: out.length }
}

/** 改组名 / 颜色 / 折叠状态。 */
async function cmdGroupUpdate(params) {
  const groupId = Number(params.groupId)
  if (!groupId) throw bridgeError('bad_args', 'groupId 必填')
  const patch = {}
  if (params.title !== undefined && params.title !== '') patch.title = String(params.title)
  if (params.color !== undefined) patch.color = normColor(params.color)
  if (params.collapsed !== undefined) patch.collapsed = Boolean(params.collapsed)
  if (Object.keys(patch).length === 0) throw bridgeError('bad_args', '至少给 title / color / collapsed 之一')
  const g = await chrome.tabGroups.update(groupId, patch)
  return { ok: true, group: { groupId: g.id, title: g.title, color: g.color, collapsed: Boolean(g.collapsed) } }
}

/** 关掉整组标签页。 */
async function cmdGroupClose(params) {
  const groupId = Number(params.groupId)
  if (!groupId) throw bridgeError('bad_args', 'groupId 必填')
  const tabs = await chrome.tabs.query({ groupId })
  const ids = tabs.map((t) => t.id)
  if (ids.length > 0) await chrome.tabs.remove(ids)
  return { ok: true, groupId, closed: ids.length }
}

/* ── 小工具 ─────────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForLoad(tabId, waitMs, maxWaitMs = 10000) {
  const deadline = Date.now() + Math.max(1000, Number(maxWaitMs) || 10000)
  // 等 status 从 loading 变 complete（最多 20s），再额外等 waitMs 给前端渲染
  let settled = false
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId)
      if (t.status === 'complete') { settled = true; break }
    } catch (e) {
      break
    }
    await sleep(250)
  }
  await sleep(Math.max(0, Math.min(10000, waitMs)))
  return settled
}

/* ── 生命周期 ───────────────────────────────────────────────────────── */

watchSystemTheme()

/** 建一个每分钟触发一次的 alarm：SW 睡着后靠它醒来自动重连。
 *  alarm 已存在时 chrome.alarms.create 会覆盖同名的，重复调用无副作用。 */
function ensureKeepAlive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES })
  } catch { /* 没有 alarms 权限就退化成只在 SW 活着时重连 */ }
}

try {
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a || a.name !== KEEPALIVE_ALARM) return
    // alarm 唤醒的这一轮 SW 里，links 可能是空的（上次休眠前就断了）
    for (const port of BRIDGE_PORTS) {
      const l = link(port)
      if (l.ws && l.ws.readyState === WebSocket.OPEN) continue
      connect(port)
    }
  })
} catch { /* 老浏览器没有 alarms 就算了 */ }

ensureKeepAlive()

/* 租约到期自动回收。
 *
 * 必须用 chrome.alarms 而不是 setInterval：MV3 的 Service Worker 会在闲置
 * 约 30s 后被浏览器卸载，setInterval 随之消失（实测"到期不回收"就是这个原因）。
 * alarms 由浏览器托管，SW 睡着也会在到点时把它唤醒。 */
try {
  chrome.alarms.create(LEASE_ALARM, { periodInMinutes: 0.5 })
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a || a.name !== LEASE_ALARM) return
    reapExpiredLeases().catch(() => { /* ignore */ })
  })
} catch { /* 没有 alarms 权限就退化成只在 release 时清理 */ }

chrome.runtime.onInstalled.addListener(() => { ensureKeepAlive(); connectAll(); connectNative() })
chrome.runtime.onStartup.addListener(() => { ensureKeepAlive(); connectAll(); connectNative() })
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'dsh-bridge-state') {
    const states = {}
    for (const port of BRIDGE_PORTS) {
      const l = link(port)
      states[port] = { connected: Boolean(l.ws && l.ws.readyState === WebSocket.OPEN), connectedAt: l.connectedAt }
    }
    reply({ version: EXT_VERSION, ports: states, inflight: inflight.size })
    return true
  }
  if (msg && msg.type === 'dsh-bridge-reconnect') {
    for (const port of BRIDGE_PORTS) {
      const l = link(port)
      try { if (l.ws) l.ws.close() } catch { /* ignore */ }
    }
    connectAll()
    reply({ ok: true })
    return true
  }
  return false
})
/* ── 右键菜单 ─────────────────────────────────────────────────────── */
try {
  chrome.runtime.onInstalled.addListener(() => {
    const items = [
      { id: 'grp-selected', title: '把所有标签收进「大肥鱼」分组并折叠' },
      { id: 'detach-all', title: '清理调试会话（顺带去掉图标角标）' },
      { id: 'open-panel', title: '打开状态面板' },
    ]
    for (const it of items) {
      chrome.contextMenus.create({
        id: it.id, title: it.title, contexts: ['action'],
      }, () => void chrome.runtime.lastError)
    }
  })
  chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId === 'grp-selected') {
      const tabs = await chrome.tabs.query({ currentWindow: true })
      const ids = tabs.filter((t) => !/^(chrome|edge|about|devtools|chrome-extension):/i.test(t.url || '')).map((t) => t.id)
      if (ids.length > 0) {
        const gid = await chrome.tabs.group({ tabIds: ids })
        await chrome.tabGroups.update(gid, { title: '大肥鱼', color: 'cyan', collapsed: true })
      }
    } else if (info.menuItemId === 'detach-all') {
      const targets = await chrome.debugger.getTargets()
      for (const t of targets) {
        if (t.attached) { try { await chrome.debugger.detach({ targetId: t.id }) } catch { } }
      }
    } else if (info.menuItemId === 'open-panel') {
      try { await chrome.sidePanel.open({ windowId: info.windowId }) } catch { }
    }
  })
} catch { /* 没有 contextMenus 权限就跳过 */ }

// 有 sidePanel 权限时，点图标开面板而不是纯重连（面板里也有刷新按钮）
try {
  if (chrome.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  }
} catch { /* 老版本没有 sidePanel，退回 connectAll */ }
chrome.action.onClicked.addListener(() => { connectAll() })

connectAll()

// 顶层也尝试连 native（SW 每次被拉起时都会跑到这里）
connectNative()
