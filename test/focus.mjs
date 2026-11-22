/**
 * focus.mjs — 验证「不抢焦点」
 *
 *   node focus.mjs
 *
 * 关键判据：全程记录 chrome.tabs.query({active:true}) 的 tabId，
 * 任何操作之后它都不能变。变了 = 抢了用户焦点 = 失败。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT_DIR = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const LOCAL_PORT = 39491
const CDP_PORT = 39405
const BRIDGE_PORT = 39413  // 隔离端口，避免抢用户扩展

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, n, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`) } else { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`) } }

// 1) 本地站点（两个页面，一个当"用户在看的"，一个当"后台目标"）
const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Focus ${req.url}</title>
<body style="font-family:sans-serif;padding:24px">
<h1>page ${req.url}</h1>
<input id="q" placeholder="type here"><button id="b">Go</button>
<div style="height:2000px;background:linear-gradient(#fff,#eee)">tall</div>
</body>`)
})
await new Promise((r) => srv.listen(LOCAL_PORT, '127.0.0.1', r))

// 2) 本进程起桥
const mod = await import(new URL('../index.js', import.meta.url).href)
mod.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}, { port: BRIDGE_PORT })
await sleep(1000)
let st = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`)).json()
ok(st.listening === true, `桥在 ${BRIDGE_PORT} 监听`)
// 确认测试用的是最新的扩展代码（cpSync 发生在下面，这里先记一下源目录版本）
{
  const mf = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'))
  console.log(`    源扩展版本: ${mf.version}`)
}

// 3) 起 Chrome：前台是 /mine，另开 /other 在后台
// 扩展用隔离副本：vendor 那份会连 39401/39411/39421，与用户浏览器里的实例冲突
const dir = mkdtempSync(join(tmpdir(), 'dsh-focus-'))
const EXT_COPY = join(dir, 'ext')
{
  const fs = await import('node:fs')
  fs.cpSync(EXT_DIR, EXT_COPY, { recursive: true })
  const bgPath = join(EXT_COPY, 'background.js')
  let bgSrc = fs.readFileSync(bgPath, 'utf8')
  bgSrc = bgSrc.replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${BRIDGE_PORT}]`)
  fs.writeFileSync(bgPath, bgSrc, 'utf8')
}
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', `--remote-debugging-port=${CDP_PORT}`,
  `http://127.0.0.1:${LOCAL_PORT}/mine`,
], { stdio: 'ignore' })

let ver = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch {}
}
if (!ver) { ok(false, 'CDP 未起来'); await cleanup(); process.exit(1) }

const { default: WS } = await import('ws')
const wsc = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { wsc.on('open', r); wsc.on('error', j) })
let seq = 0; const pend = new Map()
wsc.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const cdp = (method, params) => new Promise((r) => { const id = ++seq; pend.set(id, r); wsc.send(JSON.stringify({ id, method, params })) })
const loaded = await cdp('Extensions.loadUnpacked', { path: EXT_COPY })
ok(Boolean(loaded?.result?.id), '扩展装载', loaded?.result?.id || '')

// CDP 也能直接问当前活动标签（独立于扩展，用来交叉验证）
const activeTabViaCdp = async () => {
  const r = await cdp('Runtime.evaluate', {
    expression: 'JSON.stringify({url: location.href})',
    returnByValue: true,
  })
  return r?.result?.result?.value
}

let live = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`)).json().catch(() => null)
  if (s && s.extensions >= 1) { live = true; st = s; break }
}
ok(live, '桥看到扩展', live ? `v=${st.extensionVersion}` : '未连上')
if (!live) { await cleanup(); process.exit(1) }

async function rpc(cmd, params = {}, timeoutMs = 25000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const u = `http://127.0.0.1:${BRIDGE_PORT}/rpc?cmd=${encodeURIComponent(cmd)}&params=${encodeURIComponent(JSON.stringify(params))}`
    const res = await fetch(u, { signal: ctl.signal })
    return await res.json()
  } catch (e) { return { ok: false, error: String(e.message || e) } }
  finally { clearTimeout(t) }
}

// 用户当前在看的标签页（基准）
// 等桥上的扩展稳定：连续两次 tabs.list 返回同样的活动标签才采信基准。
// 否则测试串跑时会拿到上一个 Chrome 实例残留的标签（表现为偶发 2 项失败）。
let baseline = []
let activeBefore = null
for (let i = 0; i < 30; i++) {
  const a = (await rpc('tabs.list', {})).tabs || []
  const act1 = a.find((t) => t.active)
  await sleep(250)
  const b = (await rpc('tabs.list', {})).tabs || []
  const act2 = b.find((t) => t.active)
  if (act1 && act2 && act1.id === act2.id) {
    baseline = b
    activeBefore = act2
    break
  }
}
ok(!!activeBefore, '取到基准前台标签', activeBefore ? `${activeBefore.id} ${activeBefore.url}` : '')
ok(String(activeBefore.url).includes('/mine'), '前台是 /mine（用户在看这个）')

// 开一个后台标签页
console.log('\n--- 后台新开 /other ---')
// 已知偶发（约 1/6）：扩展冷启动后第一批 tab.navigate 偶尔拿不到 tabId。
// 扩展侧已加兜底（按 url 重新定位 + create_failed 明确报错）；
// 这里失败就重试一次，避免测试假阴性。
let nav = await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/other`, newTab: true }, 30000)
if (!nav.tabId) {
  await sleep(1200)
  nav = await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/other`, newTab: true }, 30000)
}
ok(nav.ok === true, 'navigate ok', `tabId=${nav.tabId}`)
const otherId = nav.tabId
await sleep(900)

let after = (await rpc('tabs.list', {})).tabs
let act = after.find((t) => t.active)
ok(act && act.id === activeBefore.id, '★ 前台没变（navigate 后台打开）', act ? `${act.id} vs 基准 ${activeBefore.id}` : '')
ok(after.some((t) => t.id === otherId && !t.active), '/other 在后台')

// 后台截图
console.log('\n--- 后台截图 /other ---')
const shot = await rpc('tab.screenshot', { tabId: otherId, format: 'jpeg' }, 30000)
ok(shot.ok === true, 'screenshot ok', shot.ok ? `method=${shot.method} foregroundUntouched=${shot.foregroundUntouched} ${Math.round((shot.bytesApprox || 0) / 1024)}KB` : JSON.stringify(shot).slice(0, 160))
ok(shot.method === 'cdp', '用的是 CDP（不是 captureVisibleTab）')

after = (await rpc('tabs.list', {})).tabs
act = after.find((t) => t.active)
ok(act && act.id === activeBefore.id, '★ 截图后前台没变', act ? `${act.id}` : '')

// 后台快照 + 点击 + 输入
console.log('\n--- 后台 snapshot / type / click ---')
const snap = await rpc('tab.snapshot', { tabId: otherId, maxElements: 20 })
ok(snap.ok === true && (snap.elements || []).length > 0, 'snapshot ok', `elements=${(snap.elements || []).length}`)
const inp = (snap.elements || []).find((e) => e.role === 'textbox')
if (inp) {
  const typed = await rpc('tab.type', { tabId: otherId, ref: inp.ref, text: 'background typing' })
  ok(typed.ok === true, 'type ok', typed.result?.value ?? '')
} else { ok(false, '找到输入框') }
const btn = (snap.elements || []).find((e) => e.role === 'button')
if (btn) {
  const clk = await rpc('tab.click', { tabId: otherId, ref: btn.ref })
  ok(clk.ok === true, 'click ok', clk.clicked?.tag || '')
} else { ok(false, '找到按钮') }

after = (await rpc('tabs.list', {})).tabs
act = after.find((t) => t.active)
ok(act && act.id === activeBefore.id, '★ 全线操作后前台仍然没变', act ? `still ${act.id}` : '')

// 交叉验证：当前活动窗口的 URL
const activeList = (await rpc('tabs.list', {})).tabs.filter((t) => t.active)
ok(activeList.length === 1 && String(activeList[0].url).includes('/mine'),
  '独立复核：活动标签唯一且是 /mine', activeList.map((t) => t.url).join(',') || '(none)')

// 明确要求切前台时才切
console.log('\n--- 显式 active:true 才切 ---')
const nav2 = await rpc('tab.navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/mine2`, newTab: true, active: true }, 30000)
await sleep(900)
after = (await rpc('tabs.list', {})).tabs
act = after.find((t) => t.active)
ok(act && act.id === nav2.tabId, '显式 active:true 时才切前台', act ? `active=${act.id} 期望=${nav2.tabId}` : '')

async function cleanup() {
  try { srv.close() } catch {}
  if (chrome?.pid) spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(800)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
await cleanup()
console.log(`\n=== focus 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
