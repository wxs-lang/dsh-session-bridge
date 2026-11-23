/**
 * hotreload.mjs — 验证"改代码后不用重启 DSH"
 *
 *   node test/hotreload.mjs
 *
 * 做法：
 *   1. 把整个插件目录拷到临时目录（不污染源）
 *   2. 加载入口，收集工具清单
 *   3. 往临时目录的 impl.js 里追加一个新工具定义（模拟"我改了代码"）
 *   4. 调 browser_reload
 *   5. 验证新工具出现 —— 这就是"不用重启 DSH"的证明
 */

import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 拷一份到临时目录 ──────────────────────────────────────────────── */

const dir = mkdtempSync(join(tmpdir(), 'dsh-hotreload-'))
const plugin = join(dir, 'plugin')
cpSync(new URL('..', import.meta.url).pathname.replace(/^\//, ''), plugin, {
  recursive: true,
  filter: (src) => !src.includes('node_modules') && !src.includes('icon-src'),
})
console.log(`\n临时插件目录: ${plugin}`)

/* ── 假 ctx：能注册/注销工具 ────────────────────────────────────────── */

const tools = new Map()
const sections = []
const disposers = []

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: {
    register(def) {
      tools.set(def.name, def)
      const d = () => { tools.delete(def.name) }
      disposers.push(d)
      return d
    },
  },
  systemPrompt: { section: (s) => { sections.push(s) } },
  effect: (fn) => { const d = fn(); return () => { try { d && d() } catch { /* ignore */ } } },
  on: () => {}, get: () => null,
}

/* ── 第一次加载 ─────────────────────────────────────────────────────── */

console.log('\n[1] 首次加载入口')
const entryUrl = `file:///${plugin.replace(/\\/g, '/')}/index.js`
const entry = await import(entryUrl)
ok(entry.name === 'dsh-browser-bridge', '入口 name 正确', entry.name)
ok(typeof entry.apply === 'function', '入口导出 apply')

entry.apply(ctx, { port: 39429 })
await sleep(1500)

const count1 = tools.size
console.log(`     工具数 = ${count1}`)
ok(count1 >= 20, '工具已注册（≥20）', String(count1))
ok(tools.has('browser_conn'), '含 browser_conn')
ok(!tools.has('browser_probe_test'), '此时还没有 browser_probe_test（预期）')

/* ── 模拟"改代码"：往 impl.js 追一个新工具 ─────────────────────────── */

console.log('\n[2] 往 impl.js 追加一个新工具（模拟改代码）')
const implPath = join(plugin, 'impl.js')
const src = readFileSync(implPath, 'utf8')

// 在 TOOL_SPECS 数组末尾（用 "const TOOL_SPECS = [" 后面的第一个 "]\n" 之前不行，
// 太脆弱。改为在 registerTools 函数前插一个"注入"语句，直接 push 到 TOOL_SPECS）
const marker = 'const TOOL_SPECS = ['
const idx = src.indexOf(marker)
if (idx < 0) { ok(false, '找不到 TOOL_SPECS 定义'); process.exit(1) }

// 找到这个数组的结束位置：从 idx 开始做括号计数
let i = src.indexOf('[', idx)
let depth = 0
let end = -1
for (let p = i; p < src.length; p++) {
  const c = src[p]
  if (c === '[') depth++
  else if (c === ']') { depth--; if (depth === 0) { end = p; break } }
}
if (end < 0) { ok(false, '找不到 TOOL_SPECS 数组结尾'); process.exit(1) }

// 注意：原数组末尾是 `},\n\n]`（最后一个元素后面**已有**逗号）。
// 所以注入时不能再加前导逗号，否则会出现一个 undefined 空元素，
// 后面 registerTools 读 spec.name 就崩（这个坑我踩过）。
const injected = `  {
    name: 'browser_probe_test',
    description: '热重载验证用的临时工具',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    async run() { return { ok: true, marker: 'HOT_RELOAD_WORKED' } },
  },
`

const patched = src.slice(0, end) + injected + src.slice(end)
writeFileSync(implPath, patched, 'utf8')
ok(patched !== src, 'impl.js 已改写', `+${patched.length - src.length} 字节`)

// mtime 要变（破缓存靠它）
await sleep(50)

/* ── 调 browser_reload ──────────────────────────────────────────────── */

console.log('\n[3] 调 browser_reload')
const reloadTool = tools.get('browser_reload')
ok(Boolean(reloadTool), '找到 browser_reload 工具')

if (reloadTool) {
  const bridge = globalThis.__dshBrowserBridge
  const r = await reloadTool.execute({})
  console.log('     返回:', JSON.stringify(r).slice(0, 250))
  ok(r && r.ok !== false, 'reload 返回成功', r && r.error ? String(r.error) : '')

  await sleep(1200)

  console.log(`     重载后工具数 = ${tools.size}`)
  ok(tools.size > count1, '★ 工具数增加了', `${count1} → ${tools.size}`)
  ok(tools.has('browser_probe_test'), '★ 新工具 browser_probe_test 出现了')

  // 真的能调用
  const probe = tools.get('browser_probe_test')
  if (probe) {
    const out = await probe.execute({})
    ok(out && out.marker === 'HOT_RELOAD_WORKED', '★ 新工具可执行，返回正确',
       JSON.stringify(out).slice(0, 100))
  }
}

/* ── 验证旧工具没被弄丢 ────────────────────────────────────────────── */

console.log('\n[4] 原有工具没有被弄丢')
{
  const mustHave = [
    'browser_status', 'browser_windows', 'browser_tabs', 'browser_snapshot',
    'browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_batch',
    'browser_eval', 'browser_navigate', 'browser_screenshot', 'browser_close_tabs',
    'browser_group_ensure', 'browser_lease', 'browser_conn', 'browser_reload',
  ]
  const missing = mustHave.filter((n) => !tools.has(n))
  ok(missing.length === 0, '★ 全部原有工具仍在', missing.length ? `缺: ${missing.join(',')}` : `${mustHave.length} 个都在`)
}

console.log(`\n=== hotreload 结果: pass=${pass} fail=${fail} ===`)

try { globalThis.__dshBrowserBridge?.stop() } catch { /* ignore */ }
await sleep(300)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
