/**
 * index.js — 薄入口：动态加载 impl.js，支持真正的热重载
 *
 * ── 为什么这么绕 ──
 *
 * ESM 的模块缓存是**进程级、不可清除**的。如果工具定义（TOOL_SPECS）
 * 写在 index.js 里，`fiber.restart()` 只会重新调用 apply()，
 * 用的还是缓存里的旧模块对象 —— 表现就是"热重载成功但新工具不存在"，
 * 必须完整重启 DSH 才生效。
 *
 * 解法：把实现全部放进 impl.js，入口只负责
 *   apply() → import(`./impl.js?t=<mtime>`) → 把 ctx/config 转交给它
 * query string 不同 → 浏览器/Node 视为不同模块 → 一定读磁盘最新代码。
 *
 * 代价：每次重载会多留一份旧模块在内存里（DSH 一次会话通常重载几次，
 * 可接受）。换来的是：**改代码不用重启 DSH**。
 */

import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-session-bridge'
export const inject = ['systemPrompt', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const IMPL = join(HERE, 'impl.js')

/** 当前加载的实现实例（供 browser_reload 等跨代访问） */
let current = null

export function apply(ctx, config = {}) {
  const logger = (ctx && ctx.logger) || console
  const log = {
    info: (...a) => { try { (logger.info || console.log).apply(logger, a) } catch { /* ignore */ } },
    warn: (...a) => { try { (logger.warn || console.warn).apply(logger, a) } catch { /* ignore */ } },
  }

  // 读 mtime 作为缓存破坏参数
  let stamp = '0'
  try { stamp = String(Math.round(statSync(IMPL).mtimeMs)) } catch { /* 文件读不到就退回 0 */ }

  const load = async () => {
    const url = new URL(`./impl.js?t=${stamp}`, import.meta.url).href
    const mod = await import(url)
    if (!mod || typeof mod.apply !== 'function') {
      throw new Error('impl.js 没有导出 apply()')
    }
    // 把当前 ctx/config 交给实现
    mod.apply(ctx, config)
    current = mod
    log.info(`[session-bridge] 实现已加载 impl.js?t=${stamp}`)
    return mod
  }

  // 挂一个"重新加载入口自己"的能力（实现层会用到）
  const reload = async () => {
    // 重新读取 mtime（磁盘可能刚改过）
    let s2 = stamp
    try { s2 = String(Math.round(statSync(IMPL).mtimeMs)) } catch { /* ignore */ }
    const url = new URL(`./impl.js?t=${s2}-${Date.now()}`, import.meta.url).href
    const mod = await import(url)
    if (!mod || typeof mod.apply !== 'function') throw new Error('impl.js 没有导出 apply()')
    // 先让旧实现释放（它自己用 ctx.effect 挂的 dispose 会处理 Bridge.stop）
    mod.apply(ctx, config)
    current = mod
    return { ok: true, stamp: s2 }
  }

  if (!globalThis.__dshBrowserBridgeReloadImpl) {
    globalThis.__dshBrowserBridgeReloadImpl = reload
  }
  if (!globalThis.__dshBrowserBridgeEntry) {
    globalThis.__dshBrowserBridgeEntry = { get impl() { return current }, apply, reload }
  }

  const p = load()
  // 启动失败不阻塞宿主
  Promise.resolve(p).catch((e) => {
    log.warn('[session-bridge] 加载 impl.js 失败：' + String((e && e.message) || e))
  })
}
