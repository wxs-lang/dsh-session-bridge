/**
 * run-all.mjs — 跑全部测试，按"能不能独立跑"分组
 *
 *   node test/run-all.mjs            # 只跑不需要真浏览器的
 *   node test/run-all.mjs --all      # 全跑（需要 Chrome + 扩展）
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const runAll = process.argv.includes('--all')

// unit: 纯 stub / 静态检查，任何机器都能跑
const UNIT = ['icons.mjs', 'yaml-check.mjs', 'multi-browser.mjs', 'resilience.mjs',
  'security.mjs', 'hotreload.mjs', 'connmgmt.mjs',
  'handover.mjs', 'portfallback.mjs']
// e2e: 需要真实 Chrome + 加载扩展 + 特定启动参数
const E2E = ['focus.mjs', 'groups.mjs', 'theme.mjs']
// live: 需要对端真实页面
const LIVE = ['live.mjs', 'smoke.mjs', 'multiport.mjs']

const run = (file) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, file)], { stdio: 'pipe' })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.stderr.on('data', (d) => { out += d })
  p.on('close', (code) => {
    const m = out.match(/===\s*([\w-]+)\s*结果:\s*pass=(\d+)\s*fail=(\d+)/)
    resolve({ file, code, pass: m ? +m[2] : 0, fail: m ? +m[3] : (code === 0 ? 0 : 1), raw: out })
  })
})

const groups = [['unit', UNIT]]
if (runAll) groups.push(['e2e', E2E], ['live', LIVE])

let totalPass = 0
let totalFail = 0
const failures = []

for (const [label, files] of groups) {
  console.log(`\n──── ${label} ────`)
  for (const f of files) {
    const r = await run(f)
    totalPass += r.pass
    totalFail += r.fail
    const mark = r.fail === 0 ? '✓' : '✗'
    console.log(`  ${mark} ${f.padEnd(20)} pass=${String(r.pass).padStart(2)} fail=${r.fail}`)
    if (r.fail > 0) failures.push({ file: f, raw: r.raw })
  }
}

console.log(`\n══════════════════════════════════`)
console.log(`  总计 pass=${totalPass}  fail=${totalFail}`)
console.log(`══════════════════════════════════`)

for (const f of failures) {
  console.log(`\n--- ${f.file} 失败详情 ---`)
  console.log(f.raw.split('\n').filter((l) => l.includes('✗')).join('\n'))
}

process.exit(totalFail === 0 ? 0 : 1)
