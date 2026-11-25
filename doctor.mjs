#!/usr/bin/env node
/**
 * doctor.mjs — 安装后自检
 *
 * 用法：
 *   node doctor.mjs              # 人类可读
 *   node doctor.mjs --json       # 机器可读
 *
 * 检查 8 项，每项给出「状态 / 值 / 失败时怎么办」：
 *   1. Node 版本
 *   2. ws 模块可解析（原生宿主依赖）
 *   3. 插件文件完整性（impl.js / index.js / extension/manifest.json）
 *   4. 版本一致性（package.json / manifest.json / EXT_VERSION）
 *   5. cordis.patch.yml 是否登记本插件
 *   6. 桥端口是否在监听
 *   7. 扩展是否已连接（HTTP 查桥状态）
 *   8. vendor 与 node_modules 副本是否一致
 *
 * 退出码：0 全通过；1 有 fail；2 有 warn 但无 fail
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const JSON_OUT = process.argv.includes('--json')

const results = []
function add(level, name, value, fix) {
  results.push({ level, name, value: String(value ?? ''), fix: fix || '' })
}

/* ── 1. Node ────────────────────────────────────────────────────────── */
{
  const v = process.versions.node
  const major = Number(v.split('.')[0])
  if (major >= 20) add('ok', 'Node 版本', `v${v}`)
  else add('fail', 'Node 版本', `v${v}（需要 20+）`, '升级 Node.js 到 20 或更高')
}

/* ── 2. ws 模块 ─────────────────────────────────────────────────────── */
{
  try {
    require.resolve('ws')
    add('ok', 'ws 模块', '可解析')
  } catch {
    let where = '当前目录'
    try { where = dirname(require.resolve('ws/package.json')) } catch { /* ignore */ }
    add('fail', 'ws 模块', '解析不到', '在插件目录执行 npm install ws；原生宿主与桥都依赖它')
  }
}

/* ── 3. 文件完整性 ──────────────────────────────────────────────────── */
{
  const must = ['impl.js', 'index.js', 'package.json',
                join('extension', 'manifest.json'), join('extension', 'background.js')]
  const missing = must.filter((f) => !existsSync(join(HERE, f)))
  if (missing.length === 0) add('ok', '插件文件', `${must.length} 个齐全`)
  else add('fail', '插件文件', `缺 ${missing.join(', ')}`, '重新解压完整发布包，或重跑安装脚本')
}

/* ── 4. 版本一致性 ──────────────────────────────────────────────────── */
{
  let pkgV = '?', manV = '?', extV = '?'
  try { pkgV = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version } catch { /* ignore */ }
  try { manV = JSON.parse(readFileSync(join(HERE, 'extension', 'manifest.json'), 'utf8')).version } catch { /* ignore */ }
  try {
    const bg = readFileSync(join(HERE, 'extension', 'background.js'), 'utf8')
    const m = /EXT_VERSION = '([^']+)'/.exec(bg)
    if (m) extV = m[1]
  } catch { /* ignore */ }

  const all = [pkgV, manV, extV]
  const same = all[0] === all[1] && all[1] === all[2]
  if (same) add('ok', '版本一致', `${pkgV}`)
  else add('fail', '版本一致', `package=${pkgV} manifest=${manV} EXT=${extV}`,
    '三个文件的版本号必须相同，否则浏览器会拒绝加载或行为不一致')
}

/* ── 5. cordis.patch.yml 登记 ───────────────────────────────────────── */
{
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const patch = join(dshHome, 'profiles', 'desktop', 'cordis.patch.yml')
  if (!existsSync(patch)) {
    add('warn', 'DSH 配置', `找不到 ${patch}`, '先启动一次 DSH 让它生成配置目录')
  } else {
    const t = readFileSync(patch, 'utf8')
    if (t.includes('dsh-session-bridge')) add('ok', 'DSH 配置', '已登记 dsh-session-bridge')
    else add('fail', 'DSH 配置', 'cordis.patch.yml 里没有本插件',
      '把 cordis.patch.yml 里的 - insert: 块追加到 profile 的 cordis.patch.yml，然后重启 DSH')
  }
}

/* ── 6/7. 桥端口与扩展连接 ──────────────────────────────────────────── */
const PORTS = [39401, 39411, 39421]

function probe(port, timeoutMs = 1500) {
  return new Promise((res) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (r) => {
        let b = ''
        r.on('data', (d) => { b += d })
        r.on('end', () => {
          try { res({ port, data: JSON.parse(b.replace(/^\uFEFF/, '')) }) }
          catch { res({ port, data: null }) }
        })
      })
    req.on('timeout', () => { req.destroy(); res(null) })
    req.on('error', () => res(null))
  })
}

let live = null
for (const p of PORTS) {
  const r = await probe(p)
  if (r && r.data && typeof r.data.listening === 'boolean') { live = r; break }
}

if (!live) {
  add('fail', '桥端口', `试过 ${PORTS.join(' / ')}，都没有响应`,
    '启动 DSH；若已启动，检查 cordis.patch.yml 是否生效（需要完全退出再启动）')
  add('fail', '扩展连接', '无法检查（桥没起来）', '先让桥起来')
} else {
  add('ok', '桥端口', `${live.port} 在监听`)
  const d = live.data
  const n = Number(d.extensions) || 0
  if (n > 0) {
    add('ok', '扩展连接', `${n} 个连接，版本 ${d.extensionVersion || '?'}`)
  } else {
    add('fail', '扩展连接', '0 个',
      '① chrome://extensions 确认本扩展已启用 ② 点扩展图标唤醒 ③ 检查扩展目录是否指向正确路径')
  }
  if (d.codeFresh && d.codeFresh.stale) {
    add('warn', '代码新鲜度', '磁盘比内存新', '完全退出 DSH 再启动（browser_reload 清不掉 ESM 缓存）')
  } else {
    add('ok', '代码新鲜度', '已是最新')
  }
  if (d.lastError) add('warn', '最近错误', d.lastError, '看 TROUBLESHOOTING.md')
}

/* ── 8. vendor / node_modules 一致性 ───────────────────────────────── */
{
  // 找到 profile 下的 node_modules 副本
  const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  const nm = join(dshHome, 'profiles', 'desktop', 'node_modules', 'dsh-session-bridge')
  if (!existsSync(nm)) {
    add('ok', '副本同步', '无 node_modules 副本（不需要同步）')
  } else {
    let same = true
    const detail = []
    for (const f of ['impl.js', 'index.js']) {
      const a = join(HERE, f)
      const b = join(nm, f)
      if (!existsSync(a) || !existsSync(b)) { same = false; detail.push(`${f} 缺`); continue }
      const sa = statSync(a)
      const sb = statSync(b)
      if (sa.size !== sb.size) { same = false; detail.push(`${f} ${sa.size}≠${sb.size}`) }
    }
    if (same) add('ok', '副本同步', 'vendor 与 node_modules 一致')
    else add('fail', '副本同步', detail.join('; '),
      'DSH 会优先加载 node_modules 副本，不同步会导致改动不生效。重跑安装脚本，或手动复制 vendor/* 到 node_modules/dsh-session-bridge/')
  }
}

/* ── 输出 ───────────────────────────────────────────────────────────── */
if (JSON_OUT) {
  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log(JSON.stringify({ ok: fails === 0, fails, warns, results }, null, 2))
} else {
  const icon = { ok: '\u2713', warn: '!', fail: '\u2717' }
  const color = { ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' }
  const reset = '\x1b[0m'
  console.log('\ndsh-session-bridge \u81ea\u68c0\n' + '='.repeat(56))
  for (const r of results) {
    console.log(`  ${color[r.level]}${icon[r.level]}${reset} ${r.name.padEnd(14)} ${r.value}`)
    if (r.fix && r.level !== 'ok') console.log(`      \u2192 ${r.fix}`)
  }
  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log('='.repeat(56))
  console.log(`  ${results.length - fails - warns} \u901a\u8fc7 / ${warns} \u8b66\u544a / ${fails} \u5931\u8d25`)
  console.log()
}

const fails = results.filter((r) => r.level === 'fail').length
const warns = results.filter((r) => r.level === 'warn').length
process.exit(fails > 0 ? 1 : (warns > 0 ? 2 : 0))
