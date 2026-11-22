/**
 * live.mjs — 在**真实 DSH 宿主**的桥（39401）上验证扩展链路
 *
 * 与 smoke.mjs 的区别：不自己起装插件的 Node 进程，而是用**临时 profile 的 Chrome**
 * 连到已经在跑的 DSH 宿主桥，验证"宿主里的插件 + 用户浏览器里的扩展"这一真实组合。
 *
 * 用法：
 *   node live.mjs
 *   node live.mjs --port 39401
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT_DIR = resolve(PLUGIN_ROOT, 'extension')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const LOCAL_PORT = 39489
const CDP_PORT = 39403
const args = process.argv.slice(2)
const portArg = args.indexOf('--port')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0

function ok(n, e) { pass++; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`) }
function bad(n, e) { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`) }
function ass(c, n, e) { c ? ok(n, e) : bad(n, e) }

// 1) 探测宿主桥：确认它跑的是**新代码**（有 /rpc）。
//    已运行的 DSH 宿主不会热加载插件，可能还是旧代码 —— 那种情况下
//    改为在本进程里按真实插件代码起一个桥（端口 FALLBACK_PORT），
//    验证的仍是"真实插件代码 + 真实扩展 + 真实 Chrome"这条完整链路。
const FALLBACK_PORT = 39411
let PORT = portArg >= 0 ? Number(args[portArg + 1]) : 39401
let st = null
let hostMode = 'host'

async function probe(p) {
  try {
    const s = await (await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(4000) })).json()
    let rpc = false
    try {
      const r = await (await fetch(`http://127.0.0.1:${p}/rpc?cmd=__probe__`, { signal: AbortSignal.timeout(8000) })).json()
      // 新代码对未知命令返回 {"ok":false,"error":"..."}；旧代码直接回 status（含 wsUrl 字段）
      rpc = !('wsUrl' in r)
    } catch { rpc = false }
    return { status: s, rpc }
  } catch { return null }
}

const hostProbe = PORT === 39401 ? await probe(39401) : null
if (hostProbe && hostProbe.rpc) {
  st = hostProbe.status
  console.log(`宿主桥 ${PORT}: listening=${st.listening} extensions=${st.extensions}（新代码，带 /rpc）`)
} else {
  if (hostProbe) {
    console.log(`宿主桥 39401 在跑，但仍是**旧代码**（无 /rpc）—— DSH 还没重启，插件改动未加载。`)
  }
  console.log(`→ 改为本进程起桥（端口 ${FALLBACK_PORT}），用真实插件代码验证扩展链路。`)
  const mod = await import(new URL('../index.js', import.meta.url).href)
  const stub = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => {} },
    effect: () => {}, on: () => {}, get: () => null,
  }
  mod.apply(stub, { port: FALLBACK_PORT })
  await sleep(900)
  PORT = FALLBACK_PORT
  hostMode = 'standalone'
  st = await (await fetch(`http://127.0.0.1:${PORT}/`)).json()
  console.log(`本进程桥 ${PORT}: listening=${st.listening} extDir=${st.extensionDir}`)
}
ass(st && st.listening === true, `桥在监听（${hostMode}）`)

// 2) HTTP 表单页
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Live Form</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>Live Bridge Form</h1>
<form id="f" action="/result" method="get"><label for="q">Q</label>
<input id="q" name="q" placeholder="type" autocomplete="off"><button type="submit" id="go">Go</button></form>
</body></html>`
const srv = createServer((req, res) => {
  const u = new URL(req.url || '/', `http://127.0.0.1:${LOCAL_PORT}`)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  if (u.pathname === '/result') {
    res.end(`<!doctype html><title>Live Result</title><h1 id="out">ok:${u.searchParams.get('q') || ''}</h1>`)
  } else res.end(html)
})
await new Promise((r) => srv.listen(LOCAL_PORT, '127.0.0.1', r))

// 3) 临时 Chrome + CDP 装扩展
const dir = mkdtempSync(join(tmpdir(), 'dsh-live-'))
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', `--remote-debugging-port=${CDP_PORT}`,
  `http://127.0.0.1:${LOCAL_PORT}/form`, 'https://example.com/',
], { stdio: 'ignore' })

let ver = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try { ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch {}
}
if (!ver) { bad('CDP 未起来'); await cleanup(); process.exit(1) }
const { default: WS } = await import('ws')
const wsc = new WS(ver.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { wsc.on('open', r); wsc.on('error', j) })
let seq = 0; const pend = new Map()
wsc.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
const cdp = (method, params) => new Promise((r) => { const id = ++seq; pend.set(id, r); wsc.send(JSON.stringify({ id, method, params })) })
const loaded = await cdp('Extensions.loadUnpacked', { path: EXT_DIR })
ass(Boolean(loaded?.result?.id), '扩展装载', loaded?.result?.id || JSON.stringify(loaded?.error))
try { wsc.close() } catch {}

// 4) 等宿主桥看到扩展
let live = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const s = await (await fetch(`http://127.0.0.1:${PORT}/`)).json()
    if (s.extensions >= 1) { live = true; st = s; break }
  } catch {}
}
ass(live, '宿主桥已看到扩展', live ? `extensions=${st.extensions} browser=${st.browser} v=${st.extensionVersion}` : '20s 内未连上')

// 5) 走宿主桥的 HTTP /rpc 端点发包（不开额外 WS，避免抢主连接）
async function call(cmd, params = {}, timeoutMs = 25000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const url = `http://127.0.0.1:${PORT}/rpc?cmd=${encodeURIComponent(cmd)}&params=${encodeURIComponent(JSON.stringify(params))}`
    const res = await fetch(url, { signal: ctl.signal })
    const body = await res.json()
    // /rpc 把扩展的 result 平铺在顶层（与工具返回值同构）
    return { ok: body.ok === true, result: body, error: body.error }
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  } finally {
    clearTimeout(t)
  }
}

if (live) {
  const tabs = await call('tabs.list', {})
  ass(tabs.ok === true, 'tabs.list 经宿主桥 ok', `count=${(tabs.result?.tabs || []).length}`)
  const list = tabs.result?.tabs || []
  for (const t of list.slice(0, 5)) console.log(`    [${t.id}] ${String(t.title).slice(0, 36)} :: ${String(t.url).slice(0, 50)}`)
  const formTab = list.find((t) => t.url.includes(`127.0.0.1:${LOCAL_PORT}`))
  ass(Boolean(formTab), '列表含本地表单页', formTab ? `id=${formTab.id}` : '')
  if (formTab) {
    const snap = await call('tab.snapshot', { tabId: formTab.id })
    const els = snap.result?.elements || []
    ass(snap.ok === true && els.length >= 2, 'tab.snapshot 拿到元素', `elements=${els.length}`)
    const inp = els.find((e) => e.role === 'textbox')
    const shot = await call('tab.screenshot', { tabId: formTab.id }, 30000)
    ass(shot.ok === true && String(shot.result?.dataUrl || '').startsWith('data:image/png;base64,'), 'tab.screenshot 返回 PNG data URL',
      shot.ok ? `${Math.round(String(shot.result.dataUrl).length * 0.75)} bytes` : shot.error)
  }
}

async function cleanup() {
  try { srv.close() } catch {}
  if (chrome?.pid) spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(800)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
await cleanup()
console.log(`\n=== live 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
