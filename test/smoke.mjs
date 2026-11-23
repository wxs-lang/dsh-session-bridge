/**
 * smoke.mjs — dsh-session-bridge 自测脚本（两段式）
 *
 * 用法（在任意目录）：
 *   node test/smoke.mjs
 *   node ...\smoke.mjs --no-chrome      # 只跑 stub 段（不启动浏览器）
 *
 * 段 A（stub ctx）：加载插件 → apply(ctx) → 每个工具 execute 一遍
 *   断言：不抛异常、扩展不在线时返回结构化错误 extension_disconnected。
 *
 * 段 B（真机端到端）：
 *   1. 本地起 HTTP 服务（127.0.0.1:39488）提供一张表单页
 *   2. 用**临时 profile** 起 Chrome 并 --load-extension 加载扩展
 *   3. 断言扩展连上、tabs.list 有 example.com 与本地面单页
 *   4. tab.snapshot 能拿到 ref 且含 "Example Domain" / 表单元素
 *   5. tab.type + tab.click 在表单页上验证真实输入与提交
 *   6. tab.screenshot 返回非空 data URL
 *   7. 只杀自己起的那个 Chrome（按 pid 树），不动用户的其它浏览器
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { mkdtempSync, existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PLUGIN_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const EXT_DIR = resolve(PLUGIN_ROOT, 'extension')
const PLUGIN_ENTRY = resolve(PLUGIN_ROOT, 'index.js')
// 实现在 impl.js（入口是薄壳）；_internals 从这里取
const IMPL_ENTRY = resolve(PLUGIN_ROOT, 'impl.js')
// 用 39416，避开真实 DSH 宿主占用的 39401 和各测试自己的端口
// （39411/39421 是扩展会主动连的备用口，绝不能拿来当测试口 —— 会跟真浏览器抢连接）
const PORT = Number(process.env.DSH_BRIDGE_TEST_PORT || 39416)
const LOCAL_PORT = 39488

const argv = new Set(process.argv.slice(2))
const SKIP_CHROME = argv.has('--no-chrome')

let pass = 0
let fail = 0
const failures = []

function ok(name, extra) {
  pass += 1
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`)
}
function bad(name, extra) {
  fail += 1
  failures.push(`${name}${extra ? `: ${extra}` : ''}`)
  console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
}
function assertTrue(cond, name, extra) {
  if (cond) ok(name, extra); else bad(name, extra)
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/* ── 加载插件（stub ctx）───────────────────────────────────────────── */

const tools = new Map()
const promptSections = []
const logs = []

const stubCtx = {
  logger: {
    info: (...a) => logs.push(['info', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  },
  tools: {
    register(def) {
      if (!def || !def.output || typeof def.output.render !== 'function') {
        throw new TypeError(`tool "${def && def.name}" must declare output { schema, render }`)
      }
      if (typeof def.output.schema !== 'object' || def.output.schema === null) {
        throw new TypeError(`tool "${def && def.name}" needs output.schema`)
      }
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
  },
  systemPrompt: {
    section(sec) { promptSections.push(sec) },
  },
  effect(fn) { try { fn() } catch { /* ignore */ } },
  on() { /* ignore */ },
  get(name) { return name === 'attachments' ? null : undefined },
}

console.log(`\n=== 段 A：stub ctx ===`)
console.log(`插件入口: ${PLUGIN_ENTRY}`)

const mod = await import(pathToFileURL(PLUGIN_ENTRY).href)
assertTrue(typeof mod.apply === 'function', 'apply 导出为函数')
assertTrue(mod.name === 'dsh-session-bridge', 'export const name', mod.name)
assertTrue(Array.isArray(mod.inject) && mod.inject.includes('tools') && mod.inject.includes('systemPrompt'), 'export const inject', JSON.stringify(mod.inject))

mod.apply(stubCtx, { port: PORT })

// 工具清单以插件自己声明的 TOOL_SPECS 为准，不再写死数量
// （写死过 7，后来加到 16 就误报了）
// index.js 现在是薄入口（动态加载 impl.js），_internals 在 impl 上。
// 传入的 tools Map 已经收集到实际注册结果，直接用它做基准更准确。
const __implMod = await import(pathToFileURL(IMPL_ENTRY).href)
const EXPECTED = [...tools.keys()]
assertTrue(tools.size >= 20, `注册了 ≥20 个工具`, `实际 ${tools.size}`)
for (const n of ['browser_status', 'browser_tabs', 'browser_click', 'browser_reload', 'browser_conn']) {
  assertTrue(tools.has(n), `工具存在 ${n}`)
}
assertTrue(promptSections.length >= 1, '注册了 systemPrompt 段', promptSections.map((s) => s.name).join(','))

const bridge = globalThis.__dshBrowserBridge
assertTrue(Boolean(bridge), '桥实例已挂到 globalThis.__dshBrowserBridge')

// 等 WS 起来
for (let i = 0; i < 40; i += 1) {
  if (bridge && bridge.status().listening) break
  await sleep(100)
}
assertTrue(Boolean(bridge && bridge.status().listening), `WS 服务在 ${PORT} 监听`, bridge ? bridge.status().wsUrl : 'n/a')

async function call(name, args) {
  const t = tools.get(name)
  if (!t) throw new Error(`no tool ${name}`)
  return await t.execute(args || {})
}

let r = await call('browser_status')
assertTrue(r && r.ok === true, 'browser_status 返回 ok')
assertTrue(r.available === false, 'browser_status 报告 available=false（扩展未连）')
assertTrue(r.extensionDir && existsSync(r.extensionDir), 'browser_status 给出存在的扩展目录', r.extensionDir)

const offlineCases = [
  ['browser_tabs', {}],
  ['browser_snapshot', {}],
  ['browser_click', { ref: 'e1' }],
  ['browser_type', { ref: 'e1', text: 'x' }],
  ['browser_screenshot', {}],
  ['browser_navigate', { url: 'https://example.com' }],
]
for (const [name, args] of offlineCases) {
  let out
  let threw = null
  try { out = await call(name, args) } catch (e) { threw = e }
  if (threw) { bad(`${name} 离线未抛异常`, String(threw.message || threw)); continue }
  assertTrue(out && out.ok === false && out.error === 'extension_disconnected', `${name} 离线返回 extension_disconnected`, JSON.stringify(out).slice(0, 140))
}

r = await call('browser_click', {})
assertTrue(r.ok === false && r.error === 'bad_args', 'browser_click 缺 ref/x/y → bad_args')

r = await call('browser_navigate', { url: 'example.com' })
assertTrue(r.ok === false && r.error === 'bad_args', 'browser_navigate 无 scheme → bad_args')

/* attachImage 单测：伪造一个 attachments 服务，验证走 attachment 分支 + render 出 image 块 */
{
  const PNGSIG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')
  const dataUrl = 'data:image/png;base64,' + PNGSIG.toString('base64')
  const fakeCtx = {
    get: (n) => (n === 'attachments'
      ? { saveImage: async ({ data, mediaType, name }) => ({ attachmentId: 'sha256:deadbeef', mediaType, bytes: data.byteLength, width: 1, height: 1, name }) }
      : undefined),
  }
  const out = await __implMod._internals.attachImage(fakeCtx, { tabId: 7, title: 't', url: 'u', dataUrl })
  assertTrue(out.ok === true && out.stored === 'attachment' && out.image && out.image.attachmentId === 'sha256:deadbeef',
    'attachImage 走 attachments.saveImage', JSON.stringify(out.image || {}))
  const blocks = tools.get('browser_screenshot').output.render({}, out)
  assertTrue(blocks.some((b) => b.type === 'image'), 'render 为 attachment 结果产出 image 块', `blocks=${blocks.map((b) => b.type).join(',')}`)

  const noAtt = await __implMod._internals.attachImage({ get: () => null }, { tabId: 7, title: 't', url: 'u', dataUrl })
  assertTrue(noAtt.ok === true && noAtt.stored === 'file' && existsSync(noAtt.path), 'attachImage 无 attachments 时落盘兜底', noAtt.path || '')
  if (noAtt.path) { try { rmSync(noAtt.path, { force: true }) } catch { /* ignore */ } }
}

if (SKIP_CHROME) {
  console.log(`\n=== 结果（跳过真机段）: pass=${pass} fail=${fail} ===`)
  process.exit(fail === 0 ? 0 : 1)
}

/* ── 段 B：真机端到端 ─────────────────────────────────────────────── */

console.log(`\n=== 段 B：真机端到端 ===`)

if (!existsSync(CHROME)) {
  bad('找不到 Chrome', CHROME)
  console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
  process.exit(1)
}
assertTrue(existsSync(join(EXT_DIR, 'manifest.json')), '扩展目录有 manifest.json', EXT_DIR)

// 本地表单页（避免依赖外网；data: / file: 不好注入）
const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>DSH Bridge Form</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1>DSH Bridge Test Form</h1>
<form id="f" action="/result" method="get">
  <label for="q">Query</label>
  <input id="q" name="q" placeholder="type here" autocomplete="off">
  <button type="submit" id="go">Go</button>
</form>
<p id="hint">waiting</p>
</body></html>`

const httpServer = createServer((req, res) => {
  const u = new URL(req.url || '/', `http://127.0.0.1:${LOCAL_PORT}`)
  if (u.pathname === '/result') {
    const q = u.searchParams.get('q') || ''
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>DSH Bridge Result</title></head><body>` +
      `<h1 id="out">submitted:${q}</h1><form id="f" action="/result" method="get">` +
      `<label for="q">Query</label><input id="q" name="q" value="${q.replace(/"/g, '&quot;')}">` +
      `<button type="submit" id="go">Go</button></form></body></html>`)
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(FORM_HTML)
})
await new Promise((done, reject) => {
  httpServer.once('error', reject)
  httpServer.listen(LOCAL_PORT, '127.0.0.1', done)
})
ok('本地表单页已起', `http://127.0.0.1:${LOCAL_PORT}/`)

const profileDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-test-'))
const CDP_PORT = 39402
// Chrome 137+ 起 --load-extension 被 DisableLoadExtensionCommandLineSwitch 关掉，
// 实测 Chrome 157 / Edge 147 该开关无效。改用 CDP 的 Extensions.loadUnpacked
//（需要 --enable-unsafe-extension-debugging）。
const chromeArgs = [
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,OptimizationHints',
  '--enable-unsafe-extension-debugging',
  `--remote-debugging-port=${CDP_PORT}`,
  `http://127.0.0.1:${LOCAL_PORT}/form`,
  'https://example.com/',
]
console.log(`  起临时 Chrome: ${profileDir} (CDP ${CDP_PORT})`)
const chrome = spawn(CHROME, chromeArgs, { detached: false, stdio: 'ignore' })
chrome.on('error', (e) => bad('Chrome 启动失败', String(e.message || e)))

async function cdpTargets(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    return await res.json()
  } catch { return [] }
}

// 1) 等 CDP 起来 2) Extensions.loadUnpacked 装扩展
let loadedExtId = null
let cdpVer = null
for (let i = 0; i < 40; i += 1) {
  await sleep(500)
  try { cdpVer = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break } catch { /* retry */ }
}
if (cdpVer && cdpVer.webSocketDebuggerUrl) {
  const { default: WS } = await import('ws')
  const wsc = new WS(cdpVer.webSocketDebuggerUrl, { perMessageDeflate: false })
  await new Promise((res, rej) => { wsc.on('open', res); wsc.on('error', rej) })
  let seq = 0
  const pending = new Map()
  wsc.on('message', (raw) => {
    const m = JSON.parse(String(raw))
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const sendCdp = (method, params) => new Promise((res) => {
    const myId = ++seq
    pending.set(myId, res)
    wsc.send(JSON.stringify({ id: myId, method, params }))
  })
  // 复制扩展并改桥端口：直接装真实目录的话，那份扩展只会连 39401/39411/39421，
  // 既连不上测试桥（39416），还会跟用户浏览器里的真实扩展抢连接。
  const extCopy = join(profileDir, 'ext')
  cpSync(EXT_DIR, extCopy, { recursive: true })
  const bg = join(extCopy, 'background.js')
  const bgSrc = readFileSync(bg, 'utf8')
  writeFileSync(bg, bgSrc.replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${PORT}]`), 'utf8')
  const out = await sendCdp('Extensions.loadUnpacked', { path: extCopy })
  loadedExtId = out && out.result && out.result.id ? out.result.id : null
  try { wsc.close() } catch { /* ignore */ }
}
assertTrue(Boolean(loadedExtId), '扩展经 CDP Extensions.loadUnpacked 装载', loadedExtId ? `id=${loadedExtId}` : '装载失败（老版本 Chrome 可回退 --load-extension）')

let connected = false
for (let i = 0; i < 60; i += 1) {
  await sleep(500)
  if (bridge.ready) { connected = true; break }
}
assertTrue(connected, '扩展已连上桥', connected ? 'ok' : '20s 内未连上（检查 chrome://extensions 是否有报错）')
if (!connected) {
  await cleanup()
  console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
  process.exit(1)
}
const st = bridge.status()
console.log(`  扩展信息: browser=${st.browser} version=${st.extensionVersion} extensions=${st.extensions}`)

// 多等一会儿，让 example.com 加载完
await sleep(3000)

/* tabs.list */
r = await call('browser_tabs', {})
assertTrue(r.ok === true && Array.isArray(r.tabs), 'browser_tabs ok')
const tabs = r.tabs || []
console.log(`  tabs=${r.count}`)
for (const t of tabs.slice(0, 8)) console.log(`    [${t.id}] active=${t.active} ${String(t.title).slice(0, 40)} :: ${String(t.url).slice(0, 60)}`)
const exTab = tabs.find((t) => /example\.com/.test(t.url))
const formTab = tabs.find((t) => t.url.includes(`127.0.0.1:${LOCAL_PORT}`))
assertTrue(Boolean(formTab), 'tabs.list 含本地表单页', formTab ? `id=${formTab.id}` : 'missing')
if (exTab) ok('tabs.list 含 example.com', `id=${exTab.id} title="${exTab.title}"`)
else console.log('  ! tabs.list 未见 example.com（外网不通时正常，继续用本地页验证）')

/* snapshot: example.com */
if (exTab) {
  r = await call('browser_snapshot', { tabId: exTab.id })
  assertTrue(r.ok === true, 'snapshot(example.com) ok', r.error || '')
  const hasExample = /Example Domain/i.test(r.title || '') ||
    (r.elements || []).some((e) => /Example Domain|Learn more/i.test(e.name || '')) ||
    /Example Domain/i.test(r.text || '')
  assertTrue(hasExample, 'snapshot 命中 "Example Domain"', `title="${r.title}" elements=${(r.elements || []).length} text=${String(r.text || '').slice(0, 60).replace(/\n/g, ' ')}`)
  if ((r.elements || []).length > 0) {
    const e = r.elements[0]
    ok('snapshot 元素带 ref/role/bounds', `${e.ref} role=${e.role} name=${String(e.name).slice(0, 30)} bounds=${JSON.stringify(e.bounds)}`)
  } else {
    bad('snapshot 元素清单为空')
  }
}

/* snapshot: 本地表单页 */
r = await call('browser_snapshot', { tabId: formTab.id })
assertTrue(r.ok === true, 'snapshot(表单页) ok', r.error || '')
const inputEl = (r.elements || []).find((e) => (e.attrs && e.attrs.id === 'q') || /Query|type here/.test(e.name || ''))
const buttonEl = (r.elements || []).find((e) => e.role === 'button' || /^go$/i.test(e.name || ''))
assertTrue(Boolean(inputEl), '表单页快照里有输入框 ref', inputEl ? `${inputEl.ref} role=${inputEl.role}` : 'missing')
assertTrue(Boolean(buttonEl), '表单页快照里有按钮 ref', buttonEl ? `${buttonEl.ref} name=${buttonEl.name}` : 'missing')

/* type + submit */
if (inputEl) {
  const TEXT = 'hello dsh bridge'
  r = await call('browser_type', { tabId: formTab.id, ref: inputEl.ref, text: TEXT, clear: true, submit: true, snapshot: true })
  assertTrue(r.ok === true, 'browser_type ok', r.error || '')
  assertTrue(r.typed && r.typed.value === TEXT, 'browser_type 写入值正确', r.typed ? JSON.stringify(r.typed).slice(0, 120) : '')
  await sleep(1200)
  const after = await call('browser_snapshot', { tabId: formTab.id, text: true })
  const submitted = /submitted:/.test(after.text || '') || /submitted:/.test(JSON.stringify(after.elements || []))
  assertTrue(after.ok === true && submitted, 'submit 后页面已跳转到结果页', String(after.text || after.url || '').slice(0, 80).replace(/\n/g, ' '))
}

/* click：ref 路径 + 坐标兜底（先把页面导回表单页，避免上个 submit 把页面带走） */
await call('browser_navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/form`, tabId: formTab.id, newTab: false, waitMs: 400 })
{
  const target = (await call('browser_snapshot', { tabId: formTab.id })).elements || []
  const btn = target.find((e) => e.role === 'button')
  if (btn) {
    r = await call('browser_click', { tabId: formTab.id, ref: btn.ref, snapshot: false })
    assertTrue(r.ok === true, 'browser_click(ref) ok', r.error || '')
    assertTrue(Boolean(r.clicked) && r.clicked.hit === 'ref', 'click 按 ref 命中', r.clicked ? `${r.clicked.tag}/${r.clicked.hit}` : '')
  } else bad('找按钮 ref 失败')
}

await call('browser_navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/form`, tabId: formTab.id, newTab: false, waitMs: 400 })
{
  const snap2 = await call('browser_snapshot', { tabId: formTab.id })
  const inp = (snap2.elements || []).find((e) => e.role === 'textbox')
  if (inp && inp.bounds) {
    const scrollY = (snap2.scroll && snap2.scroll.y) || 0
    const cx = inp.bounds.x + Math.round(inp.bounds.w / 2)
    const cy = inp.bounds.y + Math.round(inp.bounds.h / 2) - scrollY
    r = await call('browser_click', { tabId: formTab.id, x: cx, y: cy, snapshot: false })
    assertTrue(r.ok === true && r.clicked && r.clicked.hit === 'point',
      'browser_click(x/y) 坐标兜底 ok', r.error || (r.clicked ? `${r.clicked.tag} hit=${r.clicked.hit}` : ''))
  } else bad('找输入框 ref 失败')
}

/* 过期 ref → stale_ref（页面已重载，旧 ref 不存在） */
r = await call('browser_click', { tabId: formTab.id, ref: 'e999', snapshot: false })
assertTrue(r.ok === false && r.error === 'stale_ref', '过期 ref 返回 stale_ref', JSON.stringify(r).slice(0, 200))

/* 受保护页面 → restricted_page */
{
  const nav = await call('browser_navigate', { url: 'chrome://extensions/', newTab: true, waitMs: 500 })
  if (nav.ok && nav.tabId != null) {
    const bad2 = await call('browser_snapshot', { tabId: nav.tabId })
    assertTrue(bad2.ok === false && bad2.error === 'restricted_page', 'chrome:// 页返回 restricted_page', bad2.error || '')
  } else {
    console.log('  ! 跳过受保护页断言（导航失败）')
  }
}

/* navigate 新标签 */
r = await call('browser_navigate', { url: `http://127.0.0.1:${LOCAL_PORT}/?nav=1`, newTab: true, waitMs: 600 })
assertTrue(r.ok === true, 'browser_navigate(新标签) ok', r.error || '')
assertTrue(r.tabId != null && /127\.0\.0\.1/.test(r.url || ''), 'navigate 返回新标签 id 与 url', `tabId=${r.tabId} url=${String(r.url).slice(0, 60)}`)

/* screenshot */
r = await call('browser_screenshot', { tabId: formTab.id, format: 'png' })
assertTrue(r.ok === true, 'browser_screenshot ok', r.error || '')
assertTrue(typeof r.bytes === 'number' && r.bytes > 1000, '截图字节数 > 1000', `bytes=${r.bytes} stored=${r.stored} ${r.path || ''}`)
if (r.stored === 'attachment' && r.image) ok('截图已存为 attachment', `id=${String(r.image.attachmentId).slice(0, 16)} ${r.image.width}x${r.image.height}`)
else if (r.path) ok('截图落盘兜底', r.path)

/* 截图 render 出图片块？ */
const shotTool = tools.get('browser_screenshot')
if (shotTool && r.ok && r.image) {
  const blocks = shotTool.output.render({}, { ...r })
  assertTrue(Array.isArray(blocks) && blocks.some((b) => b.type === 'image'), 'render 产出 image 块')
}

/* ── 清理 ─────────────────────────────────────────────────────────── */

async function cleanup() {
  try { httpServer.close() } catch { /* ignore */ }
  try { bridge.stop() } catch { /* ignore */ }
  if (chrome && chrome.pid && !chrome.killed) {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch { /* ignore */ }
    } else {
      try { chrome.kill('SIGKILL') } catch { /* ignore */ }
    }
  }
  await sleep(800)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

await cleanup()
console.log(`\n=== 结果: pass=${pass} fail=${fail} ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
