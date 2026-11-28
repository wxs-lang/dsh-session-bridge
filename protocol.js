/**
 * protocol.js — 扩展端与桥接端共享的契约
 *
 * 为什么需要：
 *   命令名和错误码原本散落在 impl.js、background.js、README.md 三处。
 *   改了一端忘了另一端，表现就是"报了个没人认识的错误码"，
 *   或者文档里写的码实际不存在。
 *
 * 用法：
 *   扩展（MV3 service worker，用 importScripts 或直接内联）
 *   桥（ESM，import { CMD, ERR } from './protocol.js'）
 *   测试（import 后逐项校验）
 *
 * 这个文件必须**零依赖、纯数据**，两端都能直接吃。
 */

/* ── 命令名 ──────────────────────────────────────────────────────────
 * 键是语义名，值是线上传的字面量。改字面量要同步改两端。
 */
export const CMD = {
  // 标签页
  TABS_LIST: 'tabs.list',
  TAB_INFO: 'tab.info',
  TAB_SNAPSHOT: 'tab.snapshot',
  TAB_CLICK: 'tab.click',
  TAB_TYPE: 'tab.type',
  TAB_KEY: 'tab.key',
  TAB_SCROLL: 'tab.scroll',
  TAB_NAVIGATE: 'tab.navigate',
  TAB_EVAL: 'tab.eval',
  TAB_EVALUATE: 'tab.evaluate',   // 主世界 eval（不受 CSP 限制）
  TAB_DRAG: 'tab.drag',
  TAB_MOUSE: 'tab.mouse',
  TAB_SCREENSHOT: 'tab.screenshot',
  TAB_BATCH: 'tab.batch',
  TAB_CLOSE: 'tab.close',
  TABS_CLOSE: 'tabs.close',
  TABS_GROUP: 'tabs.group',

  // 窗口
  WINDOWS_LIST: 'windows.list',

  // 分组
  GROUP_ENSURE: 'group.ensure',
  GROUP_ASSIGN: 'group.assign',
  GROUP_LIST: 'group.list',
  GROUP_UPDATE: 'group.update',
  GROUP_CLOSE: 'group.close',

  // 租约
  LEASE_OPEN: 'lease.open',
  LEASE_RENEW: 'lease.renew',
  LEASE_ATTACH: 'lease.attach',
  LEASE_RELEASE: 'lease.release',
  LEASE_LIST: 'lease.list',

  // 调试
  DEBUG_INFO: 'debug.info',
  DEBUG_UA: 'debug.ua',
  THEME_ICON: 'theme.icon',
  DEBUG_DETACH_ALL: 'debug.detachAll',

  // 宿主本地命令（不转发给扩展）
  HOST_FIX_SILENT_DEBUGGER: 'host.fix-silent-debugger',
  HOST_INFO: 'host.info',
  HOST_SHUTDOWN: '__host.shutdown',
}

/* ── 错误码 ──────────────────────────────────────────────────────────
 * 每个码都要在 README 的错误码表里有一行。测试会校验这个一致性。
 */
export const ERR = {
  // 连接层
  DISCONNECTED: 'extension_disconnected',
  TIMEOUT: 'timeout',
  NATIVE_HOST_MISSING: 'native_host_missing',

  // 参数
  BAD_ARGS: 'bad_args',
  NO_TAB: 'tab_not_found',
  NO_TAB_LEGACY: 'no_tab',   // 扩展侧旧写法，保留兼容

  // 页面限制（细分，让调用方知道能不能换条路）
  RESTRICTED_PAGE: 'restricted_page',
  RESTRICTED_STORE: 'restricted_store',
  RESTRICTED_PDF: 'restricted_pdf',
  RESTRICTED_EXTENSION: 'restricted_extension',

  // ref / 快照
  STALE_REF: 'stale_ref',
  STALE_SNAPSHOT: 'stale_snapshot',

  // 调试器
  DEBUGGER_BUSY: 'debugger_busy',
  DEBUGGER_FAILED: 'debugger_failed',
  CDP_FAILED: 'cdp_failed',

  // 截图
  CAPTURE_UNAVAILABLE: 'capture_unavailable',
  CAPTURE_FAILED: 'capture_failed',

  // 动作
  INJECT_FAILED: 'inject_failed',
  EVAL_FAILED: 'eval_failed',
  NAVIGATION_INTERRUPTED: 'navigation_interrupted',
  NO_HISTORY: 'no_history',
  CREATE_FAILED: 'create_failed',
  UNKNOWN_COMMAND: 'unknown_command',

  // 通用
  EXT: 'extension_error',
  NO_ATTACHMENTS: 'attachments_unavailable',
}

/* ── 错误码 → 人类可读的修复建议 ─────────────────────────────────────
 * README 的错误码表从这里生成，避免文档漂移。
 */
export const ERR_HINT = {
  [ERR.DISCONNECTED]: 'browser_status 看连接数；点扩展图标唤醒',
  [ERR.TIMEOUT]: '页面可能卡住；先 browser_snapshot 探状态',
  [ERR.NATIVE_HOST_MISSING]: '重跑 install 脚本装 native messaging 宿主',
  [ERR.BAD_ARGS]: '看 message 里的具体字段',
  [ERR.NO_TAB_LEGACY]: '重新 browser_tabs 拿 id（扩展侧旧写法，与 tab_not_found 同义）',
  [ERR.NO_TAB]: '重新 browser_tabs 拿 id',
  [ERR.RESTRICTED_PAGE]: '换普通网页标签',
  [ERR.RESTRICTED_STORE]: '换页面，任何扩展都动不了',
  [ERR.RESTRICTED_PDF]: '先下载原文件',
  [ERR.RESTRICTED_EXTENSION]: '换页面',
  [ERR.STALE_REF]: '重新 browser_snapshot 取新 ref',
  [ERR.STALE_SNAPSHOT]: '重新 browser_snapshot',
  [ERR.DEBUGGER_BUSY]: '关掉 DevTools 或其他调试扩展再试',
  [ERR.DEBUGGER_FAILED]: '标签可能已被回收；重试',
  [ERR.CDP_FAILED]: '重试；持续失败就换 DOM 模式',
  [ERR.CAPTURE_UNAVAILABLE]: '传 keepForeground: true 或先切到该标签',
  [ERR.CAPTURE_FAILED]: '重试；整页截图可降 maxHeight / maxWidth',
  [ERR.INJECT_FAILED]: '页面可能刚导航；重试',
  [ERR.EVAL_FAILED]: '看 message 里的 JS 错误',
  [ERR.NAVIGATION_INTERRUPTED]: '重新取快照，从剩余动作继续',
  [ERR.NO_HISTORY]: '同文档换 query 不产生历史，属正常',
  [ERR.CREATE_FAILED]: '重试；已内置 3 次兜底',
  [ERR.UNKNOWN_COMMAND]: '扩展版本可能太旧，去 chrome://extensions 刷新',
  [ERR.EXT]: '看 message',
  [ERR.NO_ATTACHMENTS]: 'DSH 的附件服务不可用',
}

/** 所有合法的错误码集合（测试用）。 */
export const ALL_ERROR_CODES = new Set(Object.values(ERR))

/** 所有合法的命令名集合（测试用）。 */
export const ALL_COMMANDS = new Set(Object.values(CMD))
