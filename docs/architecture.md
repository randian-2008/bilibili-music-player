# 架构说明

## 仓库目录

```text
.
├── manifest.json              # Manifest V3 入口，必须位于根目录
├── update.bat                 # Windows 用户更新入口
├── README.md                  # 项目简介
├── LICENSE                    # GPL-3.0-or-later
├── CHANGELOG.md               # 正式版本记录
├── CONTRIBUTING.md            # 贡献指南
├── SECURITY.md                # 安全问题报告说明
├── package.json               # 本地检查、测试和打包命令
│
├── src/                       # 扩展运行时代码和静态配置
│   ├── background/
│   │   └── background.js      # Service Worker
│   ├── content/
│   │   └── content.js         # 页面浮层和消息桥
│   ├── player/
│   │   ├── offscreen.html
│   │   ├── offscreen-boot.js
│   │   └── offscreen.js       # 唯一音频宿主
│   ├── panel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.css
│   │   └── sidepanel.js       # 播放器和播放列表界面
│   ├── shared/
│   │   ├── logger.js
│   │   └── theme.js            # 跨上下文共享模块
│   ├── network/
│   │   └── rules.json          # declarativeNetRequest 请求规则
│   └── rename/                 # 合集标题智能重命名模块
│       ├── renamer.js          # 默认算法、规则校验和静态规则加载
│       └── rules.json          # 可选的静态正则替换规则
│
├── assets/icons/              # 扩展图标
├── docs/                      # 维护者文档和用户指南
├── tests/                     # 无浏览器依赖的 Node 测试
├── scripts/                   # 发布与更新脚本
│   ├── package.ps1            # 生成最小发布包和 SHA-256 文件
│   └── update.ps1             # 下载、校验和部署完整更新包
└── .github/                   # CI、Issue 和 PR 模板
```

运行时代码没有使用打包器。Manifest 可以直接引用 `src/` 下的 JavaScript、HTML、CSS 和 JSON 文件，因此目录整理不会改变运行方式，只需要同步更新资源路径。

## 运行时分层

```mermaid
flowchart LR
    Page[普通网页] --> Content[src/content/content.js\nclosed Shadow DOM 浮层与桥接]
    Content <--> Frame[src/panel/sidepanel.html\n播放器与播放列表界面]
    Content <--> Background[src/background/background.js\nService Worker]
    Background <--> Offscreen[src/player/offscreen.html\n唯一音频宿主]
    Background <--> Store[chrome.storage.local\n播放列表与状态]
    Background <--> BiliAPI[Bilibili API 与音频候选源]
    Background --> NetworkRules[src/network/rules.json\n请求头规则]
    Background --> Rename[src/rename/renamer.js\n合集标题处理]
```

`src/player/offscreen.js` 是唯一允许创建和控制 `<audio>` 的模块。播放命令经过 `sidepanel -> content -> background -> offscreen` 路由，状态和进度沿相反方向广播回界面。不要在内容脚本或 iframe 中增加备用音频引擎。

## 模块职责

| 路径 | 职责 |
| --- | --- |
| `manifest.json` | 权限、脚本入口、offscreen 资源、可访问资源和网络规则清单。 |
| `src/background/background.js` | 播放列表与状态持久化、Bilibili 元数据/合集/音频源解析、offscreen 生命周期和命令转发。 |
| `src/player/` | 独立音频播放、候选源容错、MediaSession、进度和状态广播。 |
| `src/content/content.js` | 页面浮动入口、播放器外壳、合集确认交互、拖拽缩放和 iframe 消息桥接。 |
| `src/panel/` | 播放器、播放列表管理、导入导出和用户交互界面。 |
| `src/shared/theme.js` | 固定主题的语义 CSS 变量和主题迁移。 |
| `src/shared/logger.js` | 跨上下文日志缓冲、落盘和日志中继。 |
| `src/network/rules.json` | Bilibili 媒体请求所需的 Referer / Origin 规则。 |
| `src/rename/` | 合集标题智能重命名；默认逻辑在 JavaScript 中，用户规则只允许使用经过校验的静态 JSON。 |
| `tests/` | 直接加载真实源码的 Node mock 测试。 |
| `update.bat` | Windows 用户双击后启动更新脚本。 |
| `scripts/package.ps1` | 运行测试、复制最小运行时文件、校验并生成版本化 ZIP 与 SHA-256 文件。 |
| `scripts/update.ps1` | 从官方 GitHub Release 下载完整包，校验后部署并在失败时回滚。 |

## 路径和配置边界

所有扩展内部路径都以扩展根目录为基准：Manifest 使用 `src/...` 路径，HTML 使用相对于自身目录的路径，Service Worker 使用 `chrome.runtime.getURL()` 或扩展根相对路径。

网络规则和标题规则必须位于不同模块目录。重命名模块只读取经过校验的静态 JSON，不执行用户上传的 JavaScript、HTML 或动态模块，也不从远程地址加载配置。空规则文件或单条规则无效时，内置默认逻辑仍然生效。

## 智能重命名

合集确认弹窗中的“智能重命名”只对当前一次导入生效。后台复制合集条目后，重命名模块按以下顺序处理：应用已启用的静态正则替换、分割标题、移除明确的前缀元数据、删除超过十个字符的可疑片段、批量识别公共前缀和后缀、重组最终标题，最后追加用户输入的统一前缀。长片段不会修改原对象；导入完成后只保存 `title`，原始标题不写入播放列表。

`rules.json` 使用合法 JSON，示例通过 `enabled: false` 禁用。支持 `scope`（`title` 或 `segment`）、`pattern`、`flags`（`g`、`i`、`m`）和 `replace` 字段；规则只执行字符串替换，并限制数量、长度和明显高风险表达式。

## 合集导入

合集导入保持“页面交互、后台持有数据”的边界：内容脚本从当前视频地址提取 BVID，后台请求 Bilibili view API 并展开分区、剧集和分 P。非嵌套条目使用分 P 名称；只有合集内的视频自身包含多个分 P 时，才使用“视频标题 · 分 P 名称”避免重名。完整条目缓存在 Service Worker 中，确认后由后台一次性去重和写入播放列表。

## 本地检查与发布

```bash
npm test
```

```powershell
npm run package:windows
```

发布脚本只复制扩展运行时文件、图标、许可证和用户指南到项目外的 `release/` 目录，不会把测试、文档源码或构建产物写回仓库。
