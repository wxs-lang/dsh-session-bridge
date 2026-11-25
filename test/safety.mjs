#!/usr/bin/env node
/**
 * safety.mjs — 防止误操作的两道闸
 *
 * 背景：抖店这类页面有真实业务数据，误点一下可能改价、改库存。
 * 之前的默认值是「没给 tabId 就用当前活动标签」—— 猜的方向恰好是
 * 「最可能是用户正在看的那个」，对有副作用的操作来说这个默认值是反的。
 *
 * 两道闸：
 *   ① 操作类工具强制要求 tabId（不猜活动标签）
 *   ② 快照绑定 tabId + url，用旧 ref 在已导航的页面上操作会被拦
 */
import { _internals } from '../impl.js'

const { TOOL_SPECS } = _internals

let pass = 0
let fail = 0
function ok(cond, name, detail) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ── ① tabId 必填 ──
console.log('\n──── ① 操作类工具强制要求 tabId ────')

const MUST_HAVE = [
  'browser_click', 'browser_type', 'browser_key', 'browser_scroll',
  'browser_eval', 'browser_drag', 'browser_mouse', 'browser_screenshot',
  'browser_snapshot', 'browser_batch',
]
const NO_NEED = [
  'browser_status', 'browser_windows', 'browser_tabs',
  'browser_group_list', 'browser_theme', 'browser_reload',
]

for (const name of MUST_HAVE) {
  const spec = TOOL_SPECS.find((t) => t.name === name)
  if (!spec) { ok(false, `${name} 存在`); continue }
  const req = (spec.parameters && spec.parameters.required) || []
  ok(req.includes('tabId'), `${name} 要求 tabId`, JSON.stringify(req))
}

for (const name of NO_NEED) {
  const spec = TOOL_SPECS.find((t) => t.name === name)
  if (!spec) { ok(false, `${name} 存在`); continue }
  const req = (spec.parameters && spec.parameters.required) || []
  ok(!req.includes('tabId'), `${name} 不强制 tabId`, JSON.stringify(req))
}

// ── ② 快照绑定 ──
console.log('\n──── ② 快照绑定 tabId + url ────')

// 用假 bridge 验证 checkSnapshotFresh 的过期逻辑
const { snapshotsForTest, checkSnapshotFresh, rememberSnapshot } = _internals

ok(typeof rememberSnapshot === 'function', 'rememberSnapshot 已导出')
ok(typeof checkSnapshotFresh === 'function', 'checkSnapshotFresh 已导出')

rememberSnapshot(12345, 'https://example.com/a')
ok(checkSnapshotFresh(12345, null) === null, '刚记录的快照通过校验')

// 手动把时间调旧，验证过期
const store = snapshotsForTest()
const rec = store.get(12345)
ok(Boolean(rec), '快照记录已存入')
if (rec) {
  rec.at = Date.now() - 11 * 60 * 1000   // 11 分钟前
  const r = checkSnapshotFresh(12345, null)
  ok(r !== null && r.ok === false, '★ 超过 10 分钟的快照被拒')
  ok(String(r.message || '').includes('browser_snapshot'), '提示里要求重取快照')
}

ok(checkSnapshotFresh(99999, null) === null, '没取过快照的 tabId 不拦（坐标模式）')

console.log(`\n=== safety 结果: pass=${pass} fail=${fail} ===`)
process.exit(fail ? 1 : 0)
