# 故障排查

按症状查。每条都给出**怎么确认**和**怎么修** —— 先确认再动手，别猜。

绝大多数问题第一步就能定位：

```
browser_status
```

把返回的 `extensions` / `extensionVersion` / `listening` / `codeFresh` /
`lastError` 看清楚，对照下面的表。

| 症状 | 大概率原因 | 跳到 |
|---|---|---|
| `extensions: 0` | 扩展没装 / 没启用 / SW 睡了 | [一](#一extensions-0扩展没连上) |
| 连上了但工具超时 | 路由发错连接 | [二](#二extensions--1-但工具报超时) |
| 改了代码行为没变 | 读的是 node_modules 旧副本 | [三](#三改了代码不生效-最常见) |
| `stale: true` 一直不消 | 宿主缓存了模块 | [四](#四codefreshstale-true-一直不消) |
| 一句话都调不动 | 插件没启用 | [五](#五装完之后一句话也调不动) |
| 没有 NativeHost 连接 | 原生宿主没注册好 | [六](#六原生宿主不工作) |
| `listening: false` | 端口被占 | [七](#七桥端口被占) |
| 报「不允许脚本注入」 | 正常，`chrome://` 动不了 | [八](#八扩展报此页面不允许脚本注入) |
| 截图空白 | 渲染未完成 / 标签被丢弃 | [九](#九截图是空白--只有半屏) |
| 快照取不到靠后元素 | 虚拟滚动 | [十](#十browser_snapshot-拿不到靠后的元素) |
| 担心网页能连桥 | 2.3.0 起不能 | [十一](#十一网页能连上桥吗安全说明) |

---

## 一、`extensions: 0`（扩展没连上）

桥在监听，但没有任何扩展连过来。

**先确认是哪一侧的问题**：

```powershell
curl.exe -s --noproxy '*' http://127.0.0.1:39401/
```

- 返回 JSON 且 `listening: true` → **桥没问题**，去查扩展
- 返回 `host not allowed` → 你用了非回环 Host（正常，见第十一节）
- 连不上 → 桥没起来，看 `lastError`，通常是端口被占（第七节）

**扩展侧逐条查**：

| 检查 | 怎么看 |
|---|---|
| 装了吗 | `chrome://extensions` 里有没有「大肥鱼 · DSH Session Bridge」 |
| 启用了？ | 卡片右下角开关是不是蓝色 |
| 报错了？ | 卡片上有没有红色「错误」按钮，点开看 |
| SW 睡了？ | 「检查视图 Service Worker」是灰的点不动 → 正常，点一下扩展图标能唤醒 |

**手动重连**：点扩展图标（打开侧边面板），在面板里点「刷新状态」。

---

## 二、`extensions >= 1` 但工具报超时

连上了却执行不了，通常是**命令发给了错误的那条连接**。

**怎么确认**：

```
browser_status
→ connections: [
    { brand: "Chrome",     commands: 29 },   ← 真实浏览器
    { brand: "NativeHost", commands: 30 }    ← 中继通道
  ]
```

如果 `primaryConnId` 是 `NativeHost:xxx`，说明主连接选中继了 —— 不该这样。

`NativeHost` 只是转发通道（宿主进程 ↔ 扩展），**不拥有标签页**。
2.2.0 之前它会响应 `tabs.list` 把 tabId 抢到自己名下，之后所有带 tabId
的命令都被路由到那条窄通道。

**修**：2.2.0 已修（`_isRelay()`）。还出现说明跑的是旧代码 ——
看 `codeFresh.stale`，然后按第三节处理。

---

## 三、改了代码不生效 ★最常见

**症状**：文件明明改过（`LastWriteTime` 是刚才），行为没变；
`codeFresh.stale` 有时还报 `false`。

**根因**：DSH 通过 `cordis.patch.yml` 的 `name:` 做模块解析，
优先级 `node_modules/` > `vendor/`。`node_modules/` 里是**物理副本**（不是符号链接），
vendor 里改的不会同步过去。

**怎么确认**：

```powershell
$prof = "$env:USERPROFILE\.dsh\profiles\desktop"
Get-Item "$prof\vendor\dsh-session-bridge\impl.js" |
  Select-Object Length, LastWriteTime
Get-Item "$prof\node_modules\dsh-session-bridge\impl.js" |
  Select-Object Length, LastWriteTime
```

两个大小不一样 → 副本陈旧，这就是原因。

**怎么修**（任选一）：

1. **重跑安装脚本**（推荐）
   ```powershell
   .\install.ps1 -Force
   ```

2. **手动同步**
   ```powershell
   $prof = "$env:USERPROFILE\.dsh\profiles\desktop"
   Copy-Item "$prof\vendor\dsh-session-bridge\*" `
             "$prof\node_modules\dsh-session-bridge\" -Recurse -Force
   ```

3. **让它指向原件**（一劳永逸）
   在 `$prof\package.json` 的 `dependencies` 里加：
   ```json
   "dsh-session-bridge": "file:vendor/dsh-session-bridge"
   ```
   然后 `pnpm install`。

改完**必须完全退出 DSH 再启动** —— `browser_reload` 只重跑 `apply()`，
不清 ESM 模块缓存。

---

## 四、`codeFresh.stale: true` 一直不消

**含义**：磁盘上的 `impl.js` 比内存里加载的模块新。

- 想让它生效 → `browser_reload`，看 `stale` 是否变 `false`
- 重载后还是 `true` → 宿主缓存了模块，**完全退出 DSH 再启动**

---

## 五、装完之后一句话也调不动

**检查插件有没有被启用**：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" `
              -Pattern 'dsh-session-bridge'
```

应该看到：

```yaml
- insert:
    - id: dsh-session-bridge
      name: dsh-session-bridge
      inject: [ systemPrompt, tools ]
      config: {}
```

| 情况 | 处理 |
|---|---|
| 搜不到 | 没启用 —— `install.ps1` 第 5 步会帮你追加 |
| 有但 `disabled: true` | 删掉那行或改 `false` |
| `name:` 和 `id:` 不一致 | 模块解析失败，两个都必须是 `dsh-session-bridge` |

---

## 六、原生宿主不工作

**症状**：`browser_status` 里没有 `NativeHost` 那条连接；或扩展闲置一会儿就断，
要等最多 60 秒才回来。

**逐条确认**：

```powershell
# 1. 注册表项在吗
reg query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dsh.session" /ve

# 2. 清单指向的文件存在吗
$j = Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-session-bridge\com.dsh.session.json" | ConvertFrom-Json
Test-Path $j.path          # 应该 True
$j.allowed_origins         # 扩展 ID 对不对

# 3. 宿主进程起来了吗
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*native-host*' } |
  Select-Object ProcessId, CreationDate
```

**最常见的三个原因**：

| 原因 | 确认 | 修 |
|---|---|---|
| `allowed_origins` 里扩展 ID 不对 | 对比 `chrome://extensions` 上显示的 ID | 重跑 `install.ps1`（自动检测填入） |
| `path` 指向的 `.cmd` 不存在 | `Test-Path $j.path` | 重跑 `install.ps1` |
| `ws` 模块没装 | 插件目录下 `Test-Path node_modules\ws` | `cd` 到插件目录 `npm install ws` |

**注意**：每个浏览器要单独注册。Chrome 装好不代表 QQ浏览器能用 ——
`install.ps1` 会一次注册三个。

---

## 七、桥端口被占

**症状**：`listening: false`，`lastError` 里有 `EADDRINUSE`。

```powershell
Get-NetTCPConnection -State Listen -LocalPort 39401 |
  Select-Object OwningProcess |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

常见是**上一个 DSH 没退干净**。杀掉那个进程，或重启 DSH。

想换端口：在 `cordis.patch.yml` 的 `config` 里加 `port: 39402`，
同时改 `extension/background.js` 里的 `BRIDGE_PORTS`。

---

## 八、扩展报「此页面不允许脚本注入」

**不是 bug**。`chrome://`、`edge://`、扩展页、内置 PDF 阅读器、
部分浏览器内置页面都禁止注入脚本，任何扩展都调不动。

`browser_snapshot` 会明确返回：

```json
{ "ok": false, "error": "restricted_page",
  "message": "此页面不允许脚本注入：chrome://extensions/" }
```

换普通网页即可。

---

## 九、截图是空白 / 只有半屏

三种可能：

1. **页面还没渲染完** → 先 `browser_navigate`，给它一点时间，
   或先 `browser_snapshot` 探一下
2. **标签在后台被丢弃**（`discarded: true`）→ `browser_tabs` 里看这个字段，
   访问一次让它恢复
3. **懒加载** → 截图只含可视区，没有整页拼接；滚动后再截

---

## 十、`browser_snapshot` 拿不到靠后的元素

**快照只覆盖当前视口附近**。虚拟滚动列表（Gmail、Twitter、长表格）里
靠后的元素必须先滚进视口：

```
browser_scroll({ tabId, mode: 'to', ref: 'e42' })
browser_snapshot({ tabId })
```

或先 `mode: 'by'` 往下滚几屏。

---

## 十一、网页能连上桥吗（安全说明）

**不能**，2.3.0 起。

桥监听在 `127.0.0.1`，但这不等于安全 —— 任何网页都能
`new WebSocket('ws://127.0.0.1:39401')`。浏览器发起 WebSocket 时**一定带 `Origin`**，
Node 的 `ws` 客户端不带，桥用这个差别区分：

```
无 Origin                → 放行（原生宿主）
chrome-extension://      → 放行（扩展）
其他（http/https/null）   → 拒绝
```

会看到：

```
HTTP 401  ← 网页 Origin 的 WS 握手被拒
HTTP 403  ← 带网页 Origin 的 HTTP 请求被拒
HTTP 403  ← Host 不是回环地址（DNS rebinding）
```

**自己验证**：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-session-bridge"
node test/security.mjs
```

15 项断言，覆盖 Origin / Host / token 三条防线。

**仍然存在的前提**：任何能读你用户目录、或能以你的身份运行进程的程序，
都能绕过这些。三道防线挡的是**网页**，不是本地恶意软件。

---

## 还是解决不了

收集这三样：

```
1. browser_status 的完整返回
2. chrome://extensions 里本扩展卡片的截图（含「错误」按钮状态）
3. Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop\vendor\dsh-session-bridge" |
     Select-Object Name, Length, LastWriteTime
```

去 https://github.com/wxs-lang/dsh-session-bridge/issues 提 issue。
