# Changelog

本文件记录每个版本**用户能感受到的变化**，以及过程中踩过的坑。
格式参考 [Keep a Changelog](https://keepachangelog.com/)。

---

## [2.3.1] — 2026-11-23

首个公开版本。

### 它做什么

通过一个 MV3 扩展加 WebSocket 桥，把 DSH 接到**你已经登录的那个浏览器**上：
点击、输入、截图、开关标签、分组、租约。不新开实例，不抢焦点，多浏览器可同时接入。

24 个 `browser_*` 工具，29 个扩展命令，128 项测试断言。

### 安全

桥监听在 `127.0.0.1`，但这不是安全边界 —— 任何网页都能
`new WebSocket('ws://127.0.0.1:39401')`，连上就能借用户已登录的浏览器
发请求、读页面、截屏。三道防线：

- **Origin 校验**：浏览器发 WebSocket 一定带 `Origin` 头，Node 的 `ws` 客户端不带。
  用这个差别区分网页与扩展/宿主，只放行 `chrome-extension://` 与无 Origin。
- **Host 校验**：挡住 DNS rebinding —— 攻击者把 `evil.com` 解析到 `127.0.0.1` 后，
  网页里 `fetch('http://evil.com:39401/')` 就能读到状态。服务端按 `Host` 头拦。
- **`/rpc` 令牌**：调试通道要 32 位随机 token；状态接口默认不返回 token
  （否则 `GET /` 就成了 token 分发器）。

`test/security.mjs` 用 15 项断言覆盖这三条。

### 关键设计

- **后台截图不抢焦点**：CDP `Page.captureScreenshot` 直接向渲染器要一帧，
  而不是 `captureVisibleTab`（后者只能截可见标签，必须先切前台）
- **点导航链接不卡死**：`el.click()` 触发导航会销毁页面 JS 上下文，
  那一行永远不返回。改成先返回结果、下一宏任务再点
- **双引擎输入**：普通点击走 DOM 注入；只认 `isTrusted` 的站点走 CDP
  `Input.dispatchMouseEvent` / `dispatchKeyEvent`
- **多浏览器不串台**：不靠「挑一个连接」，而靠认领 —— `tabId` 全局唯一，
  桥记住每个 tabId 归哪个连接
- **原生宿主保活**：MV3 的 Service Worker 闲置约 30 秒被浏览器卸载，
  WebSocket 跟着断。宿主进程由浏览器负责拉起，扩展醒来即 `connectNative()`
- **热重载**：ESM 模块缓存是进程级、不可清除的，`fiber.restart()` 只重跑
  `apply()`。实现放进 `impl.js`，入口用 mtime 做 query 破坏缓存

### 安装

`install.ps1` 一键安装：复制插件、装 `ws`（按 `.npmrc` → 官方源 → 国内镜像，
90 秒超时）、写原生宿主清单、注册三个浏览器、自动检测已装扩展 ID、
可选自动改 `cordis.patch.yml`。

扩展本身必须手动在 `chrome://extensions` 加载 —— Chrome 137+ 移除了
`--load-extension`，没有绕过的办法。

### 已知边界

只支持 Chromium 系 · `chrome://` 内部页禁止注入 · 快照只覆盖当前视口附近 ·
超 8 万字符页面文本改为粗略提取 · 截图只含可视区 · 原生宿主需按平台注册
（Windows 有 `.cmd` 启动器，macOS / Linux 要写等价脚本）· 需要 DSH，不是独立 CLI

---

## 开发过程中踩过的坑

留在这里，省得后来者重走一遍。

| 坑 | 症状 | 根因 | 解法 |
|---|---|---|---|
| `.zip` 当 tarball | 市场生成脚本报 `must point at a .tgz` | 约定用 `.tgz` | `npm pack` |
| README 没重生成 | PR 的 `READMEs match data/plugins` 失败 | README 由脚本生成 | `node scripts/generate-readme.mjs` |
| 改了代码不生效 | 文件改了行为没变 | DSH 从 `node_modules/` 读物理副本而非 `vendor/` 原件 | 同步两份，或声明 `file:` 依赖 |
| 热重载后工具绑旧实例 | 扩展连着但报 `extensions: 0` | 工具注册时闭包捕获了那刻的 `bridge`；`globalThis` 只在第一代赋值；`reload()` 没停旧监听 | `liveBridge()` 代理 + 无条件覆盖 `globalThis` + reload 前先 `stop()` |
| `fetch` 测 Host | 看着没生效 | `fetch` 不允许伪造 `Host` 头 | 用原始 TCP socket |
| token 泄露 | `GET /` 吐出 `rpcToken` | 状态接口无条件带该字段 | 只在带对 token 时返回 |
| 脚本删自己 | `install.ps1` 跑一半目录没了 | `$PSScriptRoot` 就是目标目录 | 比对 `Resolve-Path` 后跳过 |
| `.ps1` 语法错 | 中文乱码 + 括号不配对 | PowerShell 5.1 无 BOM 时按 GBK 读 | UTF-8 with BOM + CRLF |
