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

## 安装

### 一、装插件

```bash
# 放进 DSH profile 的 vendor 目录
#   Windows : %USERPROFILE%\.dsh\profiles\desktop\vendor\
#   macOS/Linux : ~/.dsh/profiles/desktop/vendor/
cp -r dsh-session-bridge "$DSH_HOME/profiles/desktop/vendor/"
```

把仓库里的 `cordis.patch.yml` **合并**进
`$DSH_HOME/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
```

它是**顶层 insert**，对所有会话生效（不是只对某个 preset 生效）。
合并时保持 0 缩进；如果目标文件本身就是列表，按它已有的风格接上去即可。

重启 DSH 一次。之后改插件代码就不必再重启了——调一次 `browser_reload` 即可热重载。

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

## 已知边界

写在这里，省得你踩到了以为是它没做好：

| 限制 | 说明 |
|---|---|
| 只支持 Chromium 系 | Chrome / Edge / Brave / QQ浏览器 / 360。Firefox 不适用 |
| `chrome://` 页面动不了 | 浏览器内部页禁止脚本注入 |
| 快照只覆盖当前视口附近 | 虚拟滚动列表（如 Gmail）里靠后的元素取不到，得先滚动 |
| 超大页面文本会截断 | 超过 8 万字符的页面改用 `textContent` 粗略提取，不是精确可见文本 |
| 截图只含可视区 | 没有整页滚动拼接 |
| 扩展冷启动首批调用偶发失败 | `tab.navigate` 极低概率拿不到 tabId，扩展侧有兜底重查，测试侧带重试 |
| `dom` 模式的事件不被信任 | `isTrusted === false`，防自动化站点会忽略。这类站点必须用 `mode: "cdp"` |
| `cdp` 模式有调试横幅 | `chrome.debugger.attach` 期间页面顶部会显示"XX 正在调试此浏览器"，detach 后消失 |
| `cdp` 模式会被其他调试器挡住 | DevTools 或另一个扩展正在调试该标签时 attach 失败，返回 `debugger_busy` |
| 系统级快捷键仍做不到 | `Ctrl+W` / `Ctrl+T` 这类浏览器级快捷键走页面事件无效，需要 CDP `Input.dispatchKeyEvent` 且要浏览器接受 |
| `browser_eval` 依赖 CDP | 目标标签被别的调试器占用时会 attach 失败；`chrome://` 页不可用 |
| `back` / `forward` 需要真实历史条目 | `chrome.tabs.update` 跳到同一文档内不同 query **不产生历史**，会报 `no_history` |
| 批量里 `navigate` 会中断后续动作 | 整页跳转会销毁脚本上下文，`browser_batch` 遇到导航会提前结束 |
| 需要 DSH | 这是 DSH 插件，不是独立 CLI |

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
