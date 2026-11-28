#!/usr/bin/env node
/**
 * hardening.mjs — 四项加固的静态验证
 *
 *  #2 ref epoch 防漂移
 *  #3 队列按连接分片
 *  #4 debugger 租约复用
 *  #5 截图体积控制
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _internals } from '../impl.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const BG = readFileSync(join(ROOT, 'extension', 'background.js'), 'utf8')
const IMPL = readFileSync(join(ROOT, 'impl.js'), 'utf8')

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ── #2 ref epoch ──
console.log('\n──── #2 ref epoch 防漂移 ────')
ok(BG.includes('__dshRefEpoch'), '维护页面级 epoch')
ok(BG.includes('function resolveRef('), '有 resolveRef 统一解析')
ok(/e\$\{epoch\}-/.test(BG), 'ref 格式带 epoch（e4-12）')
ok(BG.includes("error: 'stale_ref'"), 'epoch 不匹配报 stale_ref')
ok(BG.includes('isConnected'), '校验节点是否还在文档里')

{
  // 直接定位 querySelector 的应该全被 resolveRef 取代
  const direct = BG.split('document.querySelector(`[data-dsh-ref=').length - 1
  ok(direct === 0, '★ 没有绕过 resolveRef 的直接定位', `${direct} 处残留`)
  ok(BG.split('resolveRef(').length - 1 >= 8, 'resolveRef 调用覆盖所有操作',
     String(BG.split('resolveRef(').length - 2) + ' 处')
}

// ── #3 队列分片 ──
console.log('\n──── #3 队列按连接分片 ────')
ok(IMPL.includes('this.queues = new Map()'), '队列改成 Map 分片')
ok(!/this\.queue\.then/.test(IMPL), '★ 没有残留的全局单链')
ok(IMPL.includes("__default__"), '有无 connId 时的兜底分片')
ok(IMPL.includes('this.queues.delete(lane)'), '链走完清理分片（防 Map 泄漏）')

// ── #4 debugger 租约 ──
console.log('\n──── #4 debugger 租约复用 ────')
ok(BG.includes('DBG_LEASE_MS'), '有租约时长常量')
ok(BG.includes('dbgLeases'), '有租约表')
ok(BG.includes('function touchDbgLease('), '有顺延函数')
ok(BG.includes('function releaseDbgLease('), '有释放函数')
ok(BG.includes('chrome.tabs.onRemoved.addListener'), '★ 标签关闭立刻释放')
ok(BG.includes('chrome.debugger.onDetach.addListener'), '★ 外部 detach 时清记录')
ok(/No tab with|not found|Invalid tab/.test(BG), '识别标签已销毁')

{
  // withDebugger 内部不应该再有 detach
  const i = BG.indexOf('async function withDebugger(')
  const j = BG.indexOf('async function cdpClick(')
  const body = BG.slice(i, j)
  ok(!body.includes('chrome.debugger.detach'), '★ withDebugger 不再自己 detach')
  ok(body.includes('reused'), '有复用判定')
}

// ── #5 截图体积 ──
console.log('\n──── #5 截图体积控制 ────')
ok(/params\.format === 'png' \? 'png' : 'jpeg'/.test(BG), '★ 默认 JPEG（PNG 需显式）')
ok(BG.includes('maxWidth'), '整页截图有 maxWidth')
ok(BG.includes('byWidth'), 'scale 同时受宽度约束')
ok(BG.includes('b64Bytes') || BG.includes('fpBytes'), '返回里上报体积')

{
  const { TOOL_SPECS } = _internals
  const shot = TOOL_SPECS.find((t) => t.name === 'browser_screenshot')
  const props = Object.keys(shot.parameters.properties)
  ok(props.includes('maxWidth'), '工具暴露 maxWidth')
  ok(shot.description.includes('JPEG') || shot.description.includes('体积'), '描述里说明体积考量')
}

// ── 备份文件不入库 ──
console.log('\n──── 备份文件隔离 ────')
{
  const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  ok(gi.includes('.silent-debugger-backup.json'), '★ 备份文件已 gitignore')

  const sd = readFileSync(join(ROOT, 'silent-debugger.mjs'), 'utf8')
  ok(sd.includes('.dsh-session-bridge'), '★ 备份写到用户数据目录')
  ok(!sd.includes("join(HERE, '.silent-debugger-backup.json')"), '不再写到代码目录')
}

console.log(`\n=== hardening 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail ? 1 : 0)
