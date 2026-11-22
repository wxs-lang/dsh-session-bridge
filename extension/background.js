/**
 * DSH Browser Bridge — MV3 service worker
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
const BRIDGE_PORTS = [39401]

/** 允许连桥的浏览器品牌白名单。
 *  QQ浏览器/360/搜狗 会加载同一扩展目录，两边都连桥 → 命令随机落一边，
 *  用户看到的就是"分组建了又没了""状态滞后"。
 *  改这里并刷新扩展即可；想看 QQ浏览器 就把它加进来。 */
const ALLOWED_BRANDS = ['Chrome', 'Edge', 'Unknown']

const EXT_VERSION = '1.6.0'
const RECONNECT_MS = 2000
const PING_MS = 15000
// 超过这么久没有真实命令往来就停止心跳并断连，让 SW 休眠
const PING_IDLE_MS = 5 * 60 * 1000

/** port -> { ws, connectedAt, reconnectTimer, pingTimer, helloSent } */
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

function scheduleReconnect(port) {
  const l = link(port)
  if (l.reconnectTimer) return
  l.reconnectTimer = setTimeout(() => {
    l.reconnectTimer = null
    connect(port)
  }, RECONNECT_MS)
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

function send(l, obj) {
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
  // ── 空闲不发 ping ──
  // MV3 的 Service Worker 会在闲置约 30s 后被浏览器卸载以省内存。
  // 原来固定 15s 发一次心跳，等于永不让它睡，浏览器常驻多占几十 MB，
  // 而且扩展连 3 个端口时是 3 倍唤醒频率。
  // 现在改成：只有「最近 PING_IDLE_MS 内有过命令」才继续心跳，
  // 长期空闲就停发，让 SW 正常休眠（休眠后 WS 断开，下次需要时重连即可）。
  l.pingTimer = setInterval(() => {
    if (!l.ws || l.ws.readyState !== WebSocket.OPEN) { stopPing(port); return }
    const idleFor = Date.now() - (l.lastTrafficAt || 0)
    if (idleFor > PING_IDLE_MS) {
      // 空闲够久：主动断开，让浏览器回收 Service Worker
      stopPing(port)
      try { l.ws.close(1000, 'idle') } catch { /* ignore */ }
      return
    }
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
  'tab.navigate': cmdTabNavigate,
  'tab.screenshot': cmdTabScreenshot,
  'tab.info': cmdTabInfo,
  'tab.close': cmdTabClose,
  'debug.info': cmdDebugInfo,
  'debug.ua': cmdDebugUa,
  'debug.detachAll': cmdDebugDetachAll,
  // ── 标签分组：DSH 碰过的页面自动收进「wxs-lang」组 ──────────────
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

async function resolveTab(tabId, preferActive = true) {
  if (typeof tabId === 'number' && Number.isFinite(tabId)) {
    let tab
  try { tab = await chrome.tabs.get(tabId) } catch { tab = null }
    if (!tab) throw bridgeError('tab_not_found', `标签页 ${tabId} 不存在（可能已关闭）`)
    return tab
  }
  const tabs = await chrome.tabs.query(preferActive ? { active: true, lastFocusedWindow: true } : {})
  if (tabs.length > 0) return tabs[0]
  const all = await chrome.tabs.query({})
  if (all.length === 0) throw bridgeError('no_tab', '浏览器里没有打开的标签页')
  return all[0]
}

function assertInjectable(tab) {
  const url = tab.url || tab.pendingUrl || ''
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-untrusted|qqbrowser):/i.test(url)) {
    throw bridgeError('restricted_page', `此页面不允许脚本注入：${url.slice(0, 120)}`)
  }
  const blocked = ['chrome.google.com/webstore', 'chromewebstore.google.com', 'microsoftedge.microsoft.com/addons']
  if (blocked.some((b) => url.includes(b))) {
    throw bridgeError('restricted_page', `扩展商店页面不允许脚本注入：${url.slice(0, 120)}`)
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
      title: dark ? 'wxs-lang · DSH Browser Bridge（夜间模式）' : 'wxs-lang · DSH Browser Bridge（日间模式）',
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
  return {
    ok: true,
    tabId: tab.id,
    title: r.title,
    url: r.url,
    scroll: r.scroll,
    viewport: r.viewport,
    elementCount: r.elementCount,
    truncated: r.truncated,
    elements: r.elements,
    text: r.text,
  }
}

async function cmdTabClick(params) {
  const tab = await resolveTab(params.tabId)
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
    } catch { /* 归组失败不影响导航 */ }
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

async function cmdTabScreenshot(params) {
  const tab = await resolveTab(params.tabId)
  const fmt = params.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = Math.max(1, Math.min(100, Number(params.quality) || 80))
  const wantActive = params.keepForeground === true   // 默认绝不切前台

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
      // 确保渲染器不因后台节流而停帧
      try {
        await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch { /* 老版本可能没有，忽略 */ }
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
  return { ok: true, total: targets.length, attachedCount: attached.length, attached, targets: targets.slice(0, 20) }
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
 * 要实现的效果：DSH 一动手，被操作的页面就自动落进「wxs-lang」这个分组，
 * 名称与配色由我们统一，用户在标签栏上扫一眼就知道"这些页面是它在操作"。
 *
 * 注意：groupId 是 -1 表示"不属于任何组"，且一个组只属于一个窗口 —— 跨窗口时
 * 必须每个窗口各建一个同名组（title 相同，groupId 不同）。
 */

/** 默认分组名与配色。扩展里读不到 DSH 的环境变量，只能靠参数或常量传递。 */
const DEFAULT_GROUP_TITLE = 'wxs-lang'
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

async function waitForLoad(tabId, waitMs) {
  const deadline = Date.now() + 20000
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

chrome.runtime.onInstalled.addListener(() => { connectAll() })
chrome.runtime.onStartup.addListener(() => { connectAll() })
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
      { id: 'grp-selected', title: '把所有标签收进「wxs-lang」分组并折叠' },
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
        await chrome.tabGroups.update(gid, { title: 'wxs-lang', color: 'cyan', collapsed: true })
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
