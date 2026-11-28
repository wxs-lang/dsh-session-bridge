#!/usr/bin/env node
/**
 * contract.mjs — 命令名 / 错误码的契约一致性
 *
 * 背景：命令名和错误码原本散在 impl.js、background.js、README.md 三处。
 * 改一端忘另一端的后果是「报了个没人认识的错误码」或「文档写的码不存在」。
 *
 * 这个测试把三处对齐：
 *   protocol.js（定义） ↔ background.js（实际抛） ↔ README.md（文档）
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_COMMANDS, ALL_ERROR_CODES, CMD, ERR, ERR_HINT } from '../protocol.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

const BG = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8')
const IMPL = readFileSync(join(ROOT, 'impl.js'), 'utf8')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── ① 契约文件本身 ──
console.log('\n──── ① 契约文件 ────')
ok(ALL_COMMANDS.size >= 25, '命令数合理', String(ALL_COMMANDS.size))
ok(ALL_ERROR_CODES.size >= 20, '错误码数合理', String(ALL_ERROR_CODES.size))

{
  const noHint = [...ALL_ERROR_CODES].filter((c) => !ERR_HINT[c])
  ok(noHint.length === 0, '★ 每个错误码都有修复建议', noHint.join(',') || 'clean')
}

// ── ② 扩展端实际抛的码，必须在契约里 ──
console.log('\n──── ② 扩展端 ↔ 契约 ────')
{
  // 抓 bridgeError('xxx', ...) 的第一个参数
  const thrown = new Set()
  const re = /bridgeError\(\s*'([a-z_]+)'/g
  let m
  while ((m = re.exec(BG)) !== null) thrown.add(m[1])

  ok(thrown.size >= 10, '扩展端抛出的码数量', String(thrown.size))

  const unknown = [...thrown].filter((c) => !ALL_ERROR_CODES.has(c))
  ok(unknown.length === 0, '★ 扩展端抛的码都在契约里', unknown.join(',') || 'clean')

  // 反向：契约里声明"扩展会抛"的码，是否真的抛了（排除桥侧独有的）
  const bridgeOnly = new Set([
    ERR.DISCONNECTED, ERR.TIMEOUT, ERR.NATIVE_HOST_MISSING,
    ERR.EXT, ERR.NO_ATTACHMENTS, ERR.BAD_ARGS, ERR.STALE_SNAPSHOT,
    // 批量中断是 results 里的字段，不是 bridgeError 抛的
    ERR.NAVIGATION_INTERRUPTED,
  ])
  const declaredNotThrown = [...ALL_ERROR_CODES]
    .filter((c) => !bridgeOnly.has(c) && !thrown.has(c))
  ok(declaredNotThrown.length === 0, '契约声明的码扩展端都有实现',
     declaredNotThrown.join(',') || 'clean')
}

// ── ③ 桥侧用的码也在契约里 ──
console.log('\n──── ③ 桥侧 ↔ 契约 ────')
{
  // impl.js 里 fail(E.xxx 或 fail('xxx'
  const used = new Set()
  let m
  const re1 = /fail\(\s*E\.(\w+)/g
  while ((m = re1.exec(IMPL)) !== null) used.add(m[1])
  const re2 = /fail\(\s*'([a-z_]+)'/g
  while ((m = re2.exec(IMPL)) !== null) used.add(m[1])

  ok(used.size >= 3, '桥侧使用的码数量', String(used.size))

  // E 的键名映射到值
  const eBlock = /const E = \{([\s\S]*?)\}/.exec(IMPL)
  const keyToVal = {}
  if (eBlock) {
    for (const line of eBlock[1].split('\n')) {
      const mm = /(\w+):\s*'([a-z_]+)'/.exec(line)
      if (mm) keyToVal[mm[1]] = mm[2]
    }
  }

  const bad = []
  for (const u of used) {
    const val = keyToVal[u] || u
    if (!ALL_ERROR_CODES.has(val)) bad.push(val)
  }
  ok(bad.length === 0, '★ 桥侧用的码都在契约里', bad.join(',') || 'clean')
}

// ── ④ README 文档 ↔ 契约 ──
console.log('\n──── ④ README ↔ 契约 ────')
{
  // README 的错误码表用 | `code` | 格式
  const documented = new Set()
  const re = /\|\s*`([a-z_]+)`\s*\|/g
  let m
  while ((m = re.exec(README)) !== null) {
    if (ALL_ERROR_CODES.has(m[1])) documented.add(m[1])
  }

  ok(documented.size >= 15, 'README 记录的错误码数量', String(documented.size))

  const missing = [...ALL_ERROR_CODES].filter((c) => !documented.has(c))
  ok(missing.length === 0, '★ 所有错误码都在 README 里', missing.join(',') || 'clean')
}

// ── ⑤ 命令名一致性 ──
console.log('\n──── ⑤ 命令名 ────')
{
  // background.js 的 handlers 里注册的命令
  const handlers = new Set()
  const re = /'([a-z]+\.[a-zA-Z]+)':\s*(cmd\w+|async)/g
  let m
  while ((m = re.exec(BG)) !== null) handlers.add(m[1])

  ok(handlers.size >= 20, '扩展端注册的命令数', String(handlers.size))

  const notInContract = [...handlers].filter((c) => !ALL_COMMANDS.has(c))
  ok(notInContract.length === 0, '★ 扩展端注册的命令都在契约里',
     notInContract.join(',') || 'clean')
}

console.log(`\n=== contract 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail ? 1 : 0)
