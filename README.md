<div align="center">

# DSH Browser Bridge

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

|  | Playwright / Puppeteer | DSH Browser Bridge |
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
cp -r dsh-browser-bridge "$DSH_HOME/profiles/desktop/vendor/"
```

把仓库里的 `cordis.patch.yml` **合并**进
`$DSH_HOME/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-browser-bridge
      name: dsh-browser-bridge
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
4. 选择 dsh-browser-bridge/extension 目录
```

装好后图标是条蓝鲸鱼：白天蓝色，夜间纯黑，跟着系统深浅色自动换。

**其他浏览器**（Edge / Brave / QQ浏览器 / 360）照做一遍，指同一个目录即可——
它们会各自连上桥，互不干扰。

### 三、验证

```
browser_status
→ { "extensions": 1, "connections": [{ "brand": "Chrome", "commands": 18 }] }
```

看到 `extensions: 1` 就通了。

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
| `browser_navigate` | 打开 / 跳转（**默认后台，不切前台**） |
| `browser_screenshot` | 截图（**CDP 后台取帧，全程不碰焦点**） |
| `browser_close_tabs` | 关闭标签页 |
| `browser_group_ensure` | 把标签收进「wxs-lang」分组 |
| `browser_group_assign` / `list` / `update` / `close` | 分组增删改查 |
| `browser_theme` | 扩展图标主题（跟随系统深浅色） |
| `browser_reload` | 热重载插件本身（不必重启 DSH） |

所有工具都认 `browser` 参数：`auto`（默认）/ `chrome` / `edge` / `qqbrowser`。

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
