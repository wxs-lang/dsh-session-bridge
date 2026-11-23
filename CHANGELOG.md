# Changelog

每个版本**用户能感受到的变化**，以及过程中踩过的坑。

---

## [2.3.0] — 2026-11-23

改名 + 安全加固 + 一键安装。

### 破坏性变更

- **包名 `dsh-browser-bridge` → `dsh-session-bridge`**

  市场里已有两个同名但技术路线完全不同的项目（`alvinlui-hk/dsh-browser-bridge`
  操作 Sidebar 内嵌浏览器、`xkzm123/dsh-browser-bridge` 用 Windows UI Automation），
  三者都叫这个名字，用户根本分不清。新名字强调「接管你已有的会话」。

  **升级要做两件事**：
  1. `cordis.patch.yml` 里的 `id` / `name` 改成 `dsh-session-bridge`
  2. 原生宿主注册表项从 `com.dsh.bridge` 改成 `com.dsh.session`
     （重跑 `install.ps1` 会自动完成，它会清掉旧项）

- **原生宿主名 `com.dsh.bridge` → `com.dsh.session`**
  旧注册表项不清理会留一条死链，指向已删除的 `.cmd`。
  `install.ps1` 和 `uninstall.ps1` 都会清新旧两套。

- **启动器 `dsh-bridge-native.cmd` → `dsh-session-native.cmd`**

### 安全

堵住三个真实攻击面（新增 `test/security.mjs`，15 项断言）：

- **Origin 校验**
  任何网页都能 `new WebSocket('ws://127.0.0.1:39401')` 连上桥，然后借用户
  已登录的浏览器发请求、读页面、截屏——桥原来没有任何鉴权。

  浏览器发起 WebSocket 时**一定带 `Origin` 头**，Node 的 `ws` 客户端不带。
  用这个差别区分：只放行 `chrome-extension://` 与无 Origin，网页一律拒绝。

- **Host 校验（DNS rebinding）**
  攻击者把 `evil.com` 解析到 `127.0.0.1`，网页里
  `fetch('http://evil.com:39401/')` 就能读到状态。服务端按 `Host` 头拦，
  必须是回环地址。

  这个检查**必须在所有路由之前**——最初只加在 `/rpc` 分支里，
  结果 `GET /` 照样把 token 吐出去了。

- **`/rpc` 令牌**
  调试通道原来谁都能触发命令。现在要 32 位随机 token；
  状态接口默认**不返回** token（否则 `GET /` 就成了 token 分发器）。

### 新增

- **`install.ps1`** 一键安装
  复制插件、装 `ws`（按 `.npmrc` → 官方源 → 国内镜像 依次试，90 秒超时）、
  写原生宿主清单、注册三个浏览器、自动检测已装扩展 ID 并填入、
  可选自动追加 `cordis.patch.yml`。

- **`uninstall.ps1`**
  按安装反序清理，`-KeepFiles` 只注销不删目录。

- **`TROUBLESHOOTING.md`**
  11 类症状的排查步骤，每条都给出「怎么确认」和「怎么修」。

### 修复

- **改了代码不生效**（最坑的一个）

  DSH 通过 `cordis.patch.yml` 里的 `name:` 做模块解析，优先级是
  `node_modules/` > `vendor/`。`node_modules/` 里是**物理副本**（不是符号链接），
  vendor 里改的不会同步过去。

  此前多轮改动都写进了 vendor，运行时读的却是 node_modules 的旧副本，
  表现是「文件明明改了，行为一点没变」，`codeFresh.stale` 还可能报 `false`
  ——因为它比的是磁盘 mtime，不是内存里的模块。

  现在 `install.ps1` 会同步两份；`TROUBLESHOOTING.md` 第三节写了完整排查流程。

- **`install.ps1` 会删掉自己**

  第一版里 `$pluginDir = $PSScriptRoot`，而目标目录就是同一个目录。
  执行到「清理旧版本」时 `Remove-Item $target -Recurse` 把正在跑的脚本
  连同整个目录一起删了。

  现在先比对 `Resolve-Path`，源与目标相同时跳过复制/清理。

- **`.ps1` 无 BOM 导致语法错误**

  Windows PowerShell 5.1 没有 BOM 时按 ANSI（GBK）读文件，
  中文注释全乱，连 `}` 都配对不上。所有 `.ps1` 现在写 UTF-8 with BOM + CRLF。

- 清掉调试用的 `_probe_*.mjs` 临时文件。

---

## [2.2.0] — 2026-11-23

结构性升级：断线根治、热重载生效、输入能力补齐。

### 新增

- **原生消息宿主**（`native-host.mjs`）

  MV3 的 Service Worker 闲置约 30 秒被浏览器卸载，WebSocket 一起断，
  之后只能等 `chrome.alarms` 唤醒（最长 60 秒）。空窗期里所有 `browser_*` 都失败。

  宿主进程**由浏览器负责拉起**，扩展一醒来就 `connectNative()`，不等定时器。
  实测杀掉宿主进程后浏览器 5 秒内自动重挂。

- **双引擎输入**：DOM 注入 vs CDP 真实输入。
  `browser_mouse` / `browser_drag` / `browser_scroll` / `browser_key` 走 CDP，
  能触发只认 `isTrusted` 的站点（Google 搜索框这类）。

- **租约** `browser_lease`：临时标签到期自动关闭，只碰本轮自己开的页面。

- **`browser_eval`**（页面上下文求值）、**`browser_batch`**（一次往返批量执行）。

- 扩展命令数 18 → 29。

### 修复

- **热重载终于生效**

  之前 `browser_reload` 返回 `ok: true` 但新工具不出现，必须重启 DSH。
  根因：ESM 模块缓存是**进程级、不可清除**的，`fiber.restart()` 只重跑
  `apply()`，用的还是缓存里的旧模块对象。

  解法：`index.js` 瘦成 82 行薄入口，实现全在 `impl.js`，加载时用 mtime 做 query：

  ```js
  const stamp = String(Math.round(statSync(IMPL).mtimeMs))
  const url = new URL(`./impl.js?t=${stamp}`, import.meta.url).href
  const mod = await import(url)   // query 不同 → 一定读磁盘最新代码
  ```

- **中继通道抢 tabId 归属**

  `NativeHost` 会响应 `tabs.list`，桥把同一批 tabId 记到了中继连接名下，
  之后带 tabId 的命令全被路由到只声明部分命令的窄通道，
  表现为 `browser_snapshot` 卡 45 秒超时，或误报「都不支持该命令」。

  修法：`_isRelay()` —— 中继不参与 tabId 归属竞争；`socketFor` / `requestAll`
  优先真实浏览器，中继只在无真实连接时兜底。

- **NativeHost connId 撞车**

  两个浏览器 profile 各拉起一个宿主，原来都是 `NativeHost:w`。
  现在 URL 带 pid，是 `NativeHost:29300` / `NativeHost:4120`。

- **native-host 命令清单写死**

  原来硬编码 18 条，扩展加到 29 条后新的 11 个会被判成「不支持」。
  现在先声明 `commands: ['*']`，再发 `need-capabilities` 向扩展要真实清单。

---

## [1.6.0] — 2026-11-22

首个公开发布。

16 个 `browser_*` 工具，通过 MV3 扩展 + WebSocket 桥操控用户已登录的浏览器：
不新开实例、不抢焦点、多浏览器并存。

三个核心技术点：

- **后台截图不抢焦点**：CDP `Page.captureScreenshot` 直接向渲染器要一帧，
  而不是 `captureVisibleTab`（后者只能截可见标签，必须先切前台）
- **点导航链接不卡死**：`el.click()` 触发导航会销毁页面 JS 上下文，
  那一行永远不返回。改成先返回结果、下一宏任务再点
- **多浏览器不串台**：不靠「挑一个连接」，而靠认领 —— `tabId` 全局唯一，
  桥记住每个 tabId 归哪个连接

---

## 踩过的坑

| 坑 | 症状 | 根因 | 解法 |
|---|---|---|---|
| `.zip` 当 tarball | 市场脚本报 `must point at a .tgz` | 约定用 `.tgz` | `npm pack` |
| README 没重生成 | PR 的 `READMEs match data/plugins` 失败 | README 由脚本生成 | `node scripts/generate-readme.mjs` |
| 仓库太新 | PR 可能被拒 | 要求创建满 1 天 | 等 24 小时 |
| 改代码不生效 | 文件改了行为没变 | DSH 从 `node_modules/` 读副本 | 同步两份 |
| `fetch` 测 Host | 看着没生效 | `fetch` 不许伪造 `Host` | 用原始 TCP |
| token 泄露 | `GET /` 吐出 token | 状态无条件带该字段 | 带对 token 才返回 |
| 脚本删自己 | install.ps1 跑一半目录没了 | 源目录 = 目标目录 | 比对路径后跳过 |
| `.ps1` 语法错 | 中文乱码 + 括号不配对 | PS 5.1 无 BOM 按 GBK 读 | UTF-8 with BOM |
