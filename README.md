# B站听歌列表 (bilibili-music-player)

Chrome 扩展（Manifest V3）：浏览器级 B站后台音频播放器，自带播放列表，关闭网页也能继续听歌。

## 架构概览

```
┌─ content.js（注入所有 http/https 网页，Shadow DOM 隔离）
│    ├─ 可变形胶囊 ★（停止=24px半透明圆♪；有曲目=胶囊：频谱+上一首/播放/下一首）
│    ├─ 浮动面板（上下两区：小播放器+歌单；可拖拽，点页面空白自动收起）
│    ├─「＋加入」按钮（仅 B站视频页，把 bvid/page 发给 background）
│    ├─ 音频播放器 ★（<audio> 在本页播放；向 background 取音频 URL，5 种模式、音量记忆、进度广播）
│    └─ postMessage 桥接（iframe 的播放/音量命令 → 本页播放器；歌单命令 → background）
│              ▲  window.postMessage          │ chrome.runtime.sendMessage
│              ▼                              ▼
├─ sidepanel.html/js/css（扩展页面，被 iframe 复用为播放列表 UI：上部小播放器+下部歌单）
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

## 悬浮控制（可变形胶囊）+ 打开 / 隐藏播放列表

- **停止时**：右下角 24px 小圆按钮（♪），无鼠标指向时**半透明**（低存在感），悬停恢复
- **有曲目时（播放或暂停）**：自动**变形为胶囊**迷你播放器，内含
  - 跳动频谱图（纯动画，标识播放中；**点击频谱展开播放列表**）
  - 上一首 / 播放·暂停 / 下一首 按钮（无需展开面板即可控制）
- **打开面板**：点胶囊频谱 / 点停止时的小圆按钮 / `Ctrl+Shift+B` / 扩展图标
- **收起面板**：点 × / 再点频谱 / **点击页面任意其他位置自动收起**
- 面板位置与开合状态自动记忆（chrome.storage）

## 已实现功能

### 播放
- 音频在 content script 内用 `<audio>` 播放；音频源由 background 解析（DASH/杜比/FLAC/durl）
- 播放/暂停、上一首/下一首、进度条拖拽、**停止**（清空播放并收起胶囊，区别于暂停）
- **音量调节 + 静音**（面板内滑杆），数值持久化记忆（`bpl_volume` / `bpl_mute`）
- MediaSession 集成（系统媒体控制）
- 自动解析 cid、自动选择最高音质音频流

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
- **拖拽排序由封面触发**：改用**指针事件自定义拖拽**（HTML5 原生拖拽在此 iframe 环境不可靠），
  按住封面上下拖动即可排序，带目标位置指示线、列表边缘自动滚动；
  拖拽时封面**不放大**（与悬停预览互斥）
- **封面悬停 2 秒放大预览**：用独立的 `position:fixed` 悬浮层（最高 z-index，脱离列表裁剪、
  盖在整个面板之上）从封面中心弹出 3 倍大图，避免原地放大被边框遮挡
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
共 32 项断言（background 20 + content 12），全部通过（退出码 0）才算合格。
注意：浏览器集成层（postMessage 桥接实际收发、Referer 规则生效、autoplay 策略、CORS 真实行为）
无法在 Node 中验证，需手动在浏览器确认。

## 更新记录

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

v1.8.3 拖拽重构为指针事件自实现（修复原生 DnD 在 iframe 失效）、封面放大改为固定悬浮层。
单元测试共 32 项全部通过。待用户在浏览器验证：
1. **按住封面上下拖动可排序**（带粉色指示线、列表边缘自动滚动），落位准确
2. 拖拽过程中封面**不会**触发悬停放大
3. 封面悬停约 2 秒后弹出 3 倍大图悬浮层（在面板最上层，不被遮挡），移开即收回
4. 封面单击仍可播放，长按（标题区）进入复选

已知取舍与后续方向：
- 音频随当前网页存活，关闭或完整跳转该标签页会停止（B站站内 SPA 跳转不受影响）。
  如需"关网页也继续听"，需重新引入 Offscreen Document 并排查其在部分环境的通信问题。
- 更高音质 / 大会员曲目可能需要登录B站。
