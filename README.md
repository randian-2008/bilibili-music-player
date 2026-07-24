# B站听歌列表 (bilibili-music-player)

Chrome 扩展（Manifest V3）：浏览器级 B站后台音频播放器，自带播放列表，关闭网页也能继续听歌。

## 架构概览

```
┌─ content.js（注入所有 http/https 网页，Shadow DOM 隔离）
│    ├─ 浮动按钮 ♪（所有网页，右下角，点击开/关）
│    ├─ 浮动面板（可拖拽/开关，内嵌 iframe → sidepanel.html）
│    ├─「＋加入」按钮（仅 B站视频页，把 bvid/page 发给 background）
│    ├─ 音频播放器 ★（<audio> 在本页播放；向 background 取音频 URL，5 种模式、进度广播）
│    └─ postMessage 桥接（iframe 的播放命令 → 本页播放器；歌单命令 → background）
│              ▲  window.postMessage          │ chrome.runtime.sendMessage
│              ▼                              ▼
├─ sidepanel.html/js/css（扩展页面，被 iframe 复用为播放列表 UI）
│
├─ background.js（Service Worker：歌单管理、状态持久化、★请求B站API取cid/音频源）
│
└─ rules.json（declarativeNetRequest：为 bilivideo / api.bilibili 请求设置 Referer）
```

**核心设计**：播放列表 UI 以浮动面板注入任意网页（iframe 加载 `sidepanel.html`）。
**职责分离**：B站 API 请求（`view` 取 cid/元数据、`playurl` 取音频流）全部由 **background**
发起（持 host_permissions 绕过 CORS，这是成熟扩展的标准做法）；content script 拿到音频 URL 后
用 `<audio>` 就地播放，播放命令由 iframe 经 `postMessage` 发给本页 content script 处理；
歌单增删改等发给 background 持久化。
（取舍：音频随当前网页存活，关闭/跳转该标签页会停止；如需"关网页也继续"需 Offscreen，
该方案在部分环境存在通信问题，暂缓。）

## 打开 / 隐藏播放列表

- **浮动按钮**：任意网页右下角的粉色 ♪ 按钮（带呼吸光晕），点击后播放列表从按钮处**弹性弹出**，
  面板锚定在按钮正上方（右下角），可拖拽移动
- **键盘快捷键**：`Ctrl+Shift+B`（Mac：`Command+Shift+B`）
- **扩展图标**：点击工具栏扩展图标
- 面板位置与开合状态自动记忆（chrome.storage）

## 已实现功能

### 播放
- 后台音频播放（Offscreen Document + DASH 音频流）
- 播放/暂停、上一首/下一首、进度条拖拽
- MediaSession 集成（系统媒体控制）
- 自动解析 cid、自动选择最高音质音频流（含杜比/FLAC）

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
- 歌曲操作：添加、删除、重命名、拖拽排序
- 从 B站视频页一键添加（面板头部「＋加入」，支持多P）
- 去重检测（bvid + cid）

### 导入导出
- **导出格式**：TXT / Markdown / JSON
- **导入格式**：JSON（支持 `{name, items}` 或纯 items 数组，需含 bvid）
- **入口**：面板内歌单菜单（⋯ 按钮）

### 数据持久化
- chrome.storage.local
- 键：`bpl_playlists`（歌单）、`bpl_active`（当前歌单ID）、`bpl_state`（播放状态）、`bpl_panel`（面板位置/开合）
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
node tests/test-background.js   # B站音频源解析(dash/flac/durl/错误)、取cid、加入视频拉元数据
node tests/test-content.js      # 播放(经background取源)、5种播放模式、命令分发
```

两个测试均通过 `vm` 注入 mock 的 `chrome/fetch/Audio/document`，**直接执行真实源码**
（content.js 经 `__BPL_EXPOSE` 钩子取出内部播放器；background.js 顶层函数可直接访问），
共 21 项断言，全部通过（退出码 0）才算合格。
注意：浏览器集成层（postMessage 桥接实际收发、Referer 规则生效、autoplay 策略、CORS 真实行为）
无法在 Node 中验证，需手动在浏览器确认。

## 更新记录

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

**v1.5.0 主要功能已验证可用**：浮动面板、加入视频（正确抓取标题/UP主/封面）、
播放/暂停/上下曲、5 种播放模式、拖拽排序、进度同步、导入导出均正常。
核心逻辑通过 21 项单元测试（`tests/`）。

已知取舍与后续方向：
- 音频随当前网页存活，关闭或完整跳转该标签页会停止（B站站内 SPA 跳转不受影响）。
  如需"关网页也继续听"，需重新引入 Offscreen Document 并排查其在部分环境的通信问题。
- 更高音质 / 大会员曲目可能需要登录B站。
