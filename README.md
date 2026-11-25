<div align="center">

# DSH Session Bridge

**把你自己那个已经登录好的浏览器，变成 DSH 的手。**

不新开实例 · 不抢焦点 · 不打断你手上的事
Chrome / Edge / Brave / QQ浏览器 可以同时接入，各自独立

[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Chrome](https://img.shields.io/badge/Chromium-%E2%89%A5116-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://www.chrome.com)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![DSH](https://img.shields.io/badge/DSH-plugin-4d6bfe?style=flat-square)](https://github.com/wxs-lang)

</div>

---

```
你的 Chrome（早已登录，正开着十几个标签）
        ↕   浏览器扩展 + WebSocket
   DSH 插件（16 个 browser_* 工具）
        ↕
   模型：browser_click / browser_type / browser_screenshot …
```

---

## 为什么不是 Playwright / Puppeteer

那些工具会**另起一个浏览器**：干净的 profile、空的 cookie、没有你的扩展、没有你的书签，也没有你昨天还没提交的那张表单。

这个插件走的是反方向——**借用你桌上那台已经登录的浏览器**。

|  | Playwright / Puppeteer | DSH Session Bridge |
|---|---|---|
| 浏览器实例 | 新开一个 | 就用你正在用的那个 |
| 登录态 | 无，得重新登 | 全都在，直接可用 |
| 你原来的标签页 | 看不见 | 可读、可点、可操作 |
| 是否需要重启浏览器 | — | 不用，装个扩展就行 |
| 是否抢焦点 | headless 模式下不抢 | **从不抢**（CDP 后台截图 + 后台开标签） |
| 多浏览器 | 各管各的实例 | 同时接入，按 `browser` 参数精准分发 |

一句话：你要的是「帮我点一下那个已经登录的页面」，而不是「帮我重新登一遍」。

---

## 它专门解决的一个麻烦

多个浏览器共用一个扩展目录时，**桥不知道该把命令交给谁**。

典型症状：

- 在 Chrome 里建了标签组，去 QQ 浏览器里翻遍了也找不到
- 命令明明发出去了，动作却出现在另一个浏览器窗口
- 两个浏览器连着，`browser_click` 时而生效时而不生效

这里的解法不是"挑一个连接用"，而是**认领标签页**：

```
tabId 全局唯一  →  桥记住每个 tabId 归哪个连接  →  带 tabId 的命令精确送达
```

加到第 4 个、第 5 个浏览器？扩展连上同一个桥，归属表自己变大，**一行代码都不用改**。

---

---

## 安全风险：这个插件持有你浏览器的控制权

**请先读完这一节再安装。**

装上之后，DSH 可以通过这个插件：

- 读取你**任何已登录页面**的内容（网银、邮箱、后台、公司 ERP）
- 在你正在用的浏览器里**点击、输入、提交表单**
- 截取页面画面
- 开关标签、读取标签列表

这不是危言耸听，是这个插件的设计目的。所以边界必须讲清楚：

### 三道防线挡的是"网页"，不是"本地恶意软件"

| 防线 | 挡什么 | 不挡什么 |
|---|---|---|
| Origin 校验 | 网页里的 JS 连不上本地桥 | 本机的其他程序 |
| Host 校验 | DNS rebinding | 同上 |
| `/rpc` 令牌 | 网页猜不到调试通道 | 能读你用户目录的进程 |

**任何能以你的身份运行进程的程序，都能绕过这三道防线。**
如果你的机器上已经有恶意软件，这个插件会放大它的能力。

### 只在可信环境用

- ✅ 你自己的个人电脑
- ✅ 你控制的开发机
- ⚠️ 公司电脑 —— 先确认 IT 政策
- ❌ 共享机器、网吧、来路不明的虚拟机

### 不要做的事

- 不要和来路不明的扩展共用同一个浏览器 profile
- 不要在装了网银/支付插件的 profile 里跑自动化任务
- 不要把 `com.dsh.session.json` 的 `allowed_origins` 改成 `*`
- 不要把这个桥暴露到 `0.0.0.0`（代码里硬编码 `127.0.0.1`，别改）

### 权限说明

扩展申请 8 项权限，每一项都有对应功能：

| 权限 | 用来做什么 |
|---|---|
| `tabs` | 列出/开关标签，读标题和 URL |
| `tabGroups` | 自动归组（「大肥鱼」分组） |
| `debugger` | CDP：后台截图、真实输入、整页截图 |
| `scripting` | 注入页面脚本：快照、点击、输入 |
| `nativeMessaging` | 原生宿主保活（解决 SW 休眠断线） |
| `alarms` | 定时清理过期租约、SW 唤醒 |
| `contextMenus` | 右键菜单（归组、清理调试会话） |
| `sidePanel` | 状态面板 |

`host_permissions: <all_urls>` 是必需的 —— 你要操作哪个网站事先不知道。

**早期版本申请了 19 项**（含 `history`、`bookmarks`、`cookies`、`downloads`），
其中 11 项代码从未调用。2.4.0 起全部移除。

### 令牌文件

原生宿主的握手令牌写在 `<tmpdir>/dsh-session-bridge.token`，
权限 `0600`（仅当前用户可读）。桥每次启动重新生成。
文件读不到时宿主传空串、桥放行 —— 这是为了避免权限问题把功能弄坏，
代价是这种情况下少一道校验。

---

## 安装

### 推荐：一键脚本

**Windows**

```powershell
cd dsh-session-bridge
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

**macOS / Linux**

```bash
cd dsh-session-bridge
chmod +x install.sh && ./install.sh
```

脚本会自动完成：

| 步骤 | 做什么 |
|---|---|
| 1 | 检查 Node 版本、DSH profile 是否存在 |
| 2 | 复制插件到 `vendor/`，同步到 `node_modules/` 副本 |
| 3 | 装 `ws` 依赖（按 `.npmrc` → 官方源 → 国内镜像 依次试） |
| 4 | 生成并注册 native messaging 宿主（自动检测已装扩展的 ID） |
| 5 | 打印扩展加载步骤 |
| 6 | 可选追加 `cordis.patch.yml` |
| 7 | **跑 `doctor.mjs` 自检** |

### 装完自检

```bash
node doctor.mjs          # 人类可读
node doctor.mjs --json   # 机器可读
```

检查 9 项，失败项直接给修复命令：

```
dsh-session-bridge 自检
========================================================
  ✓ Node 版本        v24.18.0
  ✓ ws 模块          可解析
  ✓ 插件文件          5 个齐全
  ✓ 版本一致          2.4.0
  ✓ DSH 配置         已登记 dsh-session-bridge
  ✓ 桥端口            39401 在监听
  ✓ 扩展连接          2 个连接，版本 2.4.0
  ✓ 代码新鲜度         已是最新
  ✓ 副本同步          vendor 与 node_modules 一致
========================================================
  9 通过 / 0 警告 / 0 失败
```

### 手动安装

<details>
<summary>展开看逐步操作</summary>

**1. 复制插件**

```bash
cp -r dsh-session-bridge "$DSH_HOME/profiles/desktop/vendor/"
cd "$DSH_HOME/profiles/desktop/vendor/dsh-session-bridge" && npm install ws
```

**2. 合并挂载片段**

把 `cordis.patch.yml` 里的 `- insert:` 块追加到
`$DSH_HOME/profiles/desktop/cordis.patch.yml` 末尾（保持 0 缩进）：

```yaml
- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
```

它是**顶层 insert**，对所有会话生效。

**3. 重启 DSH**

改插件代码后不用重启，调 `browser_reload` 即可热重载
（但改 `index.js` 入口层仍需完整重启）。

</details>

### 二、装扩展

```
1. 打开 chrome://extensions
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择 dsh-session-bridge/extension 目录
```

装好后图标是条蓝鲸鱼：白天蓝色，夜间纯黑，跟着系统深浅色自动换。

**其他浏览器**（Edge / Brave / QQ浏览器 / 360）照做一遍，指同一个目录即可——
它们会各自连上桥，互不干扰。

### 三、装原生宿主（可选，但强烈建议）

MV3 的 Service Worker 会被浏览器卸载，卸载时 WebSocket 一起断。只靠 WebSocket，
断线后要等 `chrome.alarms` 唤醒（最长 60 秒）才能重连。

原生消息宿主（native messaging）把这条路堵死：**宿主进程由浏览器负责拉起**，
扩展一醒来就 `connectNative()`，不存在等 alarm 的窗口期。

```
# 1. 确认 ws 模块可用（native-host.mjs 用它连桥）
#    插件装在 profile 的 vendor/ 下时，通常能解析到 profile 的 node_modules
node -e "require('ws'); console.log('ws ok')"

# 2. 把 com.dsh.session.json 里的两处改成你自己的路径 / 扩展 ID
#    path          → 本机 dsh-session-native.cmd 的绝对路径
#    allowed_origins → 你装上扩展后拿到的 chrome-extension://<id>/
```

改完注册（Windows，当前用户即可，不需要管理员）：

```bat
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.session" /ve ^
  /t REG_SZ /d "<本插件目录>\com.dsh.session.json" /f

rem Edge
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.dsh.session" /ve ^
  /t REG_SZ /d "<本插件目录>\com.dsh.session.json" /f

rem QQ浏览器
reg add "HKCU\Software\Tencent\QQBrowser\NativeMessagingHosts\com.dsh.session" /ve ^
  /t REG_SZ /d "<本插件目录>\com.dsh.session.json" /f
```

装完重载一次扩展。之后浏览器会自己维护宿主进程——杀掉了会重新拉起。

### 四、验证

```
browser_status
→ {
    "extensions": 2,
    "extensionVersion": "2.3.1",
    "connections": [
      { "brand": "Chrome",     "commands": 29, "windows": [290992688] },
      { "brand": "NativeHost", "commands": 30 }
    ],
    "codeFresh": { "stale": false }
  }
```

看到 `extensions >= 1` 且 `stale: false` 就通了。

> `NativeHost` 那条连接是中继通道（宿主进程 ↔ 扩展），不是独立浏览器，
> 它不该拥有标签页。桥的路由会把它排除在 tabId 归属之外，只在没有真实浏览器
> 可用时才兜底。

---

## 工具一览

| 工具 | 作用 |
|---|---|
| `browser_status` | 桥的状态、连接列表、运行中的代码是否落后于磁盘 |
| `browser_windows` | 所有浏览器窗口（品牌 / 标签数 / 是否前台） |
| `browser_tabs` | 标签页列表（合并所有浏览器，可按 `windowId` 过滤） |
| `browser_snapshot` | 页面可交互元素快照（带 ref，供点击/输入引用） |
| `browser_click` | 点击（`ref` 或视口坐标） |
| `browser_type` | 输入文本 |
| **`browser_key`** | **按键：`Enter` / `Escape` / `Control+a` / `Shift+Tab`** |
| **`browser_scroll`** | **滚动：按屏 / 滚到元素 / 到顶 / 到底** |
| **`browser_batch`** | **批量动作，只回一次结果（实测快 11 倍）** |
| **`browser_eval`** | **页面内执行 JS（走 CDP，绕过页面 CSP）** |
| **`browser_drag`** | **拖拽（CDP 真实鼠标按下→移动→释放）** |
| **`browser_mouse`** | **鼠标移动 / 滚轮（CDP）** |
| **`browser_lease`** | **租约：临时标签到期自动清理** |
| `browser_navigate` | 打开 / 跳转 / **`back` `forward` `reload`** |
| `browser_screenshot` | 截图（**CDP 后台取帧，全程不碰焦点**） |
| `browser_close_tabs` | 关闭标签页 |
| `browser_group_ensure` | 把标签收进「大肥鱼」分组 |
| `browser_group_assign` / `list` / `update` / `close` | 分组增删改查 |
| `browser_theme` | 扩展图标主题（跟随系统深浅色） |
| `browser_reload` | 热重载插件本身（不必重启 DSH） |

所有工具都认 `browser` 参数：`auto`（默认）/ `chrome` / `edge` / `qqbrowser`。

---

## 双引擎：DOM 注入 vs CDP 真实输入

每个操作工具都有 `mode` 参数，两种引擎各有用处：

| 引擎 | `mode` | 原理 | 优点 | 缺点 |
|---|---|---|---|---|
| **DOM 注入** | `dom`（默认） | `chrome.scripting.executeScript` 在页面里合成事件 | 快（毫秒级）、不需要 attach、无调试横幅 | `event.isTrusted === false`，被防自动化站点拒绝 |
| **CDP 真实输入** | `cdp` | `chrome.debugger` + `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent` | `isTrusted === true`，能触发任何站点 | 需要 attach（有调试横幅）、略慢 |

**实测差异**（本地页面，监听 `event.isTrusted` 才处理）：

```
dom 模式 Enter  →  keydown Enter trusted=false  →  (untrusted enter ignored)
cdp 模式 Enter  →  keydown Enter trusted=true   →  *** TRUSTED ENTER => SUBMIT ***
```

真实世界的例子：**Google 搜索框**只认真实 Enter，`dom` 模式输入后按回车没反应，必须 `mode: "cdp"`。

```js
browser_key({ tabId, ref: inputRef, key: 'Enter', mode: 'cdp' })
browser_click({ tabId, ref: btnRef, mode: 'cdp' })
```

### CDP 模式的三个必须步骤

这些一开始我漏了，导致输入事件被静默丢弃：

```js
await chrome.debugger.attach(target, '1.3')
await chrome.debugger.sendCommand(target, 'Runtime.enable')          // ← 漏了会丢事件
await chrome.debugger.sendCommand(target, 'Page.enable')             // ← 同上
await chrome.debugger.sendCommand(target, 'Emulation.setFocusEmulationEnabled', { enabled: true })
                                                                      // ← 漏了后台标签会被节流
```

### 滚轮的坑

某些 Chrome 版本上 `Input.dispatchMouseEvent({type:'mouseWheel'})` 既不派发 `wheel` 事件也不滚动。
`browser_mouse` 里的实现是 **CDP 优先 + DOM 兜底**：CDP 试过后检查 `scrollY` 有没有变，没变就用原生 `wheel` 事件 + `scrollBy` 补一次。

---

## 租约：临时标签自动清理

跑一个流程会临时开若干标签页。不管的话用户的标签栏越堆越多。

```js
const { leaseId } = await browser_lease({ action: 'open', ttlMs: 600000 })
const { tabId } = await browser_navigate({ url: '...', newTab: true })
await browser_lease({ action: 'attach', leaseId, tabIds: [tabId] })

// ... 干活 ...

await browser_lease({ action: 'release', leaseId })   // 关掉这次新建的标签
// 或者不管它，到期自动回收
```

**用户原有的标签永远不碰。** 到期回收用 `chrome.alarms` 而不是 `setInterval` ——
MV3 的 Service Worker 会被卸载，`setInterval` 随之消失（我实测踩过这个坑，表现是"到期不回收"）。

---

## 性能

**批量 vs 逐条**（本地测试页，4 个动作：点击 → 输入 → Tab → 快照）：

```
browser_batch    313 ms
逐条 4 次调用    3546 ms      ← 快 11 倍
```

原因：批量只产生 1 次往返 + 1 次快照；逐条每条都往返，且默认每条都带快照。

固定序列（登录、填表、提交）一律用 `browser_batch`：

```js
browser_batch({
  tabId,
  actions: [
    { op: 'click', ref: 'e5' },
    { op: 'type', ref: 'e7', text: 'hello' },
    { op: 'key', key: 'Enter', waitAfter: 800 },
  ],
})
```

---

## 上手示例

**读一个已登录的页面**

```
browser_tabs({ windowId: 290992181 })
browser_snapshot({ tabId: 290992484, text: true })
```

**在后台搜一下，不打断你**

```
browser_navigate({ url: "https://www.google.com/search?q=gpt", browser: "chrome" })
→ 返回 tabId；你正在看的那一页没动过
```

**两个浏览器各干各的**

```
browser_windows()
→ [{ windowId: 290992181, browser: "Chrome",    tabCount: 10 },
   { windowId: 768172353, browser: "QQBrowser", tabCount: 5 }]

browser_navigate({ url: "...", browser: "chrome" })     // 只动 Chrome
browser_navigate({ url: "...", browser: "qqbrowser" })  // 只动 QQ浏览器
```

---

---

## 错误码参考

所有失败都返回 `{ ok: false, error: <code>, message }`，不抛异常。
按 code 判断该重试、换页面、还是检查环境：

| code | 含义 | 怎么办 |
|---|---|---|
| `extension_disconnected` | 扩展没连上桥 | `browser_status` 看连接数；点扩展图标唤醒 |
| `timeout` | 命令超时 | 页面可能卡住；先 `browser_snapshot` 探状态 |
| `tab_not_found` | 标签不存在或已关闭 | 重新 `browser_tabs` 拿 id |
| `restricted_page` | 浏览器内部页（`chrome://` 等） | 换普通网页标签 |
| `restricted_store` | 扩展商店页面 | 换页面，任何扩展都动不了 |
| `restricted_pdf` | 内置 PDF 阅读器 | 先下载原文件 |
| `restricted_extension` | 扩展页面 | 换页面 |
| `stale_ref` | ref 在当前页面找不到 | 重新 `browser_snapshot` |
| `stale_snapshot` | 快照超过 10 分钟或页面已变 | 重新 `browser_snapshot` |
| `debugger_busy` | 调试器被 DevTools 或其他扩展占用 | 关掉 DevTools 再试 |
| `debugger_failed` | CDP attach 失败 | 看 message；常见是标签已被回收 |
| `capture_unavailable` | 后台截不到（CDP 失败且未授权切前台） | 传 `keepForeground: true` 或先切到该标签 |
| `capture_failed` | 截图过程中失败 | 重试；整页截图可降 `maxHeight` |
| `navigation_interrupted` | 批量动作触发导航，上下文销毁 | 重新取快照，从剩余动作继续 |
| `no_history` | 没有可后退/前进的历史条目 | 同文档换 query 不产生历史，属正常 |
| `inject_failed` | 注入脚本失败 | 页面可能刚导航；重试 |
| `eval_failed` | `browser_eval` 的表达式抛错 | 看 message 里的 JS 错误 |
| `bad_args` | 参数不合法 | 看 message |
| `create_failed` | 开新标签失败（拿不到 tabId） | 重试；已内置 3 次兜底 |

### 批量动作的中断上报

`browser_batch` 遇到导航或错误会停下来，并**明确告诉你还剩几个没跑**：

```json
{
  "ok": false,
  "actionCount": 10,
  "executed": 4,
  "remaining": 6,
  "aborted": { "index": 3, "op": "click", "code": "navigation_interrupted", "reason": "..." },
  "hint": "第 3 个动作（click）触发了页面导航，后续 6 个动作未执行。请重新取快照确认新页面状态后再继续。"
}
```

---

## 已知边界

写在这里，省得你踩到了以为是它没做好：

按类型分，一眼看出「能不能做」：

| 限制 | 类型 | 说明 |
|---|---|---|
| 只支持 Chromium 系 | ❌ 不支持 | Chrome / Edge / Brave / QQ浏览器 / 360。Firefox 不适用 |
| `chrome://` 等浏览器内部页 | ❌ 不支持 | 报 `restricted_page`。浏览器强制限制，任何扩展都绕不过 |
| 扩展商店页面 | ❌ 不支持 | 报 `restricted_store`，同上 |
| 内置 PDF 阅读器 | ❌ 不支持 | 报 `restricted_pdf`。可先下载原文件，或关掉「在浏览器中打开 PDF」 |
| 系统级快捷键（`Ctrl+W` / `Ctrl+T`） | ❌ 不支持 | 浏览器级快捷键不走页面事件 |
| 虚拟滚动列表的靠后元素 | ⚠️ 需滚动 | 快照返回 `uncoveredBelow` 和提示，按提示 `browser_scroll` 再取 |
| 超大页面文本 | ⚠️ 会截断 | 超 8 万字符改用 `textContent` 粗略提取 |
| `dom` 模式的事件不被信任 | ⚠️ 需切 CDP | `isTrusted === false`，防自动化站点会忽略。用 `mode: "cdp"` |
| `cdp` 模式有调试横幅 | ⚠️ 有痕迹 | attach 期间页面顶部显示"正在调试"，detach 后消失 |
| `cdp` 模式会被其他调试器挡住 | ⚠️ 需关闭冲突 | DevTools 或另一个扩展占用时返回 `debugger_busy` |
| `browser_eval` 依赖 CDP | ⚠️ 同上 | 调试器被占时 attach 失败 |
| `back` / `forward` 需要真实历史 | ⚠️ 有限制 | 同文档内换 query **不产生历史**，报 `no_history` |
| 批量里 `navigate` 会中断后续 | ⚠️ 会上报 | 返回 `aborted` + `remaining`，明确告知剩余动作未执行 |
| 扩展冷启动首批调用偶发失败 | ⚠️ 已兜底 | `tabs.create` 约 20% 概率返回无 id，重试 3 次 |
| 整页截图 | ✅ 支持 | `fullPage: true`，临时放大视口一次截完，超 16000px 自动降 scale |
| 需要 DSH | ℹ️ 前提 | 这是 DSH 插件，不是独立 CLI |

---

## 开发

```bash
# 不依赖真浏览器的测试（任何机器都能跑）
node test/run-all.mjs

# 追加需要真 Chrome + 扩展的 e2e
node test/run-all.mjs --all
```

```
──── unit ────
  ✓ icons.mjs            pass=44 fail=0
  ✓ yaml-check.mjs       pass= 0 fail=0
  ✓ multi-browser.mjs    pass=12 fail=0
  ✓ resilience.mjs       pass= 8 fail=0
──── e2e ────
  ✓ focus.mjs            pass=17 fail=0
  ✓ groups.mjs           pass=37 fail=0
  ✓ theme.mjs            pass= 8 fail=0
```

**e2e 会启动一个独立的 Chrome 实例**（临时 user-data-dir + 独立端口），
碰不到你正在用的浏览器；跑完自动清理。

### 结构

```
index.js                ── DSH 插件（16 个 browser_* 工具）
  ├─ Bridge              WS 服务：连接管理、tabId 归属路由、命令队列
  ├─ TOOL_SPECS          工具定义
  └─ autoGroup           碰过哪个标签，就把它收进分组

extension/background.js  ── MV3 Service Worker（18 个命令）
  ├─ cmdTab*             标签操作：注入页面的函数（pageClick / pageSnapshot / pageType）
  ├─ cmdGroup*           标签分组
  └─ detectBrand()       从 UA 判别真实浏览器（QQ浏览器的 UA 里同样带着 Chrome/xxx）
```

### 两个关键技术点

**后台截图，不抢焦点**

```js
// 用不了的：captureVisibleTab 只能截可见标签，必须先切前台
// 在用的：CDP Page.captureScreenshot 直接向渲染器要一帧
await debugger.attach({ tabId }, '1.3')
const { data } = await debugger.sendCommand({ tabId }, 'Page.captureScreenshot')
debugger.detach({ tabId })   // finally 里必 detach
```

**点导航链接不会卡死**

```js
// 会挂住的：el.click() 触发导航 → 页面 JS 上下文被销毁 → 这一行永远不返回
try { el.click() } catch {}
return { ok: true }        // 20 秒后超时

// 现在的做法：先返回，下一宏任务再点
setTimeout(() => el.click(), 0)
return { clicked: { deferred: true } }
// 然后用 chrome.tabs 的 URL 变化判断结果
```

---

## 许可

MIT © [wxs-lang](https://github.com/wxs-lang)
