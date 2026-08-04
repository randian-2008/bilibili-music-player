# B站听歌列表 (bilibili-music-player)

Chrome 扩展（Manifest V3）：浏览器级 B站后台音频播放器，自带播放列表，关闭网页也能继续听歌。

> 使用与维护入口：[使用指南](USER_GUIDE.md) · [版本记录](CHANGELOG.md) · [架构说明](docs/architecture.md) · [贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [提交 Issue](.github/ISSUE_TEMPLATE)

## 架构概览

```
┌─ content.js（注入所有 http/https 网页，Shadow DOM 隔离）
│    ├─ 可变形胶囊 ★（停止=24px半透明圆♪；有曲目=胶囊：频谱+上一首/播放/下一首）
│    ├─ 浮动面板（上下两区：小播放器+歌单；可拖拽、缩放，点页面空白自动收起）
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
- 面板**位置和尺寸**自动记忆（chrome.storage）；**开合状态刻意不记忆**——新开页面 / 刷新时面板一律默认收起，
  无论是否正在播放（v2.2.8 起）
- 面板标题栏的调色盘按钮可横向展开固定色块，在**古典墨玉 / 曜石金 / 明亮白 / 星夜蓝 / 冰川玻璃 / 纯净玻璃**之间即时切换；
  配色同时作用于浮动外壳、迷你播放器和 iframe 内的完整播放器，并自动记忆

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
- 键：`bpl_playlists`（歌单，每首歌曲有稳定 `id`）、`bpl_active`（当前歌单ID）、
  `bpl_state`（播放状态，以 `trackId` 标识当前歌曲，`index` 仅作位置缓存）、`bpl_panel`（面板位置和尺寸）、
  `bpl_position`（断点：`{trackId, bvid, cid, position}`，供 offscreen 被回收后续播）、`bpl_theme`（固定主题 ID）、
  `bpl_schema_version`（存储结构版本，当前为 1）
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
npm test

# 或单独运行某个测试文件
node tests/test-offscreen.js    # offscreen 播放引擎：多音源容错/5种模式/统一停止/trackId/存储代理/断点续播
node tests/test-background.js   # B站API、存储迁移、歌单串行写入、稳定ID、批量操作、offscreen路由/自愈/广播/存储代理
node tests/test-content.js      # 播放命令路由、状态同步、桥接来源安全、面板几何边界、失效上下文自愈
node tests/test-logger.js       # 本地日志：批量落盘、级别、时间戳、上限裁剪、无存储上下文经 bg logMerge 中继
node tests/test-theme.js        # 固定主题定义、核心变量完整性、非法主题回退、主题应用
```

五个测试均通过 `vm` 注入 mock 的 `chrome/fetch/document`，**直接执行真实源码**
（offscreen.js / background.js 顶层函数可直接访问；content.js 经 `__BPL_EXPOSE` 钩子；logger.js 直接挂载 `globalThis.BPLLog`），
共 **146 项断言**（offscreen 37 + background 61 + content 21 + logger 8 + theme 19），全部通过（退出码 0）才算合格。
注意：浏览器集成层（offscreen 实际创建/发声、postMessage 桥接收发、Referer/Origin 规则、
autoplay 策略、CORS 真实行为）无法在 Node 中验证，需手动在浏览器确认。

确定性发布（自动运行上述测试、重建 release 目录、逐文件校验 SHA-256 并生成版本化 ZIP）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
```

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

## AI 辅助开发声明

本项目在维护者的设计、指导和审查下使用 AI 工具辅助开发：前期实现使用 OpenCode 配合 Qwen 3.8，后续功能完善、界面打磨、测试与文档整理使用 Codex 配合 GPT-5.6-sol。

AI 生成内容均经过维护者检查、测试和取舍；项目的维护、发布及相关责任由项目维护者承担。

## 开源许可

本项目采用 [GNU General Public License v3.0 或更高版本](LICENSE)。你可以使用、研究、修改和再发布本项目；发布修改版或衍生作品时，需要按照 GPL 提供对应源码并保留相同的自由软件许可。

## 版本记录

当前公开版本为 **v2.5.1**。正式版本说明和安装包请查看 [GitHub Releases](https://github.com/randian-2008/bilibili-music-player/releases)。

自首次公开发布起的版本变化记录见 [CHANGELOG.md](CHANGELOG.md)；此前的内部迭代保留在 Git 提交历史中。

## 项目状态

当前版本为 **v2.5.1**。播放、歌单、跨页面持久播放、可调尺寸面板和六套固定主题均已进入稳定使用阶段；
核心逻辑共有 **146 项**自动化断言，并由 GitHub Actions 在每个 Pull Request 上复跑。

已知取舍与后续方向：
- 浏览器完全关闭后音频停止（offscreen 随浏览器生命周期）。
- 更高音质 / 大会员曲目可能需要登录B站。
- offscreen 由 Chrome 管理，长时间无播放可能被回收，下次播放自动重建。
