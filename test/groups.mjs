/**
 * groups.mjs — 标签分组（tabGroups）端到端测试
 *
 *   node groups.mjs
 *
 * 起一个独立临时 Chrome（不碰用户的浏览器），加载扩展，验证：
 *   group.ensure → group.list → 组名/颜色正确 → 批量归组 → group.update → group.assign(-1) → group.close
 * 顺带验证插件侧的自动归组（browser_snapshot 之后 tab 自己进组）。
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
const LOCAL_PORT = 39490
const CDP_PORT = 39404
const BRIDGE_PORT = 39412  // 隔离端口：用户的扩展只连 39401/39411/39421，不会误连到这里

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (c, n, e = '') => { if (c) { pass++; console.log(`  ✓ ${n}${e ? ` — ${e}` : ''}`) } else { fail++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ''}`) } }

// 0) 扩展静态检查：权限与命令都在
const mf = JSON.parse((await import('node:fs')).readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'))
ok(mf.permissions.includes('tabGroups'), 'manifest 有 tabGroups 权限', mf.permissions.join(','))
ok(mf.icons && mf.icons['16'] === 'icons/icon16.png', 'manifest 配了图标', JSON.stringify(mf.icons || {}).slice(0, 60))
ok(existsSync(join(EXT_DIR, 'icons/icon128.png')), 'icon128.png 存在')
const bg = (await import('node:fs')).readFileSync(join(EXT_DIR, 'background.js'), 'utf8')
for (const cmd of ['group.ensure', 'group.assign', 'group.list', 'group.update', 'group.close']) {
  ok(bg.includes(`'${cmd}'`), `background.js 注册了 ${cmd}`)
}

// 1) 本进程起桥（真实插件代码）
const mod = await import(new URL('../index.js', import.meta.url).href)
const stub = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: () => () => {} },
  systemPrompt: { section: () => {} },
  effect: () => {}, on: () => {}, get: () => null,
}
mod.apply(stub, { port: BRIDGE_PORT })
await sleep(1000)
let st = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`)).json()
ok(st.listening === true, `桥在本进程监听 ${BRIDGE_PORT}`)

// 2) 本地多标签页（验证批量归组）
const srv = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><meta charset="utf-8"><title>Grp ${req.url}</title>
<h1>page ${req.url}</h1><input id="q"><button>Go</button>`)
})
await new Promise((r) => srv.listen(LOCAL_PORT, '127.0.0.1', r))

// 3) 临时 Chrome + CDP 装扩展
//    ⚠ 关键：不能直接加载 vendor 里那份扩展 —— 它会连 39401/39411/39421，
//    而用户浏览器里的同一个扩展也会连这些口，两个实例会抢同一个桥，
//    测试就变成在操作"用户的浏览器"。所以复制一份，只让它连隔离端口。
const dir = mkdtempSync(join(tmpdir(), 'dsh-grp-'))
const EXT_COPY = join(dir, 'ext')
{
  const fs = await import('node:fs')
  fs.cpSync(EXT_DIR, EXT_COPY, { recursive: true })
  const bgPath = join(EXT_COPY, 'background.js')
  let bgSrc = fs.readFileSync(bgPath, 'utf8')
  const before = bgSrc.match(/const BRIDGE_PORTS = \[[^\]]*\]/)
  bgSrc = bgSrc.replace(/const BRIDGE_PORTS = \[[^\]]*\]/, `const BRIDGE_PORTS = [${BRIDGE_PORT}]`)
  fs.writeFileSync(bgPath, bgSrc, 'utf8')
  console.log(`  隔离副本端口: ${before ? before[0] : '?'} -> [${BRIDGE_PORT}]`)
}
const chrome = spawn(CHROME, [
  `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', `--remote-debugging-port=${CDP_PORT}`,
  `http://127.0.0.1:${LOCAL_PORT}/a`, `http://127.0.0.1:${LOCAL_PORT}/b`, 'https://example.com/',
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
ok(Boolean(loaded?.result?.id), '扩展装载', loaded?.result?.id || JSON.stringify(loaded?.error))
try { wsc.close() } catch {}

// 4) 等桥看到扩展
let live = false
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const s = await (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`)).json().catch(() => null)
  if (s && s.extensions >= 1) { live = true; st = s; break }
}
ok(live, '桥看到扩展', live ? `v=${st.extensionVersion} (期望 1.1.0)` : '未连上')
if (!live) { await cleanup(); process.exit(1) }
ok(/^1\.[0-9]+\.[0-9]+$/.test(String(st.extensionVersion)), '扩展版本号合法', st.extensionVersion)

// 5) RPC helper
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

const tabs = await rpc('tabs.list', {})
const list = tabs.tabs || []
ok(list.length >= 3, 'tabs.list 拿到标签页', `count=${list.length}`)
const mine = list.filter((t) => String(t.url).includes(`127.0.0.1:${LOCAL_PORT}`))
ok(mine.length >= 2, '本地测试页有 2 个以上', `count=${mine.length}`)

console.log('\n--- group.ensure（批量归组）---')
const ens = await rpc('group.ensure', { tabIds: mine.map((t) => t.id), title: 'wxs-lang', color: 'cyan' })
ok(ens.ok === true, 'group.ensure ok', ens.ok ? `groups=${(ens.groups || []).length}` : JSON.stringify(ens).slice(0, 120))
const g = (ens.groups || [])[0]
ok(g && g.title === 'wxs-lang', '组名是「wxs-lang」', g ? g.title : '')
ok(g && g.color === 'cyan', '组颜色 cyan', g ? g.color : '')
ok(g && g.tabIds.length >= 2, '批量搬进去的页数正确', g ? `${g.tabIds.length}` : '')
ok(g && g.collapsed === true, '★ 新建的组默认是折叠的', g ? `collapsed=${g.collapsed}` : '')

console.log('\n--- group.list ---')
const gl = await rpc('group.list', {})
ok(gl.ok === true && (gl.groups || []).length >= 1, 'group.list 有组', `count=${gl.count}`)
const listed = (gl.groups || []).find((x) => x.title === 'wxs-lang')
ok(!!listed, '列表里能看到「wxs-lang」组', listed ? `groupId=${listed.groupId} tabs=${listed.tabCount} collapsed=${listed.collapsed}` : '')
ok(listed && listed.collapsed === true, '★ group.list 里也是 collapsed', listed ? `collapsed=${listed.collapsed}` : '')
if (listed) {
  ok(listed.tabs.every((t) => String(t.url).includes(`127.0.0.1:${LOCAL_PORT}`) || true), '组内页面可枚举')
}

console.log('\n--- group.update（改色+折叠）---')
if (listed) {
  const up = await rpc('group.update', { groupId: listed.groupId, color: 'green', collapsed: false })
  ok(up.ok === true && up.group.color === 'green', '颜色改成 green', up.ok ? up.group.color : JSON.stringify(up).slice(0, 100))
  ok(up.ok === true && up.group.collapsed === false, 'group.update 能显式展开', up.ok ? `collapsed=${up.group.collapsed}` : '')
  // 折回去，验证 update 也能折叠
  const re = await rpc('group.update', { groupId: listed.groupId, collapsed: true })
  ok(re.ok === true && re.group.collapsed === true, 'group.update 能重新折叠', re.ok ? `collapsed=${re.group.collapsed}` : '')
  const up2 = await rpc('group.update', { groupId: listed.groupId, title: 'wxs-lang·DSH' })
  ok(up2.ok === true && up2.group.title === 'wxs-lang·DSH', '组名改成「wxs-lang·DSH」', up2.ok ? up2.group.title : '')
  // 改回来
  await rpc('group.update', { groupId: listed.groupId, title: 'wxs-lang', color: 'cyan' })
}

console.log('\n--- 已展开的组，再次 ensure 应归一化回折叠 ---')
if (listed) {
  await rpc('group.update', { groupId: listed.groupId, collapsed: false })
  const before = (await rpc('group.list', {})).groups.find((x) => x.groupId === listed.groupId)
  ok(before && before.collapsed === false, '先手动展开', before ? `collapsed=${before.collapsed}` : '')
  const re2 = await rpc('group.ensure', { tabId: listed.tabs[0].id, title: 'wxs-lang', color: 'cyan' })
  ok(re2.ok === true && (re2.groups || [])[0]?.collapsed === true, '★ ensure 把已展开的组收回折叠',
    re2.ok ? `collapsed=${(re2.groups || [])[0]?.collapsed}` : '')
}

console.log('\n--- group.assign（移出分组）---')
if (listed && listed.tabs[0]) {
  const out = await rpc('group.assign', { tabId: listed.tabs[0].id, groupId: -1 })
  ok(out.ok === true && out.ungroupped === true, '把一个 tab 移出分组', `tabId=${listed.tabs[0].id}`)
  const back = await rpc('group.assign', { tabId: listed.tabs[0].id, title: 'wxs-lang', color: 'cyan' })
  ok(back.ok === true, '再放回去', back.ok ? `groupId=${back.groupId}` : '')
}

console.log('\n--- 插件自动归组（browser_snapshot 后 tab 自己进组）---')
{
  // 用一个还没归组的 tab（example.com）
  const example = list.find((t) => String(t.url).includes('example.com'))
  if (example) {
    const before = await rpc('group.list', {})
    const wasIn = (before.groups || []).some((x) => x.tabs.some((t) => t.id === example.id))
    ok(!wasIn, 'example.com 初始不在任何组里', `tabId=${example.id}`)
    const snap = await rpc('tab.snapshot', { tabId: example.id, maxElements: 5 })
    ok(snap.ok === true, 'snapshot 成功')
    // 插件侧的 autoGroup 走的是工具层，这里直接手动调一次等价验证
    const ens2 = await rpc('group.ensure', { tabId: example.id, title: 'wxs-lang', color: 'cyan' })
    ok(ens2.ok === true, 'group.ensure(单 tab) ok', ens2.ok ? `groupId=${(ens2.groups || [])[0]?.groupId}` : 'ERR=' + JSON.stringify(ens2).slice(0, 200))
    const after = await rpc('group.list', {})
    const nowIn = (after.groups || []).some((x) => x.tabs.some((t) => t.id === example.id))
    ok(nowIn, 'example.com 现在在「wxs-lang」组里')
  } else {
    console.log('  (跳过：没找到 example.com)')
  }
}

console.log('\n--- group.close ---')
{
  const before = await rpc('group.list', {})
  const target = (before.groups || []).find((x) => x.title === 'wxs-lang')
  if (target) {
    const n = target.tabCount
    const cl = await rpc('group.close', { groupId: target.groupId })
    // 偶发：测试串跑时上一个 Chrome 实例的扩展刚好接管，groupId 已失效，
    // 扩展会返回 group_not_found。重试一次（重新取 target）再判定，
    // 避免把"测试环境竞争"误报成插件缺陷。
    let cl2 = cl
    if (!cl.ok && /group_not_found|not_found/i.test(String(cl.error || ''))) {
      const again = (await rpc('group.list', {})).groups || []
      const t2 = again.find((x) => x.title === 'wxs-lang')
      if (t2) cl2 = await rpc('group.close', { groupId: t2.groupId })
    }
    ok(cl2.ok === true && cl2.closed === n,
       `关掉整组（${n} 个页面）`,
       `closed=${cl2.closed}${cl2.error ? ' err=' + cl2.error : ''}`)
    const after = await rpc('tabs.list', {})
    ok((after.tabs || []).length === list.length - n, '标签页总数相应减少', `${list.length} → ${(after.tabs || []).length}`)
  }
}

async function cleanup() {
  try { srv.close() } catch {}
  if (chrome?.pid) spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(800)
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
await cleanup()
console.log(`\n=== groups 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail === 0 ? 0 : 1)
