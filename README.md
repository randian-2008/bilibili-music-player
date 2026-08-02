# B站听歌列表 (bilibili-music-player)

Chrome 扩展（Manifest V3）：浏览器级 B站后台音频播放器，自带播放列表，关闭网页也能继续听歌。

## 架构概览

```
┌─ content.js（注入所有 http/https 网页，Shadow DOM 隔离）
│    ├─ 可变形胶囊 ★（停止=24px半透明圆♪；有曲目=胶囊：频谱+上一首/播放/下一首）
│    ├─ 浮动面板（上下两区：小播放器+歌单；可拖拽，点页面空白自动收起）
│    ├─「＋加入」按钮（仅 B站视频页，把 bvid/page 发给 background）
│    └─ postMessage 桥接（iframe 命令 ↔ background；并把 state/progress 广播回传给胶囊）
│              ▲  window.postMessage          │ chrome.runtime.sendMessage
│              ▼                              ▼
├─ sidepanel.html/js/css（扩展页面，被 iframe 复用为播放列表 UI：上部小播放器+下部歌单）
│
├─ background.js（Service Worker：歌单管理、状态持久化、★请求B站API取cid/音频源、
│                 创建/管理 offscreen 并转发播放命令）
│
├─ offscreen.html/js ★（Offscreen Document 播放引擎：<audio> 真正发声，
│                 向 background 取音频源、多音源容错、5 种模式、音量记忆、进度/状态广播）
│
└─ rules.json（declarativeNetRequest：为 bilivideo / api.bilibili 请求设置 Referer/Origin）
```

**核心设计**：
- **音频在 Offscreen Document 播放**——它独立于任何标签页存活，**关闭/跳转页面不停播**，
  只要浏览器开着就一直播；且 offscreen 是扩展页面，其音频请求为扩展请求
  （绕过页面 CSP/跨站限制、带 Referer 与 Cookie），解决了部分歌曲在普通页面无法播放的问题。
- **职责分离**：B站 API 请求（`view` 取 cid/元数据、`playurl` 取音频流）由 **background** 发起
  （持 host_permissions 绕过 CORS）；offscreen 经 **`chrome.runtime.connect` 持久 Port** 与
  background 双向通信（命令按 `_id` 匹配响应，断线自动重连）；
  播放命令由 iframe 经 content script 桥接 → background → offscreen；
  offscreen 的 state/progress 广播经 content script 回传给胶囊与面板。
- **多音源容错**：按 普通AAC→杜比→FLAC→mp4(durl) 顺序返回候选（含 backup_url），
  offscreen 逐个尝试，直接播放失败再用扩展身份 fetch 转 blob 兜底。

## 悬浮控制（可变形胶囊）+ 打开 / 隐藏播放列表

- **停止时**：右下角 24px 小圆按钮（♪），无鼠标指向时**半透明**（低存在感），悬停恢复
- **有曲目时（播放或暂停）**：自动**变形为胶囊**迷你播放器，内含
  - 跳动频谱图（纯动画，标识播放中；**点击频谱展开播放列表**）
  - 上一首 / 播放·暂停 / 下一首 按钮（无需展开面板即可控制）
- **打开面板**：点胶囊频谱 / 点停止时的小圆按钮 / `Ctrl+Shift+B` / 扩展图标
- **收起面板**：点 × / 再点频谱 / **点击页面任意其他位置自动收起**
- 面板**位置**自动记忆（chrome.storage）；**开合状态刻意不记忆**——新开页面 / 刷新时面板一律默认收起，
  无论是否正在播放（v2.2.8 起）

## 已实现功能

### 播放
- **音频在 Offscreen Document 播放**（跨页面持续播放，关页面不停）；音频源由 background 解析
- **多音源容错**：并行拉取 DASH（普通 AAC→杜比→FLAC，各含备用链接）与 mp4(durl) 兜底，
  offscreen **按序逐个尝试**，某源不可播（编码不支持/链接失效）自动切换下一源，
  直接播放失败再用扩展身份 fetch 转 blob 兜底，解决部分歌曲 "no supported source was found"
- 播放/暂停、上一首/下一首、进度条拖拽、**停止**（清空播放并收起胶囊，区别于暂停）
- **音量调节 + 静音**（面板内滑杆），数值持久化记忆（`bpl_volume` / `bpl_mute`）
- MediaSession 集成（系统媒体控制）
- 自动解析 cid

### 播放模式（单按钮循环切换）
| 模式 | 行为 |
|------|------|
| 顺序播放 | 按列表顺序播放，全部播完**停止** |
| 随机播放 | 随机打乱播放一遍，全部播完**停止** |
| 单曲循环 | 当前歌曲无限重复 |
| 列表循环 | 顺序播放，到最后一首后**回到第一首**继续 |
| 随机循环 | 全部随机播完后，用**新的随机种子**重新打乱继续 |

- 控制区只有一个模式按钮（SVG 图标 + 文字），点击按上表顺序循环切换
- 旧版的 `loop`/`shuffle` 布尔状态自动迁移为对应模式

### 歌单管理
- 多歌单：新建、重命名、删除、切换
- 歌曲操作：添加、删除、重命名、拖拽排序、**↗ 跳转原页面**
- 从 B站视频页一键添加（面板头部「＋加入」，支持多P）
- 去重检测（bvid + cid）
- **拖拽排序由封面触发**：改用**指针事件自定义拖拽**（HTML5 原生拖拽在此 iframe 环境不可靠），
  按住封面上下拖动即可排序，带目标位置指示线、列表边缘自动滚动；
  拖拽时封面**不放大**（与悬停预览互斥）
- **封面悬停 1 秒放大预览**：用独立的 `position:fixed` 悬浮层（最高 z-index，脱离列表裁剪、
  盖在整个面板之上）从封面左下角弹出 **4.2 倍**大图，避免原地放大被边框遮挡；
  靠近列表顶部的曲目自动钳位、不被面板顶边裁切；按下封面（准备拖拽）立即收起预览
- 歌曲其余区域点击为播放/选择，改名框内可正常划选文字
- **批量操作**：**长按**任一歌曲进入复选模式（出现圆形复选框），点选多首后顶部出现操作栏：
  - **移动至 / 复制到** → 下拉选择目标歌单（自动去重）
  - **删除** → 批量删除所选；「取消」退出复选模式

### 导入导出
- **导出格式**：TXT / Markdown / JSON
- **导入格式**：JSON（支持 `{name, items}` 或纯 items 数组，需含 bvid）
- **入口**：面板内歌单菜单（⋯ 按钮）

### 数据持久化
- chrome.storage.local
- 键：`bpl_playlists`（歌单）、`bpl_active`（当前歌单ID）、`bpl_state`（播放状态）、`bpl_panel`（仅面板位置）、
  `bpl_position`（断点：`{bvid, cid, position}`，供 offscreen 被回收后续播，v2.2.9）
- 旧版单歌单数据自动迁移

## 技术要点

- **页面零侵入**：content.js 所有 UI 均在 closed Shadow DOM 内，样式内联，
  不向页面注入任何 CSS、不修改页面 DOM 结构（仅向 body 追加一个 0×0 宿主元素），
  避免影响 B站导航栏及与 Bilibili Evolved 等扩展冲突
- **跨页面浮动面板**：iframe 加载扩展页面 `sidepanel.html`（通过 `web_accessible_resources`）
- **postMessage 桥接（关键）**：web-accessible iframe 内 `chrome.runtime.sendMessage` 被 Chrome
  限制（`chrome.storage` 可用、runtime 消息不可用）。因此 iframe 不直接发 runtime 消息，
  改为 `window.postMessage` 与宿主页 content script 通信，由 content script 中转：
  - iframe 请求 `{bplBridge:'req', id, payload}` → content script → `chrome.runtime.sendMessage`
    → background，响应原路返回 `{bplBridge:'res', id, result}`
  - background 广播（`target:'all'`：data/state/progress）→ content script →
    `{bplBridge:'broadcast', msg}` → iframe
  - 这样播放/上下曲/进度同步等按钮在任意网页的面板内都能正常工作
  - **来源校验用 `e.origin`（不可伪造），不要用 `e.source === iframe.contentWindow`**：
    内容脚本隔离环境中跨域 iframe 的 `WindowProxy` 引用比对会失败，导致请求被全部丢弃
- **全站生效**：content_scripts 匹配所有 http/https 页面；iframe 懒加载（首次展开才创建）以降低开销
- Referer 绕过：`declarativeNetRequest` 为 `bilivideo.com` / `bilivideo.cn` 的 media 请求注入 Referer
- Offscreen Document 生命周期管理：`hasDocument()` + `getContexts()` 双重检测
- 播放进度每秒广播；面板通过 `chrome.runtime.onMessage` 实时同步

## 加载方式

1. 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」→ 选择本目录

## 测试

核心逻辑用 Node 在模拟环境中单测（无需浏览器），改动后务必先跑：

```bash
node tests/test-offscreen.js    # offscreen 播放引擎：pPlayIndex/多音源容错/blob兜底/5种模式/命令/ping探测/无chrome.storage经bg代理播放/断点续播
node tests/test-background.js   # B站音频源解析、取cid、拉元数据、批量操作、offscreen 路由(创建/降级非粘性/去踩踏/业务错误透传/relay)、广播双路投递(runtime+tabs.sendMessage)、readBootDiag 死因诊断、存储代理(storageGet/storageSet/logMerge)
node tests/test-content.js      # 播放命令路由(一律→background player，无兜底)、状态广播同步、桥接来源决策(安全)、失效上下文自愈(一次性重载复活)
node tests/test-logger.js       # 本地日志：批量落盘、级别、时间戳、上限裁剪、无存储上下文经 bg logMerge 中继
```

四个测试均通过 `vm` 注入 mock 的 `chrome/fetch/document`，**直接执行真实源码**
（offscreen.js / background.js 顶层函数可直接访问；content.js 经 `__BPL_EXPOSE` 钩子；logger.js 直接挂载 `globalThis.BPLLog`），
共 **114 项断言**（offscreen 36 + background 52 + content 18 + logger 8），全部通过（退出码 0）才算合格。
注意：浏览器集成层（offscreen 实际创建/发声、postMessage 桥接收发、Referer/Origin 规则、
autoplay 策略、CORS 真实行为）无法在 Node 中验证，需手动在浏览器确认。

## Edge / Offscreen 触发机制（研究结论）

Edge 基于 Chromium（79+ 起），MV3 与 Offscreen Document（Chrome/Edge 109+）行为与 Chrome 一致，
并**继承 Chromium 的 Service Worker 生命周期缺陷**。本扩展的通信设计正是针对以下事实：

- **Service Worker 会被强杀**：MV3 的 background SW 空闲约 30s 即被终止；即使有活动的 `runtime.connect`
  长连接，在部分 Chromium 构建中仍约每 5 分钟被强制回收（[Chromium issue 40733525](https://issues.chromium.org/40733525)、
  [官方 offscreen 说明](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3)）。
  **SW 一旦重启，其模块级状态（`offscreenPort` 等）全部清零**。
- **Offscreen Document 独立于 SW 存活**：它是扩展页面，SW 被杀时它可继续存在并播放音频；
  但**同一时刻只允许一个** offscreen 文档，`createDocument` 在已存在时会拒绝；Chrome 不保证其自然寿命，
  空闲时可能被回收（`AUDIO_PLAYBACK` reason + 正在发声会显著延长其存活）。
  **现场实锤（v2.2.9 日志）：`AUDIO_PLAYBACK` 只在真实出声时保活——暂停后恰好 ~30s，文档即被当
  空闲回收**（日志中暂停时刻与 Port 断开时刻相差整 30s）。这是 MV3 的固有机制、无法阻止，故 v2.2.9
  起不与之对抗：播放进度持续落盘（`bpl_position`，暂停时/播放中每 5s/起播写 0/stop 清除），
  文档被回收后再按播放，新建文档按曲目身份（bvid+cid）匹配断点 seek 回原位继续；期间后台的
  `getStatus` 从存储推导暂停态，各页面 UI 保持一致。
- **`runtime.sendMessage`→offscreen 不可靠**：接收端未就绪 / 多监听者干扰时会丢消息——这是 v1.3 时代
  “音频模块通信失败”、也是 v2.0.1 改用 Port 的老问题。**绝不能把它当长期主通道**。
- **例外（现场实锤，v2.2.4 已适配）**：某些 Edge 环境下 offscreen 文档的 `chrome.runtime` 完全正常
  （Port 连接、sendMessage 往返均通），但 `chrome.storage` **恒为 undefined**——销毁后新建的文档亦然，
  故非时序/升级残留，也不是任何可由用户开启的权限（`storage` 已在 manifest 声明）。因此 v2.2.4 起
  offscreen 不再直接持有存储：所有读写经 runtime 消息交由 background 代理，offscreen 只保留 `<audio>`。

据此，`background.sendToOffscreen` 遵循：
1. **每次都重新核验** offscreen 是否存在（`hasDocument()`+`getContexts()`），不依赖可能已过期的模块状态；
2. **始终优先 Port**，冷启动/重连给足等待窗口（首轮 1.5s）；offscreen 侧断线后每 500ms 自动重连；
3. **降级只作“本轮一次性”**：Port 未就绪时才临时用 sendMessage 兜底，**绝不把通道永久切到 sendMessage**
   （旧版 `useMsgChannel` 一旦置位即永久锁死坏通道，是“全部按钮失效”的根因）；
4. **不拿 ready ping 当硬门槛**：ping 丢失不代表命令通道也坏（v2.1.0 曾因等不到 ping 而一次都没真正
   尝试 sendMessage 就判失败）——直接试发送，以实际响应判定成败；
5. **单飞（single-flight）串行化**：快速连点产生的并发命令排队执行，杜绝多路并发 create/close
   offscreen 互相踩踏（现场日志中约 30 次 `createDocument 成功`却无一次 Port 连上，踩踏是重要诱因）；
6. 任一轮失败即**关闭并重建** offscreen 再重试（最多 2 轮、总耗时上有界），不卡死 UI。

### 无兜底：offscreen 是唯一音频宿主（产品决策）

「关闭网页也能继续听歌」是本扩展的立身之本。在 MV3 纯扩展范围内，**不可见**且能跨页面持续发声的
宿主只有 offscreen document 一种（Service Worker 无 DOM/音频 API 且会被回收；content script 随页面死亡；
可见的扩展页/标签页违背产品定位）。因此：

- **offscreen 是唯一音频宿主**，content.js 只是纯 UI 桥接——播放命令一律经后台转发给 offscreen，
  状态/进度经后台广播回面板与迷你按钮。
- **不提供任何兜底引擎**（v2.1.1 的页内备用引擎已于 v2.2.0 移除）。若某环境 offscreen 确实失效，
  正确做法是依据下文 `bpl_boot` 诊断**定位并修复 offscreen 本身**，而非用会随页面死亡的页内播放掩盖问题。

### offscreen 启动诊断（`bpl_boot`）

`offscreen.html` 最先载入 `offscreen-boot.js`：发 boot ping + 直写 `chrome.storage.local[bpl_boot]`
（不经日志节流，文档即使秒级被关也能留痕）；挂冒泡相位 `window.onerror` 捕获运行时脚本错误，
并挂**捕获相位** error 监听捕获外部脚本/资源的**加载失败**（如 logger.js/offscreen.js 404——这类错误
不冒泡，普通 `window.onerror` 抓不到）。`offscreen.js` 载入后再写 `phase: 'loaded'`。
后台在 `createDocument` 成功后自检 5s：若 Port 未连上、且本文档的 `bpl_boot` 未推进到 `loaded`，
就用 `readBootDiag()` 把 `bpl_boot.phase` 翻译成**一句确切死因**记入日志并**直接回报到 UI 错误提示**
（不再笼统报「静默」，也不再在 create 前清 `bpl_boot`——那会把刚写的证据立刻抹掉）。据此可**仅凭日志/存储定性**故障层级：

| 现象 | 结论 |
| --- | --- |
| 后台有 `offscreen-boot` ping 且 `bpl_boot.phase=loaded` | 脚本与消息通道均正常，问题在后续逻辑 |
| `bpl_boot.phase=boot` 但无 `[off]` 日志/无 Port | offscreen-boot 已运行但 **offscreen.js 未加载完成**（body 脚本加载/执行失败） |
| `bpl_boot.phase=script-error` | 后续脚本运行时抛错（记录文件名/行号/msg） |
| `bpl_boot.phase=resource-error` | 外部脚本/资源加载失败（记录 src，如某脚本 404） |
| 无 `bpl_boot` | offscreen-boot 都没运行（文档脚本完全未执行，疑 Edge 后台挂起/效率模式） |

日志面板顶部实时显示该诊断，导出的 TXT 头部也带诊断摘要。
v2.2.4 起，无 `chrome.storage` 的环境（如上述 Edge 的 offscreen）写 `bpl_boot` 与 `[off]` 日志时
也经 background 代理落盘，故此表在该环境下同样有效（此前这类上下文的诊断数据会整片静默）。

## 本地运行日志

统一日志模块 `logger.js`（SW 经 `importScripts`、扩展页面经 `<script>`、content 经 manifest 注入共用）：
- 内存环形缓冲 + **批量落盘**（每 1s 合并写一次 `chrome.storage.local[bpl_log]`，上限 500 条），
  不再像旧版 `diag` 那样每条命令都写存储；
- 三级（info/warn/error）、带毫秒时间戳与来源 scope（`bg`/`off`/`content`/`ui`）；
- **error 级即时落盘**（短延时，避免文档/SW 在批量窗口内被杀而丢掉关键错误）；
  落盘失败不再静默吞掉——累计计数并 `console.warn` 告警，杜绝“日志无声丢失”；
- **无存储上下文中继**（v2.2.4）：没有 `chrome.storage` 的上下文（如该 Edge 的 offscreen）改经
  background 的 `logMerge` 把整批条目并入 `bpl_log`，`[off]` 日志不再因写存储失败而静默消失；
- 面板「歌单菜单 ⋯」内可**查看 / 导出 TXT / 清空** 日志，便于在 Edge 现场定位通信问题。

## 更新记录

### v2.2.9（断点续播：暂停后被浏览器回收，再按播放从暂停处继续）

现场日志钉死根因：用户 01:54:01 暂停，**01:54:31（整 30 秒后）**offscreen Port 断开——
`AUDIO_PLAYBACK` 只在音频**真实出声**时为 offscreen 文档保活，暂停即无输出、文档被浏览器当
空闲回收。进度与加载态全随死文档蒸发，于是：再按播放 → 新建文档从 0 播（「歌曲从头开始」）；
新页面 `getStatus` 拿不到 offscreen → 返回无曲目默认值（单音符 ♪）；旧页面仍持最后一次广播
（暂停胶囊）→ 新旧页面互相矛盾。这是 MV3 固有机制，无法阻止回收，故不与之对抗、改为状态落盘：

- **进度持久化**（offscreen.js）：新增 `bpl_position` `{bvid, cid, position}`——**暂停时**（pause
  事件，覆盖面板按钮/系统媒体键一切暂停路径）、**播放中每 5s**（防播放途中被回收，损失 ≤5s）、
  **起播写 0** 落盘；`stop`/歌单清空/自然播完即清除（显式停止 = 下次从头）。stop 先同步清曲目身份
  再让 pause 事件落空，杜绝「停了反而写回断点」的竞态。
- **断点续播**（offscreen.js）：`toggle` 发现音频为空（文档曾被回收的常态）时读出断点，按**曲目身份
  匹配**（bvid+cid，防歌单变动后盲跳）seek 回原位继续；**显式点歌/切上一首下一首不吃断点**，
  一律从头——用户主动选曲的意图优先。系统媒体键的「播放」同样接入续播路径。
- **UI 一致性**（background.js）：offscreen 不存在时的 `getStatus` 不再返回「无曲目」，改从存储推导：
  当前曲目有效 → `hasTrack:true` + 暂停态 + 断点位置 + 曲目时长。新页面胶囊与旧页面显示一致，
  按下播放即续播，整条链路自洽。
- 测试：**114 项**（offscreen 36 + background 52 + content 18 + logger 8）全部通过；新增回归
  「暂停落盘 → 新文档从 42s 续播」「身份不符/显式点歌不吃断点」「stop 清断点」「回收期 getStatus 推导」。

### v2.2.8（面板永远默认收起 + 封面预览更快更大）

v2.2.7 现场确认基础功能全部正常（进度条/胶囊/自动变形均修复）后，按用户要求打磨两处交互：

- **面板开合不再跨页记忆**：旧版把 `bpl_panel.open` 持久化并在新页面恢复——只要有一个页面开着面板，
  之后新开/刷新的页面会跟着自动展开，干扰浏览。现移除恢复逻辑、`persist()` 不再写 `open` 死字段：
  **新开页面与刷新时面板一律默认收起，无论是否正在播放**；面板位置仍照常记忆。
- **封面悬停预览调校**：触发延迟 **2s → 1s**（更跟手），放大倍数 **3× → 4.2×**
  （46×30 → 约 193×126，仍稳处 340px 面板之内）。两处配套细节：列表顶部曲目预览向上展开会被面板顶边
  裁切，现钳位到顶边之内；按下封面（准备拖拽）的瞬间即取消未触发的放大计时并收起已弹出的大图，
  杜绝「按住想拖拽、大图却弹出来挡手」。
- 测试：**104 项**（offscreen 28 + background 50 + content 18 + logger 8）全部通过
  （此二项为纯 UI 交互，改动点不经过 Node 可测路径，靠浏览器手工验证）。

### v2.2.7（修复 UI 冻结三连·续：广播双路投递 + 失效上下文自愈）

v2.2.6 现场实测**三个前端症状毫无改进**，日志给出两条新证据：① 广播改经 SW 中继后 UI 依旧冻住——
说明这个 Edge 上 `runtime.sendMessage({target:'all'})` 的广播**无论从 offscreen 还是从 SW 发出都到不了
网页里的 content script**（v2.2.6 对「实证通路」的判断只对了一半）；② 多条 `[ui] … 失败：Extension
context invalidated`——升级前就开着的标签页里，content script / 面板 iframe 的扩展上下文已**永久失效**，
所有 runtime/storage 调用必抛，只能重载页面复活。

- **广播双路投递**：后台 `broadcast()` 在保留 `runtime.sendMessage`（覆盖独立打开的扩展页）之外，
  新增 `chrome.tabs.query({})` → 逐标签页 `chrome.tabs.sendMessage` 精确投递到 content script——
  后者才是现场实证可用的通路（`togglePanel` 一直走它且从未失效）。面板 iframe 仍经 content 的
  postMessage 桥接收。两路在正常环境可能重复送达，各接收端处理均幂等，无害。
- **失效上下文自愈**：content.js 检测到 `Extension context invalidated`（sendMessage 同步抛出或
  `runtime.lastError`）时，以 sessionStorage 守卫**只重载本页一次**（绝不循环），让新版脚本重新注入即复活；
  通道恢复正常应答后清除守卫，使日后每次升级都可再次自愈。页内 storage 读写（面板/胶囊位置持久化）
  同样接入该检测。自此「升级后旧标签页 UI 僵死」不再需要手动刷新。
- **诊断留痕**：content script 每实例记录一条「收到首个广播 type=…」，日后若 UI 再冻住，凭此条即可
  断定广播是否真的送达 content 层。
- 测试：**104 项**（offscreen 28 + background 50 + content 18 + logger 8）全部通过；新增回归
  「广播双路②：tabs.sendMessage 逐标签页投递」「失效上下文 → 一次性重载复活 + 守卫防循环 + 恢复后清守卫」。

### v2.2.6（修复 UI 冻结三连：广播一律经 background 中继）

v2.2.5 播放打通后暴露三个前端症状：① 面板进度条只在暂停时刷新（暂停刷新其实是点按钮触发的
`getStatus` 拉取，并非广播）；② 胶囊播放器的播放/暂停图标不切换、暂停后频谱动画不停；
③ 开始播放后小按钮不自动变形为胶囊（刷新页面才行）。三者**同根**：现场实证 offscreen 直接
`runtime.sendMessage({target:'all'})` 的广播**到不了网页里的 content script**——胶囊的图标/动画/
变形全靠广播驱动、毫无兜底，于是全冻住；面板的曲名与列表标记因 bug② 的 `storage.onChanged`
安全网幸存，才没一起暴露（进度条没有安全网，故单独显形）。

- **修复**：offscreen 的 `state`/`progress` 广播不再直发，统一经后台 `relay` 命令以 `target:'all'`
  转发（bg→content 是实证通路，`togglePanel` 即走它）。面板经 content 的 postMessage 桥接收到，
  胶囊由 content 的 `updateMiniUI` 即时渲染；暂停期间进度广播仍每秒流动，UI 具备自愈能力。
- 测试：**99 项**（offscreen 28 + background 49 + content 14 + logger 8）全部通过；新增回归
  「起播后经 bg 中继 state 广播（hasTrack/playing 驱动胶囊变形与图标）」。

### v2.2.5（修复 resolveAudio 路由漏洞：「无候选」实为请求从未到达取源逻辑）

v2.2.4 现场日志宣告存储代理**完全成功**（`[off]` 日志首次出现、Port 连通、「reading 'local'」绝迹），
但播放仍失败：`resolveAudio 失败[BV…]：无候选`，而后台侧 `getAudioUrls` 的日志**一条都没有**——该函数
成败各分支都会留痕，零日志意味着它**根本没被调用**。根因是一个潜伏已久的路由漏洞：offscreen 的
`bgResolveAudio` 发送 `{target:'bg', resolveAudio:{…}}`——**不带 `cmd` 字段**，而 `handleBg` 按
`msg.cmd` 分发，消息落入 `default → {ok:false}`，offscreen 收到空壳响应后只能报「无候选」。
此前从未暴露：该用户 Edge 的 offscreen 在 v2.2.4 之前一直坏在更上游（chrome.storage 缺失），
请求根本走不到这一步；v2.2.4 打通链路后才把它顶出来。

- **修复**：`handleBg` 在 `switch(msg.cmd)` 之前拦截 `msg.resolveAudio` 形状；offscreen 发送端同时
  补上 `cmd:'resolveAudio'` 显式路由（双保险，与其它消息约定一致）。
- offscreen 侧空响应的日志措辞改为「无候选（取音源模块无有效应答）」，避免再把路由失败误读为「接口没给源」。
- 测试：**98 项**（offscreen 27 + background 49 + content 14 + logger 8）全部通过；新增回归
  「`resolveAudio` 无 cmd 形状也路由到取源」。

### v2.2.4（钉死并修复「reading 'local'」：offscreen 存储全量经 background 代理）

v2.2.3 现场日志（每次 playIndex 均报 `Cannot read properties of undefined (reading 'local')`）给出了
决定性证据：此 Edge 的 offscreen 文档 **`chrome.runtime` 完全正常**（boot ping、Port 连接、sendMessage
往返全部成功），但 **`chrome.storage` 恒为 undefined**——v2.2.2/v2.2.3 的自愈把文档销毁重建，**新建的
文档同样自报「chrome.storage 不可用」**，故这不是升级残留/时序竞态，而是该环境对 offscreen 的固有限制。
这也**不是用户能开关的权限**（`storage` 早已在 manifest 声明，后台侧一直可用）。既然重建无用，就不再
重建，改为绕开：

- **存储代理（核心修复）**：offscreen 不再直接碰 `chrome.storage`。加载时自检——本上下文有存储则照旧
  （Chrome 等正常环境零变化）；没有则所有读写经 runtime 消息转发给 background（新增 `storageGet` /
  `storageSet` 代理命令，bg 侧存储正常）。歌单、播放状态、音量、`bpl_boot` 诊断全部走代理，offscreen
  的职责收敛为「只持有 `<audio>`」。
- **无 storage.onChanged 的等价替换**：该环境也没有 `chrome.storage.onChanged`，offscreen 改为监听
  background 本就发出的 `{type:'data'}` 广播来同步歌单变更（清空歌单即停播清源），正常环境两条路径
  并存且幂等。
- **日志中继**：无存储上下文的日志改经 background 的 `logMerge` 并入 `bpl_log`——此前该环境的 `[off]`
  日志因写存储失败而**整片静默**（导出的日志里一条 `[off]` 都没有即证据），诊断彻底失明；修复后
  音频引擎的每条取源/播放/错误日志都能在现场取证。
- **删除 v2.2.3 的日志自动落盘**：`chrome.downloads` 只能产生真实的浏览器下载（每触发一次弹一条下载栏
  记录），做不到静默写本地文件（那需要 Native Messaging 另装宿主程序，超出纯扩展边界），按用户要求移除：
  去掉 `downloads` 权限、后台落盘代码与对应测试，**恢复为面板内手动导出**（重现一次故障点一次导出即可）。
- `offscreen-nostorage` ping 由「致命 → 触发重建」降级为**通知性提示**（既然新建文档也没有 storage，
  重建毫无意义，还会打断正在初始化的文档）。
- 测试：**97 项**（offscreen 27 + background 48 + content 14 + logger 8）全部通过；新增关键回归
  「**无 chrome.storage（chrome.runtime 仍在）→ 经 background 代理完整播放/持久化/空单停播**」，
  1:1 复刻现场环境。

### v2.2.3（自愈覆盖 sendMessage 通道）

- **补 v2.2.2 自愈缺口**：旧版「上下文损坏 → 重建重试」只包在 Port 路径上；若命令走 sendMessage 通道
  （Port 未及时连上）返回 `reading 'local'`，会被当成业务错误原样返回而**不自愈**。重构出 `trySendOnce`，
  让 `sendToOffscreenOnce` 对**两条通道的结果统一**做上下文损坏判定与有界重建重试。
- 本版曾加入「日志自动落盘（`downloads` 权限 + 后台监听 error 级条目自动存 TXT）」，因 `chrome.downloads`
  只能产生真实浏览器下载、无法静默落盘，**已于 v2.2.4 移除**（含权限与相关测试）。
- 测试：当时 **89 项** 全部通过；新增「sendMessage 通道上下文损坏也触发自愈」回归断言。
- 事后注记：本版（及 v2.2.2）把 `reading 'local'` 判定为「升级残留的半残文档、重建一次即可恢复」，
  被 v2.2.4 的现场日志证伪——根因是环境性的 offscreen 无 `chrome.storage`，最终由存储代理解决。

### v2.2.2（修复 offscreen「上下文损坏」：升级残留半残文档 → 有界自愈）

v2.2.1 现场日志确认**架构已通**（SW 启动预热后出现「offscreen Port 已连接」，offscreen.js 能加载连 Port），
但每条命令报 `Cannot read properties of undefined (reading 'local')`。签名是 reading **'local'** 而非 'storage'
→ `chrome` 对象在、`chrome.storage` 为 undefined——这是**扩展上下文未就绪/被失效**的特征，而非健康文档
（有 storage 权限的 offscreen 必有 chrome.storage）。根因：用户在 `installed:update`（重载升级）那一刻，
v2.2.1 的预热 `createDocument` 撞上旧上下文切换，建出一份 chrome.storage 未绑定的**半残文档**——Port 能连
（chrome.runtime 在）但一切存储读写都抛错。本版：

- **升级时不预热**：`installed:update` 时跳过 `prewarmOffscreen()`（此刻上下文正在切换），推迟到首条命令在
  稳定时刻惰性创建；`onStartup`（浏览器启动）与全新安装仍预热。
- **offscreen 自检存储**：加载时若 `chrome.storage` 缺失，记 error 并发 `offscreen-nostorage` ping 明确上报，
  不再让每条命令抛一个费解的 TypeError。
- **后台有界自愈**：新增 `isFatalContextError`（识别 reading 'local' / Extension context invalidated / 上下文失效）
  与 `recreateOffscreen`。命令报上下文损坏时，**冷却 10s、单次调用至多一次**地关闭重建 offscreen 并重试——
  恢复的是**同一个 offscreen 宿主**（非页内兜底），冷却闸保证绝不退回旧版 2s 一轮的踩踏风暴。
- 测试：**86 项**（offscreen 21 + background 44 + content 14 + logger 7）全部通过；新增「上下文损坏 → 重建一次
  重试成功」「持续损坏 → 单次调用至多重建一次（closeCalls=1，非踩踏）」回归断言。

### v2.2.1（钉死并修复 offscreen「无响应」：去踩踏 + 预热 + 诊断不再被自毁）

v2.2.0 现场日志推翻了「Edge 上 offscreen 脚本从不执行」的旧判断：`offscreen ping：offscreen-boot`
**反复到达**（head 第一个脚本 offscreen-boot.js 确实在执行），但**零条 `[off]` 日志、零次 Port 连接、
所有命令「无响应」**——即 offscreen-boot.js 能跑、offscreen.js（body 外链）连第一行都没执行。
同时约 30 次 `createDocument 成功`、每 2 秒一轮：**元凶是我们自己的「失败即 close+重建」重试风暴**——
boot 脚本极小、内联、最先执行，每轮都来得及发 ping；offscreen.js 还没加载/连上 Port 就被下一轮 close 杀死。
而「无 bpl_boot / 脚本静默」的假象，是因为 ensureOffscreen 每次 create 前清 `bpl_boot`，把 offscreen-boot
刚写的证据立刻抹掉——**诊断被自己的重试风暴打败了**。本版：

- **去踩踏**：`sendToOffscreenOnce` 不再失败即 close+重建。创建一次、耐心等 Port（2.5s）；Port 连上却无响应
  只丢弃陈旧连接让下条命令重连；两条通道都失败则读 `bpl_boot` 给出确切死因上报 UI——绝不重复制造踩踏。
- **SW 启动预热**：`onInstalled`/`onStartup` 即 `ensureOffscreen()`，让 offscreen.js 在用户首次点播放前
  就加载并连上 Port，消除「首条命令撞冷启动加载窗口」的竞态。
- **诊断不再自毁**：ensureOffscreen 不再清 `bpl_boot`；新增 `readBootDiag()` 把 `phase`
  （`loaded`/`boot`/`resource-error`/`script-error`/`promise-error`/无记录）翻译成一句确切死因，
  同时记日志并回报 UI。自检从 4s 放宽到 5s、且以「本文档 `loaded`」为健康判据。
- **offscreen.js 命令通道前置**：`connectAudioPort()` 与 `port` 声明提到脚本最前端，即便后续初始化较慢或
  文档被提前回收，命令通道也能第一时间立起来。
- 测试：**83 项**（offscreen 21 + background 41 + content 14 + logger 7）全部通过；新增 `readBootDiag`
  五相位断言与「失败不再关闭重建（去踩踏）」回归断言。
- 下一步：用户重载本版复现一次并导出日志，`readBootDiag` 的一句话即可钉死 offscreen.js 到底是
  「资源加载失败」还是「运行期抛错」还是「body 脚本根本未解析」，据此做最终定点修复。

### v2.2.0（架构对齐：offscreen 唯一宿主、移除一切兜底 + 日志全覆盖 + 两处播放 bug）

经调研确认：MV3 纯扩展中「关页面不停播」的不可见宿主**只有 offscreen**（Service Worker 无音频能力且会被回收；
content script 随页面死亡）。v2.1.1 的页内引擎虽能出声，却违背核心承诺。本版按产品决策回归正轨：

- **移除页内备用引擎（content.js）**：删除整个页内 `<audio>` 引擎、`bgHealthy` 路由切换、45s 探测与交还逻辑。
  content.js 回归**纯 UI 桥接**——播放命令一律经后台转发 offscreen，状态/进度经后台广播回面板与迷你按钮。
  **不提供任何兜底**：offscreen 失效时应据 `bpl_boot` 诊断修复其本身，而非用会随页面死亡的页内播放掩盖。
- **日志全覆盖（采集诊断前落地）**：
  - offscreen 给 `<audio>` 补 `error`/`stalled` 监听（记 `MediaError` code 映射名 + src host + networkState/readyState）；
    `tryPlayUrl`/`resolveAudio`/`pPlayIndex` 每个关键节点留痕（试了哪个源、为何失败、命中第几源、候选数）。
  - background `getAudioUrls` 记 API code、dash/durl 走向、候选数、是否含 flac/dolby，单边请求失败不再静默；
    `createDocument` 成功后自检 4s，无 Port 且无新 `bpl_boot` 则记一句明确的「**文档已创建但脚本静默**」；
    补 Service Worker 启动日志（含版本）。
  - offscreen-boot 增加**捕获相位** error 监听，能抓到外部脚本/资源**加载失败**（`phase=resource-error`，记 src）——
    这类错误不冒泡，普通 `window.onerror` 抓不到。
  - logger：error 级条目即时落盘（短延时，避免文档/SW 在批量窗口内被杀丢日志）；落盘失败不再静默吞掉，
    累计计数并 `console.warn` 告警。
- **修 bug①「部分歌曲无法播放音源」**：`audio.play()` 可能先 resolve、随后才由 `error` 事件异步失败
  （如 CDN 403 → `SRC_NOT_SUPPORTED`），旧实现误判“已起播”而停在坏源上无声。新增 `playSettled`：play() 与
  `error` 事件竞速 + resolve 后 ~350ms 宽限复查 `audio.error`，坏源判定失败并自动切下一候选。
- **修 bug②「切歌后面板/列表标记不更新」**：sidepanel 的 `storage.onChanged` 补 `bpl_state` 分支——
  广播链一旦丢失，依据存储变更兜底重渲染正在播放信息与列表标记。
- 测试：**78 项**（offscreen 21 + background 36 + content 14 + logger 7）全部通过。
- 待定：offscreen 在个别 Edge 环境「脚本静默」的根因，需用户现场导出含 `bpl_boot` 的日志后对症修复。

### v2.1.1（彻底解决无法播放：页内备用引擎 + 决定性诊断 + 并发踩踏修复）

用户现场日志（约 30 次 `offscreen createDocument 成功`、零 `[off]` 记录、零 Port 连接、零 ready ping）
表明：**该 Edge 环境里 offscreen 文档创建成功但脚本从不执行**，v2.1.0 的通信层修复治错了病。本版：

- **新增页内备用播放引擎（content.js）**：后台通道出现通信层失败即自动接管，在当前标签页内播放
  （音源仍由后台解析、进度经后台 `relay` 广播）。offscreen 彻底失效的环境也能正常听歌；
  offscreen 恢复后（45s ping 探测）自动交还并断点续播。业务错误（歌单为空等）不误触兜底。
- **修复 v2.1.0 遗留逻辑缺陷**：sendMessage 兜底曾被 ready ping 硬门槛挡死——ping 没到就判“未就绪”，
  兜底分支一次都没执行过（日志中全部失败都是“offscreen 未就绪”）。现以实际响应判定，直接试发送。
- **修复并发踩踏**：快速连点会使多条命令并发 create/close offscreen 互相破坏（`sendToOffscreen`
  改为单飞串行化）；重试从 3 轮收敛到 2 轮、超时收紧，失败路径总耗时上有界。
- **决定性诊断 `offscreen-boot.js`**：offscreen.html 最先载入，发 boot ping + 直写 `bpl_boot`
  启动标记 + 捕获后续脚本错误；offscreen.js 载入后写 `phase: 'loaded'`。下次复现即可仅凭日志/存储
  区分“脚本未执行 / 消息通道断 / 脚本抛错”（见上文表格）。
- offscreen 新增 `ping` 命令（供页内引擎探测通道恢复）；日志面板顶部显示启动诊断、导出 TXT 带诊断头。
- 测试扩展至 **85 项**（offscreen 20 + background 36 + content 22 + logger 7）全部通过，
  新增：页内引擎接管/零延迟路由/ended 切歌/业务错误透传、relay 广播、ping 应答。

### v2.1.0（修复按钮全坏 + 本地日志 + 安全加固 + Edge 研究）
- **修复“按钮几乎完全不可用”的回归**：根因是上一批改动新增的 `useMsgChannel` 降级通道是**粘性**的——
  首次播放冷启动时若 `waitForPort` 超时（Edge 冷启动慢极易触发），通道被**永久**锁死在
  `chrome.runtime.sendMessage`（v2.0.1 已证明其在部分 Chromium/Edge 不可靠），导致整个 SW 生命周期内
  所有按钮失效。重写 `sendToOffscreen`：**始终优先 Port、降级只作本轮一次性、失败关闭重建 offscreen 再试**，
  Port 恢复后命令立即回到 Port（新增回归单测验证“非粘性”）。
- **offscreen 就绪信号后移**：`offscreen-ready` ping 改到其 Port 与 sendMessage 监听器**都注册之后**才发出，
  消除“已报就绪却收不到兜底命令”的窗口。
- **本地运行日志**：新增共享 `logger.js`（批量落盘 `bpl_log`、三级、时间戳、scope），替换每命令写存储的临时
  `diag`；面板菜单支持查看/导出 TXT/清空。新增 `tests/test-logger.js`。
- **安全加固**：content 桥接来源校验改为分层——播放命令兼容宽松非网页源，**破坏性/通用命令（歌单增删改、
  openTab）仅信任扩展自身源**，堵住“只拒 http(s)+任意透传”的越权面（页面内 null 源 iframe 不再能删歌单/开任意网址）；
  background `openTab` 增加 B站域名白名单（纵深防御）。抽出纯函数 `bridgeDecision` 并补 7 项单测。
- **质量**：面板命令超时 4s→15s（冷启动创建 offscreen+解析音源常超 4s，避免误报“后台无响应”）；
  `fmt()` 增加 `Infinity/NaN` 守卫（个别流 duration 异常）。
- 测试扩展至 **72 项**（offscreen 19 + background 34 + content 12 + logger 7）全部通过。

### v2.0.1（修复：offscreen 通信改 Port 长连接）
- **修复全部按钮失效/无法播放**：根因是 background↔offscreen 用 `chrome.runtime.sendMessage`
  通信在部分 Chrome 环境不可靠（接收端未就绪/多监听者干扰，即 v1.3 时代"音频模块通信失败"的
  老问题）。改用 **`chrome.runtime.connect` 持久 Port**：offscreen 加载即连一条 `bpl-audio`
  通道，后台经 port 发命令、按 `_id` 匹配响应；resolveAudio 也改走 port
- offscreen 增加 **port 断线自动重连**（Service Worker 重启/文档回收后恢复）
- `getStatus` 在 offscreen 未创建时直接返回默认状态，**不再每次页面加载都创建 offscreen**
- 新增/更新测试：Port 命令→响应闭环、sendToOffscreen 经 Port 路由、getStatus 不创建、
  resolveAudio 经 Port 处理（共 55 项全过）

### v2.0.0（跨页面播放：音频迁入 Offscreen Document）
- **音频播放从 content script 迁入 Offscreen Document**：offscreen 独立于标签页存活，
  **关闭/跳转页面不停播**（只要浏览器开着）；且 offscreen 是扩展页面，音频请求为扩展请求，
  绕过页面 CSP/跨站限制、带 Referer 与 Cookie，解决部分歌曲（如 BV12c7fzBEnd）在普通页面无法播放
- **新增 offscreen.html/js 播放引擎**：`<audio>` 发声、向 background 取音频源、
  多音源容错（直接播放→fetch+blob 兜底）、5 种模式、音量记忆、MediaSession、进度/状态广播
- **background 新增 offscreen 管理**：`ensureOffscreen`（按需创建）+ `sendToOffscreen`
  （就绪轮询 + 失败关闭重建重试 3 次）+ `player` 命令路由
- **content.js 瘦身为控制层**：不再本地播放，播放命令经 background 路由到 offscreen；
  胶囊/面板状态由 offscreen 广播回传
- **修复加入歌单后列表不自动刷新**：面板新增 `storage.onChanged` 监听，歌单数据变化即刷新
- DNR 规则补设 `Origin`（见 rules.json）
- 测试扩展至 51 项（新增 offscreen 引擎测试、offscreen 路由测试）
### v1.9.0（多音源容错 + 原页面跳转）
- **多音源容错播放**：`getAudioUrl` 重构为 `getAudioUrls`，并行拉取 DASH（普通 AAC→杜比→FLAC，
  各含 `backup_url` 备用链）与 mp4(`durl`) 兜底，返回**有序候选列表**；播放器逐个尝试，
  某源不可播（`NotSupportedError`/链接失效）自动切下一源，autoplay 拦截则停止尝试。
  解决部分歌曲 "failed to load because no supported source was found"
  （此前只取单一最高码率流，遇到浏览器不支持的 FLAC/杜比或失效链就挂）
- **每首歌右侧新增 ↗ 按钮**：点击在新标签页打开 B站原视频页（经 background `chrome.tabs.create`）
- 修复 `durl` 兜底字段（mp4 用 `url` 而非 `baseUrl`，此前漏取导致兜底失效）
- 新增测试：音源候选/备用链/兜底、首源失败自动切换、全部失败报错（共 36 项全过）

### v1.8.4（拖拽可靠性 + 封面向右上放大）
- **拖拽改用 window 级指针监听**：拖拽期间在 window 上挂 pointermove/up（结束即移除），
  不依赖事件冒泡/捕获，修复"抓起后放不下、松手卡半透明、顺序不变"的问题
- **松手即本地重排并重绘**（乐观更新）+ 发后台持久化：UI 立即生效、幽灵态必被清除、刷新后顺序保留
- 新增安全清理：指针拖拽中途移出面板（iframe 边界）后，下次按下自动复位残留状态
- **封面预览改为向右上方放大**：以封面左下角为缩放原点（`transform-origin:left bottom`），
  避开面板左边框裁剪

### v1.8.3（拖拽改指针事件 + 封面悬浮预览）
- **拖拽排序彻底重构为指针事件自定义拖拽**：HTML5 原生 DnD 在本扩展的 iframe 环境
  多次失效，改用 `pointerdown/move/up` + `setPointerCapture` 自实现，按住封面拖动即可排序；
  带目标位置粉色指示线、拖动元素半透明跟随、列表边缘自动滚动
- **封面放大改为独立悬浮层**：原地 `scale` 会被列表 `overflow` 裁剪、被相邻项遮挡；
  改用 `position:fixed` + z-index 999 的预览层，脱离裁剪、盖在整个面板之上，从封面中心弹出 3 倍图
- 落位沿用 `moveItem` 的 `insertAt` 算法（拖到哪首歌落在哪首歌位置）

### v1.8.2（拖拽改由封面触发）
- **拖拽排序改为拖封面**：移除最左侧六点 `⋮⋮`；封面静态 `draggable="true"`
  （图片是 HTML5 最可靠的拖拽源，修复此前动态设置 draggable 不生效的问题）
- **拖拽与悬停放大互斥**：拖拽时给列表加 `.drag-on`，强制封面不放大
- 封面悬停放大延迟 **1s → 2s**，倍数 **2.6 → 3**
- 封面加 `cursor:grab` 拖拽提示；长按复选排除封面（封面只用于拖拽/播放）

### v1.8.1（图标精确居中 + 拖拽落位修复）
- **所有控制图标改用 SVG**（胶囊与面板的 上一首/播放·暂停/下一首/停止）：
  文字字符（▶⏸⏮⏭■）字形度量天生不对称、悬停放大时偏移被放大，SVG 几何中心精确，
  彻底解决"图标偏心/悬停位移"；播放/暂停切换改为切换 SVG path
- **修复拖拽排序落位偏差**：`moveItem` 引入 `insertAt`（下拖时 `to-1`），
  拖到某首歌上即落在该歌原位置（上/下拖均准确），并同步修正播放索引；新增 2 项单测
- 列表每首歌右侧的 **× 删除按钮移除**（删除统一走长按复选 → 批量删除）
- **列表封面悬停 1 秒放大预览**（2.6× + 阴影浮层，移开即收回）
- 胶囊补 `box-sizing:border-box`（修正 padding 导致的尺寸/偏心）

### v1.8.0（批量操作 + 交互修复）
- **批量复选功能**：长按歌曲进入复选模式（圆形复选框），操作栏支持
  **移动至 / 复制到**（下拉选目标歌单，自动去重）、**删除**、取消；
  background 新增 `batchRemove` / `batchMove` / `batchCopy` 命令（含播放索引修正）
- **拖拽排序改为仅六点 `⋮⋮` 触发**：歌曲其余区域不再整行可拖，
  改名输入框内可正常划选文字（修复"选文字却拖动整首歌"）
- 修复胶囊暂停（半透明）时悬停不恢复不透明
- 胶囊播放/暂停键、面板停止键 ■ 的光学居中微调

### v1.7.1（缺陷修复 + UI 微调）
- **修复胶囊展开后按钮/频谱点击失效**：拖拽的 `setPointerCapture` 会把 click 事件重定向到
  胶囊容器，导致 `e.target.closest` 匹配不到按钮。改为 pointerup 时用按下的原始目标判定点击
- **歌名滚动改为匀速单向循环**：复制一份文本无缝衔接，`linear` 匀速向左滚动（不再往复）
- **修复回车退出改名不即时**：commit 改为乐观更新（本地改标题+立即重绘）再上报 background
- 音量滑杆加长（`flex:1` 填充，与模式按钮留 10px 间距）
- 面板四键图标居中（`line-height:1` + 播放键光学右移）；停止键 ■ 放大（16px）
- 胶囊播放键同样做光学居中

### v1.7.0（UI 微调：胶囊右锚展开 + 跑马灯歌名 + 面板精简）
- **胶囊交互重做**：音符/频谱**固定在右侧**——停止时是 24px 圆按钮（♪），播放时 ♪ 原位
  变成跳动频谱，控制键（上一首/播放·暂停/下一首）**从左侧展开**；频谱约 24px
- **胶囊可拖拽**改位（移动 >4px 算拖拽、否则算点击，避免误触），位置记忆（`bpl_mini`）
- **歌名跑马灯**：播放器与列表中歌名过长时自动左右滚动显示全名（溢出检测 + CSS 变量驱动）
- 面板播放器：上一首/播放/下一首/**停止** 四键**等大缩小**并排到歌名右侧；
  音量缩短、去掉数字；**音量与播放模式同行**；封面不再叠加频谱、不显示 UP 主
- 面板顶栏：删去标题与 × 号，保留拖拽握把 `⠿` + 「＋加入」按钮
- 列表项：不显示 UP 主，**歌名与时长同行**；播放中高亮改为粉色左边框 + 粉色歌名

### v1.6.0（UI 大改版：可变形胶囊 + 面板重构）
- **悬浮按钮重构为可变形胶囊**：
  - 停止时 = 24px 小圆（♪），无指向时半透明；有曲目（播放/暂停）时变形为胶囊
  - 胶囊内含**跳动频谱图**（点击展开面板）+ 上一首/播放·暂停/下一首
  - 播放中胶囊带品牌粉光晕、频谱跳动；暂停时频谱静止、整体半透明
- **面板重设计为上下两区**：上部集成小播放器（封面+动态频谱、进度、
  播放/上下曲/**停止**/模式、**音量滑杆+静音**），下部歌单列表
  - 封面作为模糊氛围背景（ambient backdrop）随曲目切换
- **新增停止功能**：区别于暂停——清空音频并收起胶囊，面板显示"上次播放"
- **点击页面其他位置自动收起面板**（outside-click）
- **音量/静音持久化**（`bpl_volume`/`bpl_mute`），经 `setVolume`/`setMute` 命令同步
- 移除旧版呼吸光晕大圆按钮（fab）相关代码

### v1.5.0（修复"Failed to fetch"——B站 API 改由 background 请求）
- **根因**：MV3 里 content script 的跨域 `fetch` 受 CORS 限制，直接请求 `api.bilibili.com`
  会 "Failed to fetch"。此前"加入视频"看似成功，实为请求失败后用了兜底数据（cid=0），一播放就崩
- **改用成熟扩展的标准做法**：所有 B站 API（`view` 取 cid/元数据、`playurl` 取音频流）改由
  **background service worker** 请求（持 host_permissions，绕过 CORS），content script 只负责播放
  - 新增 background：`biliFetch` / `resolveCid` / `getAudioUrl` / `buildItem` / `resolveAudio` 命令
  - content script：`bgResolveAudio` 向 background 要音频 URL 后再 `audio.play()`；
    删除内容脚本内的直接 fetch（`getInfo`/`pGetAudioUrl`/`pResolveCid`）
  - 「加入视频」改为 content script 只传 bvid/page，元数据由 background 拉取
- 测试：`tests/test-background.js`（音频源解析/取 cid/元数据，9 项）+
  `tests/test-content.js`（播放/模式/命令，12 项），共 21 项全过

### v1.4.0（音频改由 content script 直接播放）
- **弃用 Offscreen Document**：其在部分环境无法接收消息（"音频模块通信失败"），且重试阻塞
  约 11 秒导致模式切换卡死、错误 toast 超时不显示
- **音频改为在 content script 内用 `<audio>` 直接播放**：播放命令（toggle/next/prev/playIndex/
  seek/setMode/getStatus/stop）由 iframe 经 postMessage 发给本页 content script 就地处理，
  不再绕道 background→offscreen，可靠且可单测
- 删除 `offscreen.html/js`、`offscreen` 权限及 background 内全部播放/offscreen 相关死代码
- 自动播放被浏览器拦截时，toast 会提示"点一下页面或浮动按钮再试"
- 测试改为 `tests/test-content.js`（直接执行真实 content.js，15 项断言全过）
- 取舍：音频随当前网页存活，关闭/跳转该标签页停止（后台常驻待 Offscreen 问题排查后再议）

### v1.3.1（offscreen 通信加固 + 测试）
- **修复"音频模块通信失败"**：`sendToOffscreen` 改为**主动轮询就绪 + 失败自动重建重试**
  - `waitReady` 不再被动等 ready 信号，改为循环向 offscreen 发 `getStatus` 直到其真正响应
  - 通信失败时 `closeDocument` 关掉僵尸 offscreen 文档并重建，最多重试 3 次
- **新增 `tests/` 单元测试**（Node + vm mock，21 项断言全过），见上文「测试」

### v1.3.0（音频修复 + 错误可见）
- **桥接来源校验改为"只拒绝网页源"**：跨域扩展 iframe 的 `e.origin` 可能序列化为 `"null"`，
  精确匹配会误杀请求；改为拒绝 `http(s)` 源、放行其余，网页仍无法伪造
- **音频更健壮**：`getAudioUrl` 兼容 `durl` 回退（无 DASH 时），`fnval=4048` 请求更全的音质
- **新增 api.bilibili.com 的 Referer 规则**（offscreen 发起的 playurl 请求原本无 Referer）
- **错误不再被吞**：`playIndex/toggle/next/prev` 透传失败原因；offscreen 未就绪/通信失败也返回错误
- **面板新增 toast**：播放/上下曲失败时弹出真实错误信息，便于定位（接口错误、需登录、无音频流等）

### v1.2.2（修复桥接来源校验）
- **修复面板内大多数按钮失效**（播放/上下曲/切模式/拖拽排序等）：
  content script 中转时用 `e.source === iframe.contentWindow` 校验来源，
  在隔离环境中该 `WindowProxy` 引用比对恒不相等，导致所有 iframe 请求被丢弃。
  改用浏览器设定、不可伪造的 `e.origin === chrome-extension://<id>` 校验

### v1.2.1（缺陷修复）
- **修复播放/上下曲按钮失效**：web-accessible iframe 内 `chrome.runtime.sendMessage` 受限，
  新增 postMessage 桥接（content script 中转请求与广播）
- **修复面板定位在左上角**：旧版本在面板隐藏时 `getBoundingClientRect()` 返回 0，把
  `{x:0,y:0}` 脏坐标持久化，导致新版面板被钉在左上角；现对恢复的坐标做有效性校验
  （拒绝 0,0 与越界），非法时回退到按钮上方默认位置
- 浮动按钮改为**开关键**：再次点击即可收起面板（此前只能点 ×）
- 恢复"已打开"状态时延迟到首帧后展开，保证弹出动画可见

### v1.2.0（UI 优化）
- 播放列表面板改为锚定在浮动按钮正上方（右下角），并从按钮处弹性弹出（缩放 + 位移过渡）
- 浮动按钮增加入场动画与呼吸光晕
- **播放模式重构**：合并循环/随机为单个模式按钮，5 种模式循环切换
  （顺序 / 随机 / 单曲循环 / 列表循环 / 随机循环），配 SVG 图标
- 顺序、随机模式播完一遍后停止；列表循环回首重播；随机循环换新种子重洗
- 状态字段 `loop`/`shuffle` 迁移为统一的 `mode`

### v1.1.0（架构重构）
- **改用网页内浮动面板**替代浏览器侧边栏：跨所有网页显示、可拖拽、随时开关、状态记忆
- **扩展到全站生效**：content_scripts 匹配所有 http/https 页面
- 浮动按钮 / `Ctrl+Shift+B` / 扩展图标 三种方式开关面板
- 面板通过 iframe 复用 `sidepanel.html`（新增 `web_accessible_resources`）
- **完全移除浏览器侧边栏**（删除 `sidePanel` 权限与 `side_panel` 配置）
- 「加入当前视频」改为面板头部按钮，仅 B站视频页显示，不再注入 B站工具栏
- 修复：B站视频页导航栏消失、浮动按钮无效（原 sidePanel.open 依赖用户手势与侧边栏）

### v1.0.1
- 内容脚本改用 Shadow DOM 隔离，移除独立 content.css 注入

### v1.0.0
- 初始版本：后台播放、多歌单管理、导入导出（TXT/MD/JSON）

## 开发状态

v2.0.1 修复全部按钮失效问题：offscreen 通信改 **Port 长连接**（取代不可靠的 sendMessage），
并支持断线自动重连、getStatus 不再急切创建 offscreen。单元测试共 **55 项**全部通过。
待用户在浏览器验证：
1. **跨页面播放**：开始播放后关闭/跳转当前标签页，音频继续（浏览器开着即可）
2. **所有按钮**（播放/上下曲/停止/模式/音量/歌单操作）恢复可用
3. 此前无法播放的歌曲（如 BV12c7fzBEnd）现在能否播放
4. 加入歌单后面板自动刷新
4. 胶囊/面板的播放控制、进度、音量正常

已知取舍与后续方向：
- 浏览器完全关闭后音频停止（offscreen 随浏览器生命周期）。
- 更高音质 / 大会员曲目可能需要登录B站。
- offscreen 由 Chrome 管理，长时间无播放可能被回收，下次播放自动重建。
