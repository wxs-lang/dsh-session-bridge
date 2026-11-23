/**
 * sidepanel.js — 侧边栏状态面板
 *
 * 只读展示 + 两个动作（刷新状态、清理调试会话）。
 * 所有数据都问 background 要，不在这里直接调 tabs/tabGroups，
 * 避免两处逻辑分叉。
 */

const PORTS = [39401, 39411, 39421]

const $ = (id) => document.getElementById(id)

function setDot(id, state) {
  const el = $(id)
  if (!el) return
  el.className = 'dot' + (state ? ' ' + state : '')
}

/** 问 background 要一份完整状态 */
function askBackground(type) {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(null) }
    }, 3000)
    try {
      chrome.runtime.sendMessage({ type }, (reply) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(chrome.runtime.lastError ? null : reply)
      })
    } catch {
      done = true
      clearTimeout(timer)
      resolve(null)
    }
  })
}

/** 直接问桥的 HTTP 状态（更权威：能看出 DSH 那边活着没有） */
async function fetchBridge(port) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 1500)
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal })
    clearTimeout(t)
    return await r.json()
  } catch {
    return null
  }
}

/** 汇总一次 */
async function refresh() {
  // 1) 本扩展状态
  const st = await askBackground('dsh-bridge-state')
  const version = (st && st.version) || '?'
  $('v-version').textContent = version
  setDot('d-version', version === '?' ? 'bad' : 'ok')

  // 2) 哪个端口通了（优先显示 DSH 宿主的 39401）
  let live = null
  for (const p of PORTS) {
    const s = await fetchBridge(p)
    if (s && s.listening) { live = { port: p, status: s }; break }
  }
  if (live) {
    $('v-ws').textContent = `ws://127.0.0.1:${live.port}`
    setDot('d-ws', 'ok')
    const ext = live.status.extensions || 0
    $('v-bridge').textContent = ext > 0 ? `已连上（${ext} 个扩展）` : '桥在跑，扩展未连'
    setDot('d-bridge', ext > 0 ? 'ok' : 'bad')
  } else {
    $('v-ws').textContent = '三个端口都不通'
    setDot('d-ws', 'bad')
    $('v-bridge').textContent = 'DSH 没在跑？'
    setDot('d-bridge', 'bad')
  }

  // 3) 标签页 / 分组 / 调试
  try {
    const tabs = await chrome.tabs.query({})
    $('v-tabs').textContent = String(tabs.length)
  } catch { $('v-tabs').textContent = '—' }

  try {
    const groups = await chrome.tabGroups.query({})
    const mine = groups.filter((g) => g.title === '大肥鱼')
    $('v-groups').textContent = mine.length
      ? `${groups.length} 个（其中 大肥鱼 占 ${mine.length} 个，当前${mine[0].collapsed ? '折叠' : '展开'}）`
      : String(groups.length)
  } catch { $('v-groups').textContent = '—' }

  try {
    const targets = await chrome.debugger.getTargets()
    const attached = targets.filter((t) => t.attached).length
    $('v-debug').textContent = attached === 0 ? '无' : `${attached} 个（图标可能有角标）`
  } catch { $('v-debug').textContent = '—' }

  // 4) 主题
  try {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    $('v-theme').textContent = dark ? '夜间（纯黑鲸鱼）' : '白天（蓝鲸鱼）'
    setDot('d-theme', 'ok')
  } catch { setDot('d-theme', 'bad') }
}

document.getElementById('btn-refresh').addEventListener('click', refresh)

document.getElementById('btn-detach').addEventListener('click', async () => {
  const btn = $('btn-detach')
  btn.disabled = true
  btn.textContent = '清理中…'
  try {
    const targets = await chrome.debugger.getTargets()
    let n = 0
    for (const t of targets) {
      if (!t.attached) continue
      try { await chrome.debugger.detach({ targetId: t.id }); n += 1 } catch { /* 别人的会话，忽略 */ }
    }
    btn.textContent = n > 0 ? `已清理 ${n} 个` : '没有需要清理的'
  } catch {
    btn.textContent = '清理失败'
  }
  setTimeout(async () => {
    btn.disabled = false
    btn.textContent = '清理调试会话'
    await refresh()
  }, 1200)
})

// 打开面板就刷一次；之后每 5 秒自动刷（面板开着时才跑）
refresh()
const timer = setInterval(refresh, 5000)
window.addEventListener('unload', () => clearInterval(timer))
